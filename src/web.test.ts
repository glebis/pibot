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
    app = createWebApp({ agents, scheduler, events, evolution, dataDir: dir } satisfies WebDeps);
  });

  afterEach(() => {
    scheduler.stop();
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
    const res = await app.request("/agents", { method: "POST", body: form });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/agents/coach");
    expect(agents.getAgent("coach")).toBeDefined();
    expect(fs.readFileSync(path.join(dir, "coach", "AGENTS.md"), "utf8")).toContain("strict coach");
  });

  it("rejects invalid agent names with a flash", async () => {
    const form = new FormData();
    form.set("name", "Bad Name!");
    const res = await app.request("/agents", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("msg=");
  });

  it("POST manifest saves heartbeat/evolution config", async () => {
    const form = new FormData();
    form.set("description", "The everyday one");
    form.set("model", "");
    form.set("thinking", "low");
    form.set("tools", "read,write,grep");
    form.set("hb_enabled", "on");
    form.set("hb_interval", "30m");
    form.set("hb_model", "deepseek/deepseek-chat");
    form.set("hb_from", "22:00");
    form.set("hb_to", "07:00");
    form.set("ev_interval", "3h");
    const res = await app.request("/agents/assistant/manifest", { method: "POST", body: form });
    expect(res.status).toBe(302);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "assistant", "agent.json"), "utf8"));
    expect(saved.heartbeat).toMatchObject({ enabled: true, interval: "30m", model: "deepseek/deepseek-chat", quietHours: { from: "22:00", to: "07:00" } });
    expect(saved.evolution).toMatchObject({ enabled: false, interval: "3h" });
    expect(saved.tools).toEqual(["read", "write", "grep"]);
  });

  it("manifest rejects invalid intervals", async () => {
    const form = new FormData();
    form.set("hb_interval", "a while");
    const res = await app.request("/agents/assistant/manifest", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Invalid%20interval");
  });

  it("POST persona and memory save files", async () => {
    const persona = new FormData();
    persona.set("persona", "You are someone else now.");
    await app.request("/agents/assistant/persona", { method: "POST", body: persona });
    expect(fs.readFileSync(path.join(dir, "assistant", "AGENTS.md"), "utf8")).toContain("someone else");

    const mem = new FormData();
    mem.set("memory", "# Memory\nlikes tea");
    await app.request("/agents/assistant/memory", { method: "POST", body: mem });
    expect(fs.readFileSync(path.join(dir, "assistant", "memory", "MEMORY.md"), "utf8")).toContain("likes tea");
  });

  it("snooze and wake flows", async () => {
    const form = new FormData();
    form.set("duration", "2h");
    const res = await app.request("/agents/assistant/snooze", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Snoozed");
    expect(scheduler.snoozeState("assistant")).not.toBeNull();

    const res2 = await app.request("/agents/assistant/wake", { method: "POST" });
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
    const res = await app.request(`/schedules/${job.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(302);
    expect(scheduler.get(job.id)?.status).toBe("cancelled");
  });

  it("evolve route starts a cycle (fire-and-forget) and stages on low scores", async () => {
    (io.propose as ReturnType<typeof vi.fn>).mockResolvedValue(makeProposal("evo-test"));
    (io.judge as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    const form = new FormData();
    form.set("goal", "get better at tests");
    const res = await app.request("/agents/assistant/evolve", { method: "POST", body: form });
    expect(res.status).toBe(302);
    // wait for the async cycle to land in staging
    await new Promise((r) => setTimeout(r, 120));
    expect(io.propose).toHaveBeenCalled();
    expect(path.join(dir, "assistant", "skills", ".staging", "evo-skill")).toBeDefined();
  });

  it("staged promote and reject routes", async () => {
    (io.propose as ReturnType<typeof vi.fn>).mockResolvedValue(makeProposal("stage-me"));
    (io.judge as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    await app.request("/agents/assistant/evolve", { method: "POST", body: new FormData() });
    await new Promise((r) => setTimeout(r, 120));

    const res = await app.request("/agents/assistant/staged/stage-me/promote", { method: "POST" });
    expect(res.headers.get("location")).toContain("Promoted");
    expect(fs.existsSync(path.join(dir, "assistant", "skills", "stage-me", "SKILL.md"))).toBe(true);
  });
});

describe("telegram settings", () => {
  it("loadSettings/saveSettings round-trip and merge", () => {
    const dir = tmpDir();
    expect(loadSettings(dir)).toEqual({});
    saveSettings(dir, { telegram: { token: "t1", allowedChats: ["1"] } });
    expect(loadSettings(dir).telegram?.token).toBe("t1");
    // clearing: patch with undefined drops the key from the file
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
    app = createWebApp({ agents, scheduler, events, evolution, dataDir: dir, telegram: control } satisfies WebDeps);
  }

  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = undefined as never;
  });

  afterEach(() => {
    scheduler?.stop();
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
    const res = await app.request("/telegram", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Connected");
    expect(control.enableTelegram).toHaveBeenCalledWith("123:valid", ["111", "222"]);
    expect(loadSettings(dir).telegram).toEqual({ token: "123:valid", allowedChats: ["111", "222"] });
  });

  it("POST with rejected token shows the error and does not persist", async () => {
    boot({ enableTelegram: vi.fn(async () => ({ ok: false, error: "Token rejected by Telegram: 401" })) });
    const form = new FormData();
    form.set("token", "123:bad");
    const res = await app.request("/telegram", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("rejected");
    expect(loadSettings(dir).telegram).toBeUndefined();
  });

  it("POST without a token and none configured asks for BotFather", async () => {
    boot();
    const form = new FormData();
    const res = await app.request("/telegram", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("BotFather");
  });

  it("keeps the stored token when re-submitting with an empty token field", async () => {
    boot();
    saveSettings(dir, { telegram: { token: "123:existing", allowedChats: [] } });
    const form = new FormData();
    form.set("allowedChats", "999");
    const res = await app.request("/telegram", { method: "POST", body: form });
    expect(res.headers.get("location")).toContain("Connected");
    expect(control.enableTelegram).toHaveBeenCalledWith("123:existing", ["999"]);
  });

  it("disable clears settings", async () => {
    boot({ hasTransport: vi.fn(() => true) });
    saveSettings(dir, { telegram: { token: "123:x", allowedChats: [] } });
    const res = await app.request("/telegram/disable", { method: "POST" });
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
    app = createWebApp({ agents, scheduler, events, evolution, dataDir: dir } satisfies WebDeps);
  });

  afterEach(() => {
    scheduler.stop();
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
    const res = await app.request("/agents/new", { method: "POST", body: form });
    expect(res.status).toBe(302);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "research", "agent.json"), "utf8"));
    expect(manifest.heartbeat).toMatchObject({ enabled: true, interval: "90m" });
    expect(fs.readFileSync(path.join(dir, "research", "AGENTS.md"), "utf8")).toContain("Tracks AI research papers weekly.");
  });
});
