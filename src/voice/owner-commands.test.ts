import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VoiceOwnerCommands, httpPhoneControl, type PhoneControl } from './owner-commands.js';

const CK = 'telegram:100000001';
const binding = { agentId: 'assistant', chatKey: CK };
const okReceipt = (a: { attemptId: string }) => ({ attemptId: a.attemptId, state: 'dispatching' });

function phone(dispatch?: PhoneControl['dispatch'], bindings = [binding]): PhoneControl {
  return { bindings: () => bindings, ...(dispatch ? { dispatch } : {}) };
}
const tmpUrlFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-owner-')), 'test-launch.url');

describe('VoiceOwnerCommands /call', () => {
  it('reports why a call is unavailable', () => {
    expect(new VoiceOwnerCommands({ testUrlFile: tmpUrlFile() }).callAvailability('assistant', CK)).toBe('not_configured');
    const v = new VoiceOwnerCommands({ phone: phone(vi.fn()), testUrlFile: tmpUrlFile() });
    expect(v.callAvailability('assistant', CK)).toBe('ok');
    expect(v.callAvailability('tax', CK)).toBe('not_bound');
    expect(v.callAvailability('assistant', 'telegram:-100123')).toBe('not_bound'); // groups never
  });

  it('places exactly one call per confirmation, for the chat that asked', async () => {
    const dispatch = vi.fn(async (a: { attemptId: string }) => okReceipt(a));
    const v = new VoiceOwnerCommands({ phone: phone(dispatch), testUrlFile: tmpUrlFile() });
    const id = v.armCall('assistant', CK);
    expect(await v.confirmCall(id, 'telegram:999')).toEqual({ ok: false, reason: 'expired' }); // other chat
    const id2 = v.armCall('assistant', CK);
    const r = await v.confirmCall(id2, CK);
    expect(r).toMatchObject({ ok: true, state: 'dispatching' });
    expect(await v.confirmCall(id2, CK)).toEqual({ ok: false, reason: 'expired' }); // single use
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ agentId: 'assistant', chatKey: CK, maxDurationSeconds: 180 });
    expect(dispatch.mock.calls[0][0].attemptId).toMatch(/^manual-[0-9a-f]{32}$/);
  });

  it('expires unconfirmed requests after two minutes and supports cancel', async () => {
    let now = 1_000_000;
    const dispatch = vi.fn(async (a: { attemptId: string }) => okReceipt(a));
    const v = new VoiceOwnerCommands({ phone: phone(dispatch), testUrlFile: tmpUrlFile(), clock: () => now });
    const id = v.armCall('assistant', CK);
    now += 120_001;
    expect(await v.confirmCall(id, CK)).toEqual({ ok: false, reason: 'expired' });
    const id2 = v.armCall('assistant', CK);
    expect(v.cancel(id2, 'telegram:999')).toBe(false);
    expect(v.cancel(id2, CK)).toBe(true);
    expect(await v.confirmCall(id2, CK)).toEqual({ ok: false, reason: 'expired' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('re-checks the binding at confirm time', async () => {
    const bindings = [binding];
    const dispatch = vi.fn(async (a: { attemptId: string }) => okReceipt(a));
    const v = new VoiceOwnerCommands({ phone: phone(dispatch, bindings), testUrlFile: tmpUrlFile() });
    const id = v.armCall('assistant', CK);
    bindings.length = 0; // chat rebound to another agent meanwhile
    expect(await v.confirmCall(id, CK)).toEqual({ ok: false, reason: 'not_bound' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('distinguishes a down service from an unknown outcome', async () => {
    const refused = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    const down = new VoiceOwnerCommands({ phone: phone(async () => { throw refused; }), testUrlFile: tmpUrlFile() });
    expect(await down.confirmCall(down.armCall('assistant', CK), CK)).toMatchObject({ ok: false, reason: 'service_down' });
    const timeout = new VoiceOwnerCommands({ phone: phone(async () => { throw new Error('timeout'); }), testUrlFile: tmpUrlFile() });
    expect(await timeout.confirmCall(timeout.armCall('assistant', CK), CK)).toMatchObject({ ok: false, reason: 'unknown_outcome' });
    const forged = new VoiceOwnerCommands({ phone: phone(async () => ({ attemptId: 'manual-other', state: 'accepted' })), testUrlFile: tmpUrlFile() });
    expect(await forged.confirmCall(forged.armCall('assistant', CK), CK)).toMatchObject({ ok: false, reason: 'unknown_outcome' });
  });
});

describe('VoiceOwnerCommands /voice', () => {
  const URL = `http://127.0.0.1:8788/#token=${'a'.repeat(64)}`;

  it('returns the private URL preselected with the agent', () => {
    const file = tmpUrlFile();
    fs.writeFileSync(file, URL + '\n', { mode: 0o600 });
    expect(new VoiceOwnerCommands({ testUrlFile: file }).pageLinks('assistant')).toEqual({ local: `${URL}&agent=assistant` });
  });

  it('adds the tailnet link only when it carries the same key', () => {
    const TS = `https://box.tail1.ts.net:8444/#token=${'a'.repeat(64)}`;
    const file = tmpUrlFile();
    fs.writeFileSync(file, `${URL}\n${TS}\n`, { mode: 0o600 });
    expect(new VoiceOwnerCommands({ testUrlFile: file }).pageLinks('coach')).toEqual({ local: `${URL}&agent=coach`, tailnet: `${TS}&agent=coach` });
    const foreign = tmpUrlFile();
    fs.writeFileSync(foreign, `${URL}\nhttps://evil.example/#token=${'a'.repeat(64)}\n`, { mode: 0o600 });
    expect(new VoiceOwnerCommands({ testUrlFile: foreign }).pageLinks('coach')?.tailnet).toBeUndefined();
    const stale = tmpUrlFile();
    fs.writeFileSync(stale, `${URL}\nhttps://box.tail1.ts.net:8444/#token=${'b'.repeat(64)}\n`, { mode: 0o600 });
    expect(new VoiceOwnerCommands({ testUrlFile: stale }).pageLinks('coach')?.tailnet).toBeUndefined();
  });

  it('returns nothing when the page is not running or the pointer is unsafe', () => {
    expect(new VoiceOwnerCommands({ testUrlFile: tmpUrlFile() }).pageLinks('assistant')).toBeUndefined();
    const loose = tmpUrlFile();
    fs.writeFileSync(loose, URL, { mode: 0o644 });
    fs.chmodSync(loose, 0o644);
    expect(new VoiceOwnerCommands({ testUrlFile: loose }).pageLinks('assistant')).toBeUndefined();
    const remote = tmpUrlFile();
    fs.writeFileSync(remote, `http://evil.example:8788/#token=${'a'.repeat(64)}`, { mode: 0o600 });
    expect(new VoiceOwnerCommands({ testUrlFile: remote }).pageLinks('assistant')).toBeUndefined();
    const ok = tmpUrlFile();
    fs.writeFileSync(ok, URL, { mode: 0o600 });
    expect(new VoiceOwnerCommands({ testUrlFile: ok }).pageLinks('../x')).toBeUndefined();
  });
});

describe('httpPhoneControl', () => {
  it('only talks to a loopback control endpoint with a valid token', () => {
    const b = () => [];
    expect(() => httpPhoneControl({ controlUrl: 'http://example.com:8793', token: 'a'.repeat(64), bindings: b })).toThrow(/loopback/);
    expect(() => httpPhoneControl({ controlUrl: 'https://127.0.0.1:8793', token: 'a'.repeat(64), bindings: b })).toThrow(/loopback/);
    expect(() => httpPhoneControl({ controlUrl: 'http://127.0.0.1:8793', token: 'short', bindings: b })).toThrow(/credential/);
    expect(httpPhoneControl({ controlUrl: 'http://127.0.0.1:8793', token: 'a'.repeat(64), bindings: b }).dispatch).toBeTypeOf('function');
  });
});
