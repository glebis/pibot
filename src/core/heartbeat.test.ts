import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { nextActs } = vi.hoisted(() => ({ nextActs: [] as Array<null | { speak?: string; escalate?: string; note?: string; wakeup?: string; maintain?: string }> }));

function queueActs(acts: Array<null | { speak?: string; escalate?: string; note?: string; wakeup?: string; maintain?: string }>) {
  nextActs.length = 0;
  nextActs.push(...acts);
}

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  const MockLoader = class {
    constructor(_opts?: unknown) {}
    async reload() {}
  };
  return {
    ...(orig as object),
    DefaultResourceLoader: MockLoader,
    getAgentDir: vi.fn(() => path.join(os.tmpdir(), "pibot-gad-stub")),
    createAgentSession: vi.fn(async (opts: unknown) => {
      const o = opts as { customTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> };
      const actTool = o.customTools?.find((t) => t.name === "heartbeat_act");
      const payload = nextActs.shift();
      return {
        session: {
          prompt: async () => {
            if (payload === undefined) return;
            if (payload === null) return;
            if (actTool) await actTool.execute("test-id", payload as never);
          },
          dispose() {},
          agent: { state: { messages: [] } },
        },
        modelFallbackMessage: undefined,
      };
    }),
    SessionManager: { inMemory: vi.fn(() => ({})) },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    defineTool: (o: unknown) => o,
  };
});

import { buildHeartbeatDigest, buildMaintenancePanel, HeartbeatEngine, recordMaintenanceNote, verifyMemoryClaim, triageEscalationLoop, escalationsSimilar, type EscalationLoopState } from "./heartbeat.js";
import { appendBacklogItems, loadBacklogItems } from "./backlog.js";
import { clearSignalsCache } from "./research-signals.js";
import type { LoadedAgent } from "./agent-manager.js";
import type { HeartbeatHost } from "./heartbeat.js";
import * as PiAgent from "@earendil-works/pi-coding-agent";

function tmpAgentDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-hb-"));
  fs.writeFileSync(path.join(d, "AGENTS.md"), "You are a test agent.");
  return d;
}
function makeAgent(dir: string, over: Partial<LoadedAgent["manifest"]> = {}): LoadedAgent {
  return { id: "assistant", dir, manifest: { name: "assistant", heartbeat: { enabled: true, interval: "45m" }, ...over } };
}
function makeEngine(
  agent: LoadedAgent,
  dir: string,
  over: Partial<HeartbeatHost> = {},
  cascade?: import("./cascade.js").ModelCascade,
  statePath?: string,
  consolidation?: { consolidate(agentId: string): Promise<unknown> },
) {
  const agents = { getAgent: vi.fn((id: string) => (id === agent.id ? agent : undefined)), heartbeatModel: vi.fn(() => undefined), resolveModel: vi.fn(() => undefined) } as unknown as import("./agent-manager.js").AgentManager;
  const scheduler = { snoozeState: vi.fn(() => null), list: vi.fn(() => []) } as unknown as import("./scheduler.js").Scheduler;
  const events = { log: vi.fn(), tail: vi.fn(() => []) } as unknown as import("./events.js").EventLog;
  const host: HeartbeatHost = { deliverToAgent: vi.fn(async () => true), escalateToAgent: vi.fn(async () => {}), lastUserMessageAt: vi.fn(() => 0), ...over };
  const modelRuntime = {} as PiAgent.ModelRuntime;
  const engineOptions = { agents, scheduler, modelRuntime, events, vaultDir: dir, host, cascade, statePath, consolidation };
  const engine = new HeartbeatEngine(engineOptions as ConstructorParameters<typeof HeartbeatEngine>[0]);
  return { engine, agents, scheduler, events, host };
}

