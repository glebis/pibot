import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiBot, parsePendingSubBots } from "./bot.js";
import { MANAGED_BOT_TOKEN_BACKOFF_MS } from "../transports/telegram.js";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import type { EventLog } from "./events.js";
import type { HeartbeatEngine } from "./heartbeat.js";
import type { Scheduler } from "./scheduler.js";
import type { Config } from "../config.js";
import type { ModelCascade } from "./cascade.js";
import type { PushOptions, Transport } from "./types.js";

// ─── pure helpers ───────────────────────────────────────────────────────────

describe("parsePendingSubBots (TTL pruning)", () => {
  const now = 1_800_000_000_000;

  it("keeps fresh entries", () => {
    const out = parsePendingSubBots({ creator: now - 60e3 }, now);
    expect([...out.entries()]).toEqual([["creator", now - 60e3]]);
  });

  it("prunes entries older than 24h", () => {
    const out = parsePendingSubBots({ creator: now - 24 * 3600e3 - 1, fresh: now }, now);
    expect([...out.keys()]).toEqual(["fresh"]);
  });

  it("ignores malformed timestamps", () => {
    const out = parsePendingSubBots({ bad: -1, worse: Number.NaN, str: "x" as never, ok: now }, now);
    expect([...out.keys()]).toEqual(["ok"]);
  });

  it("handles null/undefined raw", () => {
    expect(parsePendingSubBots(undefined, now).size).toBe(0);
  });
});

describe("MANAGED_BOT_TOKEN_BACKOFF_MS", () => {
  it("is monotonic, patient, and covers at least 4 minutes", () => {
    expect(MANAGED_BOT_TOKEN_BACKOFF_MS.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < MANAGED_BOT_TOKEN_BACKOFF_MS.length; i++) {
      expect(MANAGED_BOT_TOKEN_BACKOFF_MS[i]).toBeGreaterThan(MANAGED_BOT_TOKEN_BACKOFF_MS[i - 1]);
    }
    const total = MANAGED_BOT_TOKEN_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(4 * 60e3);
  });
});

// ─── harness ────────────────────────────────────────────────────────────────

type ManagedInfo = { creatorId: string; botId: number; botUsername?: string; firstName?: string };

class FakeTelegramTransport implements Transport {
  readonly name = "telegram";
  readonly chatId = "42";
  managerOn = true;
  pushed: Array<{ chatId: string; opts: PushOptions }> = [];
  messageCb: ((text: string, chatId: string) => Promise<void>) | null = null;
  managedCb: ((info: ManagedInfo) => Promise<void>) | null = null;
  tokenFetch = vi.fn(async () => {
    throw new Error("Call to 'getManagedBotToken' failed! (400: Bad Request: invalid user_id specified)");
  });

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
  onAction(): void {}
  setTyping(): void {}
  botUsername(): string {
    return "@pimother_bot";
  }
  managerMode(): boolean {
    return this.managerOn;
  }
  onManagedBot(cb: (info: ManagedInfo) => Promise<void>): void {
    this.managedBotCb = cb;
  }
  async getManagedBotToken(): Promise<string> {
    return this.tokenFetch();
  }
  setManagedBotAccessSettings(): Promise<unknown> {
    return Promise.resolve({});
  }
  async fire(info: ManagedInfo): Promise<void> {
    await this.managedBotCb?.(info);
  }
  lastText(): string {
    return this.pushed.at(-1)?.opts.text ?? "";
  }
  private managedBotCb: ((info: ManagedInfo) => Promise<void>) | null = null;
}

function fakeAgentManager() {
  const agents = {
    createAgent: vi.fn(() => undefined),
    discover: vi.fn(async () => {}),
    getOrCreateSession: vi.fn(async () => ({}) as AgentSession),
    getAgent: vi.fn((id: string): LoadedAgent | undefined =>
      id === "assistant" ? { id, dir: "/tmp/fake-assistant", manifest: { name: "assistant", heartbeat: { enabled: true, interval: "45m" } } } : undefined
    ),
    list: vi.fn(() => [{ id: "assistant", dir: "/tmp/fake-assistant", manifest: { name: "assistant" } }] as LoadedAgent[]),
    defaultAgentId: () => "assistant",
  } as unknown as AgentManager;
  return agents;
}

