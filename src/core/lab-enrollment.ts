import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type EnrollmentStatus = 'questionnaire' | 'pending_review' | 'approved' | 'rejected';
export type EnrollmentAnswer = { question: 'goal' | 'context' | 'help' | 'email'; text: string; source: 'text' | 'voice'; at: number };
export type EnrollmentEvidence = { text?: string; localPath?: string; sha256?: string; bytes?: number };
export type EnrollmentAudit = { action: string; actorId: string; at: number; note?: string };
export type EnrollmentRequest = {
  id: string; chatId: string; method: 'free' | 'crypto'; status: EnrollmentStatus;
  createdAt: number; updatedAt: number; freeGrantId?: string;
  /** set when this free request was claimed by a pre-approved Telegram username (links to usernames[].id) */
  usernamePreapprovalId?: string;
  email?: string; answers: EnrollmentAnswer[]; evidence?: EnrollmentEvidence; audit: EnrollmentAudit[];
};
export type FreeEnrollmentGrant = {
  id: string; tokenHash: string; recipientChatId: string; createdAt: number; expiresAt: number;
  revokedAt?: number; redeemedAt?: number; requestId?: string;
};
/** Pre-approved Telegram username: possession of the /start link is the claimant's access token. */
export type UsernameEnrollmentGrant = {
  id: string; username: string; createdAt: number; expiresAt?: number;
  revokedAt?: number; redeemedAt?: number; requestId?: string;
};
type State = { version: 1; cryptoChats?: string[]; grants: FreeEnrollmentGrant[]; usernames?: UsernameEnrollmentGrant[]; requests: EnrollmentRequest[] };
export type LabEnrollmentOptions = { rootDir: string; uploadsDir?: string; ownerId: string; now?: () => number };
const PRIVATE_CHAT = /^[1-9]\d{0,19}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
/** Telegram username shape (5–32 chars, letters/digits/underscore, leading letter). Stored lowercase. */
/** Telegram usernames are 5–32 chars; 4-char names exist via Fragment auctions. Stored lowercased. */
const USERNAME = /^[a-z][a-z0-9_]{3,31}$/;
const QUESTIONS = ['goal', 'context', 'help', 'email'] as const;
const MAX_STATE = 4 * 1024 * 1024;
const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const string = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;
const clone = <T>(v: T): T => structuredClone(v);

/** Eligibility ledger only. Approved never means verified website identity or delivered course access.
 * Calls are synchronous and reread persisted state, serializing all instances in one Node process.
 * Use one process for this ledger; cross-process writers require an external lock/coordinator.
 */
