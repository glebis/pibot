import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Hono } from 'hono';
import { renderInbox } from './web-inbox.js';
import { redactSecrets } from './core/redact.js';

/** Facade resolves the live transport at send time; never holds bot credentials. */
export interface InboxControl {
  conversations(): unknown;
  thread(chatId: string, before?: string): unknown;
  reply(chatId: string, text: string, requestId: string): Promise<unknown>;
}

export function runtimeLogTail(dataDir: string): { text: string; truncated: boolean } {
  const file = path.join(dataDir, 'daemon.log');
  if (!fs.existsSync(file)) return { text: 'No runtime log file yet.', truncated: false };
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid log file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Invalid log file');
    const size = Math.min(stat.size, 64 * 1024);
    const bytes = Buffer.alloc(size);
    fs.readSync(fd, bytes, 0, size, Math.max(0, stat.size - size));
    let text = bytes.toString('utf8');
    if (stat.size > size) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n');
    return { text: redactSecrets(lines.slice(-200).join('\n')), truncated: stat.size > size || lines.length > 200 };
  } finally { fs.closeSync(fd); }
}

/** Mount only AFTER the dashboard authentication gate. */
export function registerInboxRoutes(app: Hono, deps: { inbox?: InboxControl; dataDir: string }, csrf: string, origins: string[]): void {
  app.use('/inbox/*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); await next(); });
  app.use('/api/inbox/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.get('/inbox', c => { c.header('Cache-Control', 'no-store'); return c.html(renderInbox(csrf)); });
  app.get('/inbox/assets/pico.css', c => {
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(fs.readFileSync(new URL('./vendor/pico.min.css', import.meta.url), 'utf8'));
  });
  app.get('/api/inbox/logs', c => {
    try { return c.json(runtimeLogTail(deps.dataDir)); }
    catch { return c.json({ error: 'Runtime log unavailable.' }, 503); }
  });
  app.get('/api/inbox/conversations', c => {
    if (!deps.inbox) return c.json({ error: 'Lab inbox is not configured.' }, 503);
    try { return c.json({ conversations: deps.inbox.conversations() }); }
    catch { return c.json({ error: 'Lab conversations unavailable.' }, 503); }
  });
  app.get('/api/inbox/conversations/:chatId', c => {
    if (!deps.inbox) return c.json({ error: 'Lab inbox is not configured.' }, 503);
    if (!/^[1-9]\d{0,19}$/.test(c.req.param('chatId'))) return c.json({ error: 'Invalid participant.' }, 400);
    try { return c.json(deps.inbox.thread(c.req.param('chatId'), c.req.query('before')) as object); }
    catch { return c.json({ error: 'Participant conversation unavailable.' }, 404); }
  });
  app.post('/api/inbox/conversations/:chatId/reply', async c => {
    const origin = c.req.header('origin');
    if (c.req.header('x-csrf-token') !== csrf || (origin && !origins.includes(origin))) return c.json({ error: 'CSRF failed.' }, 403);
    if (!deps.inbox) return c.json({ error: 'Lab inbox is not configured.' }, 503);
    if (!/^[1-9]\d{0,19}$/.test(c.req.param('chatId'))) return c.json({ error: 'Invalid participant.' }, 400);
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'Expected JSON.' }, 415);
    // Bound actual body too: content-length is optional and untrusted.
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.json({ error: 'Missing body.' }, 400);
    let size = 0; const chunks: Uint8Array[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 24000) { await reader.cancel(); return c.json({ error: 'Reply too large.' }, 413); } chunks.push(value); }
    let body: any;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return c.json({ error: 'Invalid JSON.' }, 400); }
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000 || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId)) return c.json({ error: 'Enter a reply of 1–4000 characters with a valid request ID.' }, 400);
    try { return c.json(await deps.inbox.reply(c.req.param('chatId'), body.text, body.requestId) as object); }
    catch { return c.json({ error: 'Reply could not be confirmed. Refresh this conversation before any retry; delivery may be ambiguous.' }, 409); }
  });
}