function makeWiringBot(dir: string, transport: FakeTelegramTransport) {
  const config: Config = {
    transport: "cli",
    dataDir: dir,
    agentsDir: dir,
    vaultDir: path.join(dir, "vault"),
    defaultAgentId: "assistant",
    allowedChats: [],
    telegramOpen: false,
  };
  const events = { log: vi.fn(), tail: vi.fn(() => []) } as unknown as EventLog;
  const scheduler = {
    ensure: vi.fn(),
    create: vi.fn((job: Record<string, unknown>) => ({ id: "sc_x", ...job })),
    list: vi.fn(() => []),
    snoozeState: vi.fn(() => null),
  } as unknown as Scheduler;
  const heartbeat = { tick: vi.fn(async () => {}), takeNextWakeup: vi.fn(() => null) } as unknown as HeartbeatEngine;
  const cascade = {
    chainFor: vi.fn(() => [] as string[]),
    firstHealthy: vi.fn(() => ""),
    resolveModel: vi.fn(() => undefined),
    noteFailure: vi.fn(),
    noteSuccess: vi.fn(),
    ensure: undefined,
  } as unknown as ModelCascade;
  const bot = new PiBot({
    config,
    agents: fakeAgentManager(),
    scheduler,
    heartbeat,
    events,
    transports: [transport],
    secrets: { get: () => ({ telegram: { subBots: {} } }), save: async () => {} } as never,
    cascade,
  });
  return { bot, events };
}

describe("managed sub-bot wiring", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-wiring-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("arming a sub-bot creation persists the request across restarts", async () => {
    const tg = new FakeTelegramTransport();
    const { bot } = makeWiringBot(dir, tg);
    await bot.start();
    await tg.messageCb?.("remember me", "42"); // binds the chat → assistant
    await bot.requestSubBotCreation("assistant", { transport: "telegram", chatId: "42" });

    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    expect(state.pendingSubBots.assistant).toBeGreaterThan(0);
  });

  it("restores an armed request after restart, and a failed token fetch notifies + stays armed", async () => {
    const now = Date.now();
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        chats: { "telegram:42": "assistant" },
        agentChats: { assistant: ["telegram:42"] },
        pendingSubBots: { assistant: now - 60e3 },
      })
    );

    const tg = new FakeTelegramTransport();
    const { bot, events } = makeWiringBot(dir, tg);
    await bot.start();

    // restart simulated: the managed-bot update for the never-wired bot arrives
    await tg.fire({ creatorId: "161427550", botId: 8802922531, botUsername: "pimother_assistant_bot" });

    // user is told what went wrong and how recovery works
    console.log("PUSHED:", JSON.stringify(tg.pushed.map((p) => p.opts.text?.slice(0, 40))));
    console.log("EVENTS:", JSON.stringify((events.log as ReturnType<typeof vi.fn>).mock.calls.slice(0, 5)));
    console.log("PENDING:", JSON.stringify([...(bot as unknown as { pendingSubBots: Map<string, string> }).pendingSubBots.keys()]));
    expect(tg.lastText()).toContain("⚠︎");
    expect(tg.lastText()).toContain("pimother_assistant_bot");
    expect(events.log).toHaveBeenCalledWith("system", "system", expect.stringContaining("managed bot token fetch failed"));

    // the request stays armed so a later token re-issue completes the wiring
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    expect(state.pendingSubBots.assistant).toBeGreaterThan(0);
  });

  it("expired (≥24h) pending requests are dropped and late updates are ignored", async () => {
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ chats: { "telegram:42": "assistant" }, pendingSubBots: { assistant: Date.now() - 25 * 3600e3 } })
    );

    const tg = new FakeTelegramTransport();
    const { bot } = makeWiringBot(dir, tg);
    await bot.start();

    await tg.fire({ creatorId: "161427550", botId: 8802922531, botUsername: "pimother_assistant2_bot" });

    expect(tg.lastText()).toBe(""); // no notification — nobody asked for this bot
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    expect(state.pendingSubBots ?? {}).toEqual({});
  });
});