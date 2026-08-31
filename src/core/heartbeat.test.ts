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

import { buildHeartbeatDigest, buildMaintenancePanel, HeartbeatEngine } from "./heartbeat.js";
import { appendBacklogItems, loadBacklogItems } from "./backlog.js";
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
  const host: HeartbeatHost = { deliverToAgent: vi.fn(async () => {}), escalateToAgent: vi.fn(async () => {}), lastUserMessageAt: vi.fn(() => 0), ...over };
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
      const deliver = vi.fn(async () => {});
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
      expect(panel).toContain("MEMORY.md");
      expect(panel).toMatch(/2h ago/);
      expect(panel).toMatch(/AGENTS\.md/);
      expect(panel).toMatch(/6d ago/);
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
});
