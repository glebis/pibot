import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Script } from 'node:vm';
import { registerCoordinatorRoutes, type CoordinatorControl } from './web-coordinator-routes.js';

const csrf = 'test-token';
const origin = 'http://localhost:3000';
function setup(control?: CoordinatorControl) {
  const app = new Hono();
  registerCoordinatorRoutes(app, { coordinator: control }, csrf, [origin]);
  return app;
}
function valid() { return { sourceContractId: 'contract-1', question: 'Proceed?', choices: ['Yes', 'Wait'], deadline: Date.now() + 60_000 }; }
function post(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/api/coordinator/decisions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, origin, ...headers }, body: JSON.stringify(body) });
}

describe('coordinator dashboard', () => {
  it('reports disabled mode and never caches private content', async () => {
    const app = setup();
    const status = await app.request('/api/coordinator');
    expect(status.status).toBe(503);
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect((await post(app, valid())).status).toBe(503);
    const page = await app.request('/coordinator');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('Contract ownership and its current contents are not verified');
  });
  it('requires exact CSRF and rejects an unapproved origin before creating', async () => {
    const create = vi.fn(); const app = setup({ inspect: () => ({}), create });
    expect((await post(app, valid(), { 'x-csrf-token': 'wrong' })).status).toBe(403);
    expect((await post(app, valid(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(app, valid(), { origin: 'null' })).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
  it('passes only bounded decision fields and cannot take mandate authority from JSON', async () => {
    const create = vi.fn(() => ({ id: 'd1' })); const app = setup({ inspect: () => ({}), create });
    const body = valid();
    expect((await post(app, { ...body, ownerId: 'someone', mandateId: 'other' })).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect((await post(app, body)).status).toBe(201);
    expect(create).toHaveBeenCalledExactlyOnceWith(body);
  });
  it.each([
    { sourceContractId: ' ' }, { sourceContractId: 'x'.repeat(201) }, { question: '' }, { question: 'x'.repeat(2501) },
    { choices: [] }, { choices: ['A', ' A '] }, { choices: ['x'.repeat(51)] }, { choices: [1] },
    { choices: ['1', '2', '3', '4', '5', '6'] }, { deadline: 0 }, { deadline: null }, { deadline: 'tomorrow' },
  ])('rejects invalid fields: %j', async change => {
    const create = vi.fn(); const app = setup({ inspect: () => ({}), create });
    expect((await post(app, { ...valid(), ...change })).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('bounds actual streamed bytes independently of content length', async () => {
    const create = vi.fn(); const app = setup({ inspect: () => ({}), create });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(7000)); controller.enqueue(new Uint8Array(7000)); controller.close(); } });
    const request = new Request('http://localhost/api/coordinator/decisions', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2', 'x-csrf-token': csrf }, body, duplex: 'half' } as RequestInit);
    expect((await app.request(request)).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects invalid JSON and wrong content type', async () => {
    const app = setup({ inspect: () => ({}), create: vi.fn() });
    expect((await post(app, valid(), { 'content-type': 'text/plain' })).status).toBe(415);
    const result = await app.request('/api/coordinator/decisions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{' });
    expect(result.status).toBe(400);
  });
  it('does not expose internal errors or embed unsafe inspection data into HTML', async () => {
    const app = setup({ inspect: () => { throw new Error('secret'); }, create: () => { throw new Error('secret'); } });
    expect(await (await app.request('/api/coordinator')).text()).not.toContain('secret');
    const result = await post(app, valid()); expect(result.status).toBe(409); expect(await result.text()).not.toContain('secret');
    const page = await (await app.request('/coordinator')).text();
    expect(page).toContain('state.textContent=');
    expect(page).not.toContain('innerHTML');
    expect(page).toContain('Delivery uncertain — review before any retry');
    expect(page).toContain('availability(false)');
    expect(page).toContain("document.createElement('article')");
    expect(() => new Script(page.match(/<script>([\s\S]*?)<\/script>/)![1])).not.toThrow();
  });
  it('escapes script-breaking characters in the CSRF value', async () => {
    const app = new Hono(); registerCoordinatorRoutes(app, {}, '</script><img src=x>', [origin]);
    const page = await (await app.request('/coordinator')).text();
    expect(page).not.toContain('</script><img');
  });
});
