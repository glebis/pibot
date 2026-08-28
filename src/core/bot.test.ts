import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiBot } from "./bot.js";
import type { AgentManager } from "./agent-manager.js";
import type { EventLog } from "./events.js";
import type { HeartbeatEngine } from "./heartbeat.js";
import type { Scheduler } from "./scheduler.js";
import type { Config } from "../config.js";
import type { PushOptions, Schedule, Transport } from "./types.js";

// ─── fakes ──────────────────────────────────────────────────────────────────

class MockTransport implements Transport {
  readonly name: string;
  readonly chatId = "42";
  pushed: Array<{ chatId: string; opts: PushOptions }> = [];
  typing: Array<[string, boolean]> = [];
  messageCb: ((text: string, chatId: string) => Promise<void>) | null = null;
  actionCb: ((action: string, chatId: string) => Promise<void>) | null = null;

  constructor(name = "mock") {
    this.name = name;
  }

  async start() {}
  async stop() {}
  async push(chatId: string, opts: PushOptions): Promise<void> {
    this.pushed.push({ chatId, opts });
  }
  async notifyError(chatId: string, message: string): Promise<void> {
    this.pushed.push({ chatId, opts: { text: `⚠︎ ${message}` } });
  }
  onMessage(cb: (text: string, chatId: string) => Promise<void>): void {
    this.messageCb = cb;
  }
  onAction(cb: (action: string, chatId: string) => Promise<void>): void {
    this.actionCb = cb;
  }
  setTyping(chatId: string, on: boolean): void {
    this.typing.push([chatId, on]);
  }
  lastText(): string {
    return this.pushed.at(-1)?.opts.text ?? "";
  }
  lastCard(): { label: string; action: string }[] | undefined {
    return this.pushed.at(-1)?.opts.card?.buttons;
  }
  async say(text: string): Promise<void> {
    await this.messageCb?.(text, this.chatId);
  }
  async act(action: string): Promise<void> {
    await this.actionCb?.(action, this.chatId);
  }
}

function fakeAgentManager(promptSpy = vi.fn()) {
  const fakeSession = {
    prompt: promptSpy.mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as AgentSession;
  return {
    createAgent: vi.fn(() => undefined),
    discover: vi.fn(async () => {}),
    getOrCreateSession: vi.fn(async () => fakeSession),
    getAgent: vi.fn((id: string) =>
      id === "assistant" || id === "fitness"
        ? { id, dir: `/tmp/fake-${id}`, manifest: { name: id, description: "d", heartbeat: { enabled: true, interval: "45m" }, evolution: { enabled: true, interval: "6h" } } }
        : undefined
    ),
    list: vi.fn(() => [{ id: "assistant", dir: "/x", manifest: { name: "assistant" } }]),
    defaultAgentId: () => "assistant",
  } as unknown as AgentManager;
}

function makeBot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-bot-"));
  const config: Config = {
    transport: "cli",
    dataDir: dir,
    agentsDir: dir,
    vaultDir: path.join(dir, "vault"),
    defaultAgentId: "assistant",
    allowedChats: [],
  };
  const promptSpy = vi.fn();
  const agents = fakeAgentManager(promptSpy);
  const heartbeat = { tick: vi.fn(async () => {}) } as unknown as HeartbeatEngine;
  const events = { log: vi.fn(), tail: vi.fn(() => []) } as unknown as EventLog;
  const scheduler = {
    create: vi.fn((job: Omit<Schedule, "id"> & { id?: string }) => ({ id: job.id ?? "sc_x", ...job }) as Schedule),
    ensure: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    reschedule: vi.fn(),
    list: vi.fn(() => [] as Schedule[]),
    snooze: vi.fn(() => ({ until: Date.now() + 3600e3, reason: "manual" })),
    unsnooze: vi.fn(() => true),
    unsnoozeAll: vi.fn(() => ["assistant"]),
    snoozeState: vi.fn(() => null),
    takePendingCards: vi.fn(() => [] as Schedule[]),
  } as unknown as Scheduler;

  const transport = new MockTransport();
  const bot = new PiBot({ config, agents, scheduler, heartbeat, events, transports: [transport], secrets: { get: () => ({}), save: async () => {} } as never });
  return { bot, transport, agents, scheduler, heartbeat, events, promptSpy, dir };
}

