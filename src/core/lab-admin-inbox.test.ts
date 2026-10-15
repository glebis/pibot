import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { LabAdminInbox } from './lab-admin-inbox.js';
import { LabCompanion } from './lab-companion.js';
import type { Transport } from './types.js';

describe('private lab admin inbox', () => {
  let root: string; let inbox: LabAdminInbox; let transport: Transport;
  const write = (relative: string, value: unknown) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-admin-inbox-'));
    write('participants.json', { owner_telegram_user_id: 99, participants: [
      { key: 'alice', display_name: 'Alice', identity_status: 'confirmed', telegram_user_id: 42 },
      { key: 'bob', display_name: 'Bob', identity_status: 'confirmed', telegram_user_id: 43 },
      { key: 'pending', identity_status: 'unconfirmed', telegram_user_id: 44 },
    ] });
    inbox = new LabAdminInbox(root);
    transport = { name: 'telegram:lab', boundAgentId: 'lab', push: vi.fn().mockResolvedValue(undefined) } as unknown as Transport;
  });
  it('reads existing history and profile evidence with bounded stable pagination', () => {
    for (let i = 0; i < 4; i++) { const id = hash(`user:${i}`); write(`conversations/42/${id}.json`, { id, role: 'user', text: `Alice ${i}`, at: `2026-10-10T12:00:0${i}Z`, relevant: true }); }
    write('conversations/42/profile.json', { telegram_chat_id: '42', participant_key: 'alice', memory: ['Alice goal'] });
    const page = inbox.thread('42', { limit: 2 });
    expect(page.messages.map(m => m.text)).toEqual(['Alice 2', 'Alice 3']);
    expect(page.profile).toContain('Alice goal');
    expect(inbox.thread('42', { limit: 2, before: page.nextBefore }).messages.map(m => m.text)).toEqual(['Alice 0', 'Alice 1']);
    expect(inbox.thread('43').messages).toEqual([]);
    expect(inbox.participants().map(p => p.name)).toEqual(['Alice', 'Bob']);
    expect(() => inbox.thread('42', { before: 'missing' })).toThrow('cursor');
  });
  it('only captures known private participants on exact lab transport and deduplicates incoming IDs', () => {
    expect(inbox.capture(transport, '42', 'user', 'hello', 1)).toBe(true);
    expect(inbox.capture(transport, '42', 'user', 'hello', 1)).toBe(true);
    expect(inbox.thread('42').messages).toHaveLength(1);
    expect(inbox.capture(transport, '44', 'user', 'pending')).toBe(true);
    expect(inbox.thread('44').conversation).toMatchObject({ name: 'Telegram 44', identityStatus: 'unconfirmed' });
    expect(inbox.capture(transport, '-100123', 'user', 'group')).toBe(false);
    expect(inbox.capture(transport, '99', 'user', 'preview')).toBe(false);
    expect(inbox.capture({ ...transport, name: 'telegram' }, '42', 'user', 'wrong bot')).toBe(false);
    const file = path.join(root, 'admin-inbox/messages/42', `${hash('user:1')}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
  it('keeps original incoming evidence timestamps when intercepted after the answer', () => {
    const id = hash('user:1'); write(`conversations/42/${id}.json`, { id, role: 'user', text: 'original', at: '2026-10-10T10:00:00Z', question: 'Goal?' });
    inbox.capture(transport, '42', 'user', 'original', 1);
    expect(inbox.thread('42').messages[0].at).toBe('2026-10-10T10:00:00Z');
    expect(fs.existsSync(path.join(root, 'admin-inbox/messages/42', `${id}.json`))).toBe(false);
  });
  it('includes observed contacts, keeps event chronology, and imports only sent messages into isolated context', async () => {
    expect(inbox.observe(transport, '45')).toBe(true);
    inbox.capture(transport, '45', 'assistant', 'Welcome', 'welcome', 'bot', '2026-10-10T12:00:01Z');
    inbox.capture(transport, '45', 'user', '/start', 3, 'bot', '2026-10-10T12:00:00Z');
    expect(inbox.thread('45').messages.map(m => m.text)).toEqual(['/start', 'Welcome']);
    expect(inbox.thread('45').conversation).toMatchObject({ name: 'Telegram 45', identityStatus: 'unconfirmed' });
    await inbox.reply(transport, '45', 'Human course advice', 'observed_reply_1234');
    vi.mocked(transport.push).mockRejectedValueOnce(new Error('unknown outcome'));
    await inbox.reply(transport, '45', 'AMBIGUOUS PRIVATE', 'ambiguous_reply_1234');
    const lab = new LabCompanion(root);
    expect(lab.conversationContext(transport, '45')).toContain('Human course advice');
    expect(lab.conversationContext(transport, '45')).not.toContain('AMBIGUOUS PRIVATE');
    expect(lab.conversationContext(transport, '43')).not.toContain('Human course advice');
    await expect(inbox.reply(transport, '46', 'Never contacted bot', 'unknown_reply_1234')).rejects.toThrow('Unknown participant');
  });
  it('shows only bounded curated participant context and matching evidence', () => {
    write('participants.json', { participants: [{ key: 'alice', identity_status: 'confirmed', telegram_user_id: 42, recommendation_file: 'alice.md' }] });
    fs.writeFileSync(path.join(root, 'alice.md'), 'Alice task: printing workflow');
    write('conversations/42/profile.json', { telegram_chat_id: '43', participant_key: 'bob', memory: ['Bob private task'] });
    const profile = inbox.thread('42').profile;
    expect(profile).toContain('printing workflow'); expect(profile).not.toContain('Bob private task');
  });
  it('claims replies before send, reports ambiguous outcomes, and never automatically resends', async () => {
    const request = 'request_1234567890';
    vi.mocked(transport.push).mockRejectedValueOnce(new Error('timeout after delivery'));
    expect((await inbox.reply(transport, '42', 'hello', request)).status).toBe('ambiguous');
    const restored = new LabAdminInbox(root);
    expect((await restored.reply(transport, '42', 'hello', request)).status).toBe('ambiguous');
    expect(transport.push).toHaveBeenCalledTimes(1);
    expect(restored.thread('42').messages[0]).toMatchObject({ source: 'admin', status: 'ambiguous', text: 'hello' });
    await expect(inbox.reply(transport, '43', 'hello', request)).rejects.toThrow('already used');
    await expect(inbox.reply(transport, '42', 'changed', request)).rejects.toThrow('already used');
  });
  it('blocks concurrent same-request sends and persists sent audit across restart', async () => {
    let release!: () => void;
    vi.mocked(transport.push).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = inbox.reply(transport, '42', 'manual reply', 'same_request_123456');
    expect((await inbox.reply(transport, '42', 'manual reply', 'same_request_123456')).status).toBe('pending');
    release(); expect((await first).status).toBe('sent');
    expect(transport.push).toHaveBeenCalledTimes(1);
    expect(new LabAdminInbox(root).thread('42').messages[0].status).toBe('sent');
    expect(transport.push).toHaveBeenCalledWith('42', expect.objectContaining({ text: 'manual reply', dedupeKey: expect.stringMatching(/^lab-admin:/) }));
  });
  it('fails closed for duplicate identities, wrong transport, unsafe targets and symlink reads/writes', async () => {
    await expect(inbox.reply({ ...transport, boundAgentId: 'other' }, '42', 'hello', 'request_1234567890')).rejects.toThrow('transport');
    for (const target of ['../42', '44', '-10042', '99']) await expect(inbox.reply(transport, target, 'hello', 'request_1234567890')).rejects.toThrow('Unknown participant');
    fs.mkdirSync(path.join(root, 'admin-inbox')); fs.symlinkSync(os.tmpdir(), path.join(root, 'admin-inbox/messages'));
    expect(() => inbox.capture(transport, '42', 'user', 'hello')).toThrow('private path');
    expect(() => inbox.thread('42')).toThrow('private path');
    write('participants.json', { participants: [{ key: 'alice', identity_status: 'confirmed', telegram_user_id: 42 }, { key: 'other', identity_status: 'confirmed', telegram_user_id: 42 }] });
    expect(inbox.participantChat('43')).toBe(false);
    expect(transport.push).not.toHaveBeenCalled();
  });
});
