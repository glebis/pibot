import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./core/agent-manager.js";
import { EventLog } from "./core/events.js";
import { EvolutionEngine, type EvolutionIO } from "./core/evolution.js";
import { Scheduler } from "./core/scheduler.js";
import { createWebApp, type WebDeps } from "./web.js";

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
    expect(html).toContain("Create agent");
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