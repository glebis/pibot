import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Transport } from './types.js';

const CHAT = /^[1-9]\d{0,19}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const HASH = /^[a-f0-9]{64}\.json$/;
const MAX_FILES = 10000;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
type Participant = { key: string; display_name?: string; identity_status: string; telegram_user_id?: string | number; recommendation_file?: string };
export type InboxMessage = { id: string; at: string; direction: 'in' | 'out'; text: string; source: string; status: string };
export type InboxConversation = { chatId: string; name: string; key: string; lastMessage: string; lastAt: string; messageCount: number; truncated: boolean; identityStatus: string };
type Receipt = { id: string; chatId: string; text: string; at: string; status: 'pending' | 'sent' | 'ambiguous'; source: 'admin' };

/** Owner dashboard data only. HTTP authentication/CSRF checks belong to its caller. */
export class LabAdminInbox {
  private readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }
  private safe(relative: string): string {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(s => !s || s === '.' || s === '..')) throw new Error('Invalid private path');
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error('Invalid private root');
    const target = path.resolve(this.root, relative);
    if (!target.startsWith(this.root + path.sep)) throw new Error('Invalid private path');
    let cursor = this.root;
    for (const segment of relative.split('/')) {
      cursor = path.join(cursor, segment);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Invalid private path'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return target;
  }
  private read(relative: string): any {
    const file = this.safe(relative); const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid source');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  private write(relative: string, value: unknown, exclusive = false): void {
    const file = this.safe(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.safe(relative);
    if (exclusive) {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  private registry(): Participant[] {
    const data = this.read('participants.json');
    if (!Array.isArray(data.participants) || data.participants.length > 500) throw new Error('Invalid participant registry');
    return data.participants.filter((p: Participant) => p && p.identity_status === 'confirmed' && typeof p.key === 'string' && KEY.test(p.key) && CHAT.test(String(p.telegram_user_id)) && String(p.telegram_user_id) !== String(data.owner_telegram_user_id) && data.participants.filter((q: Participant) => q.key === p.key).length === 1 && data.participants.filter((q: Participant) => String(q.telegram_user_id) === String(p.telegram_user_id)).length === 1);
  }
  private ownerId(): string { return String(this.read('participants.json').owner_telegram_user_id ?? ''); }
  private observed(chatId: string): boolean {
    if (!CHAT.test(chatId) || chatId === this.ownerId()) return false;
    try {
      const marker = this.read(`admin-inbox/chats/${chatId}.json`);
      if (marker.chatId === chatId && marker.transport === 'telegram:lab' && marker.observed === true) return true;
    } catch { /* Fall back to older incoming conversation evidence. */ }
    return this.history(chatId).messages.some(message => message.direction === 'in');
  }
  private participant(chatId: string): Participant {
    if (!CHAT.test(chatId) || chatId === this.ownerId()) throw new Error('Unknown participant');
    const p = this.registry().find(p => String(p.telegram_user_id) === chatId);
    if (p) return p;
    if (this.observed(chatId)) return { key: `telegram_${chatId}`, display_name: `Telegram ${chatId}`, telegram_user_id: chatId, identity_status: 'unconfirmed' };
    throw new Error('Unknown participant');
  }
  private observedChats(): string[] {
    const ids = new Set<string>();
    for (const relative of ['conversations', 'admin-inbox/chats']) {
      try {
        const directory = fs.opendirSync(this.safe(relative)); let count = 0;
        try { for (;;) { const entry = directory.readSync(); if (!entry || count++ >= MAX_FILES) break; const id = relative === 'conversations' ? entry.name : entry.name.replace(/\.json$/, ''); if (CHAT.test(id)) ids.add(id); } }
        finally { directory.closeSync(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return [...ids].filter(id => this.observed(id));
  }
  participantChat(chatId: string): boolean {
    try { this.participant(chatId); return true; } catch { return false; }
  }
  private files(relative: string): { files: string[]; truncated: boolean } {
    try {
      const directory = fs.opendirSync(this.safe(relative)); const files: string[] = []; let truncated = false;
      try { for (;;) { const entry = directory.readSync(); if (!entry) break; if (HASH.test(entry.name)) { if (files.length === MAX_FILES) { truncated = true; break; } files.push(entry.name); } } }
      finally { directory.closeSync(); }
      return { files, truncated };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], truncated: false }; throw error; }
  }
  private history(chatId: string): { messages: InboxMessage[]; truncated: boolean } {
    const messages = new Map<string, InboxMessage>(); let truncated = false;
    for (const relative of [`conversations/${chatId}`, `admin-inbox/messages/${chatId}`, 'admin-inbox/replies']) {
      const listing = this.files(relative); truncated ||= listing.truncated;
      for (const file of listing.files) {
        try {
          const e = this.read(`${relative}/${file}`);
          if (relative === 'admin-inbox/replies' && e.chatId !== chatId) continue;
          const at = e.at;
          if (typeof e.id !== 'string' || !/^[a-f0-9]{64}$/.test(e.id) || typeof e.text !== 'string' || e.text.length > 64000 || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) continue;
          const direction = relative === 'admin-inbox/replies' ? 'out' : e.role === 'user' ? 'in' : e.role === 'assistant' ? 'out' : undefined;
          if (!direction) continue;
          messages.set(e.id, { id: e.id, at, direction, text: e.text, source: e.source === 'admin' ? 'admin' : 'bot', status: relative === 'admin-inbox/replies' ? (['sent', 'pending', 'ambiguous'].includes(e.status) ? e.status : 'ambiguous') : (e.status === 'sent' ? 'sent' : direction === 'in' ? 'received' : 'recorded') });
        } catch { /* One invalid historical record must not hide the rest. */ }
      }
    }
    return { messages: [...messages.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)), truncated };
  }
  private summary(p: Participant, history: ReturnType<LabAdminInbox['history']>): InboxConversation {
    const last = history.messages.at(-1);
    return { chatId: String(p.telegram_user_id), name: typeof p.display_name === 'string' ? p.display_name : p.key, key: p.key, lastMessage: last?.text.slice(0, 240) ?? '', lastAt: last?.at ?? '', messageCount: history.messages.length, truncated: history.truncated, identityStatus: p.identity_status };
  }
  participants(): InboxConversation[] {
    const profiles = this.registry();
    for (const chatId of this.observedChats()) if (!profiles.some(p => String(p.telegram_user_id) === chatId)) profiles.push(this.participant(chatId));
    return profiles.map(p => this.summary(p, this.history(String(p.telegram_user_id)))).sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.name.localeCompare(b.name));
  }
  thread(chatId: string, options: { limit?: number; before?: string } = {}): { conversation: InboxConversation; messages: InboxMessage[]; profile: string; nextBefore?: string; truncated: boolean } {
    const p = this.participant(chatId); const history = this.history(chatId);
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100) || 100));
    let end = history.messages.length;
    if (options.before) { const index = history.messages.findIndex(e => e.id === options.before); if (index < 0) throw new Error('Invalid message cursor'); end = index; }
    const start = Math.max(0, end - limit); let profile = '';
    if (p.identity_status === 'confirmed' && typeof p.recommendation_file === 'string') {
      try {
        const file = this.safe(p.recommendation_file); const stat = fs.statSync(file);
        if (stat.isFile() && stat.size <= 128 * 1024) profile = '# Known participant context\n\n' + fs.readFileSync(file, 'utf8').slice(0, 24000);
      } catch { /* Missing curated context is not a reason to expose a different file. */ }
    }
    try { const data = this.read(`conversations/${chatId}/profile.json`); if (String(data.telegram_chat_id) === chatId && (!data.participant_key || data.participant_key === p.key)) profile += (profile ? '\n\n# Attributed conversation evidence\n\n' : '') + JSON.stringify(data, null, 2).slice(0, 24000); } catch { /* No profile evidence yet. */ }
    return { conversation: this.summary(p, history), messages: history.messages.slice(start, end), profile, ...(start > 0 ? { nextBefore: history.messages[start].id } : {}), truncated: history.truncated };
  }
  /** Register only a real incoming transport event; never an arbitrary dashboard target. */
  observe(t: Transport, chatId: string): boolean {
    if (t.name !== 'telegram:lab' || t.boundAgentId !== 'lab' || !CHAT.test(chatId) || chatId === this.ownerId()) return false;
    try { this.write(`admin-inbox/chats/${chatId}.json`, { chatId, transport: 'telegram:lab', observed: true, at: new Date().toISOString() }, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return true;
  }
  /** Invoke before routing incoming text / after successful outgoing push. */
  capture(t: Transport, chatId: string, role: 'user' | 'assistant', text: string, messageId?: string | number, source: 'bot' | 'admin' = 'bot', at = new Date().toISOString()): boolean {
    if (t.name !== 'telegram:lab' || t.boundAgentId !== 'lab' || !CHAT.test(chatId) || typeof text !== 'string' || !text.trim()) return false;
    if (chatId === this.ownerId()) return false;
    if (role === 'user') this.observe(t, chatId);
    try { this.participant(chatId); } catch { return false; }
    if (text.length > 64000) throw new Error('Message too large');
    if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid message time');
    const id = digest(`${role}:${messageId ?? randomUUID()}`);
    // Preserve the original timestamp/question attribution from the answer pipeline.
    if (fs.existsSync(this.safe(`conversations/${chatId}/${id}.json`))) return true;
    try { this.write(`admin-inbox/messages/${chatId}/${id}.json`, { id, role, text, at, source, status: role === 'user' ? 'received' : 'sent' }, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return true;
  }
  /** Claim the request durably before external send; pending/ambiguous are never retried. */
  async reply(t: Transport, chatId: string, text: string, requestId: string): Promise<Receipt> {
    this.participant(chatId);
    if (t.name !== 'telegram:lab' || t.boundAgentId !== 'lab') throw new Error('Lab transport unavailable');
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Reply must contain 1–4000 characters');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new Error('Invalid request ID');
    // Global request identity also blocks accidental reuse against another recipient.
    const id = digest(requestId); const relative = `admin-inbox/replies/${id}.json`;
    const receipt: Receipt = { id, chatId, text, at: new Date().toISOString(), status: 'pending', source: 'admin' };
    try { this.write(relative, receipt, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = this.read(relative) as Receipt;
      if (previous.chatId !== chatId || previous.text !== text) throw new Error('Request ID already used for another reply');
      return previous;
    }
    try { await t.push(chatId, { text, dedupeKey: `lab-admin:${id}` }); receipt.status = 'sent'; }
    catch { receipt.status = 'ambiguous'; }
    this.write(relative, receipt);
    return receipt;
  }
}