describe("HeartbeatEngine backoff", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpAgentDir();
    nextActs.length = 0;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    nextActs.length = 0;
    vi.mocked(PiAgent.createAgentSession).mockClear();
    vi.mocked(PiAgent.getAgentDir).mockClear();
  });

  it("does not create an automatic-model heartbeat session when no permitted model is healthy", async () => {
    const agent = makeAgent(dir, { model: "anthropic/blocked", providers: ["ollama"] });
    const cascade = { chainFor: vi.fn(() => []), firstHealthy: vi.fn(() => undefined) } as unknown as import("./cascade.js").ModelCascade;
    const { engine } = makeEngine(agent, dir, {}, cascade);
    await (engine as unknown as { tickInner: (agent: LoadedAgent, opts: {}) => Promise<void> }).tickInner(agent, {});
    expect(PiAgent.createAgentSession).not.toHaveBeenCalled();
  });

  it("grants heartbeat ticks read/write/edit file tools but keeps briefs narrow", async () => {
    const agent = makeAgent(dir, { model: "anthropic/claude-opus-4-6", providers: ["anthropic"] });
    const { engine } = makeEngine(agent, dir);
    await (engine as unknown as { tickInner: (agent: LoadedAgent, opts: {}) => Promise<void> }).tickInner(agent, {});
    const tickTools = (PiAgent.createAgentSession as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].tools;
    expect(tickTools).toEqual(["heartbeat_act", "read", "write", "edit"]);

    queueActs([]);
    await (engine as unknown as { tickInner: (agent: LoadedAgent, opts: { brief?: boolean }) => Promise<void> }).tickInner(agent, { brief: true });
    const briefTools = (PiAgent.createAgentSession as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].tools;
    expect(briefTools).toEqual(["heartbeat_act", "calendar_today"]);
  });

  it("confines heartbeat file tools: customTools override read/write/edit, writes only under memory/", async () => {
    const agent = makeAgent(dir, { model: "anthropic/claude-opus-4-6", providers: ["anthropic"] });
    const { engine } = makeEngine(agent, dir);
    await (engine as unknown as { tickInner: (agent: LoadedAgent, opts: {}) => Promise<void> }).tickInner(agent, {});
    type T = { name: string; execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }> }> };
    const custom = (PiAgent.createAgentSession as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].customTools as T[];
    expect(custom.map((t) => t.name)).toEqual(["heartbeat_act", "read", "write", "edit"]);
    const run = (name: string, params: object) => custom.find((t) => t.name === name)!.execute("id", params, undefined, undefined, undefined);
    expect((await run("write", { path: "AGENTS.md", content: "x" })).content[0].text).toMatch(/^refused:/);
    expect((await run("write", { path: "~/pibot-heartbeat-test", content: "x" })).content[0].text).toMatch(/^refused:/);
    expect((await run("read", { path: "/etc/hosts" })).content[0].text).toMatch(/^refused:/);
    expect((await run("write", { path: "memory/notes/hb.md", content: "ok" })).content[0].text).toContain("Successfully wrote");
    expect(fs.readFileSync(path.join(dir, "memory", "notes", "hb.md"), "utf8")).toBe("ok");

    queueActs([]);
    await (engine as unknown as { tickInner: (agent: LoadedAgent, opts: { brief?: boolean }) => Promise<void> }).tickInner(agent, { brief: true });
    const briefCustom = (PiAgent.createAgentSession as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].customTools as T[];
    expect(briefCustom.map((t) => t.name)).toEqual(["heartbeat_act"]);
  });
  describe("shouldTick", () => {
    it("allows ticks when under the backoff threshold", () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      expect(engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 })).toEqual({ ok: true });
    });
    it("blocks when unansweredSpeaks >= 2", () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      (engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.set(agent.id, 2);
      const g = engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 });
      expect(g.ok).toBe(false);
      expect(g.reason).toMatch(/backoff/i);
    });
    it("blocks when unansweredSpeaks > 2 as well", () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      (engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.set(agent.id, 3);
      expect(engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 }).ok).toBe(false);
    });
    it("allows tick at exactly 1 unanswered speak", () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      (engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.set(agent.id, 1);
      expect(engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 }).ok).toBe(true);
    });
    it("resumes after noteUserMessage resets the counter", () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      (engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.set(agent.id, 2);
      expect(engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 }).ok).toBe(false);
      engine.noteUserMessage(agent.id);
      expect(engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 }).ok).toBe(true);
    });
    it("noteUserMessage is scoped per agent", () => {
      const agent = makeAgent(dir);
      const other: LoadedAgent = { id: "other", dir, manifest: { name: "other", heartbeat: { enabled: true, interval: "45m" } } };
      const { engine } = makeEngine(agent, dir);
      (engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.set(agent.id, 2);
      (engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.set(other.id, 2);
      engine.noteUserMessage(agent.id);
      expect(engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 }).ok).toBe(true);
      expect(engine.shouldTick(other, { snoozed: false, lastUserMessageAt: 0 }).ok).toBe(false);
    });
  });
  describe("tick integration (stubbed ModelRuntime / ephemeral session)", () => {
    it("suppresses an identical repeated speak but delivers a materially changed actionable speak", async () => {
      const agent = makeAgent(dir);
      const { engine, host } = makeEngine(agent, dir);
      const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;

      queueActs([
        { speak: "Your appointment is tomorrow at 09:00." },
        { speak: "Your appointment is tomorrow at 09:00." },
        { speak: "Your appointment moved to tomorrow at 10:30." },
      ]);

      await engine.tick(agent.id);
      await engine.tick(agent.id);
      await engine.tick(agent.id);

      expect(deliver.mock.calls.map((call: unknown[]) => call[1])).toEqual([
        "Your appointment is tomorrow at 09:00.",
        "Your appointment moved to tomorrow at 10:30.",
      ]);
    });

    it("resets fatigue after user activity without forgetting duplicate suppression", async () => {
      const agent = makeAgent(dir);
      const { engine, host } = makeEngine(agent, dir);
      const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;

      queueActs([{ speak: "Your appointment is tomorrow at 09:00." }]);
      await engine.tick(agent.id);
      engine.noteUserMessage(agent.id);
      queueActs([{ speak: "Your appointment is tomorrow at 09:00." }]);
      await engine.tick(agent.id);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBeUndefined();
    });

    it("persists anti-repeat state owner-only across engine recreation without surfacing silent or note-only acts", async () => {
      const agent = makeAgent(dir);
      const statePath = path.join(dir, "private", "heartbeat-state.json");
      const deliver = vi.fn(async () => true);
      const host = { deliverToAgent: deliver };

      queueActs([{ speak: "Submit the signed form today." }]);
      const first = makeEngine(agent, dir, host, undefined, statePath);
      await first.engine.tick(agent.id);

      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);

      queueActs([
        { speak: "Submit the signed form today." },
        null,
        { note: "Keep the form deadline in private context." },
        { speak: "The signed form deadline moved to tomorrow." },
      ]);
      const recreated = makeEngine(agent, dir, host, undefined, statePath);
      await recreated.engine.tick(agent.id);
      await recreated.engine.tick(agent.id);
      await recreated.engine.tick(agent.id);
      await recreated.engine.tick(agent.id);

      expect(deliver.mock.calls.map((call: unknown[]) => call[1])).toEqual([
        "Submit the signed form today.",
        "The signed form deadline moved to tomorrow.",
      ]);
    });

    it("increments unansweredSpeaks on each speak and skips the third tick", async () => {
      const agent = makeAgent(dir);
      const { engine, host, events } = makeEngine(agent, dir);
      const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
      queueActs([{ speak: "hello 1" }, { speak: "hello 2" }, { speak: "hello 3 — should be suppressed" }]);
      await engine.tick(agent.id);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0][1]).toBe("hello 1");
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBe(1);
      await engine.tick(agent.id);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBe(2);
      const sessionsBefore = (PiAgent.createAgentSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      await engine.tick(agent.id);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect((PiAgent.createAgentSession as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sessionsBefore);
      expect((events.log as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => String(c[2]).includes("hello 3"))).toBe(false);
    });
    it("suppresses a valueless status-report speak as silence (2026-09-22 11:49 incident)", async () => {
      const agent = makeAgent(dir);
      const { engine, host, events } = makeEngine(agent, dir);
      const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
      queueActs([
        { speak: "The agent's heartbeat at Tuesday 11:49 AM. No immediate action needed. Let me know if there's something you need to address. ––" },
        { speak: "Your appointment is tomorrow at 09:00." },
      ]);

      await engine.tick(agent.id);
      expect(deliver).not.toHaveBeenCalled(); // status-report filler is silence
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBeUndefined(); // silence ≠ backoff
      expect((events.log as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => String(c[2]).startsWith("(suppressed, valueless)"))).toBe(true);

      await engine.tick(agent.id);
      expect(deliver).toHaveBeenCalledTimes(1); // a real, specific speak still lands
      expect(deliver.mock.calls[0][1]).toBe("Your appointment is tomorrow at 09:00.");
    });

    it("resumes after noteUserMessage", async () => {
      const agent = makeAgent(dir);
      const { engine, host } = makeEngine(agent, dir);
      const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
      queueActs([{ speak: "ping 1" }, { speak: "ping 2" }]);
      await engine.tick(agent.id);
      await engine.tick(agent.id);
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBe(2);
      queueActs([{ speak: "blocked" }]);
      await engine.tick(agent.id);
      expect(deliver).toHaveBeenCalledTimes(2);
      engine.noteUserMessage(agent.id);
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBeUndefined();
      queueActs([{ speak: "after user reply" }]);
      await engine.tick(agent.id);
      expect(deliver).toHaveBeenCalledTimes(3);
      expect(deliver.mock.calls[2][1]).toBe("after user reply");
    });
    it("does not increment on silent or escalate ticks (so backoff counts speaks only)", async () => {
      const agent = makeAgent(dir);
      const { engine, host } = makeEngine(agent, dir);
      const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
      const escalate = host.escalateToAgent as ReturnType<typeof vi.fn>;
      queueActs([null]);
      await engine.tick(agent.id);
      expect(deliver).not.toHaveBeenCalled();
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBeUndefined();
      queueActs([{ escalate: "needs full brain" }]);
      await engine.tick(agent.id);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBeUndefined();
      queueActs([{ note: "private note" }]);
      await engine.tick(agent.id);
      expect(deliver).not.toHaveBeenCalled();
      expect(escalate).toHaveBeenCalledTimes(1);
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBeUndefined();
      queueActs([{ speak: "s1" }, { speak: "s2" }]);
      await engine.tick(agent.id);
      await engine.tick(agent.id);
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBe(2);
      queueActs([{ speak: "s3" }]);
      await engine.tick(agent.id);
      expect(deliver).toHaveBeenCalledTimes(2);
    });
    it("verify noteUserMessage truly resets via a full 2→backoff→reset→speak cycle", async () => {
      const agent = makeAgent(dir);
      const { engine, host } = makeEngine(agent, dir);
      queueActs([{ speak: "a" }, { speak: "b" }]);
      await engine.tick(agent.id);
      await engine.tick(agent.id);
      expect(engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 }).ok).toBe(false);
      engine.noteUserMessage(agent.id);
      expect(engine.shouldTick(agent, { snoozed: false, lastUserMessageAt: 0 }).ok).toBe(true);
      queueActs([{ speak: "c" }]);
      await engine.tick(agent.id);
      expect((host.deliverToAgent as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toBe("c");
      expect((engine as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks.get(agent.id)).toBe(1);
    });
  });

  describe("adaptive wakeups", () => {
    let dir: string;
    beforeEach(() => {
      dir = tmpAgentDir();
      nextActs.length = 0;
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      nextActs.length = 0;
      vi.mocked(PiAgent.createAgentSession).mockClear();
      vi.mocked(PiAgent.getAgentDir).mockClear();
    });

    it("exposes a requested wakeup as ms, consumable once", async () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      queueActs([{ wakeup: "3h" }]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBe(3 * 3600e3);
      expect(engine.takeNextWakeup(agent.id)).toBeNull();
    });

    it("clamps to the global floor and ceiling", async () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      queueActs([{ wakeup: "1m" }]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBe(5 * 60e3);

      queueActs([{ wakeup: "3d" }]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBe(12 * 3600e3);
    });

    it("honors the manifest min/max window", async () => {
      const agent = makeAgent(dir, { heartbeat: { enabled: true, interval: "45m", minInterval: "30m", maxInterval: "4h" } });
      const { engine } = makeEngine(agent, dir);
      queueActs([{ wakeup: "2m" }]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBe(30 * 60e3);

      queueActs([{ wakeup: "8h" }]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBe(4 * 3600e3);
    });

    it("ignores wakeup on brief ticks", async () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      queueActs([{ wakeup: "10m", speak: "brief text" }]);
      await engine.tick(agent.id, { brief: true });
      expect(engine.takeNextWakeup(agent.id)).toBeNull();
    });

    it("does not keep a stale request across ticks", async () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      queueActs([{ wakeup: "2h" }, null]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBe(2 * 3600e3);
      queueActs([{ note: "nothing to see" }]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBeNull();
    });

    it("returns null for garbage or missing wakeup values", async () => {
      const agent = makeAgent(dir);
      const { engine } = makeEngine(agent, dir);
      queueActs([{ wakeup: "banana" }]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBeNull();
      queueActs([{}]);
      await engine.tick(agent.id);
      expect(engine.takeNextWakeup(agent.id)).toBeNull();
    });
  });

  describe("maintenance rotation", () => {
    let dir: string;
    beforeEach(() => {
      dir = tmpAgentDir();
      nextActs.length = 0;
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      nextActs.length = 0;
      vi.mocked(PiAgent.createAgentSession).mockClear();
      vi.mocked(PiAgent.getAgentDir).mockClear();
    });

    it("heartbeat_act maintain persists a durable note and logs a maintenance event", async () => {
      const agent = makeAgent(dir);
      const { engine, events } = makeEngine(agent, dir);
      queueActs([{ maintain: "memory: Anna prefers voice notes" }]);
      await engine.tick(agent.id);
      const file = path.join(dir, "memory", "maintenance.jsonl");
      expect(fs.existsSync(file)).toBe(true);
      const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
      expect(line.note).toContain("voice notes");
      expect(line.ts).toBeTruthy();
      const calls = (events.log as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string, string]>;
      expect(calls.some((c) => c[1] === "maintenance" && c[2].includes("voice notes"))).toBe(true);
    });

    it("services a stale-events item by running the consolidation engine", async () => {
      const agent = makeAgent(dir);
      const consolidation = { consolidate: vi.fn(async () => ({ agentId: agent.id, ok: true, summary: "ok" })) };
      const { engine, events } = makeEngine(agent, dir, {}, undefined, undefined, consolidation);
      queueActs([{ maintain: "consolidate events" }]);
      await engine.tick(agent.id);
      expect(consolidation.consolidate).toHaveBeenCalledWith(agent.id);
      const calls = (events.log as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string, string]>;
      expect(calls.some((c) => c[1] === "maintenance" && c[2].includes("consolidate events"))).toBe(true);
      // the durable journal still gets the note
      expect(fs.existsSync(path.join(dir, "memory", "maintenance.jsonl"))).toBe(true);
    });

    it("consolidation failures never break the tick", async () => {
      const agent = makeAgent(dir);
      const consolidation = { consolidate: vi.fn(async () => { throw new Error("io down"); }) };
      const { engine, events } = makeEngine(agent, dir, {}, undefined, undefined, consolidation);
      queueActs([{ maintain: "consolidate events" }]);
      await engine.tick(agent.id);
      const calls = (events.log as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string, string]>;
      expect(calls.some((c) => c[1] === "system" && c[2].includes("io down"))).toBe(true);
    });

    it("maintain alone does not deliver or escalate", async () => {
      const agent = makeAgent(dir);
      const { engine, host } = makeEngine(agent, dir);
      queueActs([{ maintain: "persona: noticed drift into report mode" }]);
      await engine.tick(agent.id);
      expect((host.deliverToAgent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect((host.escalateToAgent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it("report is included in the digest for heartbeat agents only", () => {
      const schedule = { list: vi.fn(() => []) } as unknown as import("./scheduler.js").Scheduler;
      const events = { tail: vi.fn(() => []) } as unknown as import("./events.js").EventLog;
      const hbAgent = makeAgent(dir);
      expect(buildHeartbeatDigest(hbAgent, schedule, events)).toContain("# Maintenance");
      const plain: LoadedAgent = { id: "other", dir, manifest: { name: "other" } };
      expect(buildHeartbeatDigest(plain, schedule, events)).not.toContain("# Maintenance");
    });
  });

  describe("maintenance panel", () => {
    let dir: string;
    beforeEach(() => {
      dir = tmpAgentDir();
      nextActs.length = 0;
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function utime(p: string, daysAgo: number) {
      const t = new Date(Date.now() - daysAgo * 86_400e3);
      fs.utimesSync(p, t, t);
    }

    it("reports freshness, notes count, and the rotation rule", () => {
      fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
      fs.writeFileSync(path.join(dir, "memory", "MEMORY.md"), "x");
      fs.writeFileSync(path.join(dir, "memory", "notes-placeholder"), "");
      fs.utimesSync(path.join(dir, "memory", "MEMORY.md"), new Date(Date.now() - 2 * 3600e3), new Date(Date.now() - 2 * 3600e3));
      utime(path.join(dir, "AGENTS.md"), 6);
      const panel = buildMaintenancePanel(dir);
      expect(panel).toContain("# Maintenance");
      expect(panel).toContain("AT MOST ONE");
      // under the 24h rotation floor the digest reads current, not service-worthy
      expect(panel).toContain("current (updated 2h ago)");
      expect(panel).toContain("MEMORY.md");
      // past the floor: explicit STALE, still mtime-anchored
      expect(panel).toContain("STALE 6d ago");
      expect(panel).toMatch(/AGENTS\.md/);
      expect(panel).toMatch(/6d ago/);
    });

    it("24h rotation floor: same mtime reads current below the floor, stale above it", () => {
      fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
      fs.writeFileSync(path.join(dir, "memory", "MEMORY.md"), "x");
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "x");
      utime(path.join(dir, "memory", "MEMORY.md"), 0.9); // ~21.6h — under the floor
      utime(path.join(dir, "AGENTS.md"), 1.1); // ~26h — past it
      const panel = buildMaintenancePanel(dir);
      expect(panel).toContain("current (updated 21h ago)");
      expect(panel).toContain("STALE 26h ago");
      expect(panel).not.toContain("STALE 22h");
    });

    it("marks missing files and shows the last maintenance entry", () => {
      fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
      const journal = path.join(dir, "memory", "maintenance.jsonl");
      const ts = new Date(Date.now() - 5 * 3600e3).toISOString();
      fs.writeFileSync(journal, JSON.stringify({ ts, note: "memory: consolidated calendar lessons" }) + "\n");
      const panel = buildMaintenancePanel(dir);
      expect(panel).toContain("(missing)");
      expect(panel).toContain("last maintenance");
      expect(panel).toContain("consolidated calendar lessons");
      expect(panel).toMatch(/5h ago/);
    });

    it("shows the events-consolidation freshness line", () => {
      const panel = buildMaintenancePanel(dir);
      expect(panel).toContain("events consolidation");
      expect(panel).toContain('maintain: "consolidate events"');
      // a manifest disabling consolidation hides the line
      fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ name: "x", consolidation: { enabled: false } }));
      const panel2 = buildMaintenancePanel(dir);
      expect(panel2).not.toContain("events consolidation");
    });

    it("handles empty agents without crashing", () => {
      const empty = fs.mkdtempSync(path.join(path.dirname(dir), "pibot-empty-"));
      try {
        const panel = buildMaintenancePanel(empty);
        expect(panel).toContain("(missing)");
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe("ghost-write verification", () => {
    let dir: string;
    beforeEach(() => {
      dir = tmpAgentDir();
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("verifyMemoryClaim: fresh mtime verifies; stale or missing file flags a ghost write", () => {
      const mem = path.join(dir, "memory");
      // claim with no file behind it — the Aug 30 signature
      expect(verifyMemoryClaim(dir, "memory: seeded MEMORY.md (was missing)")?.verified).toBe(false);
      fs.mkdirSync(mem, { recursive: true });
      fs.writeFileSync(path.join(mem, "MEMORY.md"), "x");
      expect(verifyMemoryClaim(dir, "memory: refreshed MEMORY.md (was stale)")?.verified).toBe(true);
      const old = new Date(Date.now() - 14 * 86_400e3);
      fs.utimesSync(path.join(mem, "MEMORY.md"), old, old);
      const ghost = verifyMemoryClaim(dir, "memory: refreshed MEMORY.md (was 14d stale)");
      expect(ghost?.verified).toBe(false);
      expect(ghost?.detail).toMatch(/ghost write/);
    });

    it("verifyMemoryClaim: ignores notes without a MEMORY.md write claim", () => {
      expect(verifyMemoryClaim(dir, "memory: consolidated calendar lessons")).toBeNull();
      expect(verifyMemoryClaim(dir, "memory: MEMORY.md reads nicely today")).toBeNull();
    });

    it("recordMaintenanceNote appends a verification entry for ghost claims", () => {
      fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
      recordMaintenanceNote(dir, "memory: seeded MEMORY.md (was missing)");
      const lines = fs.readFileSync(path.join(dir, "memory", "maintenance.jsonl"), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const v = JSON.parse(lines[1]) as { type: string; verified: boolean };
      expect(v.type).toBe("verify");
      expect(v.verified).toBe(false);
    });

    it("panel surfaces an unverified claim in the last-maintenance line", () => {
      fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "memory", "maintenance.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), type: "verify", claim: "memory: refreshed MEMORY.md (was 14d stale)", verified: false, detail: "ghost" }) + "\n",
      );
      const panel = buildMaintenancePanel(dir);
      expect(panel).toContain("UNVERIFIED");
      expect(panel).toContain("refreshed MEMORY.md");
    });

    it("panel memory line carries the memory_save hint", () => {
      const panel = buildMaintenancePanel(dir);
      expect(panel).toContain("memory_save does NOT refresh this line");
    });
  });
});

describe("nudge-rating governor", () => {
  it("up resets backoff; down increments it and schedules a longer wakeup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-nudge-"));
    const agent = makeAgent(dir);
    const { engine, host } = makeEngine(agent, dir);
    (host.deliverToAgent as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    // a proactive speak puts the agent at 1 unanswered
    queueActs([{ speak: "research signals are live" }]);
    void engine.tick(agent.id).then(() => {
      expect(engine.unansweredFor(agent.id)).toBe(1);
      // 👎 → 2 unanswered + pending wakeup stretched to interval × 1.5 (45m → 67.5m)
      engine.noteNudgeRating(agent.id, false);
      expect(engine.unansweredFor(agent.id)).toBe(2);
      expect(engine.takeNextWakeup(agent.id)).toBe(45 * 60e3 * 1.5);
      // 👍 resets
      engine.noteNudgeRating(agent.id, true);
      expect(engine.unansweredFor(agent.id)).toBe(0);
      expect(engine.takeNextWakeup(agent.id)).toBeNull();
    });
  });
});

describe("HeartbeatEngine escalation-loop triage (bd: pibot-3w03)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpAgentDir();
    nextActs.length = 0;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    nextActs.length = 0;
    vi.mocked(PiAgent.createAgentSession).mockClear();
    vi.mocked(PiAgent.getAgentDir).mockClear();
  });

  const t = (e: HeartbeatEngine) => e as unknown as { tickInner: (a: LoadedAgent, o?: { brief?: boolean }) => Promise<void> };

  it("delivers similar escalations until threshold, then suppresses and files dev triage once", async () => {
    const agent = makeAgent(dir, { model: "anthropic/claude-opus-4-6", providers: ["anthropic"] });
    const { engine, host, events } = makeEngine(agent, dir);
    const fileDevTriage = vi.fn(async (_agentId: string, _signature: string) => {});
    (host as HeartbeatHost).fileDevTriage = fileDevTriage;
    // creator Oct 22-23 wording variants — inflected, re-worded, numbered
    queueActs([
      null,
      { escalate: "Тик снова без инструментов (3-й подряд) — рендер от 16:15 ждёт проверки" },
      { escalate: "Тик снова мёртв по инструментам: task_status, agent_message все not found уже 4-й раз подряд" },
      { escalate: "Кратко: тик снова без инструментов (6-й подряд) — рендер и AGENTS.md всё ещё ждут рабочего тика" },
      { escalate: "Кратко: тик снова без инструментов (7-й подряд) — рендер и AGENTS.md всё ещё ждут рабочего тика" },
    ]);
    const tick = () => t(engine).tickInner(agent, {});
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();
    expect(host.escalateToAgent).toHaveBeenCalledTimes(2);
    expect(fileDevTriage).toHaveBeenCalledTimes(1);
    expect(fileDevTriage.mock.calls[0][0]).toBe("assistant");
    expect(String(fileDevTriage.mock.calls[0][1])).toContain("инструмент");
    const logs = (events.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[2]));
    expect(logs.some((l) => l.includes("(suppressed, escalation loop 3x, triaged=now)"))).toBe(true);
    expect(logs.some((l) => l.includes("triaged=earlier"))).toBe(true);
  });

  it("a genuinely different escalation escapes the loop and delivers", async () => {
    const agent = makeAgent(dir, { model: "anthropic/claude-opus-4-6", providers: ["anthropic"] });
    const { engine, host, events } = makeEngine(agent, dir);
    const fileDevTriage = vi.fn(async (_agentId: string, _signature: string) => {});
    (host as HeartbeatHost).fileDevTriage = fileDevTriage;
    queueActs([
      { escalate: "Тик без инструментов: рендер ждёт проверки, исполнители недоступны" },
      { escalate: "Тик без инструментов: рендер ждёт проверки, исполнители недоступны, 2-й раз" },
      { escalate: "Утренний брифинг не уехал из-за сбоя календаря — проверить подключение" },
      { escalate: "Тик без инструментов: рендер ждёт проверки, исполнители недоступны, 3-й раз" },
    ]);
    const tick = () => t(engine).tickInner(agent, {});
    await tick();
    await tick();
    await tick();
    await tick();
    expect(host.escalateToAgent).toHaveBeenCalledTimes(3);
    // the off-topic escalation resets the tool loop: threshold not yet reached after it
    expect(fileDevTriage).toHaveBeenCalledTimes(1);
    const logs = (events.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[2]));
    expect(logs.some((l) => l.includes("(suppressed, escalation loop 3x, triaged=now)"))).toBe(true);
  });

  it("after the cooldown the same escalation starts a fresh loop that delivers again", async () => {
    const agent = makeAgent(dir, { model: "anthropic/claude-opus-4-6", providers: ["anthropic"] });
    const { engine, host } = makeEngine(agent, dir);
    queueActs([
      { escalate: "Тик без инструментов: рендер ждёт проверки" },
      { escalate: "Тик без инструментов: рендер ждёт проверки, повтор" },
      { escalate: "Тик без инструментов: рендер ждёт проверки, третий тик" },
    ]);
    const tick = () => t(engine).tickInner(agent, {});
    await tick();
    await tick();
    await tick();
    expect(host.escalateToAgent).toHaveBeenCalledTimes(2);
    // simulate cooldown expiry on the persisted/loop state
    const engineState = (engine as unknown as { escalationLoop: Map<string, EscalationLoopState> }).escalationLoop.get(agent.id);
    expect(engineState?.loops[0]?.count).toBe(3);
    (engine as unknown as { escalationLoop: Map<string, EscalationLoopState> }).escalationLoop.set(agent.id, {
      loops: engineState!.loops.map((l) => ({ ...l, triagedUntil: Date.now() - 1 })),
    });
    queueActs([{ escalate: "Тик без инструментов: рендер ждёт проверки, снова" }]);
    await tick();
    expect(host.escalateToAgent).toHaveBeenCalledTimes(3);
  });

  it("escalation fingerprints tolerate inflection but separate different topics (pure fns)", () => {
    const a = "Тик без инструментов (6-й подряд) — рендер ждёт";
    const b = "тики без инструментов подряд — рендер ждёт рабочего тика";
    const c = "деньги пришли на счёт: счёт-фактура 2026 от клиента";
    expect(triageEscalationLoop(undefined, a, 1).matchedCount).toBe(1);
    const st = triageEscalationLoop(triageEscalationLoop(undefined, a, 1).next, b, 2);
    expect(st.matchedCount).toBe(2);
    expect(escalationsSimilar(a, b)).toBe(true);
    expect(escalationsSimilar(a, c)).toBe(false);
  });
});

describe("passive bd-ticket pickup (bd: pibot-3w03)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpAgentDir();
    nextActs.length = 0;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    nextActs.length = 0;
    vi.mocked(PiAgent.createAgentSession).mockClear();
    vi.mocked(PiAgent.getAgentDir).mockClear();
  });

  it("digest shows the assigned-tickets panel only when tickets exist", () => {
    const agent = makeAgent(dir, { model: "anthropic/claude-opus-4-6", providers: ["anthropic"] });
    const scheduler = { list: vi.fn(() => []) } as unknown as import("./scheduler.js").Scheduler;
    const events = { tail: vi.fn(() => []) } as unknown as import("./events.js").EventLog;
    const without = buildHeartbeatDigest(agent, scheduler, events);
    expect(without).not.toContain("Bd tickets assigned to you");
    const withTickets = buildHeartbeatDigest(agent, scheduler, events, undefined, [
      { id: "pibot-3w03", title: "triage lane for stuck agents" },
      { id: "pibot-gahj", title: "another open ticket" },
    ]);
    expect(withTickets).toContain("# Bd tickets assigned to you");
    expect(withTickets).toContain("- pibot-3w03: triage lane for stuck agents");
    expect(withTickets).toContain("service <ticket-id>");
  });

  it("a passive tick with an assigned ticket escalates service into the main session", async () => {
    const agent = makeAgent(dir, { model: "anthropic/claude-opus-4-6", providers: ["anthropic"] });
    const seen: string[] = [];
    const acts = [
      { escalate: "service pibot-3w03: verify capability-refresh wiring and close the ticket" },
    ];
    nextActs.length = 0;
    nextActs.push(...(acts as never[]));
    const { engine, host } = makeEngine(agent, dir, {}, undefined, undefined, undefined);
    // bdAssigned feeds the digest
    (engine as unknown as { deps: { bdAssigned: (id: string) => Promise<{ id: string; title: string }[]> } }).deps.bdAssigned =
      vi.fn(async () => [{ id: "pibot-3w03", title: "triage lane for stuck agents" }]);
    const t = (e: HeartbeatEngine) => e as unknown as { tickInner: (a: LoadedAgent, o?: { brief?: boolean }) => Promise<void> };
    // capture the prompt text the tick sends
    vi.mocked(PiAgent.createAgentSession).mockImplementationOnce(async (opts: unknown) => {
      const o = opts as { customTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> };
      const actTool = o.customTools?.find((t) => t.name === "heartbeat_act");
      const payload = nextActs.shift();
      return {
        session: {
          prompt: async (text?: string) => {
            seen.push(String(text));
            if (actTool && payload) await actTool.execute("test-id", payload as never);
          },
          dispose() {},
          agent: { state: { messages: [] } },
        },
        modelFallbackMessage: undefined,
      } as never;
    });
    await t(engine).tickInner(agent, {});
    expect(seen[0]).toContain("# Bd tickets assigned to you");
    expect(seen[0]).toContain("- pibot-3w03: triage lane for stuck agents");
    expect(host.escalateToAgent).toHaveBeenCalledTimes(1);
    expect(String((host.escalateToAgent as ReturnType<typeof vi.fn>).mock.calls[0][1])).toContain("service pibot-3w03");
  });

  it("bd lookup failure never breaks a tick (panel simply omitted)", async () => {
    const agent = makeAgent(dir, { model: "anthropic/claude-opus-4-6", providers: ["anthropic"] });
    const { engine, host } = makeEngine(agent, dir);
    const t = (e: HeartbeatEngine) => e as unknown as { tickInner: (a: LoadedAgent, o?: { brief?: boolean }) => Promise<void> };
    (engine as unknown as { deps: { bdAssigned: (id: string) => Promise<never> } }).deps.bdAssigned = vi.fn(async () => {
      throw new Error("bd missing");
    });
    queueActs([{ note: "calm tick" }]);
    await t(engine).tickInner(agent, {});
    expect(host.escalateToAgent).not.toHaveBeenCalled();
  });
});

// ─── bd pibot-wr9m: the date guard is exercised at the ACTUAL delivery path ────
// Frozen system dates + the real tick with a stubbed model/transport. The guard
// must silence a wrong relative date BEFORE emission, never append a warning.
describe("heartbeat speak date guard at the delivery path (bd pibot-wr9m)", () => {
  let dir: string;
  // 2026-10-26 08:32 Europe/Berlin (CET = UTC+1) — the exact observed moment Nov 2 was called "today"
  const OCT26 = Date.UTC(2026, 9, 26, 7, 32);
  const unanswered = (e: HeartbeatEngine) => (e as unknown as { unansweredSpeaks: Map<string, number> }).unansweredSpeaks;
  const fingerprints = (e: HeartbeatEngine) => (e as unknown as { lastSpeakFingerprint: Map<string, string> }).lastSpeakFingerprint;

  beforeEach(() => {
    dir = tmpAgentDir();
    nextActs.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(OCT26));
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
    nextActs.length = 0;
    vi.mocked(PiAgent.createAgentSession).mockClear();
    vi.mocked(PiAgent.getAgentDir).mockClear();
  });

  it("suppresses an English 'today, November 2' speak before emission and does not mark it delivered", async () => {
    const agent = makeAgent(dir);
    const { engine, host, events } = makeEngine(agent, dir);
    const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
    queueActs([
      { speak: "The deadline is today, November 2." },
      { speak: "The November 2 deadline is in 7 days." },
    ]);
    await engine.tick(agent.id);
    expect(deliver).not.toHaveBeenCalled(); // silenced, not warned
    expect(unanswered(engine).get(agent.id)).toBeUndefined(); // a suppressed speak is NOT delivered
    expect(fingerprints(engine).has(agent.id)).toBe(false);
    await engine.tick(agent.id);
    expect(deliver.mock.calls.map((c: unknown[]) => c[1])).toEqual(["The November 2 deadline is in 7 days."]);
    expect(unanswered(engine).get(agent.id)).toBe(1);
    const logs = (events.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[2]));
    expect(logs.some((l) => l.startsWith("(suppressed, date mismatch)"))).toBe(true);
  });

  it("suppresses the Russian 'сегодня, 2 ноября' and the dotted numeric form", async () => {
    const agent = makeAgent(dir);
    const { engine, host } = makeEngine(agent, dir);
    const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
    queueActs([
      { speak: "Дедлайн — сегодня, 2 ноября." },
      { speak: "Дедлайн — сегодня, 02.11.2026." },
      { speak: "Дедлайн — через 7 дней, 02.11.2026." },
    ]);
    await engine.tick(agent.id);
    await engine.tick(agent.id);
    await engine.tick(agent.id);
    expect(deliver.mock.calls.map((c: unknown[]) => c[1])).toEqual(["Дедлайн — через 7 дней, 02.11.2026."]);
  });

  it("keeps housekeeping (maintain journal + requested wakeup) while only the speak is suppressed", async () => {
    const agent = makeAgent(dir);
    const { engine, host } = makeEngine(agent, dir);
    const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
    queueActs([{ maintain: "memory: rotated the journal", wakeup: "2h", speak: "The deadline is today, November 2." }]);
    await engine.tick(agent.id);
    expect(deliver).not.toHaveBeenCalled();
    expect(engine.takeNextWakeup(agent.id)).toBe(2 * 3600e3); // wakeup still applied
    expect(fs.existsSync(path.join(dir, "memory", "maintenance.jsonl"))).toBe(true); // note still written
  });

  it("stays correct across the Europe/Berlin DST change (2026-10-25 23:30 UTC is already Oct 26 local)", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 25, 23, 30)));
    const agent = makeAgent(dir);
    const { engine, host } = makeEngine(agent, dir);
    const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
    queueActs([
      { speak: "The deadline is today, November 2." }, // local day is Oct 26, so this is wrong
      { speak: "The deadline is in 7 days, November 2." },
    ]);
    await engine.tick(agent.id);
    await engine.tick(agent.id);
    expect(deliver.mock.calls.map((c: unknown[]) => c[1])).toEqual(["The deadline is in 7 days, November 2."]);
  });

  it("delivers prose where 'today' merely co-occurs with a date — no false suppression (bd pibot-wr9m review)", async () => {
    const agent = makeAgent(dir);
    const { engine, host } = makeEngine(agent, dir);
    const deliver = host.deliverToAgent as ReturnType<typeof vi.fn>;
    queueActs([
      { speak: "Today I checked the page for the November 2 deadline." },
      { speak: "Сегодня проверил страницу: дедлайн 2 ноября." },
    ]);
    await engine.tick(agent.id);
    await engine.tick(agent.id);
    expect(deliver.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      "Today I checked the page for the November 2 deadline.",
      "Сегодня проверил страницу: дедлайн 2 ноября.",
    ]);
  });
});

