import * as path from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { TelegramTransport } from "../transports/telegram.js";
import { createCommandHandler, type CommandContext } from "./commands.js";
import type { AgentManager } from "./agent-manager.js";
import type { EvolutionEngine } from "./evolution.js";
import type { EventLog } from "./events.js";
import type { HeartbeatEngine, HeartbeatHost } from "./heartbeat.js";
import { QuestionBus, type QuestionSpec } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import type { Config } from "../config.js";
import type { ChatRef, Schedule, Transport } from "./types.js";
import { errorMessage, fmtWhen, nextQuietEnd, parseDuration, readJson, truncate, writeJsonAtomic } from "./util.js";
import { NewAgentWizard } from "./wizard.js";
import { SubBotManager } from "./sub-bot-manager.js";
import { Delivery } from "./delivery.js";

export class PiBot implements HeartbeatHost {
  private transports = new Map<string, Transport>();
  private wired = new Set<string>();
  private chatAgent = new Map<string, string>(); // chatKey → agentId
  private agentChats = new Map<string, Set<string>>(); // agentId → chatKeys
  private wizardChats = new Set<string>(); // chats running /newagent interview
  private commandHandler: ((t: Transport, chatId: string, text: string) => Promise<void>) | null = null;
  private pendingSubBots = new Map<string, string>(); // chatKey → agentId awaiting its sub-bot creation
  private lastUserMessage = new Map<string, number>(); // agentId → last real user message

  /** @internal session cache access for handoff context extraction */
  private get cachedSessions(): Map<string, AgentSession> {
    return (this.deps.agents as unknown as { sessions: Map<string, AgentSession> }).sessions;
  }
  private questions = new QuestionBus({
    getTransport: (name) => this.transports.get(name),
    notify: (chatKey, text) => {
      const idx = chatKey.indexOf(":");
      const t = this.transports.get(chatKey.slice(0, idx));
      if (t) void t.push(chatKey.slice(idx + 1), { text }).catch(() => {});
    },
  });
  private statePath: string;

  private subBotManager: SubBotManager;
  private delivery: Delivery;
  private wizard: NewAgentWizard;

  constructor(
    private deps: {
      config: Config;
      agents: AgentManager;
      scheduler: Scheduler;
      heartbeat: HeartbeatEngine;
      events: EventLog;
      transports: Transport[];
      evolution?: EvolutionEngine;
      modelRuntime?: import("@earendil-works/pi-coding-agent").ModelRuntime;
      secrets: import("./secrets.js").SecretStore;
    },
  ) {
    this.statePath = path.join(deps.config.dataDir, "state.json");
    for (const t of deps.transports) this.addTransport(t);

    this.subBotManager = new SubBotManager({
      config: deps.config,
      agents: deps.agents,
      events: deps.events,
      transports: this.transports,
      pendingSubBots: this.pendingSubBots,
      secrets: deps.secrets,
      telegramUsername: () => this.telegramUsername(),
      addTransport: (t) => this.addTransport(t),
      deliverToAgent: (agentId, text) => this.deliverToAgent(agentId, text),
    });

    this.delivery = new Delivery({
      agents: deps.agents,
      scheduler: deps.scheduler,
      heartbeat: deps.heartbeat,
      events: deps.events,
      evolution: deps.evolution,
      transports: this.transports,
      agentChats: this.agentChats,
      questions: this.questions,
      promptAgent: (tr, chatId, agentId, text) => this.promptAgent(tr, chatId, agentId, text),
      deliverToAgent: (agentId, text) => this.deliverToAgent(agentId, text),
      primaryChat: (job) => this.primaryChat(job),
    });

    this.wizard = new NewAgentWizard({
      config: deps.config,
      agents: deps.agents,
      questions: this.questions,
      transports: this.transports,
      wizardChats: this.wizardChats,
      pendingSubBots: this.pendingSubBots,
      modelRuntime: deps.modelRuntime,
      chatKey: (t, chatId) => this.chatKey(t, chatId),
      rememberChat: (agentId, ck) => this.rememberChat(agentId, ck),
      ensureHeartbeatJob: (a) => this.ensureHeartbeatJob(a as never),
      ensureEvolutionJob: (a) => this.ensureEvolutionJob(a as never),
      attachSubBot: (agentId, token) => this.attachSubBot(agentId, token),
      subBotDeepLink: (agentId, username, displayName) => this.subBotDeepLink(agentId, username, displayName),
      telegramUsername: () => this.telegramUsername(),
    });
  }

