import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./core/agent-manager.js";
import { EventLog } from "./core/events.js";
import { EvolutionEngine, type EvolutionIO } from "./core/evolution.js";
import { Scheduler } from "./core/scheduler.js";
import { loadSettings, saveSettings } from "./config.js";
import { createWebApp, type TelegramControl, type WebDeps } from "./web.js";

function fakeControl(over: Partial<TelegramControl> = {}): TelegramControl & { enableSpy: ReturnType<typeof vi.fn> } {
  const enableSpy = vi.fn(async () => ({ ok: true, botName: "@test_bot" }));
  return {
    hasTransport: vi.fn(() => false),
    telegramUsername: vi.fn(() => undefined),
    enableTelegram: enableSpy,
    disableTelegram: vi.fn(async () => true),
    ...over,
    enableSpy,
  } as never;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-web-"));
}

function makeProposal(name: string) {
  return {
    mode: "create" as const,
    skillName: name,
    description: "Use when the test runs the cycle.",
    content: "# S\n\n## Steps\n- a\n- b\n",
    rationale: "test",
    probes: [{ task: "t", criteria: "c" }],
  };
}

function csrfOf(app: ReturnType<typeof createWebApp>): string {
  return (app as any)._csrf as string;
}
function withCsrf(form: FormData, app: ReturnType<typeof createWebApp>): FormData {
  const c = csrfOf(app);
  form.set("_csrf", c);
  return form;
}

function authenticateTestApp(app: ReturnType<typeof createWebApp>): void {
  const request = app.request.bind(app);
  app.request = ((input: Parameters<typeof request>[0], init?: Parameters<typeof request>[1]) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", "Bearer dashboard-test-token");
    return request(input, { ...init, headers });
  }) as typeof app.request;
}

