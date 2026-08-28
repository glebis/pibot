import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import type { AgentManager, LoadedAgent } from "./core/agent-manager.js";
import { listSkillDirs } from "./core/agent-manager.js";
import type { EventLog } from "./core/events.js";
import type { EvolutionEngine } from "./core/evolution.js";
import type { Scheduler } from "./core/scheduler.js";
import type { AgentManifest, Schedule } from "./core/types.js";
import { buildManifest, buildPersona, PROACTIVITY_OPTIONS, suggestedSubBotUsername, validateAgentName, type Proactivity } from "./core/agent-factory.js";
import { errorMessage, fmtWhen, nextQuietEnd, parseDuration, readJson, truncate, writeJsonAtomic } from "./core/util.js";
import { WebAuthStore } from "./web-auth.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

export interface TelegramControl {
  hasTransport(name: string): boolean;
  telegramUsername(): string | undefined;
  enableTelegram(token: string, allowedChats: string[]): Promise<{ ok: boolean; botName?: string; error?: string }>;
  disableTelegram(): Promise<boolean>;
  askUserAllChats(agentId: string, question: string, options: string[]): Promise<void>;
  managerMode(): boolean;
  managerUsername(): string | undefined;
  subBotFor(agentId: string): { username?: string } | undefined;
  attachSubBot(agentId: string, token: string): Promise<{ ok: boolean; botName?: string; error?: string }>;
  detachSubBot(agentId: string): Promise<boolean>;
  requestSubBotCreation(agentId: string): Promise<void>;
}

export interface WebDeps {
  agents: AgentManager;
  scheduler: Scheduler;
  events: EventLog;
  evolution: EvolutionEngine;
  dataDir: string;
  telegram?: TelegramControl;
  secrets?: { get(): import("./config.js").Settings; save(patch: Partial<import("./config.js").Settings>): Promise<void> };
  webToken?: string;
  webRpId?: string;
  webPort?: number;
  /** injectable for tests */
  webAuthStore?: WebAuthStore;
  /** per-process CSRF token override (tests) */
  csrfToken?: string;
}

