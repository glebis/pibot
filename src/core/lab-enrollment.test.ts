import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LabEnrollmentService } from './lab-enrollment.js';

let root: string;
let uploads: string;
let now: number;
let service: LabEnrollmentService;
const owner = '100';
const chat = '200';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lab-enrollment-'));
  fs.chmodSync(root, 0o700); uploads = path.join(root, 'uploads'); fs.mkdirSync(uploads, { mode: 0o700 }); now = 1800000000000;
  service = new LabEnrollmentService({ rootDir: root, uploadsDir: uploads, ownerId: owner, now: () => now });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('personal free enrollment', () => {
  it('persists only a token hash and binds redemption to recipient, expiry and one use', () => {
    const { token, grant } = service.issueFree(owner, chat, 1000);
    expect(fs.readFileSync(path.join(root, 'enrollment-state.json'), 'utf8')).not.toContain(token);
    expect(() => service.claimFree('201', token)).toThrow('unavailable');
    const r = service.claimFree(chat, token);
    expect(r.status).toBe('questionnaire');
    expect(r.freeGrantId).toBe(grant.id);
    expect(() => service.claimFree(chat, token)).toThrow('unavailable');
    const second = service.issueFree(owner, '202', 1000); now += 1000;
    expect(() => service.claimFree('202', second.token)).toThrow('unavailable');
  });
  it('honors revocation and restricts issue/revoke to admin', () => {
    expect(() => service.issueFree(chat, chat)).toThrow('administrator');
    const issued = service.issueFree(owner, chat);
    expect(() => service.revokeFree(chat, issued.grant.id)).toThrow('administrator');
    service.revokeFree(owner, issued.grant.id);
    expect(() => service.claimFree(chat, issued.token)).toThrow('unavailable');
  });
  it('requires goal and email, accepts transcribed voice and optional skips, grants eligibility only after completion', () => {
    const { token } = service.issueFree(owner, chat); service.claimFree(chat, token);
    expect(() => service.saveAnswer(chat, 'skip', 'text')).toThrow('required');
    expect(service.saveAnswer(chat, 'Automate weekly reporting', 'voice').status).toBe('questionnaire');
    service.saveAnswer(chat, 'skip', 'text');
    expect(service.saveAnswer(chat, 'Help with workflow', 'voice').status).toBe('questionnaire');
    expect(() => service.saveAnswer(chat, 'skip', 'text')).toThrow('required');
    expect(() => service.saveAnswer(chat, 'invalid-email', 'text')).toThrow('email');
    const done = service.saveAnswer(chat, 'Student@Example.com', 'text');
    expect(done.status).toBe('approved'); expect(done.email).toBe('student@example.com'); expect(done.answers[0].source).toBe('voice');
    expect(done).not.toHaveProperty('accessGranted'); expect(done).not.toHaveProperty('emailVerified');
    expect(() => service.saveAnswer(chat, 'extra', 'text')).toThrow('No enrollment');
    const reopened = new LabEnrollmentService({ rootDir: root, ownerId: owner });
    expect(reopened.getById(done.id)).toEqual(done);
  });
});

describe('manual crypto review', () => {
  it('never approves transaction text or screenshot automatically, and only admin can review once', () => {
    const file = path.join(uploads, 'proof.png');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(16)]), { mode: 0o600 });
    const r = service.submitCrypto(chat, { text: 'transaction hash from participant', localPath: file });
    expect(r.status).toBe('pending_review'); expect(r.evidence?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => service.approve(chat, r.id)).toThrow('administrator');
    expect(() => service.submitCrypto(chat, { text: 'retry' })).toThrow('already pending');
    const bound = service.setEmail(chat, 'Student@Example.com'); expect(bound.email).toBe('student@example.com');
    expect(() => service.setEmail(chat, 'different@example.com')).toThrow('already bound');
    const approved = service.approve(owner, r.id, 'Reviewed transfer manually');
    expect(approved.status).toBe('approved'); expect(approved.audit.at(-1)?.actorId).toBe(owner);
    expect(() => service.reject(owner, r.id)).toThrow('not awaiting');
  });
  it('rejects untrusted, public, nonimage and symlink evidence', () => {
    expect(() => service.submitCrypto(chat, {})).toThrow('required');
    expect(() => service.submitCrypto(chat, { localPath: '/tmp/outside.png' })).toThrow('outside');
    const file = path.join(uploads, 'fake.png'); fs.writeFileSync(file, 'not an image at all', { mode: 0o600 });
    expect(() => service.submitCrypto(chat, { localPath: file })).toThrow('image');
    fs.chmodSync(file, 0o644); expect(() => service.submitCrypto(chat, { localPath: file })).toThrow('Unsafe');
    const link = path.join(uploads, 'linked.png'); fs.symlinkSync(file, link);
    expect(() => service.submitCrypto(chat, { localPath: link })).toThrow('Unsafe');
    expect(service.list()).toEqual([]);
  });
  it('retains rejection audit and allows a new separately reviewed submission', () => {
    const r = service.submitCrypto(chat, { text: 'unconfirmed tx' }); service.reject(owner, r.id, 'Could not confirm');
    const second = service.submitCrypto(chat, { text: 'corrected tx' });
    expect(second.id).not.toBe(r.id); expect(second.status).toBe('pending_review');
    expect(service.list({ status: 'rejected' })[0].audit.at(-1)?.note).toBe('Could not confirm');
  });
});