  addTransport(t: Transport): void {
    this.transports.set(t.name, t);
    t.onMessage((text, chatId) => this.handleIncoming(t, chatId, text).catch((e) => console.error("[bot] message error:", e)));
    t.onAction((action, chatId) => this.handleAction(t, chatId, action).catch((e) => console.error("[bot] action error:", e)));
    if (t.onManagedBot) {
      t.onManagedBot(async (info) => this.handleManagedBot(t, info).catch((e) => console.error("[bot] managed bot error:", e)));
    }
  }

  /** Manager-mode: a user confirmed a managed sub-bot creation → fetch its token and wire it */
  private async handleManagedBot(t: Transport, info: { creatorId: string; botId: number; botUsername?: string; firstName?: string }): Promise<void> {
    return this.subBotManager.handleManagedBot(t, info);
  }

  async start(): Promise<void> {
    await this.deps.agents.discover();
    if (!this.deps.agents.list().length) {
      this.deps.agents.createAgent("assistant");
      console.log("[pibot] scaffolded default agent 'assistant'");
    }
    for (const agent of this.deps.agents.list()) {
      this.ensureHeartbeatJob(agent);
      this.ensureMorningBriefJob(agent);
      if (agent.manifest.evolution?.enabled) this.ensureEvolutionJob(agent);
    }
    // attend surfacing: one pass/day within its active hours, on the default agent
    const defaultAgent = this.deps.config.defaultAgentId ?? this.deps.agents.defaultAgentId();
    if (defaultAgent) this.ensureAttendPassJob(defaultAgent);

    const state = readJson<{ chats?: Record<string, string>; agentChats?: Record<string, string[]> }>(this.statePath, {});
    for (const [ck, agentId] of Object.entries(state.chats ?? {})) this.chatAgent.set(ck, agentId);
    for (const [agentId, cks] of Object.entries(state.agentChats ?? {})) this.agentChats.set(agentId, new Set(cks));

    for (const t of this.transports.values()) await t.start();
    console.log(`[pibot] running · agents: ${this.deps.agents.list().map((a) => a.id).join(", ")} · transport: ${[...this.transports.keys()].join("+")}`);
  }

  async stop(): Promise<void> {
    for (const t of this.transports.values()) {
      try {
        await t.stop();
      } catch {
        /* ignore */
      }
    }
  }

  // ── sub-bots (per-agent Telegram identities) ──────────────────────────────
  async attachSubBot(agentId: string, token: string): Promise<{ ok: boolean; botName?: string; error?: string }> {
    return this.subBotManager.attachSubBot(agentId, token);
  }

  async detachSubBot(agentId: string): Promise<boolean> {
    return this.subBotManager.detachSubBot(agentId);
  }

  /** Deep link that lets the chat owner create a managed sub-bot for an agent */
  subBotDeepLink(agentId: string, username: string, displayName?: string): string {
    return this.subBotManager.subBotDeepLink(agentId, username, displayName);
  }

  // ── HeartbeatHost ────────────────────────────────────────────────────────
  hasTransport(name: string): boolean {
    return this.transports.has(name);
  }

  telegramUsername(): string | undefined {
    return this.subBotManager.telegramUsername();
  }

  managerMode(): boolean {
    return this.subBotManager.managerMode();
  }

  managerUsername(): string | undefined {
    return this.subBotManager.managerUsername();
  }

  subBotFor(agentId: string): { username?: string } | undefined {
    return this.subBotManager.subBotFor(agentId);
  }