// ─── rendering helpers ──────────────────────────────────────────────────────

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, flash?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · pibot</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d0f12; color: #d7dce2; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: #8ab4ff; text-decoration: none; } a:hover { text-decoration: underline; }
  main { max-width: 880px; margin: 0 auto; padding: 32px 24px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #8a94a3; margin: 36px 0 10px; border-bottom: 1px solid #22262d; padding-bottom: 6px; }
  .sub { color: #8a94a3; font-size: 13px; margin: 0 0 24px; }
  .card { background: #14171c; border: 1px solid #23272f; border-radius: 10px; padding: 16px 18px; margin: 12px 0; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .row > * { flex: 1 1 160px; }
  label { display: block; font-size: 12px; color: #8a94a3; margin: 10px 0 4px; }
  input[type=text], input[type=number], input[type=password], textarea, select {
    width: 100%; background: #0d0f12; color: #d7dce2; border: 1px solid #2b313b; border-radius: 7px;
    padding: 7px 10px; font: inherit; font-size: 14px;
  }
  textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
  button, .btn {
    display: inline-block; background: #2563eb; color: #fff; border: 0; border-radius: 7px;
    padding: 7px 14px; font: inherit; font-size: 14px; cursor: pointer; margin-top: 10px;
  }
  button.ghost, .btn.ghost { background: transparent; border: 1px solid #2b313b; color: #aab3bf; }
  button.danger { background: #7f1d1d; }
  button.mini { padding: 3px 10px; font-size: 12px; margin: 0; }
  .flash { background: #10321c; border: 1px solid #1d5c33; color: #9fe0b5; border-radius: 8px; padding: 10px 14px; margin: 0 0 20px; }
  .flash.warn { background: #332a10; border-color: #5c4d1d; color: #e0cd9f; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: #8a94a3; font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid #22262d; }
  td { padding: 8px; border-bottom: 1px solid #1a1e24; vertical-align: top; }
  .muted { color: #8a94a3; font-size: 13px; }
  code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
  .pill { display: inline-block; border: 1px solid #2b313b; border-radius: 999px; padding: 1px 10px; font-size: 12px; color: #aab3bf; margin-right: 6px; }
  .pill.on { border-color: #1d5c33; color: #9fe0b5; }
  form.inline { display: inline; }
  pre.events { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #9aa4b1; max-height: 260px; overflow: auto; margin: 0; white-space: pre-wrap; }
</style></head><body><main>
<h1>🤖 pibot config</h1>
<p class="sub">agents · rhythm · schedules · evolution${flash ? "" : ""}</p>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
${body}
</main></body></html>`;
}

function manifestForm(agent: LoadedAgent, csrf: string): string {
  const m = agent.manifest;
  const hb = m.heartbeat ?? { enabled: false, interval: "45m", model: "same" };
  const ev = m.evolution ?? { enabled: false, interval: "6h", model: "same" };
  const qh = hb.quietHours ?? { from: "23:00", to: "08:00" };
  return `
<form method="post" action="/agents/${esc(agent.id)}/manifest" class="card">
  <input type="hidden" name="_csrf" value="${esc(csrf)}">
  <div class="row">
    <div><label>Description</label><input type="text" name="description" value="${esc(m.description ?? "")}"></div>
    <div><label>Model (pi shorthand, empty = auto)</label><input type="text" name="model" value="${esc(m.model ?? "")}" placeholder="sonnet:medium"></div>
  </div>
  <div class="row">
    <div><label>Thinking</label>
      <select name="thinking">
        ${["off", "minimal", "low", "medium", "high"].map((t) => `<option ${((m.thinking ?? "off") === t ? "selected" : "")}>${t}</option>`).join("")}
      </select></div>
    <div><label>Tools (comma-separated)</label><input type="text" name="tools" value="${esc((m.tools ?? []).join(","))}"></div>
  </div>
  <h2 style="border:0;margin-top:18px">Heartbeat</h2>
  <div class="row">
    <div><label class="mono">enabled <input type="checkbox" name="hb_enabled" ${hb.enabled ? "checked" : ""} style="width:auto"></label></div>
    <div><label>Interval</label><input type="text" name="hb_interval" value="${esc(hb.interval)}"></div>
    <div><label>Model</label><input type="text" name="hb_model" value="${esc(hb.model ?? "same")}"></div>
  </div>
  <div class="row">
    <div><label>Quiet from</label><input type="text" name="hb_from" value="${esc(qh.from)}"></div>
    <div><label>Quiet to</label><input type="text" name="hb_to" value="${esc(qh.to)}"></div>
  </div>
  <h2 style="border:0;margin-top:18px">Evolution</h2>
  <div class="row">
    <div><label class="mono">enabled <input type="checkbox" name="ev_enabled" ${ev.enabled ? "checked" : ""} style="width:auto"></label></div>
    <div><label>Interval</label><input type="text" name="ev_interval" value="${esc(ev.interval ?? "6h")}"></div>
    <div><label>Model</label><input type="text" name="ev_model" value="${esc(ev.model ?? "same")}"></div>
  </div>
  <button type="submit">Save manifest</button>
</form>`;
}

// ─── app factory ────────────────────────────────────────────────────────────

export function createWebApp(deps: WebDeps): Hono {
  const app = new Hono();

  const csrfToken = deps.csrfToken ?? crypto.randomBytes(32).toString("hex");
  // expose for tests
  (app as any)._csrf = csrfToken;

  const webToken = deps.webToken ?? process.env.PIBOT_WEB_TOKEN?.trim() ?? undefined;
  const rpId = deps.webRpId ?? process.env.PIBOT_WEB_RP_ID?.trim() ?? process.env.PIBOT_WEB_AUTH?.trim() ?? "127.0.0.1";
  const webPort = deps.webPort ?? parseInt(process.env.PIBOT_WEB_PORT || "7860", 10);
  const rpName = "pibot dashboard";

  const authStore: WebAuthStore = deps.webAuthStore ?? new WebAuthStore(deps.dataDir, { rpId, rpName });
  (app as any)._authStore = authStore;

  const csrfField = () => `<input type="hidden" name="_csrf" value="${esc(csrfToken)}">`;

  function checkCsrf(body: Record<string, unknown>): boolean {
    return String(body["_csrf"] ?? "") === csrfToken;
  }

  function expectedOrigins(): string[] {
    const port = String(webPort);
    const hosts = new Set([rpId, "127.0.0.1", "localhost"]);
    const out: string[] = [];
    for (const h of hosts) {
      out.push(`http://${h}:${port}`, `https://${h}:${port}`, `http://${h}`, `https://${h}`);
    }
    // also allow without explicit port for https
    return [...new Set(out)];
  }

  function isAuthenticated(c: any): boolean {
    const auth = c.req.header("authorization") ?? "";
    if (webToken && auth === `Bearer ${webToken}`) return true;
    const cookie = authStore.parseCookie(c.req.header("cookie"));
    if (cookie) {
      const tok = authStore.verifySignedToken(cookie);
      if (tok) return true;
    }
    return false;
  }

  function authRequired(): boolean {
    return !!webToken || authStore.hasCredentials();
  }

  function requireAuth(c: any): boolean {
    if (!authRequired()) return true;
    return isAuthenticated(c);
  }

  const openAuthPaths = new Set([
    "/auth",
    "/auth/token",
    "/auth/logout",
    "/auth/webauthn/register-options",
    "/auth/webauthn/register-verify",
    "/auth/webauthn/auth-options",
    "/auth/webauthn/auth-verify",
  ]);

  function isApiRequest(c: any): boolean {
    const accept = c.req.header("accept") ?? "";
    return accept.includes("application/json") || c.req.header("content-type")?.includes("application/json") || false;
  }

  // ── auth pages (open) ──
  app.get("/auth", (c) => {
    const hasCreds = authStore.hasCredentials();
    const hasToken = !!webToken;
    const body = `
<h2>🔐 Unlock dashboard</h2>
<div class="card">
  <p class="muted">Use Touch ID / passkey or a Bearer token to open the dashboard. Dashboard is bound to <span class="mono">${esc(rpId)}</span>.</p>
  <div id="webauthn" style="margin:12px 0">
    <button id="btn-touch" class="btn" style="background:#1a7f37">👆 Unlock with Touch ID</button>
    <span id="wa-msg" class="muted" style="margin-left:10px"></span>
  </div>
  ${hasCreds ? `<p class="muted">${authStore.credentials.length} passkey enrolled — this is the admin. Use Touch ID above to unlock.</p>` : `<p class="muted">No passkey yet — you can enroll below once logged in with a token, or enroll immediately if dashboard is still open.</p>`}
  ${!hasCreds && !hasToken ? `<div class="flash warn">Dashboard is open (no passkey, no PIBOT_WEB_TOKEN). Enroll a passkey now to lock it.</div>` : ""}
  ${!hasCreds ? `<div id="enroll" style="margin-top:14px">
    <button id="btn-enroll" class="btn ghost">➕ Enroll this Mac (Touch ID)</button>
    <span id="enroll-msg" class="muted" style="margin-left:10px"></span>
  </div>` : `<div id="enroll" style="margin-top:14px" class="muted">Enrolled — single admin. To re-enroll, remove <span class="mono">data/web-auth.json</span> and restart.</div>`}
</div>
${hasToken ? `<div class="card">
  <h2 style="margin-top:0">Token fallback</h2>
  <form method="post" action="/auth/token">
    ${csrfField()}
    <label>PIBOT_WEB_TOKEN</label>
    <input type="password" name="token" placeholder="paste bearer token" required>
    <button type="submit">Unlock with token</button>
  </form>
  <p class="muted">Or: <span class="mono">curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:${esc(String(webPort))}/</span></p>
</div>` : ""}
<div class="card"><a href="/">← Back to dashboard</a></div>
<script>
(function(){
  const msg = document.getElementById('wa-msg');
  const enrollMsg = document.getElementById('enroll-msg');
  function b64urlToBuf(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='='; const bin=atob(s); const b=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i); return b; }
  function bufToB64url(b){ let s=''; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }
  async function doAuth(){
    try{
      msg.textContent='…requesting challenge';
      const r=await fetch('/auth/webauthn/auth-options'); const j=await r.json();
      if(!j.challenge) throw new Error(j.error||'no challenge');
      const opts=j; opts.challenge=b64urlToBuf(opts.challenge);
      if(opts.allowCredentials) opts.allowCredentials.forEach(c=>c.id=b64urlToBuf(c.id));
      msg.textContent='Touch ID…';
      const cred=await navigator.credentials.get({publicKey: opts});
      const rawId=cred.rawId ? bufToB64url(new Uint8Array(cred.rawId)) : '';
      const resp={
        id: cred.id,
        rawId,
        response:{
          authenticatorData: bufToB64url(new Uint8Array(cred.response.authenticatorData)),
          clientDataJSON: bufToB64url(new Uint8Array(cred.response.clientDataJSON)),
          signature: bufToB64url(new Uint8Array(cred.response.signature)),
          userHandle: cred.response.userHandle ? bufToB64url(new Uint8Array(cred.response.userHandle)) : null
        },
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
      };
      const vr=await fetch('/auth/webauthn/auth-verify',{method:'POST',headers:{'content-type':'application/json'},body: JSON.stringify(resp)});
      const vj=await vr.json();
      if(vj.verified){ msg.textContent='✅ unlocked — redirecting…'; location.href='/'; } else { msg.textContent='⛔ '+(vj.error||'verification failed'); }
    }catch(e){ msg.textContent='⛔ '+(e.message||e); }
  }
  async function doEnroll(){
    try{
      enrollMsg.textContent='…requesting options';
      const r=await fetch('/auth/webauthn/register-options'); const j=await r.json();
      if(j.error) throw new Error(j.error);
      const opts=j; opts.challenge=b64urlToBuf(opts.challenge); opts.user.id=b64urlToBuf(opts.user.id);
      if(opts.excludeCredentials) opts.excludeCredentials.forEach(c=>c.id=b64urlToBuf(c.id));
      enrollMsg.textContent='Touch ID…';
      const cred=await navigator.credentials.create({publicKey: opts});
      const rawId=cred.rawId ? bufToB64url(new Uint8Array(cred.rawId)) : cred.id;
      const attResp=cred.response;
      const payload={
        id: cred.id,
        rawId,
        response:{
          attestationObject: bufToB64url(new Uint8Array(attResp.attestationObject)),
          clientDataJSON: bufToB64url(new Uint8Array(attResp.clientDataJSON)),
          transports: attResp.getTransports ? attResp.getTransports() : undefined
        },
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
      };
      const vr=await fetch('/auth/webauthn/register-verify',{method:'POST',headers:{'content-type':'application/json'},body: JSON.stringify(payload)});
      const vj=await vr.json();
      if(vj.verified){ enrollMsg.textContent='✅ enrolled — you can now unlock with Touch ID'; msg.textContent='Try Unlock above'; } else { enrollMsg.textContent='⛔ '+(vj.error||'failed'); }
    }catch(e){ enrollMsg.textContent='⛔ '+(e.message||e); }
  }
  document.getElementById('btn-touch')?.addEventListener('click', doAuth);
  document.getElementById('btn-enroll')?.addEventListener('click', doEnroll);
  // auto-trigger auth when creds exist
  if(${hasCreds ? "true" : "false"} && window.PublicKeyCredential) { /* user clicks */ }
})();
</script>
`;
    return c.html(page("auth", body, c.req.query("msg")));
  });

  app.post("/auth/token", async (c) => {
    const body = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(body as any)) return c.text("CSRF failed", 403);
    if (!webToken) return c.redirect("/auth?msg=" + encodeURIComponent("No PIBOT_WEB_TOKEN configured"));
    if (String(body.token ?? "").trim() === webToken) {
      const tok = authStore.createSession();
      c.header("Set-Cookie", authStore.makeCookie(tok));
      return c.redirect("/?msg=" + encodeURIComponent("Unlocked via token"));
    }
    return c.redirect("/auth?msg=" + encodeURIComponent("Invalid token"));
  });

  app.post("/auth/logout", async (c) => {
    const body = await c.req.parseBody().catch(()=>({})) as Record<string,string>;
    // allow JSON or form; only check csrf for form
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      if (!checkCsrf(body as any)) return c.text("CSRF failed", 403);
    }
    const cookie = authStore.parseCookie(c.req.header("cookie"));
    if (cookie) {
      const tok = authStore.verifySignedToken(cookie);
      if (tok) authStore.revokeSession(tok);
    }
    c.header("Set-Cookie", authStore.clearCookie());
    return c.redirect("/auth?msg=" + encodeURIComponent("Logged out"));
  });

  // ── WebAuthn: registration ──
  app.get("/auth/webauthn/register-options", async (c) => {
    const hasCreds = authStore.hasCredentials();
    if (hasCreds) {
      return c.json({ error: "already enrolled — single admin, remove data/web-auth.json to reset" }, 403);
    }
    const challenge = authStore.createChallenge("register");
    // SimpleWebAuthn expects raw bytes — pass Uint8Array to avoid double-base64url encoding
    const challengeBytes = Buffer.from(challenge, "base64url");
    // for open enrollment, we still generate options
    const opts = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: "pibot",
      userDisplayName: "pibot",
      userID: new Uint8Array([1,2,3,4]),
      challenge: challengeBytes as any,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred", authenticatorAttachment: "platform" },
      excludeCredentials: authStore.credentials.map((cc) => ({ id: cc.id, transports: cc.transports as any })),
    } as any);
    return c.json(opts);
  });

  app.post("/auth/webauthn/register-verify", async (c) => {
    const hasCreds = authStore.hasCredentials();
    if (hasCreds) return c.json({ verified: false, error: "already enrolled — single admin" }, 403);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ verified:false, error:"invalid json" },400); }
    const expectedChallenge = (chall: string) => authStore.hasChallenge(chall);
    let verification: any;
    try {
      verification = await verifyRegistrationResponse({
        response: body as any,
        expectedChallenge,
        expectedOrigin: expectedOrigins(),
        expectedRPID: rpId,
        requireUserVerification: false,
      } as any);
    } catch (e:any) {
      return c.json({ verified:false, error: e?.message ?? String(e) }, 400);
    }
    if (!verification.verified || !verification.registrationInfo) return c.json({ verified:false, error:"verification failed" }, 400);
    const info = verification.registrationInfo as any;
    // credential is WebAuthnCredential: { id, publicKey, counter, ... } or under credential
    const cred = (info.credential ?? info) as any;
    const id: string = cred.id ?? body.id;
    const publicKey: Uint8Array | string = cred.publicKey;
    let pkB64: string;
    if (publicKey instanceof Uint8Array) pkB64 = Buffer.from(publicKey).toString("base64");
    else if (typeof publicKey === "string") pkB64 = publicKey;
    else pkB64 = Buffer.from(publicKey as any).toString("base64");
    // consume challenge
    const chal = (body as any)?.response?.clientDataJSON ? (()=>{ try{ const s=Buffer.from((body.response.clientDataJSON as string),"base64url").toString("utf8"); const j=JSON.parse(s); return j.challenge; }catch{return null;}})() : null;
    if (chal) authStore.consumeChallenge(chal, "register");
    else {
      // fallback: try to consume any register challenge that matches? just try brute consume if single pending
    }
    authStore.addCredential({
      id,
      publicKey: pkB64,
      counter: cred.counter ?? 0,
      transports: body?.response?.transports,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
    // auto-login after enrollment
    const tok = authStore.createSession();
    c.header("Set-Cookie", authStore.makeCookie(tok));
    return c.json({ verified: true });
  });

  // ── WebAuthn: authentication ──
  app.get("/auth/webauthn/auth-options", async (c) => {
    const challenge = authStore.createChallenge("auth");
    const challengeBytes = Buffer.from(challenge, "base64url");
    const allow = authStore.credentials.map((cc) => ({ id: cc.id, transports: cc.transports as any }));
    const opts = await generateAuthenticationOptions({
      rpID: rpId,
      challenge: challengeBytes as any,
      allowCredentials: allow.length ? allow : undefined,
      userVerification: "preferred",
    } as any);
    return c.json(opts);
  });

  app.post("/auth/webauthn/auth-verify", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ verified:false, error:"invalid json" },400); }
    const credId: string = body.id ?? body.rawId;
    const stored = authStore.credentials.find((cc) => cc.id === credId || cc.id === body.rawId);
    if (!stored) return c.json({ verified:false, error:"unknown credential" }, 400);
    let credential: any;
    try {
      credential = {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64")),
        counter: stored.counter,
        transports: stored.transports as any,
      };
    } catch (e:any){ return c.json({ verified:false, error: e.message },400); }
    const expectedChallenge = (chall: string) => authStore.hasChallenge(chall);
    let verification: any;
    try {
      verification = await verifyAuthenticationResponse({
        response: body as any,
        expectedChallenge,
        expectedOrigin: expectedOrigins(),
        expectedRPID: rpId,
        credential,
        requireUserVerification: false,
      } as any);
    } catch (e:any) {
      return c.json({ verified:false, error: e?.message ?? String(e) }, 400);
    }
    if (!verification.verified) return c.json({ verified:false, error:"verification failed" }, 400);
    // consume challenge
    try {
      const s=Buffer.from(body.response.clientDataJSON as string,"base64url").toString("utf8");
      const j=JSON.parse(s);
      if (j.challenge) authStore.consumeChallenge(j.challenge, "auth");
    } catch {}
    authStore.updateCounter(stored.id, verification.authenticationInfo.newCounter);
    const tok = authStore.createSession();
    c.header("Set-Cookie", authStore.makeCookie(tok));
    return c.json({ verified: true });
  });

  // ── auth gate for all other routes ──
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (openAuthPaths.has(p)) return next();
    if (p.startsWith("/auth/webauthn/")) return next();
    if (!authRequired()) return next();
    if (isAuthenticated(c)) return next();
    if (isApiRequest(c)) return c.json({ error: "unauthorized" }, 401);
    return c.redirect("/auth?msg=" + encodeURIComponent("Please unlock with Touch ID or token"));
  });

  const agentOr404 = (id: string): LoadedAgent | null => {
    const a = deps.agents.getAgent(id);
    return a ?? null;
  };

  // ── overview ──
  app.get("/", (c) => {
    const agents = deps.agents.list();
    const cards = agents
      .map((a) => {
        const pending = deps.scheduler.list(a.id).filter((j) => !j.internal);
        const sn = deps.scheduler.snoozeState(a.id);
        const staged = deps.evolution.staged(a.id);
        const skills = listSkillDirs(path.join(a.dir, "skills"));
        return `<div class="card">
  <a href="/agents/${esc(a.id)}"><strong>${esc(a.id)}</strong></a>
  <span class="muted">${esc(a.manifest.description ?? "")}</span><br>
  <span class="pill ${a.manifest.heartbeat?.enabled ? "on" : ""}">heartbeat ${esc(a.manifest.heartbeat?.interval ?? "off")}</span>
  <span class="pill ${a.manifest.evolution?.enabled ? "on" : ""}">evolution ${esc(a.manifest.evolution?.interval ?? "off")}</span>
  <span class="pill">${pending.length} pending</span>
  ${skills.length ? `<span class="pill">${skills.length} skills</span>` : ""}
  ${staged.length ? `<span class="pill on">🧬 ${staged.length} staged</span>` : ""}
  ${sn ? `<span class="pill">😴 until ${esc(fmtWhen(sn.until))}</span>` : ""}
</div>`;
      })
      .join("\n");
    const authBanner = authRequired() ? `<div class="card"><span class="pill on">🔒 locked</span> <span class="muted">${authStore.hasCredentials() ? authStore.credentials.length+" passkey(s)" : ""} ${webToken ? "· token enabled" : ""}</span>
      <form method="post" action="/auth/logout" class="inline" style="float:right">${csrfField()}<button class="ghost mini" type="submit">Logout</button></form>
      <a href="/auth" style="margin-left:8px">Auth →</a></div>` : `<div class="card"><span class="pill">🔓 open</span> <span class="muted">No passkey, no token — <a href="/auth">enroll Touch ID</a> to lock dashboard</span></div>`;
    return c.html(page("overview", `${authBanner}${cards || '<p class="muted">No agents yet.</p>'}
<h2>Telegram</h2>
<div class="card">
  ${deps.telegram?.hasTransport("telegram")
    ? `<span class="pill on">🟢 connected${deps.telegram.telegramUsername() ? ` as <strong>@${esc(deps.telegram.telegramUsername())}</strong>` : ""}</span>`
    : `<span class="pill">⚪ not connected</span>`}
  <a href="/telegram">Configure →</a>
</div>
<h2>New agent</h2>
<div class="card"><a href="/agents/new">Create a new agent →</a> <span class="muted">guided form — or /newagent in chat for the interview wizard</span></div>`));
  });

  // ── create agent ──
  app.post("/agents", async (c) => {
    const body = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(body as any)) return c.text("CSRF failed", 403);
    const name = String(body.name ?? "").toLowerCase().trim();
    const persona = String(body.persona ?? "");
    const err = deps.agents.createAgent(name, persona || undefined);
    if (err) return c.redirect(`/?msg=${encodeURIComponent(err)}`);
    const agent = deps.agents.getAgent(name);
    if (agent) {
      // arm its rhythm jobs immediately
      const hb = agent.manifest.heartbeat;
      if (hb?.enabled) {
        const everyMs = parseDuration(hb.interval) ?? 45 * 60e3;
        deps.scheduler.ensure({
          id: `hb:${agent.id}`, agentId: agent.id, chat: { transport: "internal", chatId: "heartbeat" },
          title: "heartbeat", kind: "heartbeat", dueAt: Date.now() + everyMs, repeat: { everyMs },
          wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0, internal: true,
        });
      }
      if (agent.manifest.evolution?.enabled) {
        const everyMs = parseDuration(agent.manifest.evolution.interval ?? "6h") ?? 6 * 3600e3;
        deps.scheduler.ensure({
          id: `ev:${agent.id}`, agentId: agent.id, chat: { transport: "internal", chatId: "evolution" },
          title: "evolution", kind: "evolution", dueAt: Date.now() + everyMs, repeat: { everyMs },
          wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0, internal: true,
        });
      }
    }
    return c.redirect(`/agents/${encodeURIComponent(name)}?msg=${encodeURIComponent(`Agent "${name}" created`)}`);
  });

  // ── create agent (structured form, shares agent-factory with the chat wizard) ──
  app.get("/agents/new", (c) => {
    const body = `<h2>New agent</h2>
<form method="post" action="/agents/new" class="card">
  ${csrfField()}
  <label>Name (lowercase, dashes)</label>
  <input type="text" name="name" placeholder="coach" required>
  <label>What is its main job? One or two sentences</label>
  <textarea name="job" style="min-height:70px" placeholder="Keeps me on top of German tax filings and pushes the next sendable action." required></textarea>
  <label>Vibe</label>
  <select name="vibe">
    <option>warm & casual</option>
    <option>dry & efficient</option>
    <option>coach-like: encouraging but demanding</option>
  </select>
  <label>Proactivity</label>
  <select name="proactivity">
    ${PROACTIVITY_OPTIONS.map((o) => `<option>${o}</option>`).join("")}
  </select>
  <button type="submit">Create agent</button>
</form>`;
    return c.html(page("new agent", body, c.req.query("msg")));
  });

  app.post("/agents/new", async (c) => {
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    const name = String(b.name ?? "").toLowerCase().trim();
    const job = String(b.job ?? "").trim();
    const vibe = String(b.vibe ?? "warm & casual");
    const proRaw = String(b.proactivity ?? "balanced");
    const proactivity: Proactivity = proRaw.startsWith("quiet") ? "quiet" : proRaw.startsWith("chatty") ? "chatty" : proRaw.startsWith("off") ? "off" : "balanced";
    const nameErr = validateAgentName(name, deps.agents.list().map((a) => a.id));
    if (nameErr) return c.redirect(`/agents/new?msg=${encodeURIComponent(nameErr)}`);
    if (!job.trim()) return c.redirect(`/agents/new?msg=${encodeURIComponent("The job description is required")}`);

    const draft = { name, job, vibe, proactivity };
    const err = deps.agents.createAgent(name, buildPersona(draft));
    if (err) return c.redirect(`/agents/new?msg=${encodeURIComponent(err)}`);
    const agent = deps.agents.getAgent(name)!;
    writeJsonAtomic(path.join(agent.dir, "agent.json"), buildManifest(draft));
    await deps.agents.discover();
    const fresh = deps.agents.getAgent(name)!;
    const hb = fresh.manifest.heartbeat;
    if (hb?.enabled) {
      const everyMs = parseDuration(hb.interval) ?? 45 * 60e3;
      deps.scheduler.ensure({
        id: `hb:${fresh.id}`, agentId: fresh.id, chat: { transport: "internal", chatId: "heartbeat" },
        title: "heartbeat", kind: "heartbeat", dueAt: Date.now() + everyMs, repeat: { everyMs },
        wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0, internal: true,
      });
    }
    if (fresh.manifest.evolution?.enabled) {
      const everyMs = parseDuration(fresh.manifest.evolution.interval ?? "6h") ?? 6 * 3600e3;
      deps.scheduler.ensure({
        id: `ev:${fresh.id}`, agentId: fresh.id, chat: { transport: "internal", chatId: "evolution" },
        title: "evolution", kind: "evolution", dueAt: Date.now() + everyMs, repeat: { everyMs },
        wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0, internal: true,
      });
    }
    return c.redirect(`/agents/${encodeURIComponent(name)}?msg=${encodeURIComponent(`Agent "${name}" created — rhythm armed`)}`);
  });

  // ── agent detail ──
  app.get("/agents/:id", (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const m = agent.manifest;
    const pending = deps.scheduler.list(agent.id).filter((j) => !j.internal);
    const staged = deps.evolution.staged(agent.id);
    const skills = listSkillDirs(path.join(agent.dir, "skills"));
    const events = deps.events.tail(agent.id, 12);
    const memoryFile = path.join(agent.dir, "memory", "MEMORY.md");
    const memory = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, "utf8") : "";

    const scheduleRows = pending
      .map(
        (j: Schedule) => `<tr>
  <td class="mono">${esc(j.id)}</td><td><strong>${esc(j.title)}</strong>${j.detail ? `<br><span class="muted">${esc(truncate(j.detail, 120))}</span>` : ""}</td>
  <td>${esc(fmtWhen(j.dueAt))}${j.repeat ? " ↻" : ""}${j.wake === "important" ? " ⚡" : ""}<br><span class="muted">${esc(j.kind)} · ${esc(j.delivery)}</span></td>
  <td><form method="post" action="/schedules/${esc(j.id)}/cancel">${csrfField()}<button class="danger mini" type="submit">Cancel</button></form></td>
</tr>`
      )
      .join("\n") || `<tr><td colspan="4" class="muted">Nothing pending.</td></tr>`;

    const body = `
${staged.length ? `<div class="flash warn">🧬 Staged for review: ${staged.map((s) => `<strong>${esc(s)}</strong>`).join(", ")}</div>` : ""}
<div class="row">
  <div class="card"><span class="pill ${m.heartbeat?.enabled ? "on" : ""}">heartbeat ${esc(m.heartbeat?.interval ?? "off")}</span>
  <span class="pill ${m.evolution?.enabled ? "on" : ""}">evolution ${esc(m.evolution?.interval ?? "off")}</span>
  <span class="pill">model ${esc(m.model || "auto")}</span>
  ${skills.length ? `<span class="pill">${skills.length} skills</span>` : ""}</div>
</div>

<h2>Rhythm & model</h2>
${manifestForm(agent, csrfToken)}

<h2>Persona <span class="muted">(AGENTS.md)</span></h2>
<form method="post" action="/agents/${esc(agent.id)}/persona" class="card">
  ${csrfField()}
  <textarea name="persona" style="min-height:140px">${esc(fs.existsSync(path.join(agent.dir, "AGENTS.md")) ? fs.readFileSync(path.join(agent.dir, "AGENTS.md"), "utf8") : "")}</textarea>
  <button type="submit">Save persona</button>
</form>

<h2>Memory digest <span class="muted">(memory/MEMORY.md)</span></h2>
<form method="post" action="/agents/${esc(agent.id)}/memory" class="card">
  ${csrfField()}
  <textarea name="memory">${esc(memory)}</textarea>
  <button type="submit">Save memory digest</button>
</form>

<h2>Schedules</h2>
<form method="post" action="/agents/${esc(agent.id)}/snooze" class="card">
  ${csrfField()}
  <label>Snooze everything (e.g. 2h, 30m)</label>
  <div class="row">
    <div><input type="text" name="duration" placeholder="2h"></div>
    <div style="flex:0"><button type="submit" class="ghost">😴 Snooze</button></div>
    <div style="flex:0"><button type="submit" class="ghost" formaction="/agents/${esc(agent.id)}/wake">☀️ Wake</button></div>
  </div>
</form>
<div class="card" style="padding:0">
<table>
  <tr><th>id</th><th>item</th><th>due</th><th></th></tr>
  ${scheduleRows}
</table>
</div>

<h2>Skills</h2>
<div class="card">
  ${skills.length ? skills.map((s) => `<div><strong>${esc(s.name)}</strong> <span class="muted">${esc(s.description)}</span></div>`).join("") : '<span class="muted">No skills yet.</span>'}
  ${staged.length ? `<div style="margin-top:12px"><strong>Staged:</strong> ${staged.map((s) => `<span class="pill on">${esc(s)}</span> <form class="inline" method="post" action="/agents/${esc(agent.id)}/staged/${esc(s)}/promote">${csrfField()}<button class="mini" type="submit">promote</button></form> <form class="inline" method="post" action="/agents/${esc(agent.id)}/staged/${esc(s)}/reject">${csrfField()}<button class="mini danger" type="submit">reject</button></form>`).join(" · ")}</div>` : ""}
</div>

<h2>Telegram sub-bot <span class="muted">(its own @identity)</span></h2>
<div class="card">
  ${deps.telegram?.subBotFor(agent.id)?.username
    ? `<span class="pill on">🟢 @${esc(deps.telegram.subBotFor(agent.id)!.username)}</span>
       <form method="post" action="/agents/${esc(agent.id)}/subbot/detach" class="inline">${csrfField()}<button class="danger mini" type="submit">Detach</button></form>`
    : `<span class="pill">⚪ shared bot only</span>`}
  ${deps.telegram?.managerMode()
    ? `<p class="muted">Manager mode is ON — tap the button below in Telegram, or use the link here.</p>
       <form method="post" action="/agents/${esc(agent.id)}/subbot/request" class="inline">
         ${csrfField()}
         <button class="ghost" type="submit">Send creation link to my chats →</button>
       </form>
       <p class="muted">Tap the link in Telegram (or the button above after it arrives) and confirm — pibot fetches the token, wires the bot, and restricts it to you.</p>`
    : `<p class="muted">Manager mode is off — create a bot with @BotFather (/newbot) and paste its token here to give ${esc(agent.id)} its own identity.</p>`}
</div>
<form method="post" action="/agents/${esc(agent.id)}/subbot" class="card">
  ${csrfField()}
  <label>Sub-bot token (from @BotFather — or leave empty if using the manager flow)</label>
  <input type="password" name="token" placeholder="123456:ABC…" autocomplete="off">
  <button type="submit">Attach sub-bot</button>
</form>

<h2>Run evolution now</h2>
<form method="post" action="/agents/${esc(agent.id)}/evolve" class="card">
  ${csrfField()}
  <label>Goal (optional — empty = self-directed)</label>
  <div class="row">
    <div><input type="text" name="goal" placeholder="get better at morning briefings"></div>
    <div style="flex:0"><button type="submit">🧬 Run cycle</button></div>
  </div>
</form>

<h2>Recent events</h2>
<div class="card"><pre class="events">${esc(events.map((e) => `${new Date(e.t).toLocaleTimeString()} [${e.type}] ${e.summary}`).join("\n") || "(none)")}</pre></div>
`;
    return c.html(page(agent.id, body, c.req.query("msg")));
  });

  // ── manifest save ──
  app.post("/agents/:id/manifest", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    const str = (k: string) => String(b[k] ?? "").trim();
    const on = (k: string) => b[k] === "on";

    const hbInterval = str("hb_interval") || "45m";
    const evInterval = str("ev_interval") || "6h";
    if (!parseDuration(hbInterval) || !parseDuration(evInterval)) {
      return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Invalid interval (try 45m, 2h, 6h)")}`);
    }

    const manifest: AgentManifest = {
      ...agent.manifest,
      description: str("description") || agent.manifest.description,
      model: str("model") || undefined,
      thinking: (str("thinking") as AgentManifest["thinking"]) || "off",
      tools: str("tools") ? str("tools").split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      heartbeat: {
        enabled: on("hb_enabled"),
        interval: hbInterval,
        model: str("hb_model") || "same",
        quietHours: { from: str("hb_from") || "23:00", to: str("hb_to") || "08:00" },
      },
      evolution: {
        enabled: on("ev_enabled"),
        interval: evInterval,
        model: str("ev_model") || "same",
      },
    };
    writeJsonAtomic(path.join(agent.dir, "agent.json"), manifest);
    await deps.agents.discover(); // reload manifests
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Manifest saved — rhythm changes apply on next restart of jobs (or via chat)")}`);
  });

  // ── persona / memory ──
  app.post("/agents/:id/persona", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    fs.writeFileSync(path.join(agent.dir, "AGENTS.md"), String(b.persona ?? "").trim() + "\n");
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Persona saved")}`);
  });

  app.post("/agents/:id/memory", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    fs.mkdirSync(path.join(agent.dir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(agent.dir, "memory", "MEMORY.md"), String(b.memory ?? ""));
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Memory digest saved")}`);
  });

  // ── snooze / wake ──
  app.post("/agents/:id/snooze", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    const ms = parseDuration(String(b.duration ?? ""));
    if (!ms) return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Couldn't parse duration — try 2h or 30m")}`);
    const quietEnd = nextQuietEnd(agent.manifest.heartbeat?.quietHours);
    deps.scheduler.snooze(agent.id, Date.now() + ms, "web", quietEnd ?? undefined);
    deps.events.log(agent.id, "snooze", `web snooze ${String(b.duration)}`);
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent(`Snoozed ${String(b.duration)} — important items still fire`)}`);
  });

  app.post("/agents/:id/wake", (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    // wake via form with csrf: need to handle but this is POST with empty body? check query param?
    // For formaction wake, body still has _csrf
    return (async () => {
      const b = await c.req.parseBody().catch(()=>({})) as Record<string,string>;
      if (Object.keys(b).length && !checkCsrf(b as any)) return c.text("CSRF failed", 403);
      deps.scheduler.unsnooze(agent.id);
      return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Rhythm resumed")}`);
    })() as any;
  });

  // ── schedules ──
  app.post("/schedules/:id/cancel", async (c) => {
    const b = await c.req.parseBody().catch(()=>({})) as Record<string,string>;
    if (Object.keys(b).length && !checkCsrf(b as any)) return c.text("CSRF failed", 403);
    // also accept csrf via form field even when parsing empty? For schedule cancel, form sends _csrf
    if (b["_csrf"] && String(b["_csrf"]) !== csrfToken) return c.text("CSRF failed", 403);
    // if body empty but method is POST, still require?orig forms include _csrf, so enforce if present
    const job = deps.scheduler.cancel(c.req.param("id"));
    const back = job ? `/agents/${encodeURIComponent(job.agentId)}` : "/";
    return c.redirect(`${back}?msg=${encodeURIComponent(job ? `Cancelled: ${job.title}` : "Already gone")}`);
  });

  // ── evolution ──
  app.post("/agents/:id/evolve", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    const goal = String(b.goal ?? "").trim() || undefined;
    void deps.evolution
      .evolve(agent.id, goal || undefined, { force: true })
      .then((r) => deps.events.log(agent.id, "system", `evolution: ${r.summary}`))
      .catch((e) => deps.events.log(agent.id, "system", `evolution failed: ${errorMessage(e)}`));
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("🧬 Evolution cycle started — results appear in Recent events and are announced in chat")}`);
  });

  app.post("/agents/:id/staged/:name/promote", async (c) => {
    const b = await c.req.parseBody().catch(()=>({})) as Record<string,string>;
    if (!checkCsrf(b as any) && Object.keys(b).length) return c.text("CSRF failed", 403);
    if (b["_csrf"] && String(b["_csrf"]) !== csrfToken) return c.text("CSRF failed", 403);
    // enforce csrf even if body empty: require header? For staged, form includes _csrf, so already checked
    const ok = deps.evolution.promote(c.req.param("id"), c.req.param("name"));
    return c.redirect(`/agents/${encodeURIComponent(c.req.param("id"))}?msg=${encodeURIComponent(ok ? "Promoted ✅" : "Nothing staged with that name")}`);
  });

  app.post("/agents/:id/staged/:name/reject", async (c) => {
    const b = await c.req.parseBody().catch(()=>({})) as Record<string,string>;
    if (b["_csrf"] && String(b["_csrf"]) !== csrfToken) return c.text("CSRF failed", 403);
    deps.evolution.reject(c.req.param("id"), c.req.param("name"));
    return c.redirect(`/agents/${encodeURIComponent(c.req.param("id"))}?msg=${encodeURIComponent("Rejected 🗑")}`);
  });

  app.post("/agents/:id/subbot", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent || !deps.telegram) return c.notFound();
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    const token = String(b.token ?? "").trim();
    if (!token) return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("No token given")}`);
    const r = await deps.telegram.attachSubBot(agent.id, token);
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent(r.ok ? `🟢 Sub-bot live as ${r.botName}` : `⛔ ${r.error}`)}`);
  });

  app.post("/agents/:id/subbot/request", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent || !deps.telegram) return c.notFound();
    const b = await c.req.parseBody().catch(()=>({})) as Record<string,string>;
    if (b["_csrf"] && String(b["_csrf"]) !== csrfToken) return c.text("CSRF failed", 403);
    await deps.telegram.requestSubBotCreation(agent.id);
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Sub-bot creation requested — tap the link in Telegram and confirm")}`);
  });

  app.post("/agents/:id/subbot/detach", async (c) => {
    const b = await c.req.parseBody().catch(()=>({})) as Record<string,string>;
    if (b["_csrf"] && String(b["_csrf"]) !== csrfToken) return c.text("CSRF failed", 403);
    await deps.telegram?.detachSubBot(c.req.param("id"));
    return c.redirect(`/agents/${encodeURIComponent(c.req.param("id"))}?msg=${encodeURIComponent("Sub-bot detached")}`);
  });

  // ── telegram settings ──
  app.get("/telegram", (c) => {
    const enabled = deps.telegram?.hasTransport("telegram") ?? false;
    const username = deps.telegram?.telegramUsername();
    const settings = deps.secrets?.get() ?? {};
    const configured = Boolean(settings.telegram?.token);
    const body = `<h2>Telegram bot</h2>
<div class="card">
  ${enabled
    ? `<span class="pill on">🟢 connected${username ? ` as <strong>@${esc(username)}</strong>` : ""}</span>`
    : configured
      ? `<span class="pill">⚪ configured but not running</span>`
      : `<span class="pill">⚪ not connected</span>`}
  <p class="muted">Any chat that can see the bot can talk to it (allowlist below to restrict). Agents are switched per chat with /agent.</p>
</div>
<form method="post" action="/telegram" class="card">
  ${csrfField()}
  <label>Bot token <span class="muted">(from @BotFather — /newbot)</span></label>
  <input type="password" name="token" placeholder="${configured ? "•••••••• (configured — leave empty to keep)" : "123456:ABC-your-token"}" autocomplete="off">
  <label>Allowed chat IDs (comma-separated, empty = anyone with access to the bot)</label>
  <input type="text" name="allowedChats" value="${esc((settings.telegram?.allowedChats ?? []).join(","))}" placeholder="123456789, 987654321">
  <button type="submit">${enabled ? "Test & reconnect" : "Test & connect"}</button>
</form>
${enabled
  ? `<form method="post" action="/telegram/disable">${csrfField()}<button type="submit" class="danger">Disconnect bot</button></form>`
  : ""}`;
    return c.html(page("telegram", body, c.req.query("msg")));
  });

  app.post("/telegram", async (c) => {
    if (!deps.telegram) {
      return c.redirect(`/telegram?msg=${encodeURIComponent("Telegram control not wired")}`);
    }
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    const token = String(b.token ?? "").trim();
    const allowedChats = String(b.allowedChats ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const settings = deps.secrets?.get() ?? {};
    const effectiveToken = token || settings.telegram?.token || "";
    if (!effectiveToken) {
      return c.redirect(`/telegram?msg=${encodeURIComponent("No token provided — create a bot with @BotFather (/newbot) and paste the token")}`);
    }
    await deps.telegram.disableTelegram();
    const r = await deps.telegram.enableTelegram(effectiveToken, allowedChats);
    if (!r.ok) {
      await deps.secrets?.save({ telegram: undefined });
      return c.redirect(`/telegram?msg=${encodeURIComponent(`⛔ ${r.error}`)}`);
    }
    await deps.secrets?.save({ telegram: { token: effectiveToken, allowedChats } });
    deps.events.log("system", "system", `telegram connected as ${r.botName}`);
    return c.redirect(`/telegram?msg=${encodeURIComponent(`🟢 Connected as ${r.botName} — say hi in Telegram!`)}`);
  });

  app.post("/telegram/disable", async (c) => {
    const b = await c.req.parseBody().catch(()=>({})) as Record<string,string>;
    if (b["_csrf"] && String(b["_csrf"]) !== csrfToken) return c.text("CSRF failed", 403);
    if (deps.telegram) await deps.telegram.disableTelegram();
    await deps.secrets?.save({ telegram: undefined });
    return c.redirect(`/telegram?msg=${encodeURIComponent("Bot disconnected")}`);
  });

  // ── manual structured question (also the live test surface) ──
  app.get("/agents/:id/ask", (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const body = `<h2>Ask ${esc(agent.id)} a question</h2>
<form method="post" action="/agents/${esc(agent.id)}/ask" class="card">
  ${csrfField()}
  <label>Question</label>
  <input type="text" name="question" placeholder="Which account?" required>
  <label>Options (comma-separated, 2–6 → buttons, 7–10 → poll)</label>
  <input type="text" name="options" placeholder="client, personal, own-account, unsure" required>
  <button type="submit">Send to registered chats</button>
</form>`;
    return c.html(page(`${agent.id} · ask`, body, c.req.query("msg")));
  });

  app.post("/agents/:id/ask", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    if (!deps.telegram) return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("telegram control not wired")}`);
    const b = await c.req.parseBody() as Record<string,string>;
    if (!checkCsrf(b as any)) return c.text("CSRF failed", 403);
    const question = String(b.question ?? "").trim();
    const options = String(b.options ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      return c.redirect(`/agents/${encodeURIComponent(agent.id)}/ask?msg=${encodeURIComponent("Question + at least 2 options required")}`);
    }
    void deps.telegram
      .askUserAllChats(agent.id, question, options)
      .then(() => deps.events.log(agent.id, "system", `web question sent: "${question}"`))
      .catch((e: unknown) => deps.events.log(agent.id, "system", `web question failed: ${errorMessage(e)}`));
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Question sent — waiting for taps")}`);
  });

  return app;
}
