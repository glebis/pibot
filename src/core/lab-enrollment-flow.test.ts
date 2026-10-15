import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHmac } from 'node:crypto';
import { LabEnrollmentFlow } from './lab-enrollment-flow.js';
import { PiBot } from './bot.js';
import type { Transport } from './types.js';
let root: string;
let flow: LabEnrollmentFlow;
let transport: Transport;
let push: ReturnType<typeof vi.fn>;
const secret = 'test-enrollment-secret-with-32-characters';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'enrollment-flow-')); fs.chmodSync(root, 0o700);
  flow = new LabEnrollmentFlow(root, '100', () => secret);
  push = vi.fn(async () => {}); transport = { name: 'telegram:lab', boundAgentId: 'lab', push } as unknown as Transport;
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('fixed lab enrollment flow', () => {
  it('completes personal free questionnaire with voice, then signs identity-bound website handoff', async () => {
    const issued = flow.issue('200'); await flow.handle(transport, '200', '/start free_' + issued.token);
    await flow.handle(transport, '200', 'Improve reporting', 'voice'); await flow.handle(transport, '200', 'skip'); await flow.handle(transport, '200', 'skip');
    await flow.handle(transport, '200', 'Student@Example.com');
    const text = push.mock.calls.at(-1)![1].text as string;
    const token = text.match(/#token=([A-Za-z0-9_.-]+)/)![1]; const [encoded, signature] = token.split('.');
    expect(signature).toBe(createHmac('sha256', secret).update(encoded).digest('hex'));
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toMatchObject({ v: 1, kind: 'free', email: 'student@example.com', site: 'goal-driven-ai-01' });
    expect(flow.service.requestForChat('200')?.answers[0].source).toBe('voice');
  });
  it('saves crypto evidence pending manual admin approval and email capture, then delivers the claim', async () => {
    await flow.handle(transport, '200', '/start crypto');
    const resumed = new LabEnrollmentFlow(root, '100', () => secret);
    await resumed.handle(transport, '200', '0xtransaction');
    expect(resumed.service.requestForChat('200')?.status).toBe('pending_review');
    await resumed.handle(transport, '200', 'student@example.com');
    const r = resumed.service.requestForChat('200')!; const control = resumed.control(() => transport);
    await control.approve(r.id, 'Manually checked transfer');
    expect(push.mock.calls.at(-1)![0]).toBe('200'); expect(push.mock.calls.at(-1)![1].text).toContain('#token=');
    expect(control.list('pending_review')).toEqual([]); expect(control.list('student@example.com')).toHaveLength(1);
  });
  it('fails closed when ticket secret is missing and never reports website access as granted', async () => {
    const missing = new LabEnrollmentFlow(root, '100', () => undefined);
    const r = missing.service.submitCrypto('200', { text: 'tx' }); missing.service.setEmail('200', 'student@example.com');
    await missing.control(() => transport).approve(r.id);
    expect(push.mock.calls.at(-1)![1].text).toContain('доступ на сайте пока не выдан');
    expect(push.mock.calls.at(-1)![1].text).not.toContain('#token=');
  });
  it('does not open another bot or hijack unrelated member attachments; refuses unauthorized free link issue', async () => {
    expect(await flow.handle({ ...transport, name: 'telegram:other' }, '200', '/crypto')).toBe(false);
    expect(await flow.handle(transport, '200', '', 'text', { kind: 'photo', chatId: '200', filePath: '/outside', fileId: 'id' })).toBe(false);
    await flow.handle(transport, '200', '/freeaccess 300'); expect(flow.control(() => transport).listGrants()).toEqual([]);
    await flow.handle(transport, '100', '/freeaccess 300');
    expect(flow.control(() => transport).listGrants()[0].recipientChatId).toBe('300');
    expect(flow.control(() => transport).listGrants()[0]).not.toHaveProperty('tokenHash');
  });
  it('captures public answers privately with bearer tokens scrubbed and preserves feedback interrupts', async () => {
    const bot = Object.create(PiBot.prototype) as any; bot.labEnrollment = flow; bot.deps = {};
    const capture = vi.fn(); bot.inboxFor = () => ({ observe: vi.fn(), capture });
    const feedback = vi.fn(async (_t: Transport, _chat: string, text: string) => text.startsWith('I have feedback'));
    bot.labFor = () => ({ handleFeedback: feedback });
    const issued = flow.issue('200');
    await bot.publicLabRequest(transport, '200', '/start free_' + issued.token);
    await bot.publicLabRequest(transport, '200', 'Improve weekly reporting');
    await bot.publicLabRequest(transport, '200', 'I have feedback, please improve this question');
    expect(flow.service.requestForChat('200')?.answers).toHaveLength(1);
    expect(capture.mock.calls.map(call => call[3]).join(' ')).toContain('Improve weekly reporting');
    expect(capture.mock.calls.map(call => call[3]).join(' ')).not.toContain(issued.token);
    expect(capture.mock.calls.map(call => call[3]).join(' ')).toContain('free_[redacted]');
    await bot.publicLabRequest(transport, '200', '/start');
    expect(flow.service.requestForChat('200')?.answers).toHaveLength(1);
  });
  it('public voice does not transcribe without an active enrollment', async () => {
    const bot = Object.create(PiBot.prototype) as any; bot.labEnrollment = flow; bot.handleVoiceMedia = vi.fn();
    await bot.publicLabRequest(transport, '200', '', { kind: 'voice', chatId: '200', filePath: '/unused.ogg', fileId: 'voice' });
    expect(bot.handleVoiceMedia).not.toHaveBeenCalled();
    flow.service.beginCrypto('200');
    await bot.publicLabRequest(transport, '200', '', { kind: 'voice', chatId: '200', filePath: '/unused.ogg', fileId: 'voice' });
    expect(bot.handleVoiceMedia).toHaveBeenCalledWith(transport, expect.objectContaining({ chatId: '200' }), 'lab', true);
  });
  it('bot routes enrollment commands before agent dispatch and exposes the admin control', async () => {
    const bot = Object.create(PiBot.prototype) as any; bot.labEnrollment = flow;
    bot.transports = new Map([['telegram:lab', transport]]); bot.routeUserTurn = vi.fn();
    const issued = flow.issue('200'); await bot.handleIncoming(transport, '200', '/start free_' + issued.token);
    expect(bot.routeUserTurn).not.toHaveBeenCalled(); expect(bot.labEnrollmentControl().list()).toHaveLength(1);
  });
});

describe('username pre-approval deep links', () => {
  it('routes /start user payloads only for pre-approved names and claims into the questionnaire', async () => {
    expect(await flow.handle(transport, '200', '/start total_stranger')).toBe(false); // no grant → normal start
    const control = flow.control(() => transport);
    // admin-only issuance command
    await flow.handle(transport, '200', '/approveuser @bobby'); expect(push.mock.calls).toHaveLength(0);
    await flow.handle(transport, '100', '/approveuser @bobby');
    expect(flow.service.listUsernames().some(u => u.username === 'bobby')).toBe(true);
    const text = push.mock.calls.at(-1)![1].text as string;
    expect(text).toContain('start=user_bobby');
    // claim via @name, bare name, and the user_ prefix
    await flow.handle(transport, '201', '/start @bobby');
    expect(flow.service.requestForChat('201')?.usernamePreapprovalId).toBeTruthy();
    expect(push.mock.calls.at(-1)![1].text).toContain('Чего вы ждёте');
    // re-claim is refused with the reason
    const before = push.mock.calls.length;
    await flow.handle(transport, '201', '/start bobby');
    expect(push.mock.calls.length).toBeGreaterThan(before);
    expect(push.mock.calls.at(-1)![1].text).toContain('Не получилось');
  });
  it('control exposes username grants without secrets', () => {
    const control = flow.control(() => transport);
    control.issueUsername('dana');
    const list = control.listUsernames();
    expect(list).toHaveLength(1);
    expect(list[0].username).toBe('dana');
  });
});