  /** Validate a token against Telegram, then enable the transport live. */
  async enableTelegram(token: string, allowedChats: string[]): Promise<{ ok: boolean; botName?: string; error?: string }> {
    if (this.transports.has("telegram")) {
      return { ok: false, error: "Telegram is already enabled — disable it first." };
    }
    const t = new TelegramTransport(token, allowedChats);
    let botName: string;
    try {
      botName = await t.verify();
    } catch (e) {
      return { ok: false, error: `Token rejected by Telegram: ${errorMessage(e)}` };
    }
    this.addTransport(t);
    try {
      await t.start();
    } catch (e) {
      this.transports.delete("telegram");
      return { ok: false, error: `Started but polling failed: ${errorMessage(e)}` };
    }
    return { ok: true, botName };
  }

  async disableTelegram(): Promise<boolean> {
    const t = this.transports.get("telegram");
    if (!t) return false;
    await t.stop().catch(() => {});
    this.transports.delete("telegram");
    return true;
  }

  // ── chat plumbing ─────────────────────────────────────────────────────────

  private chatKey(t: Transport, chatId: string): string {
    return `${t.name}:${chatId}`;
  }

  private currentAgent(ck: string): string | undefined {
    const idx = ck.lastIndexOf(":");
    const transportName = ck.slice(0, idx);
    const bound = this.transports.get(transportName)?.boundAgentId;
    return bound ?? this.chatAgent.get(ck) ?? this.deps.config.defaultAgentId ?? this.deps.agents.defaultAgentId();
  }

  private rememberChat(agentId: string, ck: string): void {
    this.chatAgent.set(ck, agentId);
    if (!this.agentChats.has(agentId)) this.agentChats.set(agentId, new Set());
    this.agentChats.get(agentId)!.add(ck);
    this.persistState();
  }

  private persistState(): void {
    const chats: Record<string, string> = {};
    for (const [k, v] of this.chatAgent) chats[k] = v;
    const agentChats: Record<string, string[]> = {};
    for (const [k, v] of this.agentChats) agentChats[k] = [...v];
    writeJsonAtomic(this.statePath, { chats, agentChats });
  }

  private async sessionFor(t: Transport, chatId: string, agentId: string, ck: string): Promise<AgentSession> {
    const session = await this.deps.agents.getOrCreateSession(
      agentId,
      ck,
      { transport: t.name, chatId },
      this.deps.scheduler,
      (spec: QuestionSpec) => this.questions.ask(agentId, { transport: t.name, chatId }, spec),
    );
    const wkey = `${agentId}::${ck}`;
    if (!this.wired.has(wkey)) {
      this.wired.add(wkey);
      session.subscribe((ev) => this.onSessionEvent(t, chatId, agentId, ev));
    }
    return session;
  }

  private onSessionEvent(t: Transport, chatId: string, agentId: string, ev: AgentSessionEvent): void {
    if (ev.type === "agent_start") {
      t.setTyping?.(chatId, true);
    } else if (ev.type === "agent_end") {
      t.setTyping?.(chatId, false);
      const text = extractAssistantText((ev as { messages?: unknown[] }).messages ?? []);
      if (text) {
        void t.push(chatId, { text }).catch((e) => console.error("[bot] push failed:", e));
        this.deps.events.log(agentId, "message", truncate(text, 200));
      } else {
        // failed turn (e.g. model auth) — tell the user instead of silence
        const err = lastAssistantError((ev as { messages?: unknown[] }).messages ?? []);
        if (err) void t.notifyError(chatId, `model error: ${err}`).catch(() => {});
      }
    }
  }

  private static QUICK_ACTIONS: Record<string, string> = {
    "😴 snooze 1h": "/snooze 1h",
    "😴 until morning": "/snooze until morning",
    "☀️ wake": "/wake",
    "📋 status": "/status",
    "snooze 1h": "/snooze 1h",
    "snooze until morning": "/snooze until morning",
    "wake": "/wake",
  };