export class LabEnrollmentService {
  private readonly root: string;
  private readonly uploads?: string;
  private readonly ownerId: string;
  private readonly clock: () => number;
  constructor(options: LabEnrollmentOptions) {
    if (!PRIVATE_CHAT.test(options.ownerId)) throw new Error('Invalid enrollment owner');
    if (!path.isAbsolute(options.rootDir)) throw new Error('Enrollment root must be absolute');
    this.root = path.resolve(options.rootDir);
    this.ownerId = options.ownerId;
    this.clock = options.now ?? Date.now;
    this.checkDirectory(this.root);
    if (options.uploadsDir) {
      if (!path.isAbsolute(options.uploadsDir)) throw new Error('Uploads root must be absolute');
      this.uploads = path.resolve(options.uploadsDir);
      if (!this.inside(this.root, this.uploads)) throw new Error('Uploads must be within private enrollment root');
      this.checkDirectory(this.uploads);
    }
  }
  private inside(root: string, target: string): boolean { const rel = path.relative(root, target); return !!rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); }
  private noLinks(target: string): void {
    let cursor = path.parse(target).root;
    for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Unsafe enrollment path'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private checkDirectory(dir: string): void {
    this.noLinks(dir); const st = fs.statSync(dir);
    if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) throw new Error('Enrollment directory must be private and owned by current user');
  }
  private filename(name: string): string { this.checkDirectory(this.root); const f = path.join(this.root, name); this.noLinks(f); return f; }
  private now(): number { const n = this.clock(); if (!time(n)) throw new Error('Invalid enrollment clock'); return n; }
  private admin(actor: string): void { if (actor !== this.ownerId) throw new Error('Enrollment administrator required'); }
  private chat(chatId: string): void { if (!PRIVATE_CHAT.test(chatId)) throw new Error('Private Telegram chat required'); }
  private text(text: string, required = true): string {
    if (!string(text) || (required && !text.trim())) throw new Error('Invalid enrollment text');
    return text.trim();
  }
  private validate(s: unknown): asserts s is State {
    const fail = (): never => { throw new Error('Invalid enrollment state'); };
    if (!obj(s) || s.version !== 1 || !Array.isArray(s.grants) || !Array.isArray(s.requests) || s.grants.length > 10000 || s.requests.length > 10000) fail();
    const state = s as State;
    if (state.cryptoChats !== undefined && (!Array.isArray(state.cryptoChats) || state.cryptoChats.length > 10000 || state.cryptoChats.some(c => !PRIVATE_CHAT.test(c)) || new Set(state.cryptoChats).size !== state.cryptoChats.length)) fail();
    const ids = new Set<string>(); const hashes = new Set<string>();
    if (state.usernames !== undefined) {
      if (!Array.isArray(state.usernames) || state.usernames.length > 10000) fail();
      for (const u of state.usernames) {
        if (!obj(u) || !UUID.test(u.id) || ids.has(u.id) || !string(u.username, 32) || !USERNAME.test(u.username) || !time(u.createdAt) || (u.expiresAt !== undefined ? (!time(u.expiresAt) || u.expiresAt <= u.createdAt) : false) || (u.revokedAt !== undefined && !time(u.revokedAt)) || (u.redeemedAt !== undefined && !time(u.redeemedAt)) || (u.requestId !== undefined && !UUID.test(u.requestId)) || (u.redeemedAt === undefined) !== (u.requestId === undefined)) fail();
        ids.add(u.id); // one live grant per name is enforced at issue time (it needs the clock)
      }
    }
    for (const g of state.grants) {
      if (!obj(g) || !UUID.test(g.id) || ids.has(g.id) || !HASH.test(g.tokenHash) || hashes.has(g.tokenHash) || !PRIVATE_CHAT.test(g.recipientChatId) || !time(g.createdAt) || !time(g.expiresAt) || g.expiresAt <= g.createdAt || (g.revokedAt !== undefined && !time(g.revokedAt)) || (g.redeemedAt !== undefined && !time(g.redeemedAt)) || (g.requestId !== undefined && !UUID.test(g.requestId)) || (g.redeemedAt === undefined) !== (g.requestId === undefined)) fail();
      ids.add(g.id); hashes.add(g.tokenHash);
    }
    for (const r of state.requests) {
      if (!obj(r) || !UUID.test(r.id) || ids.has(r.id) || !PRIVATE_CHAT.test(r.chatId) || !['free', 'crypto'].includes(r.method) || !['questionnaire', 'pending_review', 'approved', 'rejected'].includes(r.status) || !time(r.createdAt) || !time(r.updatedAt) || !Array.isArray(r.answers) || r.answers.length > 4 || !Array.isArray(r.audit) || r.audit.length > 100 || !r.audit.length) fail();
      ids.add(r.id);
      if (r.email !== undefined && (!string(r.email, 254) || this.email(r.email) !== r.email)) fail();
      if (r.status === 'approved' && r.method === 'free' && !r.email) fail();
      for (const [i, a] of r.answers.entries()) if (!obj(a) || a.question !== QUESTIONS[i] || !string(a.text) || (i === 0 && !a.text.trim()) || !['text', 'voice'].includes(a.source) || !time(a.at)) fail();
      for (const a of r.audit) if (!obj(a) || !string(a.action, 80) || !PRIVATE_CHAT.test(a.actorId) || !time(a.at) || (a.note !== undefined && !string(a.note))) fail();
      if (r.method === 'free') {
        if (r.usernamePreapprovalId !== undefined) {
          if (r.freeGrantId !== undefined) fail();
          const u = (state.usernames ?? []).find(u => u.id === r.usernamePreapprovalId);
          if (!u || u.requestId !== r.id || r.evidence !== undefined || (r.status === 'approved' && r.answers.length !== 4)) fail();
        } else {
          const g = state.grants.find(g => g.id === r.freeGrantId);
          if (!g || g.requestId !== r.id || g.recipientChatId !== r.chatId || r.evidence !== undefined || (r.status === 'approved' && r.answers.length !== 4)) fail();
        }
      } else {
        if (r.freeGrantId !== undefined || r.usernamePreapprovalId !== undefined || r.status === 'questionnaire' || !obj(r.evidence) || (!r.evidence.text && !r.evidence.localPath) || (r.evidence.text !== undefined && (!string(r.evidence.text) || !r.evidence.text.trim()))) fail();
        if (r.evidence!.localPath !== undefined && (!this.uploads || !string(r.evidence!.localPath, 4096) || !path.isAbsolute(r.evidence!.localPath) || !this.inside(this.uploads, r.evidence!.localPath) || !HASH.test(r.evidence!.sha256 ?? '') || !time(r.evidence!.bytes))) fail();
      }
    }
    for (const g of state.grants) if (g.requestId && !state.requests.some(r => r.id === g.requestId && r.method === 'free' && r.freeGrantId === g.id)) fail();
    if (state.usernames) for (const u of state.usernames) if (u.requestId && !state.requests.some(r => r.id === u.requestId && r.method === 'free' && r.usernamePreapprovalId === u.id)) fail();
  }
  private read(): State {
    const file = this.filename('enrollment-state.json'); let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, grants: [], requests: [] }; throw e; }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > MAX_STATE) throw new Error('Unsafe enrollment state');
      const s: unknown = JSON.parse(fs.readFileSync(fd, 'utf8')); this.validate(s); return s;
    } finally { fs.closeSync(fd); }
  }
  private save(s: State): void {
    this.validate(s); const data = JSON.stringify(s);
    if (Buffer.byteLength(data) > MAX_STATE) throw new Error('Enrollment state capacity reached');
    const file = this.filename('enrollment-state.json'); const tmp = this.filename(`enrollment-${randomUUID()}.tmp`);
    const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.filename('enrollment-state.json'); fs.renameSync(tmp, file);
    const directory = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  issueFree(actorId: string, recipientChatId: string, ttlMs = 7 * 86400000): { token: string; grant: FreeEnrollmentGrant } {
    this.admin(actorId); this.chat(recipientChatId);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86400000) throw new Error('Invalid free-link lifetime');
    const s = this.read(); const token = randomBytes(24).toString('base64url'); const now = this.now();
    const grant: FreeEnrollmentGrant = { id: randomUUID(), tokenHash: hash(token), recipientChatId, createdAt: now, expiresAt: now + ttlMs };
    s.grants.push(grant); this.save(s); return { token, grant: clone(grant) };
  }
  revokeFree(actorId: string, grantId: string): FreeEnrollmentGrant {
    this.admin(actorId); const s = this.read(); const g = s.grants.find(g => g.id === grantId);
    if (!g || g.redeemedAt) throw new Error('Free link cannot be revoked');
    g.revokedAt ??= this.now(); this.save(s); return clone(g);
  }
  claimFree(chatId: string, token: string): EnrollmentRequest {
    this.chat(chatId); if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Invalid free link');
    const s = this.read(); const now = this.now(); const g = s.grants.find(g => g.tokenHash === hash(token));
    if (!g || g.recipientChatId !== chatId || g.revokedAt || g.redeemedAt || g.expiresAt <= now) throw new Error('Free link unavailable');
    if (s.requests.some(r => r.chatId === chatId && r.method === 'free' && ['questionnaire', 'approved'].includes(r.status))) throw new Error('Free enrollment already exists');
    const r: EnrollmentRequest = { id: randomUUID(), chatId, method: 'free', status: 'questionnaire', createdAt: now, updatedAt: now, freeGrantId: g.id, answers: [], audit: [{ action: 'free_link_claimed', actorId: chatId, at: now }] };
    g.redeemedAt = now; g.requestId = r.id; s.requests.push(r); this.save(s); return clone(r);
  }

  // ── pre-approved usernames: /start <username> claims a username grant → the same questionnaire → free participation ──
  /** Normalized Telegram username (lowercased, no @). Throws on invalid shape. */
  private username(name: string): string {
    const normalized = String(name ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME.test(normalized)) throw new Error('Invalid Telegram username');
    return normalized;
  }
  issueUsername(actorId: string, rawUsername: string, ttlMs = 14 * 86400000): UsernameEnrollmentGrant {
    const username = this.username(rawUsername);
    this.admin(actorId);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86400000) throw new Error('Invalid pre-approval lifetime');
    const s = this.read(); const now = this.now();
    s.usernames ??= [];
    if (s.usernames.some(u => u.username === username && !u.revokedAt && !u.redeemedAt && (u.expiresAt === undefined || u.expiresAt > now))) throw new Error('Username already pre-approved');
    const grant: UsernameEnrollmentGrant = { id: randomUUID(), username, createdAt: now, expiresAt: now + ttlMs };
    s.usernames.push(grant); this.save(s); return clone(grant);
  }
  revokeUsername(actorId: string, grantId: string): UsernameEnrollmentGrant {
    this.admin(actorId); const s = this.read(); const u = s.usernames?.find(u => u.id === grantId);
    if (!u || u.redeemedAt) throw new Error('Pre-approval cannot be revoked');
    u.revokedAt ??= this.now(); this.save(s); return clone(u);
  }
  /** Grant name a /start payload refers to: the exact name, else the deep-link `user_<name>` form. */
  private grantName(s: State, raw: string): string {
    const name = this.username(raw);
    if (s.usernames?.some(u => u.username === name)) return name;
    const bare = name.startsWith('user_') ? name.slice(5) : '';
    return bare && USERNAME.test(bare) && s.usernames?.some(u => u.username === bare) ? bare : name;
  }
  /** True when any username grant (even redeemed/revoked/expired) carries this name — routes /start payloads without side effects. */
  hasUsernamePreapproval(rawUsername: string): boolean {
    try { const s = this.read(); const name = this.grantName(s, rawUsername); return s.usernames?.some(u => u.username === name) ?? false; } catch { return false; }
  }
  claimUsername(chatId: string, rawUsername: string, proof: { actualUsername?: string } = {}): EnrollmentRequest {
    this.chat(chatId);
    const s = this.read(); const now = this.now();
    const username = this.grantName(s, rawUsername);
    const u = s.usernames?.find(u => u.username === username && !u.revokedAt && !u.redeemedAt && (u.expiresAt === undefined || u.expiresAt > now));
    if (!u) throw new Error('Pre-approval unavailable');
    // compare only: the sender's real @username is whatever Telegram shows, not something to validate
    if (proof.actualUsername && proof.actualUsername.trim().replace(/^@/, '').toLowerCase() !== username) throw new Error('This link was issued for another account');
    if (s.requests.some(r => r.chatId === chatId && r.method === 'free' && ['questionnaire', 'approved'].includes(r.status))) throw new Error('Free enrollment already exists');
    // Link-possession is the proof; the claimant's own @username, when Telegram shows it, must match.
    const hidden = !proof.actualUsername;
    const r: EnrollmentRequest = { id: randomUUID(), chatId, method: 'free', status: 'questionnaire', createdAt: now, updatedAt: now, usernamePreapprovalId: u.id, answers: [], audit: [{ action: 'username_preapproval_claimed', actorId: chatId, at: now, ...(hidden ? { note: 'sender username hidden from the bot' } : {}) }] };
    u.redeemedAt = now; u.requestId = r.id; s.requests.push(r); this.save(s); return clone(r);
  }
  listUsernames(): UsernameEnrollmentGrant[] { return clone(this.read().usernames ?? []); }
  saveAnswer(chatId: string, text: string, source: 'text' | 'voice'): EnrollmentRequest {
    this.chat(chatId); const value = this.text(text); if (!['text', 'voice'].includes(source)) throw new Error('Invalid answer source');
    const s = this.read(); const r = s.requests.find(r => r.chatId === chatId && r.status === 'questionnaire');
    if (!r) throw new Error('No enrollment questionnaire');
    const question = QUESTIONS[r.answers.length]; if (!question) throw new Error('Questionnaire already complete');
    const skip = /^(skip|пропустить)$/i.test(value); if (skip && ['goal', 'email'].includes(question)) throw new Error('Goal and email are required');
    if (question === 'email') r.email = this.email(value);
    const now = this.now(); r.answers.push({ question, text: skip ? '' : question === 'email' ? r.email! : value, source, at: now }); r.updatedAt = now;
    r.audit.push({ action: `answer_${question}`, actorId: chatId, at: now });
    if (r.answers.length === 4) { r.status = 'approved'; r.audit.push({ action: 'free_eligibility_confirmed', actorId: chatId, at: now }); }
    this.save(s); return clone(r);
  }
  private evidence(input: { text?: string; localPath?: string }): EnrollmentEvidence {
    const evidence: EnrollmentEvidence = {};
    if (input.text !== undefined) evidence.text = this.text(input.text);
    if (input.localPath !== undefined) {
      if (!this.uploads || !path.isAbsolute(input.localPath) || !this.inside(this.uploads, path.resolve(input.localPath))) throw new Error('Evidence outside trusted uploads');
      this.checkDirectory(this.uploads); const file = path.resolve(input.localPath); this.noLinks(file);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size < 12 || st.size > 20 * 1024 * 1024) throw new Error('Unsafe enrollment evidence');
        const data = fs.readFileSync(fd);
        const image = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (data[0] === 255 && data[1] === 216 && data[2] === 255) || /^GIF8[79]a/.test(data.subarray(0,6).toString('ascii')) || (data.subarray(0,4).toString('ascii') === 'RIFF' && data.subarray(8,12).toString('ascii') === 'WEBP');
        if (!image) throw new Error('Evidence must be an image');
        evidence.localPath = file; evidence.sha256 = hash(data); evidence.bytes = data.length;
      } finally { fs.closeSync(fd); }
    }
    if (!evidence.text && !evidence.localPath) throw new Error('Payment evidence required');
    return evidence;
  }
  beginCrypto(chatId: string): void {
    this.chat(chatId); const s = this.read(); s.cryptoChats ??= [];
    if (!s.cryptoChats.includes(chatId)) { s.cryptoChats.push(chatId); this.save(s); }
  }
  awaitingCrypto(chatId: string): boolean { this.chat(chatId); return this.read().cryptoChats?.includes(chatId) ?? false; }
  submitCrypto(chatId: string, input: { text?: string; localPath?: string }): EnrollmentRequest {
    this.chat(chatId); const evidence = this.evidence(input); const s = this.read(); const now = this.now();
    if (s.requests.some(r => r.chatId === chatId && r.method === 'crypto' && r.status === 'pending_review')) throw new Error('Crypto submission already pending review');
    const r: EnrollmentRequest = { id: randomUUID(), chatId, method: 'crypto', status: 'pending_review', createdAt: now, updatedAt: now, answers: [], evidence, audit: [{ action: 'crypto_evidence_submitted', actorId: chatId, at: now }] };
    s.requests.push(r); s.cryptoChats = s.cryptoChats?.filter(c => c !== chatId); this.save(s); return clone(r);
  }
  private email(value: string): string {
    if (!string(value, 254)) throw new Error('Invalid enrollment email');
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid enrollment email');
    return email;
  }
  /** Records the expected email only; identity verification is the website's responsibility. */
  setEmail(chatId: string, email: string): EnrollmentRequest {
    this.chat(chatId); const value = this.email(email); const s = this.read();
    const r = [...s.requests].reverse().find(r => r.chatId === chatId && ['pending_review', 'approved'].includes(r.status));
    if (!r) throw new Error('No enrollment eligible for email');
    if (r.email && r.email !== value) throw new Error('Enrollment email already bound');
    if (!r.email) { const now = this.now(); r.email = value; r.updatedAt = now; r.audit.push({ action: 'expected_email_recorded', actorId: chatId, at: now }); this.save(s); }
    return clone(r);
  }
  listGrants(): Omit<FreeEnrollmentGrant, 'tokenHash'>[] { return this.read().grants.map(({ tokenHash: _hash, ...grant }) => clone(grant)); }
  getById(id: string): EnrollmentRequest | undefined { return clone(this.read().requests.find(r => r.id === id)); }
  requestForChat(chatId: string): EnrollmentRequest | undefined {
    this.chat(chatId); return clone([...this.read().requests].reverse().find(r => r.chatId === chatId));
  }
  list(query: { chatId?: string; status?: EnrollmentStatus } = {}): EnrollmentRequest[] {
    if (query.chatId !== undefined) this.chat(query.chatId);
    return clone(this.read().requests.filter(r => (!query.chatId || r.chatId === query.chatId) && (!query.status || r.status === query.status)));
  }
  approve(actorId: string, requestId: string, note?: string): EnrollmentRequest { return this.review(actorId, requestId, 'approved', note); }
  reject(actorId: string, requestId: string, note?: string): EnrollmentRequest { return this.review(actorId, requestId, 'rejected', note); }
  private review(actorId: string, requestId: string, status: 'approved' | 'rejected', note?: string): EnrollmentRequest {
    this.admin(actorId); const reviewNote = note === undefined ? undefined : this.text(note); const s = this.read(); const r = s.requests.find(r => r.id === requestId);
    if (!r || r.method !== 'crypto' || r.status !== 'pending_review') throw new Error('Enrollment is not awaiting review');
    const now = this.now(); r.status = status; r.updatedAt = now; r.audit.push({ action: `admin_${status}`, actorId, at: now, ...(reviewNote ? { note: reviewNote } : {}) });
    this.save(s); return clone(r);
  }
}
