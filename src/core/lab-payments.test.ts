import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LabPayments } from './lab-payments.js';
import type { Transport } from './types.js';

describe('local Stripe payment reconciliation', () => {
  let root: string; let payments: LabPayments; let transport: Transport; let api: ReturnType<typeof vi.fn>;
  let sessions: any[]; let items: any; let config: any;
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'payments-state.json'), 'utf8'));
  const reference = (chat = '42') => Object.entries(state().references).find(([, r]: [string, any]) => r.chatId === chat)![0];
  const paid = (extra = {}) => ({ id: 'cs_test_session1', client_reference_id: reference(), created: Math.floor(Date.now() / 1000), payment_link: 'plink_standard', livemode: true, mode: 'payment', status: 'complete', payment_status: 'paid', ...extra });
  const invites = () => vi.mocked(transport.push).mock.calls.filter(([, opts]) => opts.text.includes('[Войти в группу курса]'));
  const reset = () => new LabPayments(root, { apiKey: 'sk_private_test', fetch: api as typeof fetch });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-payments-'))); fs.chmodSync(root, 0o700);
    config = { enabled: true, groupInviteUrl: 'https://t.me/+testInvite', links: [{ tier: 'standard', label: 'Стандартный', url: 'https://buy.stripe.com/testStandard', paymentLinkId: 'plink_standard', productId: 'prod_standard' }], offers: { KRAFT: { code: 'KRAFT' } } };
    write('payments.json', config); sessions = [];
    items = { data: [{ quantity: 1, price: { product: { id: 'prod_standard', metadata: { cohort_site: 'goal-driven-ai-01' } } } }], has_more: false };
    api = vi.fn(async (input: string, init: RequestInit) => {
      expect(init.method).toBe('GET'); expect(init.redirect).toBe('error'); expect((init.headers as any).Authorization).toBe('Bearer sk_private_test');
      const url = new URL(input); expect(url.origin).toBe('https://api.stripe.com');
      if (url.pathname.endsWith('/line_items')) { expect(url.searchParams.get('expand[]')).toBe('data.price.product'); return new Response(JSON.stringify(items)); }
      expect(url.searchParams.get('payment_link')).toBe('plink_standard');
      expect(Number(url.searchParams.get('created[gte]'))).toBeGreaterThan(0);
      return new Response(JSON.stringify({ data: sessions, has_more: false }));
    });
    transport = { name: 'telegram:lab', boundAgentId: 'lab', push: vi.fn().mockResolvedValue(undefined) } as unknown as Transport;
    payments = reset();
  });
  it('creates opaque chat-bound references and applies only an explicitly selected configured offer', async () => {
    await payments.menu(transport, '42');
    let url = new URL(vi.mocked(transport.push).mock.calls.at(-1)![1].card!.buttons[0].url!);
    expect(url.searchParams.get('prefilled_promo_code')).toBeNull();
    expect(url.searchParams.get('client_reference_id')).toMatch(/^[a-f0-9]{48}$/);
    expect(state().references[url.searchParams.get('client_reference_id')!]).toMatchObject({ chatId: '42', paymentLinkId: 'plink_standard', productId: 'prod_standard' });
    await payments.menu(transport, '43', 'KRAFT');
    url = new URL(vi.mocked(transport.push).mock.calls.at(-1)![1].card!.buttons[0].url!); expect(url.searchParams.get('prefilled_promo_code')).toBe('KRAFT');
    await reset().menu(transport, '43');
    expect(new URL(vi.mocked(transport.push).mock.calls.at(-1)![1].card!.buttons[0].url!).searchParams.get('prefilled_promo_code')).toBe('KRAFT');
    await payments.menu(transport, '44'); expect(new URL(vi.mocked(transport.push).mock.calls.at(-1)![1].card!.buttons[0].url!).searchParams.has('prefilled_promo_code')).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(fs.statSync(path.join(root, 'payments-state.json')).mode & 0o777).toBe(0o600);
  });
  it('does not accept arbitrary codes or missing configured offers', async () => {
    await payments.menu(transport, '42', 'OTHER'); expect(fs.existsSync(path.join(root, 'payments-state.json'))).toBe(false);
    delete config.offers; write('payments.json', config); await payments.menu(transport, '42', 'KRAFT'); expect(fs.existsSync(path.join(root, 'payments-state.json'))).toBe(false);
  });
  it('verifies a paid session after restart, sends once, and remembers success across restart', async () => {
    await payments.menu(transport, '42'); sessions = [paid(), paid()];
    await reset().tick(transport); expect(invites()).toHaveLength(1);
    expect(invites()[0][1].text).toContain('https://t.me/+testInvite'); expect(invites()[0][1].text).toContain('почту');
    expect(state().deliveries.cs_test_session1.status).toBe('sent');
    api.mockClear(); await reset().tick(transport); await reset().check(transport, '42');
    expect(invites()).toHaveLength(1); expect(api).not.toHaveBeenCalled();
    expect(vi.mocked(transport.push).mock.calls.at(-1)![1].text).toContain('уже отправлено');
  });
  it.each([
    { payment_status: 'unpaid' }, { status: 'open' }, { mode: 'subscription' }, { livemode: false },
    { payment_link: 'plink_other' }, { client_reference_id: 'not-saved' }, { created: 1 },
  ])('does not grant access for invalid session fields %j', async extra => {
    await payments.menu(transport, '42'); sessions = [paid(extra)]; await payments.check(transport, '42');
    expect(invites()).toHaveLength(0); expect(state().deliveries).toEqual({});
  });
  it.each([
    { id: 'prod_other', metadata: { cohort_site: 'goal-driven-ai-01' } },
    { id: 'prod_standard', metadata: { cohort_site: 'another-cohort' } },
    { id: 'prod_standard', metadata: { cohort: 'goal-driven-ai-01' } },
    'prod_standard',
  ])('requires the expanded exact product and cohort_site metadata %j', async product => {
    await payments.menu(transport, '42'); sessions = [paid()]; items.data[0].price.product = product;
    await payments.check(transport, '42'); expect(invites()).toHaveLength(0); expect(state().deliveries).toEqual({});
  });
  it('never binds another chat by email or Telegram identity', async () => {
    await payments.menu(transport, '42'); await payments.menu(transport, '43');
    sessions = [paid({ customer_details: { email: 'other@example.com' }, metadata: { telegram_user_id: '43' } })];
    await payments.check(transport, '43'); expect(invites()).toHaveLength(0);
    await payments.check(transport, '42'); expect(invites()[0][0]).toBe('42');
  });
  it('persists sending before a rejected/ambiguous push and blocks manual and automatic replay', async () => {
    await payments.menu(transport, '42'); sessions = [paid()];
    vi.mocked(transport.push).mockImplementation(async (_chat, opts) => {
      if (opts.text.includes('[Войти в группу курса]')) { expect(state().deliveries.cs_test_session1.status).toBe('sending'); throw new Error('ambiguous transport error'); }
    });
    await payments.check(transport, '42'); expect(invites()).toHaveLength(1); expect(state().deliveries.cs_test_session1.status).toBe('sending');
    await reset().tick(transport); await reset().check(transport, '42'); expect(invites()).toHaveLength(1);
  });
  it('blocks pending delivery after a crash before starting the send', async () => {
    await payments.menu(transport, '42'); const s = state(); s.deliveries.cs_test_session1 = { reference: reference(), status: 'pending' }; write('payments-state.json', s); sessions = [paid()];
    await reset().tick(transport); await reset().check(transport, '42'); expect(invites()).toHaveLength(0); expect(api).not.toHaveBeenCalled();
  });
  it('retains references and reports unavailable for API failures without leaking error bodies', async () => {
    await payments.menu(transport, '42'); const before = state(); api.mockResolvedValue(new Response('secret-private-response', { status: 401 }));
    await payments.check(transport, '42'); expect(state()).toEqual(before); expect(invites()).toHaveLength(0);
    expect(vi.mocked(transport.push).mock.calls.at(-1)![1].text).toContain('недоступна'); expect(JSON.stringify(vi.mocked(transport.push).mock.calls)).not.toContain('secret-private-response');
  });
  it('does not send until bounded session pagination finishes', async () => {
    await payments.menu(transport, '42'); const before = state();
    api.mockImplementation(async () => new Response(JSON.stringify({ data: [paid()], has_more: true })));
    await payments.check(transport, '42'); expect(invites()).toHaveLength(0); expect(state()).toEqual(before); expect(vi.mocked(transport.push).mock.calls.at(-1)![1].text).toContain('недоступна');
  });
  it('finds sessions on a later page using a Stripe cursor', async () => {
    await payments.menu(transport, '42'); const normal = api.getMockImplementation() as (input: string, init: RequestInit) => Promise<Response>;
    api.mockImplementation(async (input, init) => {
      const url = new URL(input as string);
      if (url.pathname.endsWith('/line_items')) return normal(input, init);
      if (!url.searchParams.has('starting_after')) return new Response(JSON.stringify({ data: [paid({ id: 'cs_cursor', client_reference_id: 'other' })], has_more: true }));
      expect(url.searchParams.get('starting_after')).toBe('cs_cursor'); return new Response(JSON.stringify({ data: [paid()], has_more: false }));
    });
    await payments.check(transport, '42'); expect(invites()).toHaveLength(1);
  });
  it('does not send on incomplete line items', async () => {
    await payments.menu(transport, '42'); sessions = [paid()]; items.has_more = true;
    await payments.check(transport, '42'); expect(invites()).toHaveLength(0); expect(state().deliveries).toEqual({}); expect(vi.mocked(transport.push).mock.calls.at(-1)![1].text).toContain('недоступна');
  });
  it('ticks silently without network when there are no references', async () => { await payments.tick(transport); expect(api).not.toHaveBeenCalled(); expect(transport.push).not.toHaveBeenCalled(); });
  it('offers a truthful menu without an API key', async () => {
    await new LabPayments(root, { fetch: api as typeof fetch }).menu(transport, '42');
    expect(vi.mocked(transport.push).mock.calls.at(-1)![1].text).toContain('недоступна'); expect(vi.mocked(transport.push).mock.calls.at(-1)![1].card!.buttons[0].url).toContain('client_reference_id=');
  });
  it('fails closed on corrupted state and never overwrites it', async () => {
    fs.writeFileSync(path.join(root, 'payments-state.json'), '{broken', { mode: 0o600 });
    await payments.menu(transport, '42'); await payments.check(transport, '42'); await payments.tick(transport);
    expect(fs.readFileSync(path.join(root, 'payments-state.json'), 'utf8')).toBe('{broken'); expect(api).not.toHaveBeenCalled(); expect(invites()).toHaveLength(0);
  });
  it('rejects symlink state and symlink roots without reading or sending invitations', async () => {
    write('real-state.json', { private: true }); fs.symlinkSync(path.join(root, 'real-state.json'), path.join(root, 'payments-state.json'));
    await payments.menu(transport, '42'); expect(fs.readFileSync(path.join(root, 'real-state.json'), 'utf8')).toBe('{"private":true}');
    const alias = path.join(root, 'alias'); fs.symlinkSync(root, alias); await new LabPayments(alias, { apiKey: 'sk_private_test', fetch: api as typeof fetch }).check(transport, '42'); expect(api).not.toHaveBeenCalled();
  });
  it('rejects world-readable configuration and never follows an existing lock', async () => {
    fs.chmodSync(path.join(root, 'payments.json'), 0o644); expect(payments.isEnabled()).toBe(false); await payments.menu(transport, '42'); expect(fs.existsSync(path.join(root, 'payments-state.json'))).toBe(false);
    fs.chmodSync(path.join(root, 'payments.json'), 0o600); fs.symlinkSync(path.join(root, 'payments.json'), path.join(root, 'payments-state.lock')); await payments.menu(transport, '42'); expect(fs.existsSync(path.join(root, 'payments-state.json'))).toBe(false);
  });
  it('prevents overlapping instances from claiming one payment twice', async () => {
    await payments.menu(transport, '42'); sessions = [paid()];
    await Promise.all([payments.tick(transport), reset().tick(transport)]); expect(invites()).toHaveLength(1);
  });
  it('rejects non-private chats and unrelated transports', async () => {
    await payments.menu(transport, '-42'); await payments.check(transport, '-42'); await payments.tick({ ...transport, name: 'telegram:main' });
    expect(api).not.toHaveBeenCalled(); expect(transport.push).not.toHaveBeenCalled();
  });
  it('recovers a known dead PID lock without replaying an ambiguous receipt', async () => {
    await payments.menu(transport, '42');
    const s = state(); s.deliveries.cs_test_session1 = { reference: reference(), status: 'sending' }; write('payments-state.json', s);
    write('payments-state.lock', { version: 1, pid: 2147483647 });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('No process'), { code: 'ESRCH' }); });
    await reset().check(transport, '42'); expect(invites()).toHaveLength(0); expect(api).not.toHaveBeenCalled();
    expect(vi.mocked(transport.push).mock.calls.at(-1)![1].text).toContain('вручную');
    expect(fs.existsSync(path.join(root, 'payments-state.lock'))).toBe(false);
  });
  it('keeps live, malformed and recovery locks blocked for review', async () => {
    write('payments-state.lock', { version: 1, pid: process.pid });
    await payments.menu(transport, '42'); expect(fs.existsSync(path.join(root, 'payments-state.json'))).toBe(false);
    write('payments-state.lock', { version: 1, pid: 'not-known' });
    await payments.menu(transport, '42'); expect(fs.existsSync(path.join(root, 'payments-state.json'))).toBe(false);
    write('payments-recovery.lock', {});
    await payments.menu(transport, '42'); expect(fs.existsSync(path.join(root, 'payments-state.json'))).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });

});
