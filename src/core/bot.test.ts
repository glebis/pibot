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
import type { ModelCascade } from "./cascade.js";
import type { PushOptions, ReplyContext, Schedule, Transport, IncomingMedia } from "./types.js";

// The /newagent wizard runs the LLM-backed ambiguity gate before creating the
// agent. With no modelRuntime stub the SDK falls back to the machine's real
// providers — the test then depends on live model latency (vi.waitFor 1s). The
// gate itself is covered in agent-factory.test.ts; stub it deterministically here.
vi.mock("./ambiguity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ambiguity.js")>();
  return {
    ...actual,
    scorePersonaAmbiguity: vi.fn(async () => ({
      score: 0,
      questions: [],
      dimensions: { goal: 1, constraints: 1, success: 1 },
    })),
  };
});

// model cascade stub — chain empty, everything healthy
function makeCascadeStub() {
  return {
    chainFor: vi.fn(() => ["ollama/test"] as string[]),
    firstHealthy: vi.fn(() => "ollama/test"),
    nextCandidate: vi.fn(() => undefined),
    resolveModel: vi.fn(() => undefined),
    isOpen: vi.fn(() => false),
    noteFailure: vi.fn(() => "unknown" as const),
    noteSuccess: vi.fn(),
    creditBlockedProviders: vi.fn(() => [] as string[]),
    queueDead: vi.fn((dl: Record<string, unknown>) => ({ id: "dl_test", ...dl })),
    deadLetterCount: vi.fn(() => 0),
    deadLetters: vi.fn(() => [] as never[]),
    takeOneDead: vi.fn(() => undefined),
    unshiftDead: vi.fn(),
    clearBreakers: vi.fn(() => 0),
    needsRecoveryProbe: vi.fn(() => false),
    probeAlive: vi.fn(async () => []),
    statusLines: vi.fn(() => [] as string[]),
  } as unknown as ModelCascade;
}

// ─── fakes ──────────────────────────────────────────────────────────────────

class MockTransport implements Transport {
  readonly name: string;
  readonly boundAgentId?: string;
  readonly chatId = "42";
  pushed: Array<{ chatId: string; opts: PushOptions }> = [];
  typing: Array<[string, boolean]> = [];
  working: Array<[string, boolean]> = [];
  workBadges: Array<[string, string]> = [];
  messageCb: ((text: string, chatId: string, reply?: ReplyContext, messageId?: number) => Promise<void>) | null = null;
  actionCb: ((action: string, chatId: string) => Promise<void>) | null = null;
  mediaCb: ((media: import("./types.js").IncomingMedia) => Promise<void>) | null = null;
  mediaSeen: import("./types.js").IncomingMedia[] = [];
  speechSeen: Array<{ kind: "voice" | "audio"; chatId: string; filePath: string; caption?: string }> = [];

  constructor(name = "mock", boundAgentId?: string) {
    this.name = name;
    this.boundAgentId = boundAgentId;
  }

  async start() {}
  async stop() {}
  async push(chatId: string, opts: PushOptions): Promise<void> {
    this.pushed.push({ chatId, opts });
  }
  async notifyError(chatId: string, message: string): Promise<void> {
    this.pushed.push({ chatId, opts: { text: `⚠︎ ${message}` } });
  }
  async sendVoice(chatId: string, filePath: string, caption?: string): Promise<void> {
    this.speechSeen.push({ kind: "voice", chatId, filePath, caption });
  }
  async sendAudio(chatId: string, filePath: string, caption?: string): Promise<void> {
    this.speechSeen.push({ kind: "audio", chatId, filePath, caption });
  }
  onMessage(cb: (text: string, chatId: string, reply?: ReplyContext, messageId?: number) => Promise<void>): void {
    this.messageCb = cb;
  }
  onMedia(cb: (media: import("./types.js").IncomingMedia) => Promise<void>): void {
    this.mediaCb = cb;
  }
  onAction(cb: (action: string, chatId: string) => Promise<void>): void {
    this.actionCb = cb;
  }
  setTyping(chatId: string, on: boolean): void {
    this.typing.push([chatId, on]);
  }
  setWorking(chatId: string, on: boolean): void {
    this.working.push([chatId, on]);
  }
  setWorkBadge(chatId: string, emoji: string): void {
    this.workBadges.push([chatId, emoji]);
  }
  lastText(): string {
    return this.pushed.at(-1)?.opts.text ?? "";
  }
  lastCard(): { label: string; action: string }[] | undefined {
    return this.pushed.at(-1)?.opts.card?.buttons;
  }
  async say(text: string, messageId?: number): Promise<void> {
    await this.messageCb?.(text, this.chatId, undefined, messageId);
  }
  async sayReply(text: string, reply: ReplyContext): Promise<void> {
    await this.messageCb?.(text, this.chatId, reply);
  }
  async sayMedia(media: Partial<import("./types.js").IncomingMedia>): Promise<void> {
    const full = { kind: "voice", chatId: this.chatId, filePath: "/tmp/x.ogg", fileId: "f1", ...media } as import("./types.js").IncomingMedia;
    this.mediaSeen.push(full);
    await this.mediaCb?.(full);
  }
  async act(action: string): Promise<string | void> {
    return await this.actionCb?.(action, this.chatId);
  }
}

function fakeAgentManager(promptSpy = vi.fn()) {
  const sessionListeners: Array<(event: unknown) => void> = [];
  const fakeSession = {
    agent: { state: { messages: [] } },
    prompt: promptSpy.mockResolvedValue(undefined),
    setModel: vi.fn(async () => {}),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      sessionListeners.push(listener);
      return () => {};
    }),
  } as unknown as AgentSession;
  const agents = {
    createAgent: vi.fn(() => undefined),
    resetSession: vi.fn(async () => {}),
    discover: vi.fn(async () => {}),
    getOrCreateSession: vi.fn(async (..._args: unknown[]) => fakeSession),
    resolveModel: vi.fn(() => undefined),
    sessions: new Map(),
    getAgent: vi.fn((id: string) =>
      id === "pibot-dev"
        ? { id, dir: `/tmp/fake-${id}`, manifest: { name: id, description: "d", workspace: "repo" } }
        : id === "assistant" || id === "fitness"
        ? { id, dir: `/tmp/fake-${id}`, manifest: { name: id, description: "d", heartbeat: { enabled: true, interval: "45m" }, evolution: { enabled: true, interval: "6h" } } }
        : undefined
    ),
    list: vi.fn(() => [{ id: "assistant", dir: "/x", manifest: { name: "assistant" } }]),
    defaultAgentId: () => "assistant",
  } as unknown as AgentManager;
  return { agents, emitSessionEvent: (event: unknown) => sessionListeners.forEach((listener) => listener(event)) };
}

