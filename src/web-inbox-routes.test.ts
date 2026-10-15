import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWebApp } from './web.js';
import { runtimeLogTail } from './web-inbox-routes.js';

describe('authenticated lab inbox', () => {
  let dir: string;
  let app: ReturnType<typeof createWebApp>;
  let reply: ReturnType<typeof vi.fn>;
  const headers = { Authorization: 'Bearer inbox-test-token', 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf' };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-routes-'));
    reply = vi.fn(async () => ({ status: 'sent' }));
    app = createWebApp({ dataDir: dir, webToken: 'inbox-test-token', csrfToken: 'test-csrf', inbox: {
      conversations: () => [{ chatId: '123', name: 'Test', key: 'test' }],
      thread: (id: string) => { if (id !== '123') throw new Error('Unknown'); return { messages: [], profile: '<script>test</script>' }; },
      reply,
    } } as any);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  it('challenges inbox, assets, messages and logs without admin authentication', async () => {
    expect((await app.request('/inbox')).status).toBe(302);
    expect((await app.request('/inbox/assets/pico.css')).status).toBe(302);
    expect((await app.request('/api/inbox/conversations')).status).toBe(401);
    expect((await app.request('/api/inbox/logs')).status).toBe(401);
    expect(reply).not.toHaveBeenCalled();
  });
  it('returns private history with no-store and handles unknown participant', async () => {
    const list = await app.request('/api/inbox/conversations', { headers });
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect((await list.json() as any).conversations[0].chatId).toBe('123');
    expect((await app.request('/api/inbox/conversations/999', { headers })).status).toBe(404);
  });
  it('requires CSRF and rejects foreign origins before sending', async () => {
    const body = JSON.stringify({ text: 'Hello', requestId: 'test-request-123456' });
    expect((await app.request('/api/inbox/conversations/123/reply', { method: 'POST', headers: { ...headers, 'x-csrf-token': '' }, body })).status).toBe(403);
    expect((await app.request('/api/inbox/conversations/123/reply', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body })).status).toBe(403);
    expect(reply).not.toHaveBeenCalled();
    expect((await app.request('/api/inbox/conversations/123/reply', { method: 'POST', headers, body })).status).toBe(200);
    expect(reply).toHaveBeenCalledWith('123', 'Hello', 'test-request-123456');
  });
  it('bounds input and reports uncertain send without retrying', async () => {
    expect((await app.request('/api/inbox/conversations/123/reply', { method: 'POST', headers, body: 'x'.repeat(24001) })).status).toBe(413);
    reply.mockRejectedValueOnce(new Error('timeout'));
    const res = await app.request('/api/inbox/conversations/123/reply', { method: 'POST', headers, body: JSON.stringify({ text: 'Hello', requestId: 'test-request-123456' }) });
    expect(res.status).toBe(409);
    expect(reply).toHaveBeenCalledTimes(1);
  });
  it('reads a bounded, credential-redacted fixed runtime log', () => {
    fs.writeFileSync(path.join(dir, 'daemon.log'), 'ok\n'.repeat(30000) + 'token=abcdef1234567890\n');
    const log = runtimeLogTail(dir);
    expect(log.truncated).toBe(true);
    expect(log.text.length).toBeLessThan(65537);
    expect(log.text).toContain('[REDACTED]');
    expect(log.text).not.toContain('abcdef1234567890');
  });
});