  async handleIncoming(t: Transport, chatId: string, raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    const ck = this.chatKey(t, chatId);
    // quick-action keyboard buttons arrive as plain text
    const quick = PiBot.QUICK_ACTIONS[text.toLowerCase()];
    if (quick) return void (await this.handleCommand(t, chatId, quick));
    // slash commands always work, even with a question pending
    if (text.startsWith("/")) return void (await this.handleCommand(t, chatId, text));
    // a pending structured question eats the next plain message in this chat
    if (this.questions.answerViaText(ck, text)) return;
    const agentId = this.currentAgent(ck);
    if (!agentId) {
      await t.notifyError(chatId, "No agents yet. Create one: /newagent myfriend <persona text>");
      return;
    }
    this.lastUserMessage.set(agentId, Date.now());
    this.deps.heartbeat.noteUserMessage?.(agentId);
    await this.promptAgent(t, chatId, agentId, text);
  }

  /** Every prompt gets a subtle time envelope so the agent always knows the moment. */
  async promptAgent(t: Transport, chatId: string, agentId: string, text: string): Promise<void> {
    const ck = this.chatKey(t, chatId);
    this.rememberChat(agentId, ck);

    let session: AgentSession;
    try {
      session = await this.sessionFor(t, chatId, agentId, ck);
    } catch (e) {
      await t.notifyError(chatId, `Agent "${agentId}" failed to start: ${errorMessage(e)}`);
      return;
    }

    t.setTyping?.(chatId, true);
    try {
      // followUp: concurrent messages queue behind the running turn instead of erroring
      await session.prompt(envelope(text), { streamingBehavior: "followUp" });
    } catch (e) {
      this.deps.events.log(agentId, "system", `prompt error: ${errorMessage(e)}`);
      await t.notifyError(chatId, errorMessage(e));
      return;
    } finally {
      t.setTyping?.(chatId, false);
    }
    await this.flushCards(t, chatId, agentId);
  }

  private async flushCards(t: Transport, chatId: string, agentId: string): Promise<void> {
    const ck = this.chatKey(t, chatId);
    const jobs = this.deps.scheduler.takePendingCards(agentId, ck);
    for (const j of jobs) {
      await t.push(chatId, {
        text: `📅 Scheduled: “${j.title}” — ${fmtWhen(j.dueAt)}${j.repeat ? " ↻" : ""}${j.wake === "important" ? "  ⚡" : ""}`,
        card: {
          text: "",
          buttons: [
            { label: "✅ OK", action: `scd:${j.id}:ok` },
            { label: "⏰ +10m", action: `scd:${j.id}:+10m` },
            { label: "🕒 +1h", action: `scd:${j.id}:+1h` },
            { label: "🗑 Cancel", action: `scd:${j.id}:cancel` },
          ],
        },
      });
    }
  }

  // ── inline card actions ───────────────────────────────────────────────────