function makeBot(evolution?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-bot-"));
  const config: Config = {
    transport: "cli",
    dataDir: dir,
    agentsDir: dir,
    vaultDir: path.join(dir, "vault"),
    defaultAgentId: "assistant",
    allowedChats: [],
    telegramOpen: false,
  };
  const promptSpy = vi.fn();
  const { agents, emitSessionEvent } = fakeAgentManager(promptSpy);
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
  const cascade = makeCascadeStub();
  const stt = {
    configured: vi.fn(() => true),
    transcribe: vi.fn(async () => ({ ok: true, text: "spoken words", provider: "groq" })),
  };
  const audioMedia = {
    prepare: vi.fn(async (media: IncomingMedia) => ({ ok: true, filePath: media.filePath, durationSec: media.durationSec ?? 1, cleanup: vi.fn(async () => {}) })),
  };
  const runBd = vi.fn(async () => "✓ Created issue: pibot-test (P2)");
  const bot = new PiBot({ config, agents, scheduler, heartbeat, events, transports: [transport], secrets: { get: () => ({}), save: async () => {} } as never, cascade, stt: stt as never, audioMedia: audioMedia as never, runBd: runBd as never, evolution: evolution as never });
  return { bot, transport, agents, scheduler, heartbeat, events, promptSpy, cascade, dir, stt, audioMedia, emitSessionEvent, resetSession: agents.resetSession, runBd };
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

  it("delivers host messages through a sub-bot transport whose name contains colons", async () => {
    const subBot = new MockTransport("telegram:assistant", "assistant");
    t.bot.addTransport(subBot);
    await subBot.say("remember this chat");
    subBot.pushed = [];
    await t.bot.deliverToAgent("assistant", "hello");
    expect(subBot.pushed).toEqual([{ chatId: "42", opts: { text: "hello" } }]);
  });

  it("prefers an agent's dedicated bot for proactive delivery", async () => {
    const subBot = new MockTransport("telegram:assistant", "assistant");
    t.bot.addTransport(subBot);
    await t.transport.say("remember the main bot chat");
    await subBot.say("remember the dedicated bot chat");
    t.transport.pushed = [];
    subBot.pushed = [];

    await t.bot.deliverToAgent("assistant", "one proactive message");

    expect(t.transport.pushed).toHaveLength(0);
    expect(subBot.pushed).toEqual([{ chatId: "42", opts: { text: "one proactive message" } }]);
  });

  it("surfaces a missing reminder transport so the scheduler can retry", async () => {
    await expect(t.bot.deliverFire({
      id: "sc_retry", agentId: "assistant", chat: { transport: "offline", chatId: "42" },
      title: "retry me", kind: "reminder", dueAt: Date.now(), wake: "normal",
      delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0,
    }, false)).rejects.toThrow("offline");
  });

  it("replies to unknown commands", async () => {
    await t.transport.say("/frobnicate");
    expect(t.transport.lastText()).toContain("Unknown /frobnicate");
  });

  it("/evolve status renders staged candidates with accept/reject buttons that act on them", async () => {
    const evolution = {
      stagedDetail: vi.fn((agentId: string) =>
        agentId === "assistant"
          ? [{
              name: "morning-brief", mode: "create" as const,
              description: "Use when mornings start.",
              preview: "# Morning brief\n- greet\n- list schedule",
              content: "---\nname: morning-brief\ndescription: Use when mornings start.\n---\n\n# Morning brief",
              closesBacklog: ["bl-1"], scores: [3, 4], stagedAt: Date.now() - 7200e3,
            }]
          : []
      ),
      reviewToken: vi.fn(() => "tok_abc"),
      resolveReviewToken: vi.fn((tok: string) => (tok === "tok_abc" ? { agentId: "assistant", skillName: "morning-brief" } : undefined)),
      promote: vi.fn(() => true),
      reject: vi.fn(() => true),
      stagedContent: vi.fn(() => "# Morning brief\n\n- greet"),
    };
    const ev = makeBot(evolution);
    await ev.transport.say("/evolve status");
    expect(evolution.stagedDetail).toHaveBeenCalledWith("assistant");
    const cardMsg = ev.transport.pushed.find((p) => p.opts.card);
    expect(cardMsg?.opts.text).toContain("morning-brief");
    expect(cardMsg?.opts.text).toContain("assistant");
    expect(cardMsg?.opts.text).toContain("probes 3, 4");
    expect(cardMsg?.opts.text).toContain("closes bl-1");
    expect(cardMsg?.opts.card?.buttons.map((b) => b.action)).toEqual(["evo:tok_abc:y", "evo:tok_abc:n", "evo:tok_abc:peek"]);

    // ✅ Accept via card → promote (toasts come back as the callback answer)
    await ev.transport.act("evo:tok_abc:y");
    expect(evolution.promote).toHaveBeenCalledWith("assistant", "morning-brief");

    // ✖ Reject via card → reject
    await ev.transport.act("evo:tok_abc:n");
    expect(evolution.reject).toHaveBeenCalledWith("assistant", "morning-brief");

    // 📄 Peek → pushes the full candidate text
    await ev.transport.act("evo:tok_abc:peek");
    expect(ev.transport.lastText()).toContain("Morning brief");

    // stale/unknown token → gentle expired toast, no crash
    expect(await ev.transport.act("evo:gone:n")).toContain("expired");
  });

  it("/evolve status with nothing staged says so", async () => {
    const evolution = { stagedDetail: vi.fn(() => []) };
    const ev = makeBot(evolution);
    await ev.transport.say("/evolve status");
    expect(ev.transport.lastText()).toContain("Nothing staged");
  });

  it("/evolve status caps the review batch — 10 cards max, then a batch note", async () => {
    const mk = (name: string) => ({
      name, mode: "create" as const,
      description: "d",
      preview: "# preview",
      content: `---\nname: ${name}\n---\n\n# preview`,
      closesBacklog: [], scores: [4], stagedAt: Date.now(),
    });
    const evolution = {
      stagedDetail: vi.fn((agentId: string) => (agentId === "assistant"
        ? Array.from({ length: 8 }, (_, i) => mk(`skill-${i + 1}`))
        : Array.from({ length: 5 }, (_, i) => mk(`fit-${i + 1}`)))),
      reviewToken: vi.fn((_agentId: string, name: string) => `tok_${name}`),
    };
    const ev = makeBot(evolution);
    (ev.agents.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "assistant", dir: "/x", manifest: { name: "assistant" } },
      { id: "fitness", dir: "/y", manifest: { name: "fitness" } },
    ]);
    await ev.transport.say("/evolve status");
    const cards = ev.transport.pushed.filter((p) => p.opts.card);
    expect(cards).toHaveLength(10);
    // only shown candidates get tokens minted (unshown ones would expire unused)
    expect(evolution.reviewToken).toHaveBeenCalledTimes(10);
    // closing note points at the remainder and the re-run command
    expect(ev.transport.lastText()).toContain("3 more staged");
    expect(ev.transport.lastText()).toContain("/evolve status");
  });

  it("/model lists candidates, switches via tap and typed spec, and auto resets", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-model-"));
    const manifestPath = path.join(agentDir, "agent.json");
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id !== "assistant") return undefined;
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : { name: "assistant", description: "d", heartbeat: { enabled: true, interval: "45m" }, evolution: { enabled: true, interval: "6h" } };
      return { id, dir: agentDir, manifest };
    });
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/a:cloud", "ollama/b:cloud"]);
    (t.cascade.resolveModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "a" } as never);
    (t.cascade.isOpen as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // picker: current is auto, one button per candidate
    await t.transport.say("/model");
    expect(t.transport.lastText()).toContain("auto — first healthy");
    const card = t.transport.lastCard();
    expect(card?.map((b) => b.label)).toEqual(["ollama/a:cloud", "ollama/b:cloud"]);

    // tap a candidate → persisted to agent.json + toast confirmation
    expect(await t.transport.act(card![0].action)).toContain("will use **ollama/a:cloud**");
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).model).toBe("ollama/a:cloud");

    // picker marks current, offers auto
    await t.transport.say("/model");
    expect(t.transport.lastText()).toContain("`ollama/a:cloud`");
    expect(t.transport.lastCard()?.some((b) => b.label === "↺ auto")).toBe(true);

    // auto reset
    const autoBtn = t.transport.lastCard()!.find((b) => b.label === "↺ auto")!;
    expect(await t.transport.act(autoBtn.action)).toContain("back to **auto**");
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).model).toBeUndefined();

    // typed spec outside the permitted chain is refused
    await t.transport.say("/model openai/gpt-x");
    expect(t.transport.lastText()).toContain("not in assistant's permitted chain");

    // stale picker token → gentle expired toast
    expect(await t.transport.act("mdl:m_deadbeef")).toContain("expired");

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("staging via the evolution job delivers a review card automatically", async () => {
    const evolution = {
      evolve: vi.fn(async () => ({ agentId: "assistant", ok: true, summary: "Staged \"morning-brief\" for review", skill: "morning-brief", staged: true })),
      reviewToken: vi.fn(() => "tok_job"),
    };
    const ev = makeBot(evolution);
    await ev.transport.say("remember this chat"); // bind mock:42 → assistant so proactive delivery lands
    ev.transport.pushed = [];
    await ev.bot.deliverFire({
      id: "ev:assistant", agentId: "assistant", chat: { transport: "mock", chatId: "42" },
      title: "evolution", kind: "evolution", dueAt: Date.now(), wake: "normal",
      delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0,
    }, false);
    expect(evolution.reviewToken).toHaveBeenCalledWith("assistant", "morning-brief");
    const cardMsg = ev.transport.pushed.find((p) => p.opts.card);
    expect(cardMsg?.opts.text).toContain("staged **morning-brief**");
    expect(cardMsg?.opts.card?.buttons.map((b) => b.action)).toEqual(["evo:tok_job:y", "evo:tok_job:n", "evo:tok_job:peek"]);
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

  it("prefixes prompts with reply-quote context when the user replies to a message", async () => {
    // replying to the bot's own earlier message
    await t.transport.sayReply("yes do that", { messageId: 7, sender: "you", quoted: "Want me to open the spike?" });
    let arg = t.promptSpy.mock.calls[0][0] as string;
    expect(arg).toContain("↩ replying to your message \"Want me to open the spike?\"");
    expect(arg).toContain("yes do that");
    expect(arg.startsWith("[")).toBe(true); // envelope still wraps the whole prompt

    // replying to the user's own earlier message in a DM
    await t.transport.sayReply("and this one", { messageId: 8, sender: "Gleb", quoted: "earlier thought" });
    arg = t.promptSpy.mock.calls[1][0] as string;
    expect(arg).toContain("↩ replying to Gleb's message \"earlier thought\"");
  });

  it("passes inter-agent communication hooks into chat sessions", async () => {
    await t.transport.say("hello");
    const hooks = (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mock.calls[0][5];
    expect(hooks).toMatchObject({
      askAgent: expect.any(Function),
      handoffContext: expect.any(Function),
      listAgents: expect.any(Function),
    });
    expect(hooks.listAgents()).toEqual([{ id: "assistant", description: undefined }]);
  });

  it("binds speech delivery to the exact invoking transport and chat", async () => {
    await t.transport.say("hello");
    const sendSpeech = (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mock.calls[0][7] as (
      transport: string,
      chatId: string,
      kind: "voice" | "audio",
      filePath: string,
      caption?: string,
    ) => Promise<void>;

    expect(sendSpeech).toBeTypeOf("function");
    await sendSpeech("mock", "42", "voice", "/tmp/generated.ogg", "requested");
    expect(t.transport.speechSeen).toEqual([{ kind: "voice", chatId: "42", filePath: "/tmp/generated.ogg", caption: "requested" }]);
    await expect(sendSpeech("mock", "different", "voice", "/tmp/generated.ogg")).rejects.toThrow(/invoking chat/i);
  });

  it("transcribes voice notes and routes them like typed text", async () => {
    await t.transport.sayMedia({ kind: "voice", durationSec: 12 });
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    const arg = t.promptSpy.mock.calls[0][0] as string;
    expect(arg).toContain("spoken words");
    expect(arg).not.toContain("🎙"); // bare transcript IS the prompt — no transcript-object framing
    expect(arg).not.toContain("transcribed via");
  });

  it("uses the resolved agent speech policy for video-note transcription", async () => {
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => id === "assistant"
      ? { id, dir: "/tmp/fake-assistant", manifest: { name: id, speech: { sttProviders: ["whisperkit", "groq"], allowExternalStt: true } } }
      : undefined);

    await t.transport.sayMedia({ kind: "video_note", durationSec: 9, filePath: "/tmp/note.mp4" });

    expect(t.stt.configured).toHaveBeenCalledWith({ providers: ["whisperkit", "groq"], allowExternal: true });
    expect(t.stt.transcribe).toHaveBeenCalledWith("/tmp/note.mp4", { providers: ["whisperkit", "groq"], allowExternal: true });
    expect(t.promptSpy.mock.calls[0][0]).toContain("spoken words");
    expect(t.promptSpy.mock.calls[0][0]).not.toContain("video note");
  });

  it("does not expose private media paths when validation fails", async () => {
    t.audioMedia.prepare.mockResolvedValueOnce({ ok: false, error: "ffprobe failed for /private/media/secret-chat-id.ogg" } as never);

    await t.transport.sayMedia({ kind: "voice", filePath: "/private/media/secret-chat-id.ogg" });

    expect(t.transport.lastText()).toContain("Audio validation failed");
    expect(t.transport.lastText()).not.toContain("/private/media");
    expect(t.transport.lastText()).not.toContain("secret-chat-id");
  });

  it("answers pending questions from voice transcripts before promoting to the agent", async () => {
    const t2 = makeBot();
    (t2.stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, text: "personal", provider: "groq" });
    const promise = t2.bot.askUser("assistant", { transport: "mock", chatId: "42" }, { text: "Which account?", options: ["client", "personal", "own-account", "unsure"] });
    await vi.waitFor(() => expect(t2.transport.lastCard()).toBeDefined());
    await t2.transport.sayMedia({ kind: "voice" });
    expect(await promise).toMatchObject({ choice: "personal", via: "text" });
    expect(t2.promptSpy).not.toHaveBeenCalled();
    fs.rmSync(t2.dir, { recursive: true, force: true });
  });

  it("references photo files with caption in the prompt", async () => {
    await t.transport.sayMedia({ kind: "photo", filePath: "/tmp/42-7-photo.jpg", caption: "the whiteboard" });
    const arg = t.promptSpy.mock.calls[0][0] as string;
    expect(arg).toContain("📎 photo attached — file: /tmp/42-7-photo.jpg");
    expect(arg).toContain("caption: the whiteboard");
    expect(arg).toContain("read tool");
  });

  it("applies custom-dictionary corrections to voice transcripts", async () => {
    fs.writeFileSync(path.join(t.dir, "dictionary.json"), JSON.stringify({ entries: [{ from: "west", to: "WhisperKit" }] }));
    (t.stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, text: "I tested west today", provider: "whisperkit" });
    await t.transport.sayMedia({ kind: "voice", durationSec: 4 });
    // bias reached the STT call…
    const args = (t.stt.transcribe as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(args[2]?.bias)).toContain("WhisperKit");
    // …and the transcript was corrected before the agent saw it
    const arg = t.promptSpy.mock.calls[0][0] as string;
    expect(arg).not.toContain("tested west");
    expect(arg).toContain("I tested WhisperKit today");
  });

  it("notifies instead of prompting when transcription fails", async () => {
    t.stt.transcribe.mockRejectedValueOnce(new Error("network down"));
    await t.transport.sayMedia({ kind: "voice" });
    expect(t.promptSpy).not.toHaveBeenCalled();
    expect(t.transport.lastText()).toContain("Transcription failed");
    expect(t.transport.lastText()).toContain("network down");
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

  it("hands the conversation to another agent with /handoff", async () => {
    await t.transport.say("we are planning the tax report");
    await t.transport.say("/handoff fitness deadline is friday");
    expect(t.transport.lastText()).toContain("Handed to **fitness**");
    // the target's chat session received the handoff envelope with a brief section
    const handoffPrompt = t.promptSpy.mock.calls.map((c) => String(c[0])).find((p) => p.includes('[handoff from "assistant"]'));
    expect(handoffPrompt).toBeTruthy();
    expect(handoffPrompt).toContain("# Handoff brief");
    expect(handoffPrompt).toContain("deadline is friday");
    // the chat is rebound: the next plain message goes to the target agent
    await t.transport.say("continue");
    const lastCall = (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(lastCall[0]).toBe("fitness");
    expect(lastCall[1]).toBe("mock:42");
  });

  it("/handoff rejects self and unknown targets", async () => {
    await t.transport.say("/handoff assistant");
    expect(t.transport.lastText()).toContain("already talking");
    await t.transport.say("/handoff ghost");
    expect(t.transport.lastText()).toContain('No agent "ghost"');
  });

  it("agent-initiated handoff moves the chat to the target", async () => {
    await t.transport.say("hello"); // create the sender's chat session (carries the comms hooks)
    const hookCall = (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[5] && typeof (c[5] as { handoffContext?: unknown }).handoffContext === "function"
    );
    expect(hookCall).toBeTruthy();
    const hooks = hookCall![5] as { handoffContext: (from: string, to: string, note?: string) => Promise<string> };
    const ack = await hooks.handoffContext("assistant", "fitness", "take over the thread");
    expect(ack).toBe("Ready.");
    // the target's chat session received the brief + the chat rebound
    const handoffPrompt = t.promptSpy.mock.calls.map((c) => String(c[0])).find((p) => p.includes('[handoff from "assistant"]'));
    expect(handoffPrompt).toContain("take over the thread");
    expect((t.bot as unknown as { chatAgent: Map<string, string> }).chatAgent.get("mock:42")).toBe("fitness");
  });

  it("agent-initiated handoff falls back to the pair session for sub-bot chats", async () => {
    const subBot = new MockTransport("telegram:assistant", "assistant");
    t.bot.addTransport(subBot);
    await subBot.say("hello"); // create the sender's sub-bot chat session
    const hookCall = (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[5] && typeof (c[5] as { handoffContext?: unknown }).handoffContext === "function"
    );
    expect(hookCall).toBeTruthy();
    const hooks = hookCall![5] as { handoffContext: (from: string, to: string, note?: string) => Promise<string> };
    await hooks.handoffContext("assistant", "fitness");
    // the target was prompted in its pair session (agent::…), not the user's chat
    const pairPrompt = t.promptSpy.mock.calls.map((c) => String(c[0])).find((p) => p.includes("[agent-message from") && p.includes("handoff"));
    expect(pairPrompt).toBeTruthy();
    // the user's sub-bot chat stays with the bound agent
    expect((t.bot as unknown as { chatAgent: Map<string, string> }).chatAgent.get("telegram:assistant:42")).toBe("assistant");
  });

  it("switches agents via the born-card action and confirms in the toast", async () => {
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      const known = { fitness: { id: "fitness", dir: "/tmp/fake-fitness", manifest: { name: "fitness" } } } as Record<string, unknown>;
      const fallback = { id: "assistant", dir: "/tmp/fake-assistant", manifest: { name: "assistant" } };
      return (known as Record<string, unknown>)[id] ?? (id === "assistant" ? fallback : undefined);
    });
    // switch away, then back via the card action
    await t.transport.say("/agent fitness");
    await t.transport.act("agt:assistant");
    await t.transport.say("hello again");
    expect((t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBe("assistant");
    // unknown agent handled gracefully — toast, not a push
    const toast = await t.transport.act("agt:ghost");
    expect(String(toast)).toContain("doesn't exist");
  });

  it("/issue walks the standard questionnaire and files a bd issue", async () => {
    void t.transport.say("/issue Buttons flicker when tapped twice"); // title from arg — the wizard chain blocks this promise
    // pain (free text)
    await vi.waitFor(() => expect(t.transport.lastCard()).toBeDefined());
    await t.transport.say("it flickers when I tap fast");
    // scope
    await vi.waitFor(() => expect(t.transport.lastCard()).toBeDefined());
    await t.transport.say("this bot");
    // priority — buttons
    await vi.waitFor(() => expect(t.transport.lastCard()).toBeDefined());
    await t.transport.act(t.transport.lastCard()![0].action); // P1 — now
    // done-when
    await vi.waitFor(() => expect(t.transport.lastCard()).toBeDefined());
    await t.transport.say("no flicker");
    await vi.waitFor(() => expect(t.runBd).toHaveBeenCalled());
    const args = (t.runBd.mock.calls[0] as unknown as string[][])?.[0] ?? [];
    expect(args[0]).toBe("create");
    expect(args.map((a) => a.toLowerCase())).toContain("buttons flicker when tapped twice");
    expect(t.transport.lastText()).toContain("Filed as **pibot-test**");
  });

  it("/new starts a fresh session for the chat's agent and keeps state", async () => {
    await t.transport.say("/new");
    expect(t.resetSession).toHaveBeenCalledWith("assistant", "mock:42", { transport: "mock", chatId: "42" }, expect.anything());
    expect(t.transport.lastText()).toContain("Fresh session for **assistant**");
    await t.transport.say("/newagent ghost persona"); // unrelated commands unaffected
    expect(t.resetSession).toHaveBeenCalledTimes(1);
  });

  it("posts an interactive card on agent creation (direct path)", async () => {
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => ({ id, dir: `/tmp/fake-${id}`, manifest: { name: id, heartbeat: { enabled: true, interval: "45m" } } }));
    await t.transport.say("/newagent runner Run with me every morning");
    const card = t.transport.lastCard();
    expect(card).toBeDefined();
    const actions = card!.map((b) => b.action);
    expect(actions).toContain("agt:runner");
    expect(actions).toContain("subbot:runner");
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
    // fmtWhen floors to whole minutes — the render can land 1ms past the mock's
    // dueAt snapshot and legitimately show 9 instead of 10
    expect(t.transport.lastText()).toMatch(/in (9|10) min/);

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
  it("direct delivery pushes a formatted card, sender-attributed on a shared transport", async () => {
    const t = makeBot();
    await t.bot.deliverFire(
      {
        id: "sc1", agentId: "assistant", chat: { transport: "mock", chatId: "42" },
        title: "stretch", kind: "reminder", dueAt: Date.now(), wake: "normal",
        delivery: "direct", status: "pending", createdAt: 0, firedCount: 1,
      },
      false
    );
    expect(t.transport.lastText()).toContain("**[assistant]** ⏰ **stretch**");
    expect(t.transport.lastCard()?.map((b) => b.label)).toEqual(["⏰ +10m", "🕒 +1h", "🗑 Done"]);
  });

  it("direct delivery on the agent's own bot skips the sender prefix", async () => {
    const t = makeBot();
    const own = new MockTransport("telegram:assistant", "assistant");
    t.bot.addTransport(own);
    await t.bot.deliverFire(
      {
        id: "sc1b", agentId: "assistant", chat: { transport: "telegram:assistant", chatId: "42" },
        title: "stretch", kind: "reminder", dueAt: Date.now(), wake: "normal",
        delivery: "direct", status: "pending", createdAt: 0, firedCount: 1,
      },
      false
    );
    expect(own.lastText()).toContain("⏰ **stretch**");
    expect(own.lastText()).not.toContain("[assistant]");
  });

  it("agent delivery prompts the agent instead", async () => {
    const t = makeBot();
    await t.transport.say("remember this chat"); // bind mock:42 → assistant (delivery needs an owned chat)
    t.promptSpy.mockClear();
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

  it("agent delivery with the synthetic 'agent' transport resolves the agent's remembered chat", async () => {
    const t = makeBot();
    // agent→chat bindings persist in state.json; simulate a restored binding (both maps)
    (t.bot as unknown as { agentChats: Map<string, Set<string>> }).agentChats.set("assistant", new Set(["mock:42"]));
    (t.bot as unknown as { chatAgent: Map<string, string> }).chatAgent.set("mock:42", "assistant");
    await t.bot.deliverFire(
      {
        id: "sc3", agentId: "assistant", chat: { transport: "agent", chatId: "42" },
        title: "wake me to compose", kind: "task", dueAt: Date.now(), wake: "normal",
        delivery: "agent", status: "pending", createdAt: 0, firedCount: 1,
      },
      false
    );
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    const arg = t.promptSpy.mock.calls[0][0] as string;
    expect(arg).toContain("wake me to compose");
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

  it("heartbeat jobs adopt an agent-requested adaptive wakeup", async () => {
    const t = makeBot();
    (t.heartbeat as unknown as { takeNextWakeup: ReturnType<typeof vi.fn> }).takeNextWakeup = vi.fn(() => 2 * 3600e3);
    const job = {
      id: "hb:assistant", agentId: "assistant", chat: { transport: "internal", chatId: "heartbeat" },
      title: "heartbeat", kind: "heartbeat" as const, dueAt: Date.now(), wake: "normal" as const,
      delivery: "direct" as const, status: "pending" as const, createdAt: 0, firedCount: 1, internal: true,
      repeat: { everyMs: 45 * 60e3 },
    };
    await t.bot.deliverFire(job, false);
    expect((t.heartbeat as unknown as { takeNextWakeup: ReturnType<typeof vi.fn> }).takeNextWakeup).toHaveBeenCalledWith("assistant");
    expect(job.repeat.everyMs).toBe(2 * 3600e3);
  });

  it("heartbeat jobs without an adaptive request keep their base rhythm", async () => {
    const t = makeBot();
    const job = {
      id: "hb:assistant", agentId: "assistant", chat: { transport: "internal", chatId: "heartbeat" },
      title: "heartbeat", kind: "heartbeat" as const, dueAt: Date.now(), wake: "normal" as const,
      delivery: "direct" as const, status: "pending" as const, createdAt: 0, firedCount: 1, internal: true,
      repeat: { everyMs: 45 * 60e3 },
    };
    await t.bot.deliverFire(job, false);
    expect(job.repeat.everyMs).toBe(45 * 60e3);
  });

  it("suppresses sibling proactive output in chats owned by another agent", async () => {
    const t = makeBot();
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "creator"
        ? { id: "creator", dir: "/tmp/fake-creator", manifest: { name: "creator", heartbeat: { enabled: true, interval: "20m" } } }
        : { id: "assistant", dir: "/tmp/fake-assistant", manifest: { name: "assistant" } }
    );
    // creator carries a stale memory of the main chat (rebind cleanup normally
    // prunes these — this simulates the historical state the guard defends against)
    const b = t.bot as unknown as { agentChats: Map<string, Set<string>>; chatAgent: Map<string, string> };
    b.agentChats.set("creator", new Set(["mock:42"]));
    b.chatAgent.set("mock:42", "assistant"); // main chat owned by assistant now
    t.transport.pushed.length = 0;

    await t.bot.deliverToAgent("creator", "Opinions loaded, red pen ready.");

    expect(t.transport.pushed).toHaveLength(0); // no sibling chatter in the main chat
    expect(t.events.log).toHaveBeenCalledWith("creator", "system", expect.stringContaining("suppressed"));
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("still delivers proactive output via the agent's dedicated subbot transport", async () => {
    const t = makeBot();
    const creatorBot = new MockTransport("telegram:creator", "creator");
    t.bot.addTransport(creatorBot);
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "creator"
        ? { id: "creator", dir: "/tmp/fake-creator", manifest: { name: "creator", heartbeat: { enabled: true, interval: "20m" } } }
        : { id: "assistant", dir: "/tmp/fake-assistant", manifest: { name: "assistant" } }
    );
    await creatorBot.say("creator registers its home chat");
    await t.transport.say("/agent assistant"); // main chat stays the assistant's
    t.transport.pushed.length = 0;

    await t.bot.deliverToAgent("creator", "Draft review nudge");

    expect(creatorBot.pushed).toHaveLength(1);
    expect(t.transport.pushed).toHaveLength(0);
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("heartbeat speak reaches all chats of the agent", async () => {
    const t = makeBot();
    await t.transport.say("ping"); // registers chat
    t.transport.pushed.length = 0;
    await t.bot.deliverToAgent("assistant", "good morning ✨");
    expect(t.transport.lastText()).toBe("**[assistant]** good morning ✨"); // shared transport → sender attribution
  });

  it("heartbeat-originated sends carry an [heartbeat] tag on both transport kinds", async () => {
    const t = makeBot();
    await t.transport.say("ping"); // shared chat
    const own = new MockTransport("telegram:assistant", "assistant");
    t.bot.addTransport(own);
    await own.say("register dedicated chat");

    await t.bot.deliverToAgent("assistant", "check-in from the rhythm", { origin: "heartbeat" });
    expect(own.lastText()).toBe("[heartbeat] check-in from the rhythm");
    // dedicated identity wins: proactive output goes there only, shared bot stays silent
    expect(t.transport.lastText()).toBe("");
  });

  it("heartbeat origin is tagged together with the sender prefix on a shared transport", async () => {
    const t = makeBot();
    await t.transport.say("ping");
    t.transport.pushed.length = 0;
    await t.bot.deliverToAgent("assistant", "quiet tick", { origin: "heartbeat" });
    expect(t.transport.lastText()).toBe("**[assistant]** [heartbeat] quiet tick");
  });

  it("sendAsAgent attributes sends on shared transports and logs them", async () => {
    const t = makeBot();
    await t.bot.sendAsAgent("assistant", "mock:42", "hello from the tool");
    expect(t.transport.lastText()).toBe("**[assistant]** hello from the tool");
    expect(t.events.log).toHaveBeenCalledWith("assistant", "send", expect.stringContaining("mock:42"));
  });

  it("sendAsAgent skips the prefix on the agent's own bot", async () => {
    const t = makeBot();
    const own = new MockTransport("telegram:assistant", "assistant");
    t.bot.addTransport(own);
    await t.bot.sendAsAgent("assistant", "telegram:assistant:42", "own-identity post");
    expect(own.lastText()).toBe("own-identity post");
  });

  it("sendAsAgent rejects malformed targets and unknown transports", async () => {
    const t = makeBot();
    await expect(t.bot.sendAsAgent("assistant", "nonsense", "x")).rejects.toThrow(/transport:chatId/);
    await expect(t.bot.sendAsAgent("assistant", "nosuch:42", "x")).rejects.toThrow(/no transport/);
  });

  it("resolves per-agent telegram tokens: env overrides manifest overrides persisted settings", async () => {
    const t = makeBot();
    const attach = vi.fn(async () => ({ ok: true, botName: "@pimother_test_bot" }));
    (t.bot as unknown as { attachSubBot: unknown }).attachSubBot = attach;
    (t.agents.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "assistant", dir: "/x", manifest: { name: "assistant", telegram: { token: "111:manifest" } } },
      { id: "coach", dir: "/y", manifest: { name: "coach" } },
      { id: "tax", dir: "/z", manifest: { name: "tax", telegram: { token: "333:manifest-only" } } },
    ]);
    const prev = process.env.PIBOT_TELEGRAM_TOKEN_ASSISTANT;
    process.env.PIBOT_TELEGRAM_TOKEN_ASSISTANT = "222:env";
    try {
      const r = await t.bot.attachConfiguredSubBots({ attempts: 1 });
      expect(attach).toHaveBeenCalledTimes(2);
      expect(attach).toHaveBeenCalledWith("assistant", "222:env"); // env beats manifest
      expect(attach).toHaveBeenCalledWith("tax", "333:manifest-only"); // manifest when no env
      expect(r.attached).toEqual(["assistant", "tax"]);
    } finally {
      if (prev === undefined) delete process.env.PIBOT_TELEGRAM_TOKEN_ASSISTANT;
      else process.env.PIBOT_TELEGRAM_TOKEN_ASSISTANT = prev;
    }
  });

  it("agents without a token stay on the shared bot (no attach attempt)", async () => {
    const t = makeBot();
    const attach = vi.fn(async () => ({ ok: true, botName: "@x" }));
    (t.bot as unknown as { attachSubBot: unknown }).attachSubBot = attach;
    const r = await t.bot.attachConfiguredSubBots({ attempts: 1 });
    expect(attach).not.toHaveBeenCalled();
    expect(r.attached).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it("suppresses heartbeat escalations for agents that own no chat", async () => {
    const t2 = makeBot();
    (t2.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "creator"
        ? { id: "creator", dir: "/tmp/fake-creator", manifest: { name: "creator", heartbeat: { enabled: true, interval: "20m" } } }
        : { id: "assistant", dir: "/tmp/fake-assistant", manifest: { name: "assistant" } }
    );
    await t2.transport.say("ping"); // main chat owns assistant
    t2.promptSpy.mockClear();

    await t2.bot.escalateToAgent("creator", "MEMORY.md is missing");

    expect(t2.promptSpy).not.toHaveBeenCalled();
    expect(t2.transport.lastText()).toBe(""); // nothing surfaced in someone else's chat
    expect(t2.events.log).toHaveBeenCalledWith("creator", "system", expect.stringContaining("suppressed"));
    fs.rmSync(t2.dir, { recursive: true, force: true });
  });

  it("escalations still work for the chat's own agent", async () => {
    const t2 = makeBot();
    await t2.transport.say("ping"); // assistant owns the main chat
    t2.promptSpy.mockClear();

    await t2.bot.escalateToAgent("assistant", "check in");

    expect(t2.promptSpy).toHaveBeenCalledTimes(1);
    expect(String(t2.promptSpy.mock.calls[0][0])).toContain("[heartbeat]");
    fs.rmSync(t2.dir, { recursive: true, force: true });
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

// ─── cascade dead-letter loop guards (Aug 2026 incident regression) ─────────

describe("cascade dead-letter loop guards", () => {
  let t: ReturnType<typeof makeBot>;

  beforeEach(() => {
    t = makeBot();
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    t.promptSpy.mockRejectedValue(new Error("402 payment required"));
  });
  afterEach(() => {
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("queues genuine user messages on cascade exhaustion and notifies the chat", async () => {
    await t.transport.say("hello there");
    expect(t.promptSpy).not.toHaveBeenCalled();
    expect(t.cascade.queueDead).toHaveBeenCalledTimes(1);
    expect(t.cascade.queueDead).toHaveBeenCalledWith(expect.objectContaining({ text: "hello there", agentId: "assistant" }));
    expect(t.transport.lastText()).toContain("couldn't reach any model");
  });

  it("credit exhaustion produces a deterministic top-up notice naming the provider", async () => {
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["anthropic/claude"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("anthropic/claude");
    (t.cascade.noteFailure as ReturnType<typeof vi.fn>).mockReturnValue("credits");
    await t.transport.say("hello there");
    expect(t.cascade.queueDead).toHaveBeenCalledTimes(1);
    const text = t.transport.lastText();
    expect(text).toContain("ran out of API credits");
    expect(text).toContain("top up at the provider console");
    expect(text).toContain("anthropic");
    expect(text).not.toContain("couldn't reach any model");
  });

  it("auth exhaustion produces a distinct deterministic key/billing notice", async () => {
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["anthropic/claude"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("anthropic/claude");
    (t.cascade.noteFailure as ReturnType<typeof vi.fn>).mockReturnValue("auth");
    await t.transport.say("hello there");
    const text = t.transport.lastText();
    expect(text).toContain("couldn't authenticate with any provider");
    expect(text).toContain("Check the API keys / billing");
    expect(text).not.toContain("ran out of API credits");
  });

  it("credit holds from earlier turns still yield the credits notice when the chain is already down", async () => {
    (t.cascade.creditBlockedProviders as ReturnType<typeof vi.fn>).mockReturnValue(["anthropic"]);
    await t.transport.say("hello there");
    const text = t.transport.lastText();
    expect(text).toContain("ran out of API credits (anthropic)");
  });

  it("never queues host-generated prompts — they re-fire instead of compounding", async () => {
    await expect(t.bot.promptAgent(t.transport, "42", "assistant", "[scheduler] It's time for “stretch”")).rejects.toThrow("permitted model");
    expect(t.cascade.queueDead).not.toHaveBeenCalled();
    expect(t.transport.pushed.filter((p) => p.opts.text.startsWith("⚠︎"))).toHaveLength(0);
  });

  it("never queues a cascade retry note either (the stale [cascade-recover] guard missed the new prefix)", async () => {
    await expect(
      t.bot.promptAgent(
        t.transport,
        "42",
        "assistant",
        "[cascade] Internal: the previous attempt hit a provider error on ollama/glm-5.3-flash:cloud — continue answering the user's last message with the switched model. Do not mention models, errors, or failover."
      )
    ).rejects.toThrow("permitted model");
    expect(t.cascade.queueDead).not.toHaveBeenCalled();
  });

  it("flushDeadLetters drops a dead-lettered cascade retry note (loop guard)", async () => {
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        id: "dl3", agentId: "assistant", transport: "mock", chatId: "42",
        text: "[cascade] Internal: the previous attempt hit a provider error on openai-codex/gpt-5.6-terra — continue answering the user's last message with the switched model. Do not mention models, errors, or failover.",
        createdAt: Date.now(), attempts: [], lastError: "x",
      })
      .mockReturnValue(undefined);
    const n = await t.bot.flushDeadLetters();
    expect(n).toBe(0);
    expect(t.promptSpy).not.toHaveBeenCalled();
  });

  it("flushDeadLetters replays raw text — no synthetic wrapper", async () => {
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    t.promptSpy.mockResolvedValue(undefined);
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ id: "dl2", agentId: "assistant", transport: "mock", chatId: "42", text: "stretch in 20m", createdAt: Date.now(), attempts: [], lastError: "x" })
      .mockReturnValue(undefined);
    const n = await t.bot.flushDeadLetters();
    expect(n).toBe(1);
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    const prompted = t.promptSpy.mock.calls[0][0] as string;
    expect(prompted).toContain("stretch in 20m");
    expect(prompted).not.toContain("[cascade-recover]");
  });

  it("keeps a provider-error replay queued without delivering partial assistant text or auto-retrying it", async () => {
    const original = {
      id: "dl-provider-error", agentId: "assistant", transport: "mock", chatId: "42",
      text: "book the train", createdAt: Date.now(), attempts: ["ollama/test"], lastError: "provider unavailable",
    };
    const queue = [original];
    const failedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "I booked the train" }],
      api: "openai-completions",
      provider: "ollama",
      model: "test",
      usage: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: "connection reset after partial response",
      timestamp: Date.now(),
    };
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>).mockImplementation(() => queue.shift());
    (t.cascade.unshiftDead as ReturnType<typeof vi.fn>).mockImplementation((dead) => { queue.unshift(dead); });
    (t.cascade.deadLetters as ReturnType<typeof vi.fn>).mockImplementation(() => queue);
    t.promptSpy.mockImplementation(async () => {
      t.emitSessionEvent({ type: "message_end", message: failedAssistant });
      t.emitSessionEvent({ type: "turn_end", message: failedAssistant, toolResults: [] });
      t.emitSessionEvent({ type: "agent_end", messages: [failedAssistant], willRetry: false });
    });

    const first = await t.bot.flushDeadLetters();
    const second = await t.bot.flushDeadLetters();

    expect({
      recovered: [first, second],
      promptCalls: t.promptSpy.mock.calls.length,
      pushedTexts: t.transport.pushed.map((push) => push.opts.text),
      requeued: (t.cascade.unshiftDead as ReturnType<typeof vi.fn>).mock.calls.length,
      queue,
    }).toEqual({
      recovered: [0, 0],
      promptCalls: 1,
      pushedTexts: [],
      requeued: 1,
      queue: [original],
    });
  });

  it("does not let a removed blocked replay suppress an unrelated later queue head", async () => {
    const blocked = {
      id: "dl-blocked", agentId: "assistant", transport: "mock", chatId: "42",
      text: "book the train", createdAt: Date.now(), attempts: [], lastError: "provider unavailable",
      automaticReplayBlocked: undefined as boolean | undefined,
    };
    const later = {
      id: "dl-later", agentId: "assistant", transport: "mock", chatId: "42",
      text: "tell me the weather", createdAt: Date.now() + 1, attempts: [], lastError: "provider unavailable",
      automaticReplayBlocked: undefined as boolean | undefined,
    };
    const queue = [blocked];
    const failedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "I booked the train" }],
      stopReason: "aborted",
      timestamp: Date.now(),
    };
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>).mockImplementation(() => queue.shift());
    (t.cascade.unshiftDead as ReturnType<typeof vi.fn>).mockImplementation((dead) => { queue.unshift(dead); });
    (t.cascade.deadLetters as ReturnType<typeof vi.fn>).mockImplementation(() => queue);
    t.promptSpy.mockImplementationOnce(async () => {
      t.emitSessionEvent({ type: "agent_end", messages: [failedAssistant], willRetry: false });
    });

    expect(await t.bot.flushDeadLetters()).toBe(0);
    expect(blocked.automaticReplayBlocked).toBe(true);

    queue.shift();
    queue.push(later);
    t.promptSpy.mockResolvedValueOnce(undefined);

    expect(await t.bot.flushDeadLetters()).toBe(1);
    expect(t.promptSpy).toHaveBeenCalledTimes(2);
  });

  it("delivers a successful terminal assistant output after an earlier failed attempt", async () => {
    const failedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "error",
      errorMessage: "temporary provider failure",
      timestamp: Date.now(),
    };
    const successfulAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "complete fallback answer" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    t.promptSpy.mockImplementationOnce(async () => {
      t.emitSessionEvent({ type: "agent_end", messages: [failedAssistant], willRetry: true });
      t.emitSessionEvent({ type: "agent_end", messages: [successfulAssistant], willRetry: false });
    });

    await expect(t.bot.promptAgent(t.transport, "42", "assistant", "answer this")).resolves.toBeUndefined();

    expect(t.transport.pushed.map((push) => push.opts.text)).toEqual(["complete fallback answer"]);
    expect(t.cascade.queueDead).not.toHaveBeenCalled();
    expect(t.cascade.noteSuccess).toHaveBeenCalledWith("ollama/test");
  });

  it("notifies the user when a turn is answered on a fallback model (primary down)", async () => {
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["primary/m", "fallback/m"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("fallback/m");
    (t.cascade.resolveModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "fallback" } as never);
    t.promptSpy.mockResolvedValue(undefined);

    await t.bot.promptAgent(t.transport, "42", "assistant", "hello");

    const notice = t.transport.pushed.map((p) => p.opts.text).find((text) => text.includes("answering on fallback model"));
    expect(notice).toBeTruthy();
    expect(notice).toContain("`fallback/m`");
    expect(notice).toContain("**primary/m**");
  });

  it("reports the fallback notice once, not once per message, while the primary stays down", async () => {
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["primary/m", "fallback/m"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("fallback/m");
    (t.cascade.resolveModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "fallback" } as never);
    t.promptSpy.mockResolvedValue(undefined);

    await t.bot.promptAgent(t.transport, "42", "assistant", "first");
    await t.bot.promptAgent(t.transport, "42", "assistant", "second");

    const notices = t.transport.pushed.filter((p) => p.opts.text.includes("answering on fallback model"));
    expect(notices).toHaveLength(1);
  });

  it("does not mistake historical assistant text for partial output on a terminal error", async () => {
    const original = {
      id: "dl-history", agentId: "assistant", transport: "mock", chatId: "42",
      text: "check the booking", createdAt: Date.now(), attempts: [], lastError: "provider unavailable",
      automaticReplayBlocked: undefined as boolean | undefined,
    };
    const priorAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "an answer from the previous turn" }],
      stopReason: "stop",
      timestamp: Date.now() - 1,
    };
    const failedAssistant = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider unavailable",
      timestamp: Date.now(),
    };
    const queue = [original];
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>).mockImplementation(() => queue.shift());
    (t.cascade.unshiftDead as ReturnType<typeof vi.fn>).mockImplementation((dead) => { queue.unshift(dead); });
    (t.cascade.deadLetters as ReturnType<typeof vi.fn>).mockImplementation(() => queue);
    t.promptSpy.mockImplementationOnce(async () => {
      t.emitSessionEvent({ type: "agent_end", messages: [priorAssistant, failedAssistant], willRetry: false });
    });

    expect(await t.bot.flushDeadLetters()).toBe(0);
    expect(original.automaticReplayBlocked).toBeUndefined();
    expect(t.transport.pushed).toEqual([]);
    expect(queue).toEqual([original]);
  });

  it("leaves a stale-route dead letter queued when the agent now prefers a dedicated route", async () => {
    const dedicated = new MockTransport("telegram:assistant", "assistant");
    t.bot.addTransport(dedicated);
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    t.promptSpy.mockResolvedValue(undefined);
    await dedicated.say("register the current dedicated route");
    t.promptSpy.mockClear();
    t.transport.pushed = [];
    dedicated.pushed = [];

    const stale = {
      id: "dl-stale-route", agentId: "assistant", transport: "mock", chatId: "42",
      text: "stale route message", createdAt: Date.now(), attempts: [], lastError: "models unavailable",
    };
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>).mockReturnValueOnce(stale).mockReturnValueOnce(undefined);

    expect(await t.bot.flushDeadLetters()).toBe(0);
    expect(t.promptSpy).not.toHaveBeenCalled();
    expect(t.cascade.unshiftDead).toHaveBeenCalledWith(stale);
  });

  it("still replays a dead letter addressed to the agent's current dedicated route", async () => {
    const dedicated = new MockTransport("telegram:assistant", "assistant");
    t.bot.addTransport(dedicated);
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    t.promptSpy.mockResolvedValue(undefined);
    await dedicated.say("register the current dedicated route");
    t.promptSpy.mockClear();
    dedicated.pushed = [];

    const current = {
      id: "dl-current-route", agentId: "assistant", transport: "telegram:assistant", chatId: "42",
      text: "current route message", createdAt: Date.now(), attempts: [], lastError: "models unavailable",
    };
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>).mockReturnValueOnce(current).mockReturnValueOnce(undefined);

    expect(await t.bot.flushDeadLetters()).toBe(1);
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    expect(t.promptSpy.mock.calls[0][0]).toContain("current route message");
    expect(t.cascade.unshiftDead).not.toHaveBeenCalled();
  });

  it("failed dead-letter recovery retains one item without notifying or re-queueing copies", async () => {
    const original = {
      id: "dl-focus", agentId: "assistant", transport: "mock", chatId: "42",
      text: "test", createdAt: Date.now(), attempts: ["ollama/test"], lastError: "402 payment required",
    };
    const queue = [original];
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>).mockImplementation(() => queue.shift());
    (t.cascade.queueDead as ReturnType<typeof vi.fn>).mockImplementation((dl) => {
      const copy = { id: `copy-${queue.length}`, ...dl };
      queue.push(copy);
      return copy;
    });
    (t.cascade.unshiftDead as ReturnType<typeof vi.fn>).mockImplementation((dl) => { queue.unshift(dl); });

    const n = await t.bot.flushDeadLetters();

    expect(n).toBe(0);
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    expect(t.cascade.queueDead).not.toHaveBeenCalled();
    expect(t.cascade.unshiftDead).toHaveBeenCalledWith(original);
    expect(queue).toEqual([original]);
    expect(t.transport.pushed.filter((p) => p.opts.text.startsWith("⚠︎"))).toHaveLength(0);
  });

  it("flushDeadLetters drops legacy wrapped meta-entries (loop guard)", async () => {
    (t.cascade.takeOneDead as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        id: "dl1", agentId: "focuscoach", transport: "mock", chatId: "42", createdAt: Date.now(), attempts: [], lastError: "x",
        text: "[cascade-recover] (queued while all models were down, 11:06 PM): [cascade-recover] (queued while all models were down, 11:06 PM): [cascade-recover] (que",
      })
      .mockReturnValue(undefined);
    const n = await t.bot.flushDeadLetters();
    expect(n).toBe(0);
    expect(t.promptSpy).not.toHaveBeenCalled();
    expect(t.events.log).toHaveBeenCalledWith("focuscoach", "system", expect.stringContaining("loop guard"));
  });
});

