import { describe, expect, it, vi } from 'vitest';
import { createWebApp, type WebDeps } from './web.js';

function setup(webToken = 'dashboard-test-token', omitRp = false) {
  const inspect = vi.fn(() => ({ decisions: [], attempts: [], paused: false }));
  const create = vi.fn(() => ({ id: 'decision-1' }));
  const enableTelegram = vi.fn();
  const disableTelegram = vi.fn();
  const save = vi.fn();
  const app = createWebApp({
    dataDir: '/unused-coordinator-test', webToken, csrfToken: 'csrf-test', webRpId: omitRp ? undefined : 'localhost', webPort: 7860,
    webAuthStore: { parseCookie: () => undefined, verifySignedToken: () => undefined, hasCredentials: () => false, credentials: [] },
    agents: {}, scheduler: {}, events: {}, evolution: {},
    coordinator: { inspect, create }, telegram: { enableTelegram, disableTelegram },
    secrets: { get: () => ({}), save },
  } as unknown as WebDeps);
  return { app, inspect, create, enableTelegram, disableTelegram, save };
}
const decision = () => ({ sourceContractId: 'contract-1', question: 'Proceed?', choices: ['Yes', 'Later'], deadline: Date.now() + 60_000 });

describe('coordinator dashboard integration', () => {
  it('denies coordinator access with neither token, explicit RP, nor credentials configured', async () => {
    // authRequired() is always true today; the coordinator's 503 guard is defensive.
    const { app, inspect, create } = setup('', true);
    expect((await app.request('/api/coordinator')).status).toBe(401);
    expect((await app.request('/coordinator')).status).toBe(302);
    const response = await app.request('/api/coordinator/decisions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-test' }, body: JSON.stringify(decision()) });
    expect(response.status).toBe(401);
    expect(inspect).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it.each(['', 'dashboard-test-token'])('requires authentication with configured token %j', async token => {
    const { app, inspect, create } = setup(token);
    expect((await app.request('/api/coordinator')).status).toBe(401);
    const page = await app.request('/coordinator');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toMatch(/^\/auth\?/);
    const response = await app.request('/api/coordinator/decisions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-test' }, body: JSON.stringify(decision()) });
    expect(response.status).toBe(401);
    expect(inspect).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it('denies an invalid bearer and allows the exact configured bearer', async () => {
    const { app, inspect, create } = setup();
    expect((await app.request('/api/coordinator', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(inspect).not.toHaveBeenCalled();
    expect((await app.request('/api/coordinator', { headers: { authorization: 'Bearer dashboard-test-token' } })).status).toBe(200);
    expect(inspect).toHaveBeenCalledOnce();
    expect((await app.request('/coordinator', { headers: { authorization: 'Bearer dashboard-test-token' } })).status).toBe(200);
    const response = await app.request('/api/coordinator/decisions', { method: 'POST', headers: { authorization: 'Bearer dashboard-test-token', 'content-type': 'application/json', 'x-csrf-token': 'csrf-test', origin: 'http://localhost:7860' }, body: JSON.stringify(decision()) });
    expect(response.status).toBe(201); expect(create).toHaveBeenCalledOnce();
  });
  it.each(['/telegram', '/telegram/disable'])('blocks account mutation at %s while the coordinator is configured', async route => {
    const { app, enableTelegram, disableTelegram, save } = setup();
    const form = new FormData(); form.set('_csrf', 'csrf-test'); form.set('token', '123:replacement'); form.set('allowedChats', '123');
    const response = await app.request(route, { method: 'POST', headers: { authorization: 'Bearer dashboard-test-token' }, body: form });
    expect(response.status).toBe(409);
    expect(enableTelegram).not.toHaveBeenCalled(); expect(disableTelegram).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
});
