/** Public voice-only forwarding. Twilio signatures and PIN are checked by PiBot. */
// VOICE_ORIGIN is a Worker secret (never committed): exactly one Tailscale Funnel host on 8443.
const TAILNET_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;
function upstreamOf(value) {
  let upstream;
  try { upstream = new URL(value); } catch { return undefined; }
  if (upstream.protocol !== 'https:' || !TAILNET_HOST.test(upstream.hostname) || upstream.port !== '8443' || upstream.pathname !== '/' || upstream.username || upstream.password || upstream.search || upstream.hash) return undefined;
  return upstream;
}
export default {
 async fetch(request, env) {
  const url = new URL(request.url);
  const webhook = request.method === 'POST' && ['/answer','/authenticate','/status'].includes(url.pathname);
  const stream = request.method === 'GET' && /^\/ws\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (!webhook && !stream) return new Response('Not found', {status:404});
  if (!request.headers.get('x-twilio-signature')) return new Response('Forbidden', {status:403});
  const upstream = upstreamOf(env.VOICE_ORIGIN);
  if (!upstream) return new Response('Unavailable', {status:503});
  url.protocol = upstream.protocol; url.host = upstream.host;
  try { return await fetch(new Request(url, request), {redirect:'manual'}); }
  catch { return new Response('Unavailable', {status:502}); }
 }
};