describe("splitMediaLines", () => {
  it("extracts url and local-path media lines, strips them from text, caps at 3", async () => {
    const { splitMediaLines } = await import("./bot.js");
    const text = [
      "Here are the candidates:",
      "MEDIA: /tmp/a.jpg",
      "",
      "MEDIA: https://x.example/b.png",
      "extra note",
      "MEDIA: /tmp/c.jpg",
      "MEDIA: /tmp/d.jpg",
      "MEDIA: /tmp/e.jpg (this one is over the cap)",
    ].join("\n");
    const { text: clean, media } = splitMediaLines(text);
    expect(media).toEqual(["/tmp/a.jpg", "https://x.example/b.png", "/tmp/c.jpg"]);
    expect(clean).not.toContain("MEDIA:");
    expect(clean).toContain("Here are the candidates:");
    expect(clean).toContain("extra note");
expect(clean).not.toContain("/tmp/d.jpg");
  });
});

describe("MEDIA delivery observability", () => {
  const assistantWithMedia = {
    role: "assistant",
    content: [{ type: "text", text: "Files attached.\n\nMEDIA: /tmp/creator/linked.srt" }],
  };
  function primeTurn(t: ReturnType<typeof makeBot>) {
    (t.promptSpy as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      t.emitSessionEvent({ type: "message_end", message: assistantWithMedia });
      t.emitSessionEvent({ type: "turn_end", message: assistantWithMedia, toolResults: [] });
      t.emitSessionEvent({ type: "agent_end", messages: [assistantWithMedia], willRetry: false });
    });
  }

  it("records a dropped-media event when the transport cannot send media", async () => {
    const t = makeBot();
    primeTurn(t);
    await t.transport.say("attach test");
    expect(t.transport.pushed.map((p) => p.opts.text)).toEqual(["Files attached."]);
    expect(t.events.log).toHaveBeenCalledWith("assistant", "system", expect.stringContaining("media dropped"));
    expect(t.events.log).toHaveBeenCalledWith("assistant", "system", expect.stringContaining("/tmp/creator/linked.srt"));
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("logs successful media sends with file, transport and chat", async () => {
    const t = makeBot();
    const sendMedia = vi.fn(async () => {});
    (t.transport as unknown as { sendMedia?: unknown }).sendMedia = sendMedia;
    primeTurn(t);
    await t.transport.say("attach test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMedia).toHaveBeenCalledWith("42", "/tmp/creator/linked.srt");
    expect(t.events.log).toHaveBeenCalledWith("assistant", "media", expect.stringContaining("sent /tmp/creator/linked.srt"));
    fs.rmSync(t.dir, { recursive: true, force: true });
  });
});

describe("voice transcript echo", () => {
  it("does not echo by default — the transcript goes to the agent, not back to the chat", async () => {
    const t = makeBot();
    fs.writeFileSync(path.join(t.dir, "dictionary.json"), JSON.stringify({ entries: [{ from: "west", to: "WhisperKit" }] }));
    (t.stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, text: "I tested west today", provider: "whisperkit" });
    await t.transport.sayMedia({ kind: "voice", durationSec: 5 });
    expect(t.transport.pushed.some((p) => p.opts.text.startsWith("🎙"))).toBe(false);
    expect(t.promptSpy.mock.calls[0][0]).toContain("I tested WhisperKit today");
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("echoes only with PIBOT_VOICE_ECHO=1 (opt-in)", async () => {
    process.env.PIBOT_VOICE_ECHO = "1";
    try {
      const t2 = makeBot();
      await t2.transport.sayMedia({ kind: "voice", durationSec: 5 });
      expect(t2.transport.pushed.some((p) => p.opts.text.startsWith("🎙 spoken words"))).toBe(true);
      fs.rmSync(t2.dir, { recursive: true, force: true });
    } finally {
      delete process.env.PIBOT_VOICE_ECHO;
    }
  });
});

describe("task ack confirmations", () => {
  function sessionWithReply(text: string) {
    return {
      agent: { state: { messages: [{ role: "assistant", content: [{ type: "text", text }] }] } },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      isStreaming: false,
    };
  }

  it("inter-agent task replies surface a passive ack line in the recipient's chat", async () => {
    const t = makeBot();
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithReply("On it — leave it with me."));
    bBind(t, "assistant", "mock:42");
    await (t.bot as unknown as { agentTurn(a: string, f: string, text: string): Promise<string> }).agentTurn(
      "assistant", "knower", "file the Berlin takeaways"
    );
    expect(t.transport.pushed.some((p) => p.opts.text.includes("🤝 **assistant** accepted **knower**'s task: “file the Berlin takeaways”"))).toBe(true);
    expect(t.events.log).toHaveBeenCalledWith("assistant", "task-ack", expect.stringContaining("accepted"));
  });

  it("origin-chat routing: delegated work reports back to the chat the owner typed in", async () => {
    const t = makeBot();
    const sess = {
      agent: { state: { messages: [{ role: "assistant", content: [{ type: "text", text: "Built and committed. Dashboard is live." }] }] } },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      isStreaming: false,
    };
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sess);
    await (t.bot as unknown as { agentAsk(f: string, to: string, q: string, timeoutMs?: number, origin?: { transport: string; chatId: string }): Promise<string> }).agentAsk(
      "fitness", "assistant", "implement the dashboard", undefined, { transport: "mock", chatId: "42" }
    );
    // final status pushed into the origin chat, sender-attributed (shared transport)
    const status = t.transport.pushed.find((p) => p.opts.text.includes("Built and committed"));
    expect(status).toBeDefined();
    expect(status!.opts.text).toContain("[assistant]");
    // envelope told the target agent where the owner typed
    const promptArg = (sess.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("Reply-to (owner's chat): mock:42");
    // trail: origin send is event-logged with a bounded preview
    expect(t.events.log).toHaveBeenCalledWith("assistant", "send", expect.stringContaining("mock:42"));
  });

  it("origin-chat routing: long delegated replies survive past the old 900-char cap", async () => {
    const t = makeBot();
    const tail = "TAIL-MARKER-cue-35-37-survive";
    const sess = sessionWithReply("A".repeat(900) + " … " + tail);
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sess);
    await (t.bot as unknown as { agentAsk(f: string, to: string, q: string, timeoutMs?: number, origin?: { transport: string; chatId: string }): Promise<string> }).agentAsk(
      "fitness", "assistant", "long job with a long report", undefined, { transport: "mock", chatId: "42" }
    );
    const status = t.transport.pushed.find((p) => p.opts.text.includes(tail));
    expect(status).toBeDefined(); // the tail must survive the origin-chat push
    expect(status!.opts.text).toContain("[assistant]"); // attribution kept
  });

  it("origin-chat routing: unknown origin transport degrades silently", async () => {
    const t = makeBot();
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithReply("done"));
    await (t.bot as unknown as { agentAsk(f: string, to: string, q: string, timeoutMs?: number, origin?: { transport: string; chatId: string }): Promise<string> }).agentAsk(
      "fitness", "assistant", "implement", undefined, { transport: "ghost", chatId: "42" }
    );
    expect(t.transport.pushed.length).toBe(0); // no push, no crash
  });

  it("origin-chat routing: inter-agent questions render in the owner's chat", async () => {
    const t = makeBot();
    const sess = sessionWithReply("answered with the structured question");
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sess);
    let askHook: ((spec: unknown) => Promise<unknown>) | undefined;
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => {
      askHook = args[4] as (spec: unknown) => Promise<unknown>;
      return sess;
    });
    const p = (t.bot as unknown as { agentAsk(f: string, to: string, q: string, timeoutMs?: number, origin?: { transport: string; chatId: string }): Promise<string> }).agentAsk(
      "fitness", "assistant", "decide with me", undefined, { transport: "mock", chatId: "42" }
    );
    await vi.waitFor(() => expect(askHook).toBeDefined());
    // ask_user from the pair session renders into the origin chat
    const answerPromise = askHook!({ text: "Which framing?", options: ["survey", "interviews"] } as never) as Promise<unknown>;
    await vi.waitFor(() => {
      const pushed = t.transport.pushed.find((p2) => p2.opts.text.includes("Which framing?"));
      expect(pushed).toBeDefined();
    });
    const card = t.transport.pushed.find((p2) => p2.opts.text.includes("framing?"))!.opts.card!;
    const action = card.buttons[0].action; // tap "survey"
    expect(card.buttons.map((b) => b.label)).toEqual(["survey", "interviews"]);
    await (t.bot as unknown as { handleAction(t: unknown, chatId: string, action: string): Promise<void> }).handleAction(t.transport, "42", action);
    const answer = (await answerPromise) as { choice: string; via: string };
    expect(answer.choice).toBe("survey");
    await p; // the delegated turn completes
  });

  it("task acks respect the per-agent opt-out", async () => {
    const t = makeBot();
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "assistant" ? { id, dir: "/x", manifest: { name: id, comms: { taskAcks: false } } } : undefined
    );
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithReply("On it, will do."));
    bBind(t, "assistant", "mock:42");
    await (t.bot as unknown as { agentTurn(a: string, f: string, text: string): Promise<string> }).agentTurn(
      "assistant", "knower", "file the report"
    );
    expect(t.transport.pushed.some((p) => p.opts.text.includes("accepted"))).toBe(false);
  });

  it("owner task assignments in the agent's chat ack too", async () => {
    const t = makeBot();
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithReply("On it — will do."));
    await t.transport.say("file the Berlin takeaways");
    // unthreaded owner lines quote the handed task, not the reply — quoting the
    // reply reads as if the reply were the task ("accepted your task: 'On it…'")
    expect(t.transport.pushed.some((p) => p.opts.text.includes("🤝 **assistant** accepted your task: “file the Berlin takeaways”"))).toBe(true);
  });

  it("wiring: transports forwarding the message id produce threaded acks", async () => {
    const t = makeBot();
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithReply("On it — will do."));
    await t.transport.say("please file the Berlin takeaways today", 77);
    const ack = t.transport.pushed.find((p) => p.opts.text.includes("🤝"));
    expect(ack?.opts.replyToMessageId).toBe(77);
    // threaded lines are description-first — no attribution needed
    expect(ack?.opts.text).toBe("🤝 **assistant**: “On it — will do.”");
  });

  it("owner statements and questions never ack — even when the reply quotes completion words", async () => {
    const t = makeBot();
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      sessionWithReply("That was a housekeeping receipt. The note says: report finished files, not intentions.")
    );
    await t.transport.say("received this in creator, [17. Sep 2026]: rotation serviced");
    expect(t.transport.pushed.some((p) => p.opts.text.includes("✅") || p.opts.text.includes("🤝") || p.opts.text.includes("🚫"))).toBe(false);
  });

  it("threaded owner turns on non-task statements stay silent too", async () => {
    const t = makeBot();
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      sessionWithReply("Nothing changed in how the bots behave — the word finished was inside a quoted note.")
    );
    await t.transport.say("received this in creator, [17. Sep 2026]: rotation serviced", 55);
    expect(t.transport.pushed.some((p) => p.opts.text.includes("✅") || p.opts.text.includes("🤝") || p.opts.text.includes("🚫"))).toBe(false);
  });

  it("acks thread to the original task message when its id is known", async () => {
    const t = makeBot();
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithReply("On it — will do."));
    await t.bot.handleIncoming(t.transport, "42", "please file the Berlin takeaways today", undefined, 77);
    const ack = t.transport.pushed.find((p) => p.opts.text.includes("🤝"));
    expect(ack?.opts.replyToMessageId).toBe(77);
    // threaded lines are description-first — no attribution needed
    expect(ack?.opts.text).toBe("🤝 **assistant**: “On it — will do.”");
  });

  it("chatter-trigger words never ack in owner chats", async () => {
    const t = makeBot();
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithReply("On it — will do."));
    await t.transport.say("ok");
    expect(t.transport.pushed.some((p) => p.opts.text.includes("🤝"))).toBe(false);
  });

  function bBind(t: ReturnType<typeof makeBot>, agentId: string, ck: string): void {
    const b = t.bot as unknown as { agentChats: Map<string, Set<string>>; chatAgent: Map<string, string> };
    b.chatAgent.set(ck, agentId);
    b.agentChats.set(agentId, new Set([ck]));
  }
});

