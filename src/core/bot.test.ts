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
  messageCb: ((text: string, chatId: string, reply?: ReplyContext) => Promise<void>) | null = null;
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
  onMessage(cb: (text: string, chatId: string, reply?: ReplyContext) => Promise<void>): void {
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
  lastText(): string {
    return this.pushed.at(-1)?.opts.text ?? "";
  }
  lastCard(): { label: string; action: string }[] | undefined {
    return this.pushed.at(-1)?.opts.card?.buttons;
  }
  async say(text: string): Promise<void> {
    await this.messageCb?.(text, this.chatId);
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
      id === "assistant" || id === "fitness"
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
    // creator historically spoke in the main chat…
    await t.transport.say("/agent creator");
    await t.transport.say("/agent assistant"); // …main chat is pibot-dev's again
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
    expect(t.transport.lastText()).toBe("good morning ✨");
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