describe("PiBot commands", () => {
  let t: ReturnType<typeof makeBot>;

  beforeEach(() => {
    t = makeBot();
  });

  afterEach(() => {
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("answers /help", async () => {
    await t.transport.say("/help");
    expect(t.transport.lastText()).toContain("/agents");
  });

  it("replies to unknown commands", async () => {
    await t.transport.say("/frobnicate");
    expect(t.transport.lastText()).toContain("Unknown /frobnicate");
  });

  it("/snooze snoozes the current agent and /wake resumes", async () => {
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "assistant" ? { id: "assistant", dir: "/x", manifest: { name: "assistant", heartbeat: { enabled: true, interval: "45m" } } } : undefined
    );
    await t.transport.say("/snooze 2h");
    expect(t.scheduler.snooze).toHaveBeenCalledWith("assistant", expect.any(Number), "manual", undefined);
    expect(t.transport.lastText()).toContain("paused");

    await t.transport.say("/wake");
    expect(t.scheduler.unsnoozeAll).toHaveBeenCalled();
    expect(t.transport.lastText()).toContain("resumed");
  });

  it("/snooze rejects unparseable durations", async () => {
    await t.transport.say("/snooze a while");
    expect(t.transport.lastText()).toContain("Couldn't parse");
    expect(t.scheduler.snooze).not.toHaveBeenCalled();
  });

  it("/schedules lists pending items", async () => {
    (t.scheduler.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "sc1", agentId: "assistant", chat: { transport: "mock", chatId: "42" }, title: "stretch", kind: "reminder", dueAt: Date.now() + 60e3, wake: "normal", delivery: "direct", status: "pending", createdAt: 0, firedCount: 0 },
    ]);
    await t.transport.say("/schedules");
    expect(t.transport.lastText()).toContain("sc1");
    expect(t.transport.lastText()).toContain("stretch");
  });

  it("routes plain messages to the agent with a time envelope", async () => {
    await t.transport.say("hello there");
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    const arg = t.promptSpy.mock.calls[0][0] as string;
    expect(arg.startsWith("[")).toBe(true);
    expect(arg).toContain("hello there");
  });

  it("switches agents with /agent", async () => {
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "coach" ? { id: "coach", dir: "/y", manifest: { name: "coach" } } : undefined
    );
    await t.transport.say("/agent coach");
    expect(t.transport.lastText()).toContain("Switched to");

    // subsequent messages go to the new agent
    await t.transport.say("hi");
    expect((t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("coach");
  });

  it("rejects switching to unknown agents", async () => {
    await t.transport.say("/agent ghost");
    expect(t.transport.lastText()).toContain("No agent");
  });
});