describe("chat routing ownership", () => {
  type RoutingBot = {
    agentChats: Map<string, Set<string>>;
    chatAgent: Map<string, string>;
    transports: Map<string, Transport>;
    primaryChat(job: { agentId: string; chat?: { transport: string; chatId: string } }): string | null;
    rememberChat(agentId: string, ck: string): void;
    reconcileChatMemories(): void;
  };
  const bot = (t: ReturnType<typeof makeBot>) => t.bot as unknown as RoutingBot;

  it("primaryChat routes internal jobs to a chat the agent owns, never a rebound memory", () => {
    const t = makeBot();
    const b = bot(t);
    b.transports.set("telegram", { name: "telegram" } as unknown as Transport);
    b.transports.set("telegram:coach", { name: "telegram:coach", boundAgentId: "coach" } as unknown as Transport);
    b.chatAgent.set("telegram:161427550", "assistant"); // main chat rebound to assistant
    b.agentChats.set("coach", new Set(["telegram:161427550", "telegram:coach:161427550"]));
    expect(b.primaryChat({ agentId: "coach", chat: { transport: "internal", chatId: "brief" } })).toBe("telegram:coach:161427550");
    // captured concrete chat the agent no longer owns → falls back to the owned one
    expect(b.primaryChat({ agentId: "coach", chat: { transport: "telegram", chatId: "161427550" } })).toBe("telegram:coach:161427550");
    // still-owned captured chat → honored
    expect(b.primaryChat({ agentId: "coach", chat: { transport: "telegram:coach", chatId: "161427550" } })).toBe("telegram:coach:161427550");
    // nothing owned at all → null (caller suppresses instead of misdelivering)
    b.agentChats.delete("coach");
    expect(b.primaryChat({ agentId: "coach", chat: { transport: "internal", chatId: "brief" } })).toBeNull();
  });

  it("rebinding a chat drops it from the previous owner's memory", () => {
    const t = makeBot();
    const b = bot(t);
    b.chatAgent.set("telegram:161427550", "assistant");
    b.agentChats.set("assistant", new Set(["telegram:161427550"]));
    b.rememberChat("knower", "telegram:161427550");
    expect(b.chatAgent.get("telegram:161427550")).toBe("knower");
    expect(b.agentChats.get("assistant")?.has("telegram:161427550")).toBe(false);
    expect(b.agentChats.get("knower")?.has("telegram:161427550")).toBe(true);
  });

  it("boot reconcile prunes stale memories and keeps owned ones", () => {
    const t = makeBot();
    const b = bot(t);
    b.transports.set("telegram:creator", { name: "telegram:creator", boundAgentId: "creator" } as unknown as Transport);
    b.chatAgent.set("telegram:161427550", "knower");
    b.agentChats.set("focuscoach", new Set(["telegram:161427550"]));
    b.agentChats.set("creator", new Set(["telegram:creator:161427550"]));
    b.agentChats.set("knower", new Set(["telegram:161427550"]));
    b.reconcileChatMemories();
    expect(b.agentChats.get("focuscoach")).toBeUndefined();
    expect(b.agentChats.get("creator")?.has("telegram:creator:161427550")).toBe(true);
    expect(b.agentChats.get("knower")?.has("telegram:161427550")).toBe(true);
  });
});