  /** Returns a short toast string for Telegram callback feedback */
  async handleAction(t: Transport, chatId: string, action: string): Promise<string | void> {
    if (action.startsWith("url:")) return; // URL buttons open in the client; no callback

    if (action.startsWith("snz:")) {
      const dur = action.slice(4);
      const agentId = this.currentAgent(this.chatKey(t, chatId));
      if (!agentId) return void (await t.push(chatId, { text: "No agent selected." }));
      if (dur === "morning") {
        const quietEnd = nextQuietEnd(this.deps.agents.getAgent(agentId)?.manifest.heartbeat?.quietHours);
        if (!quietEnd) return void (await t.push(chatId, { text: "No quiet hours configured." }));
        const st = this.deps.scheduler.snooze(agentId, quietEnd, "until morning", quietEnd);
        this.deps.events.log(agentId, "snooze", `until morning (${fmtWhen(st.until)})`);
        await t.push(chatId, { text: `😴 Until **${fmtWhen(st.until)}** — good ${new Date().getHours() < 12 ? "night" : "rest"} 🌙` });
        return;
      }
      const ms = parseDuration(dur);
      if (!ms) return void (await t.push(chatId, { text: "Unknown snooze duration." }));
      const quietEnd = nextQuietEnd(this.deps.agents.getAgent(agentId)?.manifest.heartbeat?.quietHours);
      const st = this.deps.scheduler.snooze(agentId, Date.now() + ms, "card", quietEnd ?? undefined);
      await t.push(chatId, { text: `😴 Snoozed until **${fmtWhen(st.until)}**` });
      return;
    }

    if (action.startsWith("q:")) {
      const answer = this.questions.resolveCallback(action); // stale/unknown ids → null
      this.deps.events.log("system", "system", `question tap: ${action} → ${answer ? `resolved: ${answer.choice}` : "stale (ignored)"}`);
      return answer ? `✅ ${answer.choice}` : "⏳ This question expired";
    }
    if (!action.startsWith("scd:")) return;
    const [, id, verb] = action.split(":");
    const job = this.deps.scheduler.get(id);
    if (!job) {
      await t.push(chatId, { text: "That item is already gone." });
      return;
    }
    let toast = "";
    switch (verb) {
      case "ok":
        toast = "✅ Locked in";
        await t.push(chatId, { text: "✅ Locked in." });
        break;
      case "cancel": {
        const c = this.deps.scheduler.cancel(id);
        toast = c ? `🗑 Cancelled: ${c.title}` : "Already done";
        await t.push(chatId, { text: toast + "." });
        break;
      }
      case "+10m":
      case "+1h":
      case "+1d": {
        const delta = verb === "+10m" ? 600e3 : verb === "+1h" ? 3600e3 : 86400e3;
        const r = this.deps.scheduler.reschedule(id, Date.now() + delta);
        toast = r ? `⏰ “${r.title}” → ${fmtWhen(r.dueAt)}` : "Already done";
        await t.push(chatId, { text: toast });
        break;
      }
      default:
        toast = "Unknown action";
        await t.push(chatId, { text: "Unknown action." });
    }
    this.deps.events.log(job.agentId, "system", `card ${verb} → ${job.title}`);
    return toast;
  }

  // ── commands ──────────────────────────────────────────────────────────────

  handleCommand(t: Transport, chatId: string, text: string): Promise<void> {
    this.commandHandler ??= createCommandHandler(this.commandContext());
    return this.commandHandler(t, chatId, text);
  }

  /** @internal narrow surface for the command layer */
  private commandContext(): CommandContext {
    return {
      config: this.deps.config,
      agents: this.deps.agents,
      scheduler: this.deps.scheduler,
      events: this.deps.events,
      transports: this.transports,
      agentChats: this.agentChats,
      pendingSubBots: this.pendingSubBots,
      wizardChats: this.wizardChats,
      evolution: this.deps.evolution,
      heartbeat: this.deps.heartbeat,
      telegram: this,
      currentAgent: (ck) => this.currentAgent(ck),
      chatKey: (t, chatId) => this.chatKey(t, chatId),
      rememberChat: (agentId, c) => this.rememberChat(agentId, c),
      ensureHeartbeatJob: (a) => this.ensureHeartbeatJob(a as never),
      ensureEvolutionJob: (a) => this.ensureEvolutionJob(a as never),
      ensureMorningBriefJob: (a) => this.ensureMorningBriefJob(a as never),
      deliverToAgent: (id, text) => this.deliverToAgent(id, text),
      questions: this.questions,
      wizard: this,
    };
  }

  // ── scheduler fire delivery ───────────────────────────────────────────────

  async runNewAgentWizard(t: Transport, chatId: string): Promise<void> {
    return this.wizard.runNewAgentWizard(t, chatId);
  }

  private pendingSubBotFor(_ck: string): string | undefined {
    return this.pendingSubBots.get(_ck);
  }

  /** Manager-mode: register a pending sub-bot creation + push the deep link into the agent's chats */
  async requestSubBotCreation(agentId: string): Promise<void> {
    return this.subBotManager.requestSubBotCreation(agentId, this.agentChats, this.transports, (id, text) => this.deliverToAgent(id, text));
  }

  private ensureAttendPassJob(agentId: string): void {
    return this.delivery.ensureAttendPassJob(agentId);
  }