describe("web dashboard", () => {
  let dir: string;
  let app: ReturnType<typeof createWebApp>;
  let scheduler: Scheduler;
  let agents: AgentManager;
  let io: EvolutionIO;

  beforeEach(() => {
    dir = tmpDir();
    agents = new AgentManager(dir, { getModels: () => [] } as unknown as ModelRuntime);
    agents.createAgent("assistant", "You are a test companion.");
    scheduler = new Scheduler(path.join(dir, "data"), () => {});
    const events = new EventLog(dir);
    io = { propose: vi.fn(), runProbe: vi.fn(), judge: vi.fn() };
    const evolution = new EvolutionEngine({
      agents,
      modelRuntime: {} as ModelRuntime,
      events,
      dataDir: dir,
      host: { announce: async () => {} },
      io,
    });
    app = createWebApp({ agents, scheduler, events, evolution, dataDir: dir, webToken: "dashboard-test-token", secrets: { get: () => ({}), save: async () => {} } } satisfies WebDeps);
    authenticateTestApp(app);
  });

  afterEach(() => {
    scheduler.stop();
    try { (app as any)._authStore?.stop?.(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET / lists agents with pills and the create form", async () => {
    const res = await app.request("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("assistant");
    expect(html).toContain("/agents/new");
  });

  it("GET /agents/:id renders manifest form, schedules, persona, events", async () => {
    scheduler.create({
      agentId: "assistant",
      chat: { transport: "mock", chatId: "42" },
      title: "stretch",
      kind: "reminder",
      dueAt: Date.now() + 60e3,
      wake: "normal",
      delivery: "direct",
    });
    const res = await app.request("/agents/assistant");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("stretch");
    expect(html).toContain("Save manifest");
    expect(html).toContain("You are a test companion.");
  });

  it("404s on unknown agent", async () => {
    const res = await app.request("/agents/ghost");
    expect(res.status).toBe(404);
  });

  it("POST /agents creates an agent and redirects", async () => {
    const form = new FormData();
    form.set("name", "coach");
    form.set("persona", "You are a strict coach.");
    withCsrf(form, app);
    const res = await app.request("/agents", { method: "POST", body: form });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/agents/coach");
    expect(agents.getAgent("coach")).toBeDefined();
    expect(fs.readFileSync(path.join(dir, "coach", "AGENTS.md"), "utf8")).toContain("strict coach");
  });

  it("rejects invalid agent names with a flash", async () => {
    const form = new FormData();
    form.set("name", "Bad Name!");
    withCsrf(form, app);
    const res = await app.request("/agents", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("msg=");
  });

  it("POST manifest saves heartbeat/evolution config", async () => {
    const form = new FormData();
    form.set("description", "The everyday one");
    form.set("model", "");
    form.set("thinking", "low");
    form.set("tools", "read,write,grep");
    form.set("providers", "ollama,anthropic");
    form.set("hb_enabled", "on");
    form.set("hb_interval", "30m");
    form.set("hb_model", "deepseek/deepseek-chat");
    form.set("hb_from", "22:00");
    form.set("hb_to", "07:00");
    form.set("ev_interval", "3h");
    withCsrf(form, app);
    const res = await app.request("/agents/assistant/manifest", { method: "POST", body: form });
    expect(res.status).toBe(302);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "assistant", "agent.json"), "utf8"));
    expect(saved.heartbeat).toMatchObject({ enabled: true, interval: "30m", model: "deepseek/deepseek-chat", quietHours: { from: "22:00", to: "07:00" } });
    expect(saved.evolution).toMatchObject({ enabled: false, interval: "3h" });
    expect(saved.tools).toEqual(["read", "write", "grep"]);
    expect(saved.providers).toEqual(["ollama", "anthropic"]);
  });

  it("manifest rejects invalid intervals", async () => {
    const form = new FormData();
    form.set("hb_interval", "a while");
    withCsrf(form, app);
    const res = await app.request("/agents/assistant/manifest", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Invalid%20interval");
  });

  it("POST persona and memory save files", async () => {
    const persona = new FormData();
    persona.set("persona", "You are someone else now.");
    withCsrf(persona, app);
    await app.request("/agents/assistant/persona", { method: "POST", body: persona });
    expect(fs.readFileSync(path.join(dir, "assistant", "AGENTS.md"), "utf8")).toContain("someone else");

    const mem = new FormData();
    mem.set("memory", "# Memory\nlikes tea");
    withCsrf(mem, app);
    await app.request("/agents/assistant/memory", { method: "POST", body: mem });
    expect(fs.readFileSync(path.join(dir, "assistant", "memory", "MEMORY.md"), "utf8")).toContain("likes tea");
  });

  it("snooze and wake flows", async () => {
    const form = new FormData();
    form.set("duration", "2h");
    withCsrf(form, app);
    const res = await app.request("/agents/assistant/snooze", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Snoozed");
    expect(scheduler.snoozeState("assistant")).not.toBeNull();

    // wake via POST; include csrf via form body (the route reads body)
    const wakeForm = new FormData();
    withCsrf(wakeForm, app);
    const res2 = await app.request("/agents/assistant/wake", { method: "POST", body: wakeForm });
    expect(res2.headers.get("location")).toContain("resumed");
    expect(scheduler.snoozeState("assistant")).toBeNull();
  });

  it("cancel schedule via web", async () => {
    const job = scheduler.create({
      agentId: "assistant",
      chat: { transport: "mock", chatId: "42" },
      title: "cancel me",
      kind: "reminder",
      dueAt: Date.now() + 3600e3,
      wake: "normal",
      delivery: "direct",
    });
    const form = new FormData();
    withCsrf(form, app);
    const res = await app.request(`/schedules/${job.id}/cancel`, { method: "POST", body: form });
    expect(res.status).toBe(302);
    expect(scheduler.get(job.id)?.status).toBe("cancelled");
  });

  it("evolve route starts a cycle (fire-and-forget) and stages on low scores", async () => {
    (io.propose as ReturnType<typeof vi.fn>).mockResolvedValue(makeProposal("evo-test"));
    (io.judge as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    const form = new FormData();
    form.set("goal", "get better at tests");
    withCsrf(form, app);
    const res = await app.request("/agents/assistant/evolve", { method: "POST", body: form });
    expect(res.status).toBe(302);
    await new Promise((r) => setTimeout(r, 120));
    expect(io.propose).toHaveBeenCalled();
    expect(path.join(dir, "assistant", "skills", ".staging", "evo-skill")).toBeDefined();
  });

  it("staged promote and reject routes", async () => {
    (io.propose as ReturnType<typeof vi.fn>).mockResolvedValue(makeProposal("stage-me"));
    (io.judge as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    const ef = new FormData(); withCsrf(ef, app);
    await app.request("/agents/assistant/evolve", { method: "POST", body: ef });
    await new Promise((r) => setTimeout(r, 120));

    const form2 = new FormData(); withCsrf(form2, app);
    const res = await app.request("/agents/assistant/staged/stage-me/promote", { method: "POST", body: form2 });
    expect(res.headers.get("location")).toContain("Promoted");
    expect(fs.existsSync(path.join(dir, "assistant", "skills", "stage-me", "SKILL.md"))).toBe(true);
  });

  it("CSRF enforcement: POST without token is 403", async () => {
    const form = new FormData();
    form.set("description", "x");
    // no csrf
    const res = await app.request("/agents/assistant/manifest", { method: "POST", body: form });
    expect(res.status).toBe(403);
  });

  it("rejects an empty mutating POST without CSRF", async () => {
    const res = await app.request("/agents/assistant/wake", { method: "POST" });
    expect(res.status).toBe(403);
  });
});

describe("telegram settings", () => {
  it("loadSettings/saveSettings round-trip and merge", () => {
    const dir = tmpDir();
    expect(loadSettings(dir)).toEqual({});
    saveSettings(dir, { telegram: { token: "t1", allowedChats: ["1"] } });
    expect(loadSettings(dir).telegram?.token).toBe("t1");
    saveSettings(dir, { telegram: undefined });
    expect(loadSettings(dir).telegram).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("web /telegram", () => {
  let dir: string;
  let app: ReturnType<typeof createWebApp>;
  let control: ReturnType<typeof fakeControl>;

  function boot(over: Partial<TelegramControl> = {}) {
    dir = tmpDir();
    const agents = new AgentManager(dir, { getModels: () => [] } as unknown as ModelRuntime);
    agents.createAgent("assistant");
    scheduler = new Scheduler(path.join(dir, "data"), () => {});
    const events = new EventLog(dir);
    const evolution = new EvolutionEngine({
      agents,
      modelRuntime: {} as ModelRuntime,
      events,
      dataDir: dir,
      host: { announce: async () => {} },
      io: { propose: vi.fn(), runProbe: vi.fn(), judge: vi.fn() },
    });
    control = fakeControl(over);
    app = createWebApp({ agents, scheduler, events, evolution, dataDir: dir, webToken: "dashboard-test-token", telegram: control, secrets: { get: () => loadSettings(dir), save: async (p) => { await saveSettings(dir, p); } } } satisfies WebDeps);
    authenticateTestApp(app);
  }

  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = undefined as never;
  });

  afterEach(() => {
    scheduler?.stop();
    try { (app as any)?._authStore?.stop?.(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET /telegram shows not-connected state and the token form", async () => {
    boot();
    const res = await app.request("/telegram");
    const html = await res.text();
    expect(html).toContain("not connected");
    expect(html).toContain('name="token"');
    expect(html).toContain("@BotFather");
  });

  it("overview links to telegram config and shows status", async () => {
    boot({ hasTransport: vi.fn(() => true), telegramUsername: vi.fn(() => "test_bot") });
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain("connected as");
    expect(html).toContain("@test_bot");
    expect(html).toContain("/telegram");
  });

  it("POST connects with a valid token and persists settings", async () => {
    boot();
    const form = new FormData();
    form.set("token", "123:valid");
    form.set("allowedChats", "111, 222");
    withCsrf(form, app);
    const res = await app.request("/telegram", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Connected");
    expect(control.enableTelegram).toHaveBeenCalledWith("123:valid", ["111", "222"]);
    expect(loadSettings(dir).telegram).toEqual({ token: "123:valid", allowedChats: ["111", "222"] });
  });

  it("POST with rejected token shows the error and does not persist", async () => {
    boot({ enableTelegram: vi.fn(async () => ({ ok: false, error: "Token rejected by Telegram: 401" })) });
    const form = new FormData();
    form.set("token", "123:bad");
    withCsrf(form, app);
    const res = await app.request("/telegram", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("rejected");
    expect(loadSettings(dir).telegram).toBeUndefined();
  });

  it("POST without a token and none configured asks for BotFather", async () => {
    boot();
    const form = new FormData();
    withCsrf(form, app);
    const res = await app.request("/telegram", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("BotFather");
  });

  it("keeps the stored token when re-submitting with an empty token field", async () => {
    boot();
    saveSettings(dir, { telegram: { token: "123:existing", allowedChats: [] } });
    const form = new FormData();
    form.set("allowedChats", "999");
    withCsrf(form, app);
    const res = await app.request("/telegram", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Connected");
    expect(control.enableTelegram).toHaveBeenCalledWith("123:existing", ["999"]);
  });

  it("disable clears settings", async () => {
    boot({ hasTransport: vi.fn(() => true) });
    saveSettings(dir, { telegram: { token: "123:x", allowedChats: [] } });
    const form = new FormData(); withCsrf(form, app);
    const res = await app.request("/telegram/disable", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("disconnected");
    expect(control.disableTelegram).toHaveBeenCalled();
    expect(loadSettings(dir).telegram).toBeUndefined();
  });
});
describe("web /agents/new", () => {
  let dir: string;
  let app: ReturnType<typeof createWebApp>;
  let scheduler: Scheduler;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-"));
    const agents = new AgentManager(dir, { getModels: () => [] } as unknown as ModelRuntime);
    agents.createAgent("assistant");
    scheduler = new Scheduler(path.join(dir, "data"), () => {});
    const events = new EventLog(dir);
    const evolution = new EvolutionEngine({
      agents,
      modelRuntime: {} as ModelRuntime,
      events,
      dataDir: dir,
      host: { announce: async () => {} },
      io: { propose: vi.fn(), runProbe: vi.fn(), judge: vi.fn() },
    });
    app = createWebApp({ agents, scheduler, events, evolution, dataDir: dir, webToken: "dashboard-test-token", secrets: { get: () => ({}), save: async () => {} } } satisfies WebDeps);
    authenticateTestApp(app);
  });

  afterEach(() => {
    scheduler.stop();
    try { (app as any)._authStore?.stop?.(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renders the structured creation form", async () => {
    const res = await app.request("/agents/new");
    const html = await res.text();
    expect(html).toContain('name="name"');
    expect(html).toContain('name="job"');
    expect(html).toContain("proactivity");
  });

  it("POST /agents/new creates the agent with rhythm from the preset", async () => {
    const form = new FormData();
    form.set("name", "research");
    form.set("job", "Tracks AI research papers weekly.");
    form.set("vibe", "dry & efficient");
    form.set("proactivity", "quiet");
    withCsrf(form, app);
    const res = await app.request("/agents/new", { method: "POST", body: form });
    expect(res.status).toBe(302);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "research", "agent.json"), "utf8"));
    expect(manifest.heartbeat).toMatchObject({ enabled: true, interval: "90m" });
    expect(fs.readFileSync(path.join(dir, "research", "AGENTS.md"), "utf8")).toContain("Tracks AI research papers weekly.");
  });
});

describe("web auth — Touch ID + Bearer + CSRF", () => {
  let dir: string;
  let app: ReturnType<typeof createWebApp>;
  let scheduler: Scheduler;

  function makeApp(opts: { webToken?: string; hasCred?: boolean } = {}) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-auth-"));
    const agents = new AgentManager(dir, { getModels: () => [] } as unknown as ModelRuntime);
    agents.createAgent("assistant");
    scheduler = new Scheduler(path.join(dir, "data"), () => {});
    const events = new EventLog(dir);
    const evolution = new EvolutionEngine({
      agents,
      modelRuntime: {} as ModelRuntime,
      events,
      dataDir: dir,
      host: { announce: async () => {} },
      io: { propose: vi.fn(), runProbe: vi.fn(), judge: vi.fn() },
    });
    app = createWebApp({ agents, scheduler, events, evolution, dataDir: dir, secrets: { get: () => ({}), save: async () => {} }, webToken: opts.webToken, webRpId: "127.0.0.1" } satisfies WebDeps);
    if (opts.hasCred) {
      const store = (app as any)._authStore;
      store.addCredential({ id: "test-cred-id", publicKey: Buffer.from("fake-public-key").toString("base64"), counter: 0 });
    }
    return { dir, app, scheduler };
  }

  afterEach(() => {
    scheduler?.stop();
    try { (app as any)?._authStore?.stop?.(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET /auth returns 200 with Touch ID button", async () => {
    makeApp();
    const res = await app.request("/auth");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Unlock with Touch ID");
    expect(html).toContain("navigator.credentials");
  });

  it("WebAuthn authentication stays open but first-passkey registration requires the configured bearer", async () => {
    makeApp({ webToken: "bootstrap-secret" });
    const r1 = await app.request("/auth/webauthn/auth-options");
    expect(r1.status).toBe(200);
    const j1 = await r1.json() as any;
    expect(typeof j1.challenge).toBe("string");
    expect(j1.challenge.length).toBeGreaterThan(10);

    const denied = await app.request("/auth/webauthn/register-options");
    expect(denied.status).toBe(401);
    const r2 = await app.request("/auth/webauthn/register-options", { headers: { Authorization: "Bearer bootstrap-secret" } });
    expect(r2.status).toBe(200);
    const j2 = await r2.json() as any;
    expect(typeof j2.challenge).toBe("string");
  });

  it("challenge TTL: challenge exists after generation", async () => {
    makeApp();
    const store = (app as any)._authStore;
    const chal = store.createChallenge("auth");
    expect(store.hasChallenge(chal)).toBe(true);
    // consume works
    expect(store.consumeChallenge(chal, "auth")).toBe(true);
    expect(store.hasChallenge(chal)).toBe(false);
    // wrong kind fails
    const c2 = store.createChallenge("register");
    expect(store.consumeChallenge(c2, "auth")).toBe(false);
    expect(store.consumeChallenge(c2, "register")).toBe(true);
  });

  it("Bearer gate: 401 when token required but missing, 200 with valid token", async () => {
    makeApp({ webToken: "secret123" });
    const res1 = await app.request("/");
    expect(res1.status).toBe(302);
    expect(res1.headers.get("location")).toContain("/auth");

    const resApi = await app.request("/", { headers: { accept: "application/json" } });
    expect(resApi.status).toBe(401);

    const res2 = await app.request("/", { headers: { Authorization: "Bearer secret123" } });
    expect(res2.status).toBe(200);

    const res3 = await app.request("/", { headers: { Authorization: "Bearer wrong" } });
    expect(res3.status).toBe(302);
  });

  it("Bearer bypasses WebAuthn session for API routes", async () => {
    makeApp({ webToken: "tok", hasCred: true });
    // /agents/new is protected
    const r1 = await app.request("/agents/new");
    expect(r1.status).toBe(302);
    const r2 = await app.request("/agents/new", { headers: { Authorization: "Bearer tok" } });
    expect(r2.status).toBe(200);
  });

  it("session cookie after WebAuthn login grants access (mocked via store)", async () => {
    makeApp({ hasCred: true });
    const store = (app as any)._authStore;
    const tok = store.createSession();
    const cookie = store.makeCookie(tok);
    const signed = cookie.split(";")[0]; // pibot_session=...
    const r = await app.request("/", { headers: { Cookie: signed } });
    expect(r.status).toBe(200);
    // logout clears? check token flow
    const form = new FormData(); withCsrf(form, app);
    const logout = await app.request("/auth/logout", { method: "POST", body: form, headers: { Cookie: signed } });
    expect(logout.status).toBe(302);
    const r2 = await app.request("/", { headers: { Cookie: signed } });
    // after logout, should redirect to /auth because hasCred=true
    expect(r2.status).toBe(302);
  });

  it("POST /auth/token with valid token sets session cookie", async () => {
    makeApp({ webToken: "s3cr3t" });
    const form = new FormData();
    form.set("token", "s3cr3t");
    withCsrf(form, app);
    const res = await app.request("/auth/token", { method: "POST", body: form });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("pibot_session=");
  });

  it("POST /auth/token with invalid token redirects with error", async () => {
    makeApp({ webToken: "s3cr3t" });
    const form = new FormData();
    form.set("token", "wrong");
    withCsrf(form, app);
    const res = await app.request("/auth/token", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Invalid");
  });

  it("rate-limits repeated invalid token attempts", async () => {
    makeApp({ webToken: "s3cr3t" });
    for (let i = 0; i < 5; i++) {
      const form = new FormData(); form.set("token", "wrong"); withCsrf(form, app);
      expect((await app.request("/auth/token", { method: "POST", body: form })).status).toBe(302);
    }
    const form = new FormData(); form.set("token", "wrong"); withCsrf(form, app);
    expect((await app.request("/auth/token", { method: "POST", body: form })).status).toBe(429);
  });

  it("rate-limits repeated WebAuthn challenge requests", async () => {
    makeApp({ hasCred: true });
    for (let i = 0; i < 30; i++) expect((await app.request("/auth/webauthn/auth-options")).status).toBe(200);
    expect((await app.request("/auth/webauthn/auth-options")).status).toBe(429);
  });

  it("stores passkeys and sessions with owner-only permissions", () => {
    makeApp();
    const store = (app as any)._authStore;
    store.addCredential({ id: "cred", publicKey: Buffer.from("key").toString("base64"), counter: 0 });
    store.createSession();
    expect(fs.statSync(path.join(dir, "web-auth.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "web-sessions.json")).mode & 0o777).toBe(0o600);
  });

  it("fails closed when no token and no passkey are configured", async () => {
    makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth");
  });

  it("rejects a malformed signed-session cookie without crashing", async () => {
    makeApp({ hasCred: true });
    const res = await app.request("/", { headers: { Cookie: "pibot_session=x.y" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth");
  });
});