describe("morning brief scheduling — one bot only", () => {
  function runBriefEnsure(t: ReturnType<typeof makeBot>, agents: unknown[]): void {
    const b = t.bot as unknown as { ensureMorningBriefJob(a: unknown): void };
    for (const a of agents) b.ensureMorningBriefJob(a);
  }

  it("schedules the brief only for the default agent and prunes stale brief jobs of others", () => {
    const t = makeBot();
    const agents = [
      { id: "assistant", dir: "/x", manifest: { name: "assistant", heartbeat: { enabled: true, interval: "45m" } } },
      { id: "coach", dir: "/y", manifest: { name: "coach", heartbeat: { enabled: true, interval: "30m" } } },
    ];
    (t.agents.list as ReturnType<typeof vi.fn>).mockReturnValue(agents);
    (t.scheduler.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "brief:coach" ? { id, kind: "morning-brief" } : undefined);
    runBriefEnsure(t, agents);
    const ensured = ((t.scheduler.ensure as ReturnType<typeof vi.fn>).mock.calls as Array<Array<unknown>>).map((c) => (c[0] as { id: string }).id);
    expect(ensured).toContain("brief:assistant");
    expect(ensured).not.toContain("brief:coach");
    expect(t.scheduler.cancel).toHaveBeenCalledWith("brief:coach");
  });

  it("a non-default agent can opt in via manifest.heartbeat.morningBrief", () => {
    const t = makeBot();
    const agents = [
      { id: "assistant", dir: "/x", manifest: { name: "assistant", heartbeat: { enabled: true, interval: "45m" } } },
      { id: "coach", dir: "/y", manifest: { name: "coach", heartbeat: { enabled: true, interval: "30m", morningBrief: true } } },
    ];
    (t.agents.list as ReturnType<typeof vi.fn>).mockReturnValue(agents);
    runBriefEnsure(t, agents);
    const ensured = ((t.scheduler.ensure as ReturnType<typeof vi.fn>).mock.calls as Array<Array<unknown>>).map((c) => (c[0] as { id: string }).id);
    expect(ensured).toContain("brief:coach");
    expect(t.scheduler.cancel).not.toHaveBeenCalled();
  });

  it("prunes stale brief jobs even when the agent's heartbeat is disabled", () => {
    const t = makeBot();
    const agents = [
      { id: "coach", dir: "/y", manifest: { name: "coach", heartbeat: { enabled: false, interval: "30m" } } },
    ];
    (t.agents.list as ReturnType<typeof vi.fn>).mockReturnValue(agents);
    (t.scheduler.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "brief:coach" ? { id, kind: "morning-brief" } : undefined);
    runBriefEnsure(t, agents);
    expect(t.scheduler.cancel).toHaveBeenCalledWith("brief:coach");
  });
});