describe("buildHeartbeatDigest — computed relative wording in the named zone (bd pibot-wr9m)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpAgentDir();
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function digestFor(dueAt: number): string {
    const agent = makeAgent(dir);
    const scheduler = { list: vi.fn(() => [{ id: "1", title: "Deadline", dueAt, internal: false, wake: "important" }]) } as unknown as import("./scheduler.js").Scheduler;
    const events = { tail: vi.fn(() => []) } as unknown as import("./events.js").EventLog;
    return buildHeartbeatDigest(agent, scheduler, events);
  }

  it("renders the absolute date + exact Berlin clock + a computed relative phrase, never a bare 'today'", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 26, 7, 32))); // Oct 26 Berlin
    const digest = digestFor(Date.UTC(2026, 10, 2, 9, 0)); // Nov 2 09:00 UTC = 10:00 Berlin
    expect(digest).toContain('"Deadline" — 2026-11-02 10:00 (in 7 days) (!important)');
    expect(digest).not.toMatch(/\btoday\b/);
  });

  it("keeps the exact Berlin due clock beside the relative wording so a same-day reminder stays actionable", () => {
    // 2026-11-02 08:00 UTC = 09:00 Europe/Berlin; "today" alone would lose the time to act on.
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 2, 6, 0))); // 07:00 Berlin, before the due time
    const digest = digestFor(Date.UTC(2026, 10, 2, 8, 0));
    expect(digest).toContain("2026-11-02 09:00 (today)");
  });

  it("derives urgency in the NAMED zone, not the machine's (DST-safe)", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 25, 23, 30))); // = Oct 26 00:30 Berlin
    expect(digestFor(Date.UTC(2026, 10, 2, 9, 0))).toContain("2026-11-02 10:00 (in 7 days)"); // 8 under a UTC machine zone
  });
});