describe('private durable state', () => {
  it('fails closed on corrupt existing state without rewriting it', () => {
    const file = path.join(root, 'enrollment-state.json'); fs.writeFileSync(file, '{broken', { mode: 0o600 });
    expect(() => service.issueFree(owner, chat)).toThrow(); expect(() => service.list()).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    fs.writeFileSync(file, JSON.stringify({ version: 1, grants: [], requests: [{ status: 'approved' }] }));
    expect(() => service.list()).toThrow('Invalid enrollment state');
  });
  it('rejects public roots/state files and symlink state', () => {
    fs.chmodSync(root, 0o755); expect(() => service.list()).toThrow('private'); fs.chmodSync(root, 0o700);
    service.issueFree(owner, chat); const file = path.join(root, 'enrollment-state.json'); fs.chmodSync(file, 0o644);
    expect(() => service.list()).toThrow('Unsafe');
    fs.chmodSync(file, 0o600); fs.renameSync(file, path.join(root, 'other.json')); fs.symlinkSync(path.join(root, 'other.json'), file);
    expect(() => service.list()).toThrow('Unsafe');
  });
  it('rereads state between same-process instances and returns defensive copies', () => {
    const other = new LabEnrollmentService({ rootDir: root, ownerId: owner, now: () => now });
    service.submitCrypto(chat, { text: 'tx 1' }); other.submitCrypto('201', { text: 'tx 2' });
    expect(service.list()).toHaveLength(2);
    const requests = service.list(); requests[0].status = 'approved'; expect(service.list()[0].status).toBe('pending_review');
    expect(fs.statSync(path.join(root, 'enrollment-state.json')).mode & 0o777).toBe(0o600);
    expect(() => service.submitCrypto('-200', { text: 'group' })).toThrow('Private');
  });
});

describe('pre-approved usernames', () => {
  it('issues, revokes and expires username grants, admin-only, one active per name', () => {
    expect(() => service.issueUsername(chat, 'alice')).toThrow('administrator');
    expect(() => service.issueUsername(chat, 'bad name!')).toThrow('Invalid Telegram username');
    expect(() => service.issueUsername(chat, '@Al')).toThrow('Invalid Telegram username');
    expect(() => service.issueUsername(chat, '0alice')).toThrow('Invalid Telegram username');
    const grant = service.issueUsername(owner, '@Alice'); // owner may issue; normalized
    expect(grant.username).toBe('alice');
    expect(service.hasUsernamePreapproval('user_alice')).toBe(true);
    expect(() => service.issueUsername(owner, 'alice')).toThrow('already pre-approved');
    expect(service.revokeUsername(owner, grant.id).revokedAt).toBe(now);
    expect(() => service.claimUsername('200', 'alice')).toThrow('unavailable');
    const fresh = service.issueUsername(owner, 'alice');
    now += 4000;
    service.issueUsername(owner, 'carol', 3000);
    now += 3200;
    expect(service.claimUsername('200', 'alice').usernamePreapprovalId).toBe(fresh.id);
    expect(() => service.claimUsername('201', 'carol')).toThrow('unavailable'); // expired for claim
    expect(service.listUsernames().some(u => u.username === 'carol')).toBe(true);
    // an expired grant does not block issuing the same name again
    expect(service.issueUsername(owner, 'carol').username).toBe('carol');
    expect(service.claimUsername('201', 'carol').usernamePreapprovalId).toBeTypeOf('string');
  });
  it('claims link-possession, enforces visible mismatches, single use, and the full free questionnaire', () => {
    service.issueUsername(owner, 'alice');
    // a visible sender username that differs from the pre-approved name is refused
    expect(() => service.claimUsername('200', 'alice', { actualUsername: 'bob' })).toThrow('another account');
    // hidden sender username accepted with an audit note
    const r = service.claimUsername('200', 'alice');
    expect(r.usernamePreapprovalId).toBeTypeOf('string');
    expect(r.audit.at(-1)?.note).toContain('hidden');
    expect(() => service.claimUsername('200', 'alice')).toThrow('unavailable'); // one use
    // the standard questionnaire completes to approved free participation
    service.saveAnswer('200', 'Собрать трекер привычек', 'text');
    service.saveAnswer('200', 'пропустить', 'text');
    service.saveAnswer('200', 'пропустить', 'text');
    service.saveAnswer('200', 'student@example.com', 'text');
    const done = service.requestForChat('200')!;
    expect(done.status).toBe('approved');
    expect(done.email).toBe('student@example.com');
    expect(done.method).toBe('free');
    // persisted state round-trips through the validator
    const other = new LabEnrollmentService({ rootDir: root, ownerId: owner, now: () => now });
    expect(other.listUsernames()).toEqual(service.listUsernames());
    expect(other.requestForChat('200')?.usernamePreapprovalId).toBe(r.usernamePreapprovalId);
  });
});