describe("schedule failure notices", () => {
  it("excludes the failing chat from the notice target — no phantom-session recreation loop", async () => {
    const { bot, transport } = makeBot();
    const b = bot as unknown as {
      agentChats: Map<string, Set<string>>;
      chatAgent: Map<string, string>;
      transports: Map<string, Transport>;
    };
    const phantom = new MockTransport("telegram");
    b.transports.set("telegram", phantom);
    // assistant "owns" the phantom chat (telegram:123) and one real chat
    b.agentChats.set("assistant", new Set(["telegram:123", "telegram:161427550"]));
    b.chatAgent.set("telegram:123", "assistant");
    b.chatAgent.set("telegram:161427550", "assistant");

    const job = {
      id: "sc_x",
      agentId: "assistant",
      chat: { transport: "telegram", chatId: "123" },
      title: "morning brief",
    } as unknown as Schedule;
    await bot.notifyScheduleFailure(job, "could not be delivered");

    expect(phantom.pushed.some((p) => p.chatId === "123")).toBe(false); // nothing into the failing chat
    expect(phantom.pushed.some((p) => p.chatId === "161427550")).toBe(true); // the real chat gets it
  });

  it("suppresses the notice when the agent owns no real chat", async () => {
    const { bot, events } = makeBot();
    const b = bot as unknown as {
      agentChats: Map<string, Set<string>>;
      chatAgent: Map<string, string>;
      transports: Map<string, Transport>;
    };
    const phantom = new MockTransport("telegram");
    b.transports.set("telegram", phantom);
    b.agentChats.set("assistant", new Set(["telegram:123"]));
    b.chatAgent.set("telegram:123", "assistant");

    const job = {
      id: "sc_x",
      agentId: "assistant",
      chat: { transport: "telegram", chatId: "123" },
      title: "morning brief",
    } as unknown as Schedule;
    await bot.notifyScheduleFailure(job, "could not be delivered");

    expect(phantom.pushed.length).toBe(0); // no notice into the phantom
    expect((events.log as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[2]).includes("suppressed"))).toBe(true);
  });
});