  private ensureMorningBriefJob(agent: Parameters<Delivery["ensureMorningBriefJob"]>[0]): void {
    return this.delivery.ensureMorningBriefJob(agent);
  }

  private ensureEvolutionJob(agent: Parameters<Delivery["ensureEvolutionJob"]>[0]): void {
    return this.delivery.ensureEvolutionJob(agent);
  }

  private ensureHeartbeatJob(agent: Parameters<Delivery["ensureHeartbeatJob"]>[0]): void {
    return this.delivery.ensureHeartbeatJob(agent);
  }

  async deliverFire(job: Schedule, snoozed: boolean): Promise<void> {
    return this.delivery.deliverFire(job, snoozed);
  }

  /** Structured question with tappable options; resolves on tap/vote/typed answer */
  askUser(agentId: string, chat: ChatRef, spec: QuestionSpec) {
    return this.questions.ask(agentId, chat, spec);
  }

  /** Fire a structured question to all chats registered for an agent (dashboard surface) */
  async askUserAllChats(agentId: string, question: string, options: string[]): Promise<void> {
    const cks = this.agentChats.get(agentId) ?? new Set<string>();
    if (!cks.size) throw new Error(`no chats registered for "${agentId}" — message it in Telegram first`);
    await Promise.allSettled(
      [...cks].map((ck) => {
        const idx = ck.lastIndexOf(":");
        return this.questions.ask(agentId, { transport: ck.slice(0, idx), chatId: ck.slice(idx + 1) }, { text: question, options, poll: options.length > 6 });
      }),
    );
  }

