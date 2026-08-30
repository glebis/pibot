import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { nextActs } = vi.hoisted(() => ({ nextActs: [] as Array<null | { speak?: string; escalate?: string; note?: string }> }));

function queueActs(acts: Array<null | { speak?: string; escalate?: string; note?: string }>) {
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

import { HeartbeatEngine } from "./heartbeat.js";
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
function makeEngine(agent: LoadedAgent, dir: string, over: Partial<HeartbeatHost> = {}, cascade?: import("./cascade.js").ModelCascade) {
  const agents = { getAgent: vi.fn((id: string) => (id === agent.id ? agent : undefined)), heartbeatModel: vi.fn(() => undefined), resolveModel: vi.fn(() => undefined) } as unknown as import("./agent-manager.js").AgentManager;
  const scheduler = { snoozeState: vi.fn(() => null), list: vi.fn(() => []) } as unknown as import("./scheduler.js").Scheduler;
  const events = { log: vi.fn(), tail: vi.fn(() => []) } as unknown as import("./events.js").EventLog;
  const host: HeartbeatHost = { deliverToAgent: vi.fn(async () => {}), escalateToAgent: vi.fn(async () => {}), lastUserMessageAt: vi.fn(() => 0), ...over };
  const modelRuntime = {} as PiAgent.ModelRuntime;
  const engine = new HeartbeatEngine({ agents, scheduler, modelRuntime, events, vaultDir: dir, host, cascade });
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
});
