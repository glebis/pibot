import type { Hono } from 'hono';

export interface LabPaymentDeps {
  getKey: () => string | undefined;
  saveKey: (key: string) => Promise<void>;
  root: () => string | undefined;
  fetch?: typeof fetch;
}

const ACCOUNT = 'acct_1MRIFEJubV3fWiDW';
const PRODUCT = 'prod_VNGGSBfAWRcqrf';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function page(configured: boolean, csrf: string, message = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lab payments</title>
  <style>body{margin:0;background:#f3f7f2;color:#183c2d;font:17px/1.55 system-ui,sans-serif}main{max-width:660px;margin:48px auto;padding:28px}a{color:#246c4c}form{padding:24px;border:1px solid #bed1c1;border-radius:12px;background:white}input,button{font:inherit;box-sizing:border-box;padding:12px;border-radius:6px}input{display:block;width:100%;margin:8px 0 18px;border:1px solid #829e88}button{background:#246c4c;color:white;border:0;cursor:pointer}.status{font-weight:600}</style></head>
  <body><main><nav><a href="/inbox">Lab inbox</a> · <a href="/">Dashboard</a></nav><h1>Lab payments</h1>
  <p>The bot sends the group invite only after Stripe confirms a paid payment for the configured course. A participant's message or receipt screenshot does not grant access.</p>
  <p class="status">Stripe key: ${configured ? 'configured' : 'not configured'}</p>
  ${message ? `<p role="status">${escape(message)}</p>` : ''}
  <p>In <a href="https://dashboard.stripe.com/apikeys" rel="noreferrer">Stripe API keys</a>, create a live restricted key for this account. Grant <strong>Read</strong> access to Account, Checkout Sessions, Products, and Prices (used when expanding purchased items); leave write permissions disabled. Paste the key here, never in chat.</p>
  <form method="post" action="/lab-payments"><input type="hidden" name="_csrf" value="${escape(csrf)}"><label for="stripeKey">Restricted live Stripe key</label><input id="stripeKey" name="stripeKey" type="password" autocomplete="off" spellcheck="false" required maxlength="256" placeholder="rk_live_…"><button type="submit">Verify and save key</button></form>
  <p>The saved key is encrypted and never displayed. Saving verifies the Stripe account, Checkout Sessions read access, and the configured course product and cohort metadata.</p></main></body></html>`;
}

/** Mount only after the dashboard authentication gate. Never expose saved keys. */
export function mountLabPaymentRoutes(app: Hono, deps: LabPaymentDeps, csrf: string, origins: string[] = []): void {
  app.use('/lab-payments', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // Keep same-origin form POSTs identifiable; no-referrer makes browsers send Origin: null.
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    await next();
  });
  app.get('/lab-payments', c => c.html(page(Boolean(deps.getKey()), csrf)));
  app.post('/lab-payments', async c => {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin && !origins.includes(origin)) return c.text('CSRF failed.', 403);
    if (!c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')) return c.text('Expected form.', 415);
    // Bound the actual body; Content-Length is optional and untrusted.
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.text('Missing form.', 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); return c.text('Form too large.', 413); }
      chunks.push(value);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (form.get('_csrf') !== csrf) return c.html(page(Boolean(deps.getKey()), csrf, 'This form expired after a server restart. Enter the key again in this refreshed form.'), 403);
    const key = form.get('stripeKey')?.trim() ?? '';
    const failure = (message: string) => c.html(page(Boolean(deps.getKey()), csrf, message), 400);
    if (!/^rk_live_[A-Za-z0-9]{16,248}$/.test(key) || key.length > 256) return failure('Enter a live restricted Stripe key beginning rk_live_.');
    try {
      const request = deps.fetch ?? fetch;
      const options = { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' as const };
      const accountResponse = await request('https://api.stripe.com/v1/account', options);
      if (!accountResponse.ok) return failure('Stripe could not verify this restricted key. Check the account and permissions.');
      const account = await accountResponse.json() as { id?: unknown };
      if (account.id !== ACCOUNT) return failure('This key belongs to a different Stripe account.');
      const sessions = await request('https://api.stripe.com/v1/checkout/sessions?limit=1', options);
      if (!sessions.ok) return failure('Enable Read permission for Checkout Sessions, then try again.');
      await sessions.body?.cancel();
      const productResponse = await request(`https://api.stripe.com/v1/products/${PRODUCT}`, options);
      if (!productResponse.ok) return failure('Enable Read permission for Products and check access to the course product, then try again.');
      const product = await productResponse.json() as { id?: unknown; deleted?: unknown; metadata?: { cohort_site?: unknown } };
      if (product.id !== PRODUCT || product.deleted === true || product.metadata?.cohort_site !== 'goal-driven-ai-01') return failure('The configured Stripe product does not match this course cohort.');
      await deps.saveKey(key);
    } catch {
      return c.html(page(Boolean(deps.getKey()), csrf, 'The key could not be verified and saved. Check Stripe access and try again.'), 503);
    }
    return c.html(page(true, csrf, 'Stripe account, Checkout Sessions access, and course product verified. Key saved.'));
  });
}
