import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountLabPaymentRoutes } from './web-payments.js';

const key = `rk_live_${'a'.repeat(64)}`;
function setup() {
  const saveKey = vi.fn(async (_key: string) => {});
  const request = vi.fn<typeof fetch>();
  const app = new Hono();
  mountLabPaymentRoutes(app, { getKey: () => key, saveKey, root: () => undefined, fetch: request }, 'csrf');
  const post = (stripeKey = key, origin = 'http://localhost', token = 'csrf') => app.request('/lab-payments', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ stripeKey, _csrf: token }).toString(),
  });
  return { app, post, saveKey, request };
}

describe('lab payment settings', () => {
  it('renders status and an empty password field without revealing stored keys', async () => {
    const { app } = setup();
    const response = await app.request('/lab-payments');
    const html = await response.text();
    expect(html).toContain('Stripe key: configured');
    expect(html).toContain('type="password" autocomplete="off"');
    expect(html).not.toContain(key);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
  });
  it.each(['sk_live_bad', `rk_test_${'a'.repeat(64)}`, 'rk_live_short', `${key}<script>`])('rejects invalid or test keys without saving: %s', async invalid => {
    const { post, request, saveKey } = setup();
    expect((await post(invalid)).status).toBe(400);
    expect(request).not.toHaveBeenCalled();
    expect(saveKey).not.toHaveBeenCalled();
  });
  it('requires the CSRF token and rejects foreign origins before accessing Stripe', async () => {
    const { post, request, saveKey } = setup();
    expect((await post(key, 'https://evil.example')).status).toBe(403);
    expect((await post(key, 'http://localhost', 'wrong')).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
    expect(saveKey).not.toHaveBeenCalled();
  });
  it('rejects opaque origins and refreshes stale forms without reflecting credentials', async () => {
    const { post, request, saveKey } = setup();
    expect((await post(key, 'null')).status).toBe(403);
    const response = await post(key, 'http://localhost', 'old-token');
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain('This form expired');
    expect(html).toContain('name="_csrf" value="csrf"');
    expect(html).not.toContain(key);
    expect(request).not.toHaveBeenCalled();
    expect(saveKey).not.toHaveBeenCalled();
  });
  it('verifies the configured live account and session read access before saving', async () => {
    const { post, request, saveKey } = setup();
    request.mockResolvedValueOnce(Response.json({ id: 'acct_1MRIFEJubV3fWiDW' }));
    request.mockResolvedValueOnce(Response.json({ data: [] }));
    request.mockResolvedValueOnce(Response.json({ id: 'prod_VNGGSBfAWRcqrf', metadata: { cohort_site: 'goal-driven-ai-01' } }));
    const response = await post();
    expect(response.status).toBe(200);
    expect(request).toHaveBeenNthCalledWith(2, 'https://api.stripe.com/v1/checkout/sessions?limit=1', expect.objectContaining({ headers: { Authorization: `Bearer ${key}` } }));
    expect(request).toHaveBeenNthCalledWith(3, 'https://api.stripe.com/v1/products/prod_VNGGSBfAWRcqrf', expect.objectContaining({ headers: { Authorization: `Bearer ${key}` } }));
    expect(saveKey).toHaveBeenCalledExactlyOnceWith(key);
    expect(await response.text()).not.toContain(key);
  });
  it('rejects a key for another account', async () => {
    const { post, request, saveKey } = setup();
    request.mockResolvedValueOnce(Response.json({ id: 'acct_other' }));
    expect((await post()).status).toBe(400);
    expect(request).toHaveBeenCalledTimes(1);
    expect(saveKey).not.toHaveBeenCalled();
  });
  it('rejects missing read permission and never reflects Stripe errors or keys', async () => {
    const { post, request, saveKey } = setup();
    request.mockResolvedValueOnce(Response.json({ id: 'acct_1MRIFEJubV3fWiDW' }));
    request.mockResolvedValueOnce(Response.json({ error: key }, { status: 403 }));
    const response = await post();
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(key);
    expect(saveKey).not.toHaveBeenCalled();
  });
  it('reports verification failure without exposing a thrown secret', async () => {
    const { post, request, saveKey } = setup();
    request.mockRejectedValueOnce(new Error(key));
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(key);
    expect(saveKey).not.toHaveBeenCalled();
  });
  it('requires Products read permission before saving', async () => {
    const { post, request, saveKey } = setup();
    request.mockResolvedValueOnce(Response.json({ id: 'acct_1MRIFEJubV3fWiDW' }));
    request.mockResolvedValueOnce(Response.json({ data: [] }));
    request.mockResolvedValueOnce(Response.json({ error: key }, { status: 403 }));
    const response = await post();
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(key);
    expect(saveKey).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'prod_other', metadata: { cohort_site: 'goal-driven-ai-01' } },
    { id: 'prod_VNGGSBfAWRcqrf', metadata: { cohort_site: 'wrong-cohort' } },
    { id: 'prod_VNGGSBfAWRcqrf' },
    { id: 'prod_VNGGSBfAWRcqrf', deleted: true, metadata: { cohort_site: 'goal-driven-ai-01' } },
  ])('rejects a mismatched course product: %j', async product => {
    const { post, request, saveKey } = setup();
    request.mockResolvedValueOnce(Response.json({ id: 'acct_1MRIFEJubV3fWiDW' }));
    request.mockResolvedValueOnce(Response.json({ data: [] }));
    request.mockResolvedValueOnce(Response.json(product));
    expect((await post()).status).toBe(400);
    expect(saveKey).not.toHaveBeenCalled();
  });
});