describe("silent turns — a turn that produces no text must not leave the owner guessing", () => {
  // Sep 18 incident: a genuine question to pibot-dev ran 14 tool calls and ended on a
  // reasoning-only terminal message. Nothing was pushed, no error, no log line — the
  // owner's chat simply stayed silent and looked like a dead bot.
  function sessionWithMessages(messages: unknown[]) {
    return {
      agent: { state: { messages } },
      prompt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      isStreaming: false,
    };
  }
  const userTurn = { role: "user", content: [{ type: "text", text: "[Fri, Sep 18, 2026, 3:55 PM]\n\nanalyse the whole flow" }] };
  const reasoningOnly = { role: "assistant", content: [{ type: "thinking", thinking: "weighing options…" }], stopReason: "stop" };
  const toolCallOnly = { role: "assistant", content: [{ type: "toolCall", name: "read", args: {} }], stopReason: "toolUse" };
  const narrated = { role: "assistant", content: [{ type: "text", text: "Now the Telegram transport:" }], stopReason: "toolUse" };

  async function runTurn(t: ReturnType<typeof makeBot>, prompt: string, messages: unknown[]) {
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithMessages(messages));
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    await t.bot.promptAgent(t.transport, "42", "assistant", prompt);
    return t.transport.pushed.filter((p) => p.opts.text.includes("without a reply"));
  }

  it("announces the silence on a genuine user turn instead of pushing nothing", async () => {
    const t = makeBot();
    const notices = await runTurn(t, "analyse the whole flow", [userTurn, narrated, toolCallOnly, reasoningOnly]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.opts.text).toContain("1 tool call");
    expect(t.events.log).toHaveBeenCalledWith("assistant", "system", expect.stringContaining("silent turn"));
  });

  it("does not narrate stale intermediate text as if it were the answer", async () => {
    const t = makeBot();
    const notices = await runTurn(t, "analyse the whole flow", [userTurn, narrated, reasoningOnly]);
    expect(t.transport.pushed.some((p) => p.opts.text.includes("Now the Telegram transport:"))).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it("stays quiet for host-generated prompts — a heartbeat may legitimately say nothing", async () => {
    const t = makeBot();
    const notices = await runTurn(t, "[heartbeat] stretch and check the queue", [userTurn, reasoningOnly]);
    expect(notices).toHaveLength(0);
    expect(t.events.log).not.toHaveBeenCalledWith("assistant", "system", expect.stringContaining("silent turn"));
  });

  it("stays quiet when the terminal message does carry a reply", async () => {
    const t = makeBot();
    const replied = { role: "assistant", content: [{ type: "text", text: "Here is the analysis." }], stopReason: "stop" };
    const notices = await runTurn(t, "analyse the whole flow", [userTurn, replied]);
    expect(notices).toHaveLength(0);
  });

  it("counts only the current turn's tool calls, not the whole session", async () => {
    const t = makeBot();
    const olderTurn = { role: "user", content: [{ type: "text", text: "[Thu, Sep 17, 2026]\n\nearlier ask" }] };
    const olderTools = [
      { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "toolCall", name: "read" }], stopReason: "toolUse" },
    ];
    const notices = await runTurn(t, "analyse the whole flow", [olderTurn, ...olderTools, userTurn, toolCallOnly, reasoningOnly]);
    expect(notices[0]?.opts.text).toContain("1 tool call");
  });
});