describe("PiBot card actions", () => {
  it("reschedules +10m / cancels / acks", async () => {
    const t = makeBot();
    const job = { id: "sc1", agentId: "assistant", title: "stretch", kind: "reminder", status: "pending" } as Schedule;

    (t.scheduler.get as ReturnType<typeof vi.fn>).mockReturnValue(job);
    (t.scheduler.reschedule as ReturnType<typeof vi.fn>).mockReturnValue({ ...job, dueAt: Date.now() + 600e3 });

    await t.transport.act("scd:sc1:+10m");
    expect(t.scheduler.reschedule).toHaveBeenCalledWith("sc1", expect.any(Number));
    expect(t.transport.lastText()).toContain("stretch");
    expect(t.transport.lastText()).toContain("in 10 min");

    await t.transport.act("scd:sc1:ok");
    expect(t.transport.lastText()).toContain("Locked in");

    (t.scheduler.cancel as ReturnType<typeof vi.fn>).mockReturnValue(job);
    await t.transport.act("scd:sc1:cancel");
    expect(t.scheduler.cancel).toHaveBeenCalledWith("sc1");
    expect(t.transport.lastText()).toContain("Cancelled");
  });

  it("says so when the item is gone", async () => {
    const t = makeBot();
    (t.scheduler.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    await t.transport.act("scd:gone:ok");
    expect(t.transport.lastText()).toContain("already gone");
  });
});

describe("PiBot fire delivery", () => {
  it("direct delivery pushes a formatted card", async () => {
    const t = makeBot();
    await t.bot.deliverFire(
      {
        id: "sc1", agentId: "assistant", chat: { transport: "mock", chatId: "42" },
        title: "stretch", kind: "reminder", dueAt: Date.now(), wake: "normal",
        delivery: "direct", status: "pending", createdAt: 0, firedCount: 1,
      },
      false
    );
    expect(t.transport.lastText()).toContain("stretch");
    expect(t.transport.lastCard()?.map((b) => b.label)).toEqual(["⏰ +10m", "🕒 +1h", "🗑 Done"]);
  });

  it("agent delivery prompts the agent instead", async () => {
    const t = makeBot();
    await t.bot.deliverFire(
      {
        id: "sc2", agentId: "assistant", chat: { transport: "mock", chatId: "42" },
        title: "compose me", kind: "subject", dueAt: Date.now(), wake: "normal",
        delivery: "agent", status: "pending", createdAt: 0, firedCount: 1,
      },
      false
    );
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    const arg = t.promptSpy.mock.calls[0][0] as string;
    expect(arg).toContain("[scheduler]");
    expect(arg).toContain("compose me");
  });

  it("heartbeat jobs tick the heartbeat engine", async () => {
    const t = makeBot();
    await t.bot.deliverFire(
      {
        id: "hb:assistant", agentId: "assistant", chat: { transport: "internal", chatId: "heartbeat" },
        title: "heartbeat", kind: "heartbeat", dueAt: Date.now(), wake: "normal",
        delivery: "direct", status: "pending", createdAt: 0, firedCount: 1, internal: true,
      },
      false
    );
    expect(t.heartbeat.tick).toHaveBeenCalledWith("assistant");
  });

  it("heartbeat speak reaches all chats of the agent", async () => {
    const t = makeBot();
    await t.transport.say("ping"); // registers chat
    t.transport.pushed.length = 0;
    await t.bot.deliverToAgent("assistant", "good morning ✨");
    expect(t.transport.lastText()).toBe("good morning ✨");
  });

  it("escalations route into the main session", async () => {
    const t = makeBot();
    await t.transport.say("ping");
    t.promptSpy.mockClear();
    await t.bot.escalateToAgent("assistant", "the user seems stressed, check in");
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    expect(String(t.promptSpy.mock.calls[0][0])).toContain("[heartbeat]");
  });
});
describe("PiBot question interception", () => {
  function spec() {
    return { text: "Which account?", options: ["client", "personal", "own-account", "unsure"] };
  }

  it("text answers a pending question instead of prompting the agent", async () => {
    const t = makeBot();
    const promise = t.bot.askUser("assistant", { transport: "mock", chatId: "42" }, spec());
    await vi.waitFor(() => expect(t.transport.lastCard()).toBeDefined());
    t.promptSpy.mockClear();
    await t.transport.say("personal");
    expect(t.promptSpy).not.toHaveBeenCalled();
    expect(await promise).toMatchObject({ choice: "personal", via: "text" });
  });

  it("button taps resolve pending questions", async () => {
    const t = makeBot();
    const promise = t.bot.askUser("assistant", { transport: "mock", chatId: "42" }, spec());
    await vi.waitFor(() => expect(t.transport.lastCard()).toBeDefined());
    const action = t.transport.lastCard()![1].action;
    t.promptSpy.mockClear();
    await t.transport.act(action);
    expect(t.promptSpy).not.toHaveBeenCalled();
    expect(await promise).toMatchObject({ choice: "personal", index: 1, via: "button" });
  });

  it("slash commands still work while a question is pending", async () => {
    const t = makeBot();
    const promise = t.bot.askUser("assistant", { transport: "mock", chatId: "42" }, spec());
    await vi.waitFor(() => expect(t.transport.lastCard()).toBeDefined());
    await t.transport.say("/status");
    expect(t.transport.pushed.some((p) => p.opts.text.includes("assistant"))).toBe(true);
    
    t.promptSpy.mockClear();
    await t.transport.say("unsure");
    expect(await promise).toMatchObject({ choice: "unsure" });
  });
});

describe("PiBot /newagent wizard", () => {
  it("walks name → job → vibe → proactivity and creates the agent", async () => {
    const t = makeBot();
    await t.transport.say("/newagent");

    // step 1: name
    await vi.waitFor(() => expect(t.transport.pushed.some((p) => p.opts.text.includes("What should I call"))).toBe(true));
    await t.transport.say("fitness");
    // step 2: job
    await vi.waitFor(() => expect(t.transport.pushed.some((p) => p.opts.text.includes("main job"))).toBe(true));
    await t.transport.say("Keeps me moving every day.");
    // step 3: vibe (buttons — tap the second option)
    await vi.waitFor(() => expect(t.transport.lastCard()).toBeDefined());
    await t.transport.act(t.transport.lastCard()![1].action);
    // step 4: proactivity
    await vi.waitFor(() => expect(t.transport.pushed.filter((p) => p.opts.text.includes("How proactive")).length).toBeGreaterThan(0));
    await t.transport.say("quiet — a couple of proactive messages a day");

    // creation happened with persona built from answers
    await vi.waitFor(() => expect(t.agents.createAgent).toHaveBeenCalled());
    expect(t.agents.createAgent).toHaveBeenCalledWith("fitness", expect.stringContaining("Keeps me moving every day."));
    await vi.waitFor(() => expect(t.transport.pushed.some((p) => p.opts.text.includes("Born: **fitness**"))).toBe(true));
    expect(t.transport.pushed.some((p) => p.opts.text.includes("Born: **fitness**"))).toBe(true);
  });
});