  /** Compact transcript tail for handoffs: last N user/assistant turns */
  private transcriptTail(session: AgentSession, turns = 12): string {
    const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    const turnsOut: string[] = [];
    for (const m of msgs) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = (m.content ?? []).filter((b) => b?.type === "text" && b.text).map((b) => b.text).join(" ").trim();
      if (!text) continue;
      turnsOut.push(`${m.role === "user" ? "user" : "agent"}: ${truncate(text.replace(/\n+/g, " "), 220)}`);
    }
    return turnsOut.slice(-turns).join("\n") || "(no prior conversation)";
  }

  /** Handoff: move a conversation (with its context) from one agent to another, in the same chat */
  private async runHandoff(t: Transport, chatId: string, fromAgent: string, toAgent: string, note?: string): Promise<void> {
    const ck = this.chatKey(t, chatId);
    if (!this.deps.agents.getAgent(toAgent)) {
      await t.push(chatId, { text: `No agent "${toAgent}". /agents for the list.` });
      return;
    }
    // context from the CURRENT session
    const fromSession = await this.sessionFor(t, chatId, fromAgent, ck);
    const tail = this.transcriptTail(fromSession, 12);
    // deliver into the TARGET's session for this chat — its history now carries the context
    const targetSession = await this.sessionFor(t, chatId, toAgent, ck);
    await targetSession.prompt(envelope(`[handoff from "${fromAgent}"] The user is moving this conversation to you. Continue where this left off — acknowledge in one short line, then pick up the thread.\n\n# Recent context\n${tail}${note ? `\n\n# Note from ${fromAgent}\n${note}` : ""}`));
    this.rememberChat(toAgent, ck);
    this.deps.events.log(toAgent, "system", `handoff from ${fromAgent} (${truncate(tail, 80)})`);
  }

  // ── agent-to-agent messaging ─────────────────────────────────────────────

  /** Run one turn in an agent's inter-agent session and return the reply text */
  private async agentTurn(agentId: string, fromAgent: string, text: string, timeoutMs?: number): Promise<string> {
    const target = this.deps.agents.getAgent(agentId);
    if (!target) throw new Error(`unknown agent "${agentId}"`);
    const ck = `agent::${agentId}::from-${fromAgent}`;
    const session = await this.deps.agents.getOrCreateSession(agentId, ck, { transport: "agent", chatId: fromAgent }, this.deps.scheduler);
    if ((session as { isStreaming?: boolean }).isStreaming) throw new Error("target agent is busy");
    const run = session.prompt(envelope(`[agent-message from "${fromAgent}"]\n\n${text}`));
    const reply = timeoutMs
      ? await Promise.race([
          run.then(() => extractAssistantTextFromSession(session)),
          new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
        ])
      : await run.then(() => extractAssistantTextFromSession(session));
    return reply || "(no reply)";
  }

  /** Agent-initiated handoff: package the sender's transcript tail + deliver to the target's pair session */
  async handoffContext(fromAgent: string, toAgent: string, note?: string): Promise<string> {
    const fromCk = [...(this.agentChats.get(fromAgent) ?? [])][0];
    let tail = "(no recent context)";
    if (fromCk) {
      const fromSession = this.cachedSessions.get(`${fromAgent}::${fromCk}`);
      if (fromSession) tail = this.transcriptTail(fromSession, 12);
    }
    return this.agentTurn(toAgent, fromAgent, `[handoff from "${fromAgent}"] The user is moving this thread to you.${note ? ` Note: ${note}` : ""}\n\n# Context from ${fromAgent}\n${tail}\n\nAcknowledge briefly and continue.`, 10 * 60e3);
  }

  /** Blocking inter-agent question — used by the agent_ask tool */
  async agentAsk(fromAgent: string, toAgent: string, question: string, timeoutMs?: number): Promise<string> {
    if (!this.deps.agents.getAgent(toAgent)) throw new Error(`unknown agent "${toAgent}"`);
    // loop protection: identical asks within 5 minutes are rejected (OpenClaw-style bot loop guard)
    const now = Date.now();
    for (const [k, ts] of this.recentAsks) {
      if (now - ts > 5 * 60e3) this.recentAsks.delete(k);
    }
    const dedupeKey = `${fromAgent}->${toAgent}:${truncate(question, 120)}`;
    const hit = this.recentAsks.get(dedupeKey);
    if (hit && now - hit < 5 * 60e3) throw new Error(`loop guard: the same question was sent to ${toAgent} recently`);
    this.recentAsks.set(dedupeKey, now);
    return this.agentTurn(toAgent, fromAgent, question, timeoutMs);
  }

  private recentAsks = new Map<string, number>(); // "from->to:text" → ts

  // ── HeartbeatHost ─────────────────────────────────────────────────────

  lastUserMessageAt(agentId: string): number {
    return this.lastUserMessage.get(agentId) ?? 0;
  }

  async deliverToAgent(agentId: string, text: string) {
    const cks = this.agentChats.get(agentId) ?? new Set<string>();
    for (const ck of cks) {
      const idx = ck.indexOf(":");
      const t = this.transports.get(ck.slice(0, idx));
      if (t) await t.push(ck.slice(idx + 1), { text }).catch((e) => console.error("[bot] deliver failed:", e));
    }
  }

  async escalateToAgent(agentId: string, instruction: string): Promise<void> {
    const ck = this.primaryChat({ agentId } as Schedule);
    if (!ck) return;
    const idx = ck.lastIndexOf(":");
    const t = this.transports.get(ck.slice(0, idx));
    if (!t) return;
    if (!t) return;
    await this.promptAgent(t, ck.slice(idx + 1), agentId, `[heartbeat] ${instruction}`);
  }

  private primaryChat(job: Pick<Schedule, "agentId" | "chat">): string | null {
    if (job.chat && job.chat.transport !== "internal") return `${job.chat.transport}:${job.chat.chatId}`;
    const cks = this.agentChats.get(job.agentId);
    return cks && cks.size ? [...cks][0] : null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Time envelope so the agent always knows the moment */
function envelope(text: string): string {
  const now = new Date().toLocaleString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `[${now}]\n\n${text}`;
}

function extractAssistantTextFromSession(session: AgentSession): string | null {
  return extractAssistantText((session.agent.state.messages ?? []) as unknown[]);
}

function lastAssistantError(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; errorMessage?: string };
    if (m?.role === "assistant" && m.errorMessage) return m.errorMessage;
  }
  return null;
}

function extractAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> };
    if (m?.role !== "assistant") continue;
    const text = (m.content ?? [])
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}