describe("turn identity + failed attachments (silent-loss fixes)", () => {
  /** Drive a turn through the real wiring (sessionFor subscribes the listener). */
  function wireTurn(t: ReturnType<typeof makeBot>, replyText: string | null) {
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    t.promptSpy.mockImplementation(async () => {
      if (replyText === null) return;
      t.emitSessionEvent({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: replyText }] }],
      });
    });
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("stamps every reply with its turn's identity, not its text", async () => {
    const t = makeBot();
    wireTurn(t, "On it.");
    await t.bot.promptAgent(t.transport, "42", "assistant", "do X", { incomingMessageId: 101 });
    await t.bot.promptAgent(t.transport, "42", "assistant", "do X", { incomingMessageId: 102 });

    const replies = t.transport.pushed.filter((p) => p.opts.text === "On it.");
    expect(replies).toHaveLength(2); // the same words answering two messages are not a duplicate
    expect(replies.map((p) => p.opts.dedupeKey)).toEqual([
      expect.stringContaining("msg:101"),
      expect.stringContaining("msg:102"),
    ]);
  });

  it("gives a turn with no incoming message a unique key rather than falling back to text", async () => {
    const t = makeBot();
    wireTurn(t, "Same words.");
    await t.bot.promptAgent(t.transport, "42", "assistant", "one");
    await t.bot.promptAgent(t.transport, "42", "assistant", "two");

    const keys = t.transport.pushed.filter((p) => p.opts.text === "Same words.").map((p) => p.opts.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("surfaces a failed attachment instead of only logging it to the console", async () => {
    const t = makeBot();
    (t.transport as unknown as { sendMedia: unknown }).sendMedia = vi.fn(async () => {
      throw new Error("file too big");
    });
    wireTurn(t, "Report attached.\n\nMEDIA: /tmp/flow-review.md");
    await t.bot.promptAgent(t.transport, "42", "assistant", "send the report");
    await settle();

    expect(t.events.log).toHaveBeenCalledWith("assistant", "system", expect.stringContaining("media send failed"));
    const notice = t.transport.pushed.find((p) => p.opts.text.includes("couldn't deliver the attachment"));
    expect(notice?.opts.text).toContain("flow-review.md");
  });

  it("stays quiet when the attachment arrives", async () => {
    const t = makeBot();
    (t.transport as unknown as { sendMedia: unknown }).sendMedia = vi.fn(async () => {});
    wireTurn(t, "Report attached.\n\nMEDIA: /tmp/ok.md");
    await t.bot.promptAgent(t.transport, "42", "assistant", "send the report");
    await settle();

    expect(t.transport.pushed.some((p) => p.opts.text.includes("couldn't deliver"))).toBe(false);
    expect(t.events.log).toHaveBeenCalledWith("assistant", "media", expect.stringContaining("ok.md"));
  });

  it("oversized attachments become a private tailnet link instead of a failed upload", async () => {
    const t = makeBot();
    const big = path.join(t.dir, "big-export.zip");
    fs.writeFileSync(big, Buffer.alloc(24 * 1024 * 1024, 7)); // > 20MB pibot cap
    const sendMedia = vi.fn(async () => {});
    (t.transport as unknown as { sendMedia: unknown }).sendMedia = sendMedia;
    const hostname = vi.fn(async () => "https://macbook-pro-4.tail1234.ts.net");
    (t.bot as unknown as { mediaBaseOverride?: unknown }).mediaBaseOverride = hostname;
    wireTurn(t, `Export attached.\n\nMEDIA: ${big}`);
    await t.bot.promptAgent(t.transport, "42", "assistant", "send the export");
    await settle();

    expect(sendMedia).not.toHaveBeenCalled(); // no doomed upload attempt
    const notice = t.transport.pushed.find((p) => p.opts.text.includes("📦"));
    expect(notice?.opts.text).toContain("big-export.zip");
    expect(notice?.opts.text).toContain("https://macbook-pro-4.tail1234.ts.net/media/big-export.zip?t=");
    expect(t.events.log).toHaveBeenCalledWith("assistant", "media", expect.stringContaining("tailnet link"));
    fs.rmSync(big, { force: true });
  });
});

describe("dev-turn start confirmation", () => {
  it("dev agent turn start: stable 🛠 badge instead of the emoji cycle", async () => {
    const t = makeBot();
    await t.bot.promptAgent(t.transport, t.transport.chatId, "pibot-dev", "dig into the flow");
    t.emitSessionEvent({ type: "agent_start" });
    expect(t.transport.workBadges).toEqual([["42", "👨‍💻"]]);
    expect(t.transport.working.length).toBe(0);
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("ordinary agent turn start: emoji cycle, no badge", async () => {
    const t = makeBot();
    await t.transport.say("hello");
    t.emitSessionEvent({ type: "agent_start" });
    expect(t.transport.working.length).toBe(1);
    expect(t.transport.workBadges.length).toBe(0);
    fs.rmSync(t.dir, { recursive: true, force: true });
  });
});

describe("post-boot confirmation", () => {
  it("sends one 🟢 line to the owner's main chat, with offline sub-bots surfaced", async () => {
    const t = makeBot();
    await t.transport.say("hi"); // binds the default agent's chat
    t.transport.pushed.length = 0;
    await t.bot.notifyBoot({ attached: ["tax"], failed: ["knower"] });
    const text = t.transport.pushed.map((p) => p.opts.text).join("\n");
    expect(text).toContain("🟢 pibot restarted");
    expect(text).toContain("1 agent · telegram offline · 1 sub-bot attached");
    expect(text).toContain("⚠︎ offline: knower");
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("stays silent when no chat is bound (suppression, not a crash)", async () => {
    const t = makeBot();
    await expect(t.bot.notifyBoot({ attached: [], failed: [] })).resolves.toBeUndefined();
    expect(t.transport.pushed).toHaveLength(0);
    fs.rmSync(t.dir, { recursive: true, force: true });
  });
});

describe("nudge feedback cards", () => {
  it("heartbeat-origin pushes carry the 👍/👎/🔎/later card and record the nudge id", async () => {
    const t = makeBot();
    const commitments = {
      deliverHeartbeatSpeak: vi.fn(),
      handleNudgeAction: vi.fn(async () => "Noted — more of this 👍"),
      onFire: vi.fn(async () => {}),
    };
    (t.bot as unknown as { deps: { commitments: unknown } }).deps.commitments = commitments;
    const bBind2 = (t as unknown as { bot: { rememberChat: (a: string, c: string) => void } }).bot;
    bBind2.rememberChat("assistant", "mock:42");
    await t.bot.deliverToAgent("assistant", "research signals look interesting", { origin: "heartbeat" });
    const push = t.transport.pushed.find((p) => p.opts.text.includes("research signals"));
    expect(push?.opts.card?.buttons.map((b) => b.label)).toEqual(["👍", "👎", "🔎", "⏰ later"]);
    expect(push?.opts.card?.buttons[0].action).toMatch(/^nudge:nv\w+:up$/);
    expect(commitments.deliverHeartbeatSpeak).toHaveBeenCalledWith("assistant", true, expect.stringMatching(/^nv/));
    // card tap routes to the engine
    await t.bot.handleAction(t.transport, "42", "nudge:nv000001:up");
    expect(commitments.handleNudgeAction).toHaveBeenCalledWith("nudge:nv000001:up", "42");
  });

  it("non-heartbeat pushes carry no nudge card", async () => {
    const t = makeBot();
    const commitments = { deliverHeartbeatSpeak: vi.fn(), handleNudgeAction: vi.fn() };
    (t.bot as unknown as { deps: { commitments: unknown } }).deps.commitments = commitments;
    (t as unknown as { bot: { rememberChat: (a: string, c: string) => void } }).bot.rememberChat("assistant", "mock:42");
    await t.bot.deliverToAgent("assistant", "plain update", {});
    expect(t.transport.pushed.at(-1)?.opts.card).toBeUndefined();
  });
});

describe("acceptance acks for delegated work", () => {
  it("origin chat sees an immediate accepted-ack before the final result", async () => {
    const t = makeBot();
    const sess = {
      agent: { state: { messages: [{ role: "assistant", content: [{ type: "text", text: "Built and committed. Dashboard is live." }] }] } },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      isStreaming: false,
    };
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue(sess);
    // release the session prompt only after a tick so the ack has time to land first
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    sess.prompt = vi.fn(async () => { await gate; });
    setTimeout(release, 20);
    await (t.bot as unknown as { agentAsk(f: string, to: string, q: string, timeoutMs?: number, origin?: { transport: string; chatId: string }): Promise<string> }).agentAsk(
      "fitness", "assistant", "implement the dashboard", undefined, { transport: "mock", chatId: "42" }
    );
    const texts = t.transport.pushed.map((p) => p.opts.text);
    const ackIdx = texts.findIndex((x) => x.includes("accepted"));
    const doneIdx = texts.findIndex((x) => x.includes("Dashboard is live"));
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(ackIdx).toBeLessThan(doneIdx); // ack precedes the result
    expect(texts[ackIdx]).toContain("[assistant]");
  });
});

describe("minimal voice communication", () => {
  const TECH = "Fixed it — see https://github.com/glebis/pibot/pull/42 and the notes in /Users/gleb/ai_projects/pibot/src/core/bot.ts.";
  function wire(t: ReturnType<typeof makeBot>, reply: string) {
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
    t.promptSpy.mockImplementation(async () => {
      t.emitSessionEvent({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: reply }] }] });
    });
  }
  const lastReply = (t: ReturnType<typeof makeBot>) => t.transport.pushed.at(-1)?.opts.text ?? "";

  it("is off by default and leaves replies alone", async () => {
    const t = makeBot();
    wire(t, TECH);
    await t.bot.promptAgent(t.transport, "42", "assistant", "what did you do");
    expect(lastReply(t)).toBe(TECH);
  });

  it("/minimal on turns it on, persists it, and strips the reply", async () => {
    const t = makeBot();
    await t.transport.say("/minimal on");
    expect(lastReply(t)).toContain("Minimal voice: **on**");
    const reply = lastReply(t);

    wire(t, TECH);
    await t.bot.promptAgent(t.transport, "42", "assistant", "what did you do");
    const out = lastReply(t);
    expect(out).not.toContain("https://github.com");
    expect(out).not.toContain("/Users/gleb/ai_projects/pibot/src/core/");
    expect(out).toContain("bot.ts"); // file name survives, path does not
    expect(out).not.toBe(reply);

    // durable: the override is in the state file, not just in memory
    const state = JSON.parse(fs.readFileSync(path.join(t.dir, "state.json"), "utf8")) as { minimalChats?: Record<string, boolean> };
    expect(state.minimalChats).toEqual({ "mock:42": true });
  });

  it("reports where the current setting comes from, and turns back off", async () => {
    const t = makeBot();
    await t.transport.say("/minimal");
    expect(lastReply(t)).toContain("minimal voice: **off**");
    await t.transport.say("/minimal on");
    await t.transport.say("/minimal");
    expect(lastReply(t)).toContain("set here with /minimal");
    await t.transport.say("/minimal off");
    wire(t, TECH);
    await t.bot.promptAgent(t.transport, "42", "assistant", "again");
    expect(lastReply(t)).toBe(TECH);
  });

  it("a per-chat override beats the agent's manifest default", async () => {
    const t = makeBot();
    // production's getAgent returns the cached LoadedAgent; pin it so the manifest
    // mutation is visible to later reads (the stub otherwise rebuilds the object)
    const agentInstance = t.agents.getAgent("assistant")!;
    (t.agents.getAgent as ReturnType<typeof vi.fn>).mockReturnValue(agentInstance);
    agentInstance.manifest.speech = { minimal: true };
    wire(t, TECH);
    await t.bot.promptAgent(t.transport, "42", "assistant", "with the manifest default on");
    expect(lastReply(t)).toContain("bot.ts"); // filtered
    expect(lastReply(t)).not.toContain("https://github.com");

    await t.transport.say("/minimal off"); // explicit per-chat wins, even against the manifest
    await t.bot.promptAgent(t.transport, "42", "assistant", "overridden off");
    expect(lastReply(t)).toBe(TECH);

    // ...and /minimal default hands control back to the agent's manifest
    await t.transport.say("/minimal default");
    await t.bot.promptAgent(t.transport, "42", "assistant", "back to the manifest default");
    expect(lastReply(t)).not.toContain("https://github.com");
  });

  it("never filters an operational notice — silence is not an option", async () => {
    const t = makeBot();
    await t.transport.say("/minimal on");
    const notice = "⚠️ **assistant** finished that turn without a reply — ask again, or say “continue”.";
    wire(t, "warm up the session listener");
    await t.bot.promptAgent(t.transport, "42", "assistant", "warm up");
    t.emitSessionEvent({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: notice }] }] });
    await vi.waitFor(() => expect(t.transport.pushed.some((p) => p.opts.text === notice)).toBe(true));
  });

  it("hands the session a spoken-text styler that caps (so the AUDIO is minimal, not just the caption)", async () => {
    const t = makeBot();
    await t.transport.say("/minimal on");
    wire(t, "ok");
    await t.bot.promptAgent(t.transport, "42", "assistant", "say it");
    const call = (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const styler = call.at(-1) as (text: string) => string;
    expect(typeof styler).toBe("function");
    const spoken = styler(
      "First sentence here. Second sentence here. Third one. Fourth one. Fifth one. " +
      "Then a path /Users/gleb/ai_projects/pibot/src/core/bot.ts and https://x.com/y.",
    );
    expect(spoken).not.toContain("/Users/");
    expect(spoken).not.toContain("https://");
    expect(spoken.split(".").filter((s) => s.trim()).length).toBeLessThanOrEqual(4);
  });

  it("stamps the prompt with the speakable-style directive when on, and not when off", async () => {
    const t = makeBot();
    wire(t, "ok");
    await t.bot.promptAgent(t.transport, "42", "assistant", "plain ask");
    const plain = (t.promptSpy.mock.calls.at(-1)![0] as string);
    expect(plain).not.toMatch(/Replying for listening/);

    await t.transport.say("/minimal on");
    await t.bot.promptAgent(t.transport, "42", "assistant", "styled ask");
    const styled = (t.promptSpy.mock.calls.at(-1)![0] as string);
    expect(styled).toMatch(/Replying for listening/);
    expect(styled).toMatch(/full path only when the request explicitly asks/i);
  });
});
