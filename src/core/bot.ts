import * as fs from "node:fs";
import * as path from "node:path";
import { buildManifest, buildPersona, validateAgentName, type AgentDraft, type Proactivity } from "./agent-factory.js";
import { listSkillDirs } from "./agent-manager.js";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { TelegramTransport } from "../transports/telegram.js";
import { attendCli } from "../plugins/attend-plugin.js";
import { createCommandHandler, type CommandContext } from "./commands.js";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import type { EvolutionEngine } from "./evolution.js";
import type { EventLog } from "./events.js";
import type { HeartbeatEngine, HeartbeatHost } from "./heartbeat.js";
import { QuestionBus, type QuestionSpec } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import type { Config } from "../config.js";
import type { Card, ChatRef, Schedule, Transport } from "./types.js";
import * as os from "node:os";
import { PROACTIVITY_INTERVAL, PROACTIVITY_OPTIONS, VIBE_OPTIONS, suggestedSubBotUsername } from "./agent-factory.js";
import { scorePersonaAmbiguity, AMBIGUITY_THRESHOLD } from "./ambiguity.js";
import { errorMessage, fmtWhen, nextDailyAt, nextQuietEnd, parseDuration, readJson, truncate, uid, writeJsonAtomic } from "./util.js";
import { classifyModelError, ModelCascade } from "./cascade.js";

export class PiBot implements HeartbeatHost {
  private transports = new Map<string, Transport>();
  private wired = new Set<string>();
  private chatAgent = new Map<string, string>(); // chatKey → agentId
  private agentChats = new Map<string, Set<string>>(); // agentId → chatKeys
  private wizardChats = new Set<string>(); // chats running /newagent interview
  private commandHandler: ((t: Transport, chatId: string, text: string) => Promise<void>) | null = null;
  private pendingSubBots = new Map<string, string>(); // chatKey → agentId awaiting its sub-bot creation
  private lastUserMessage = new Map<string, number>(); // agentId → last real user message
  private subBots = new Map<string, { token: string; username?: string }>(); // agentId → token
  /** model spec currently bound to each persistent session ("" = not yet bound) */
  private sessionSpec = new Map<string, string>();
  private probing = false; // one recovery probe at a time

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
      /** model cascade / triage: primary → fallbacks → deterministic */
      cascade?: ModelCascade;
    }
  ) {
    this.statePath = path.join(deps.config.dataDir, "state.json");
    for (const t of deps.transports) this.addTransport(t);
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
    const botName = info.botUsername ?? info.firstName ?? `bot_${info.botId}`;
    console.log(`[telegram] managed bot update: ${botName} (id ${info.botId}) by ${info.creatorId}`);

    // token rotation for an already-wired sub-bot: re-attach with the fresh token
    for (const [agentId, sub] of Object.entries(this.deps.secrets.get().telegram?.subBots ?? {})) {
      if (sub.username && info.botUsername && sub.username.toLowerCase() === info.botUsername.toLowerCase()) {
        const token = await (t as import("../transports/telegram.js").TelegramTransport).getManagedBotToken(info.botId);
        const r = await this.attachSubBot(agentId, token);
        this.deps.events.log(agentId, "system", `sub-bot token rotated → ${r.ok ? "re-attached" : r.error}`);
        return;
      }
    }

    const agentId =
      this.pendingSubBots.get(botName) ??
      this.pendingSubBots.get(botName.replace(/_?bot$/, "")) ??
      [...this.pendingSubBots.keys()].find((id) => botName.toLowerCase().includes(id.replace(/-/g, "").toLowerCase()));
    if (!agentId) {
      console.log(`[telegram] managed bot ${botName} — no pending request, ignoring`);
      return;
    }
    try {
      const tg = t as import("../transports/telegram.js").TelegramTransport;
      const token = await tg.getManagedBotToken(info.botId);
      const r = await this.attachSubBot(agentId, token);
      this.pendingSubBots.delete(agentId);
      // managed sub-bots are private: only the manager's owner can use them
      await tg.setManagedBotAccessSettings(info.botId, true).catch((e) => console.error("[telegram] access restriction failed:", errorMessage(e)));
      if (r.ok) {
        this.deps.events.log(agentId, "system", `sub-bot created: ${r.botName} (restricted to owner)`);
        await this.deliverToAgent(agentId, `🟢 My own Telegram bot is live: **${r.botName}** — its own chat, its own identity, restricted to you.`);
      } else {
        this.deps.events.log(agentId, "system", `sub-bot wiring failed: ${r.error}`);
      }
    } catch (e) {
      this.deps.events.log("system", "system", `managed bot token fetch failed: ${errorMessage(e)}`);
    }
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
    this.ensureCascadeProbeJob();
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

  private async persistSubBot(agentId: string, token: string, username?: string): Promise<void> {
    const cur = this.deps.secrets.get();
    const subBots = { ...(cur.telegram?.subBots ?? {}), [agentId]: { token, username } };
    await this.deps.secrets.save({ telegram: { ...cur.telegram, subBots } });
  }

  private async removeSubBotFromSettings(agentId: string): Promise<void> {
    const cur = this.deps.secrets.get();
    const subBots = { ...(cur.telegram?.subBots ?? {}) };
    delete (subBots as Record<string, unknown>)[agentId];
    await this.deps.secrets.save({ telegram: { ...cur.telegram, subBots } });
  }

  /** Wire a dedicated bot for one agent (token verified against Telegram first) */
  async attachSubBot(agentId: string, token: string): Promise<{ ok: boolean; botName?: string; error?: string }> {
    const existingName = `telegram:${agentId}`;
    if (this.transports.has(existingName)) {
      await this.transports.get(existingName)?.stop().catch(() => {});
      this.transports.delete(existingName);
    }
    const t = new TelegramTransport(token, [], { nameSuffix: agentId, boundAgentId: agentId, openWhenEmpty: this.deps.config.telegramOpen });
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
      this.transports.delete(existingName);
      return { ok: false, error: `Started but polling failed: ${errorMessage(e)}` };
    }
    await this.persistSubBot(agentId, token, botName.startsWith("@") ? botName.slice(1) : botName);
    this.deps.events.log("system", "system", `sub-bot attached for ${agentId} as ${botName}`);
    return { ok: true, botName };
  }

  async detachSubBot(agentId: string): Promise<boolean> {
    const t = this.transports.get(`telegram:${agentId}`);
    if (!t) return false;
    await t.stop().catch(() => {});
    this.transports.delete(`telegram:${agentId}`);
    const cur = this.deps.secrets.get();
    const subBots = { ...(cur.telegram?.subBots ?? {}) };
    delete (subBots as Record<string, unknown>)[agentId];
    await this.deps.secrets.save({ telegram: { ...cur.telegram, subBots } });
    this.deps.events.log("system", "system", `sub-bot detached for ${agentId}`);
    return true;
  }

  /** Deep link that lets the chat owner create a managed sub-bot for an agent */
  subBotDeepLink(agentId: string, username: string, displayName?: string): string {
    const name = encodeURIComponent(displayName ?? agentId);
    return `https://t.me/newbot/${this.telegramUsername() ?? "pimother_bot"}/${username}?name=${name}`;
  }

  // ── HeartbeatHost ────────────────────────────────────────────────────────
  hasTransport(name: string): boolean {
    return this.transports.has(name);
  }

  telegramUsername(): string | undefined {
    const t = this.transports.get("telegram");
    return t instanceof TelegramTransport ? t.botUsername() : undefined;
  }

  managerMode(): boolean {
    const t = this.transports.get("telegram");
    return t instanceof TelegramTransport ? t.managerMode() : false;
  }

  managerUsername(): string | undefined {
    return this.telegramUsername();
  }

  subBotFor(agentId: string): { username?: string } | undefined {
    const t = this.transports.get(`telegram:${agentId}`);
    return t instanceof TelegramTransport && t.botUsername() ? { username: t.botUsername() } : undefined;
  }

  /** Validate a token against Telegram, then enable the transport live. */
  async enableTelegram(token: string, allowedChats: string[]): Promise<{ ok: boolean; botName?: string; error?: string }> {
    if (this.transports.has("telegram")) {
      return { ok: false, error: "Telegram is already enabled — disable it first." };
    }
    const t = new TelegramTransport(token, allowedChats, { openWhenEmpty: this.deps.config.telegramOpen });
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

  private splitChatKey(ck: string): { transport: string; chatId: string } {
    const idx = ck.lastIndexOf(":");
    return { transport: ck.slice(0, idx), chatId: ck.slice(idx + 1) };
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
      (spec: QuestionSpec) => this.questions.ask(agentId, { transport: t.name, chatId }, spec)
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
        // failed turn — logged here; user-facing triage lives in the cascade layer
        const err = lastAssistantError((ev as { messages?: unknown[] }).messages ?? []);
        if (err) this.deps.events.log(agentId, "system", `failed turn: ${truncate(err, 200)}`);
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
      await this.turnWithCascade(t, chatId, agentId, session, ck, text);
    } finally {
      t.setTyping?.(chatId, false);
    }
    await this.flushCards(t, chatId, agentId);
  }

  /**
   * One full turn with model cascade triage: try the session's model; on a
   * switchable model error classify it (auth/credits → long cooldown, 429 →
   * short, transient → brief), open a breaker on that model and retry the turn
   * on the next model in the chain within the SAME session (history kept).
   * When every model is down the message is queued (dead letter) and the user
   * gets an honest notice; a periodic probe replays queued messages on recovery.
   */
  private async turnWithCascade(
    t: Transport,
    chatId: string,
    agentId: string,
    session: AgentSession,
    ck: string,
    text: string
  ): Promise<void> {
    const cascade = this.deps.cascade;
    const attempts: string[] = [];
    if (!cascade) {
      await session.prompt(envelope(text), { streamingBehavior: "followUp" });
      return;
    }

    const agent = this.deps.agents.getAgent(agentId);
    const chain = cascade.chainFor(agent?.manifest ?? {});
    const wkey = `${agentId}::${ck}`;
    let spec = this.sessionSpec.get(wkey) ?? ""; // "" = not yet bound

    // first turn on this session: bind the first healthy model (skips open breakers)
    if (!spec) {
      const wanted = agent?.manifest.model ?? "";
      const healthy = cascade.firstHealthy(chain) ?? wanted;
      let bound = wanted;
      if (healthy && healthy !== wanted) {
        const m = cascade.resolveModel(healthy);
        if (m) {
          try {
            await session.setModel(m);
            bound = healthy;
          } catch {
            /* can't bind — fall through, the prompt will triage */
          }
        }
      }
      spec = bound;
      this.sessionSpec.set(wkey, spec);
    } else if (cascade.isOpen(spec)) {
      // previously-bound model has an open breaker (e.g. a failure elsewhere opened it) → pre-switch
      const next = cascade.nextCandidate(chain, spec);
      if (next) {
        const m = cascade.resolveModel(next);
        if (m) {
          try {
            await session.setModel(m);
            spec = next;
            this.sessionSpec.set(wkey, next);
          } catch {
            /* prompt will fail and triage */
          }
        }
      }
    }

    let landed = false; // has the user's text entered the session history?
    let lastError = "";
    for (let step = 0; step < MAX_TURN_MODELS; step++) {
      let thrown: string | null = null;
      const body = !landed
        ? text
        : `[cascade] The previous attempt failed with a model error${spec ? ` on ${spec}` : ""}. A different model is now active — respond to the user's last message now.`;
      try {
        await session.prompt(envelope(body), { streamingBehavior: "followUp" });
      } catch (e) {
        thrown = errorMessage(e);
      }
      const err = thrown ?? lastAssistantError(((session as { agent?: { state?: { messages?: unknown[] } } }).agent?.state?.messages) ?? []);
      if (!err) {
        if (spec) cascade.noteSuccess(spec);
        return;
      }
      landed = thrown === null; // prompt resolved → the user msg is in history; retries use the note
      lastError = err;
      attempts.push(spec || "(auto)");
      if (spec) cascade.noteFailure(spec, err);
      this.deps.events.log(agentId, "system", `model error on ${spec || "(auto)"} [${classifyModelError(err)}]: ${truncate(err, 160)}`);

      const next = cascade.nextCandidate(chain, spec || undefined);
      if (!next) break; // whole chain exhausted → deterministic fallback
      const model = cascade.resolveModel(next);
      if (!model) break;
      try {
        await session.setModel(model);
        spec = next;
        this.sessionSpec.set(wkey, next);
      } catch (e) {
        cascade.noteFailure(next, `cannot bind model: ${errorMessage(e)}`);
        continue;
      }
    }

    // deterministic fallback: queue the message, tell the user honestly
    const dl = cascade.queueDead({ agentId, transport: t.name, chatId, text, createdAt: Date.now(), attempts, lastError });
    this.deps.events.log(agentId, "system", `cascade exhausted (${attempts.join(" → ")}) — queued ${dl.id} (${cascade.deadLetterCount()} pending)`);
    const internal = INTERNAL_PROMPT_PREFIXES.some((p) => text.startsWith(p));
    if (!internal) {
      await t.notifyError(
        chatId,
        `🪫 **${agentId}** couldn't reach any model just now (${attempts.join(" → ")}).\nYour message is saved — I'll process it automatically once a provider recovers. /cascade for details.`
      );
    }
  }

  /** Periodic probe (scheduler job): when a model recovers, flush the dead-letter queue. */
  private async runCascadeRecovery(): Promise<void> {
    if (this.probing) return;
    const cascade = this.deps.cascade;
    if (!cascade || !cascade.needsRecoveryProbe()) return;
    this.probing = true;
    try {
      // probe each dead-letter agent's first healthy candidate (capped)
      const specs = new Set<string>();
      const dls = cascade.deadLetters();
      if (dls.length) {
        for (const dl of dls.slice(-3)) {
          const chain = cascade.chainFor(this.deps.agents.getAgent(dl.agentId)?.manifest ?? {});
          const head = cascade.firstHealthy(chain) ?? chain[0];
          if (head) specs.add(head);
        }
      } else {
        const chain = cascade.chainFor(this.deps.agents.list()[0]?.manifest ?? {});
        const head = chain.find((s) => cascade.isOpen(s)) ?? cascade.firstHealthy(chain);
        if (head) specs.add(head);
      }
      const results = await cascade.probeAlive([...specs]);
      if (results.some((r) => r.ok)) await this.flushDeadLetters();
    } finally {
      this.probing = false;
    }
  }

  /** Replay queued messages into their agent sessions (oldest first). */
  async flushDeadLetters(): Promise<number> {
    const cascade = this.deps.cascade;
    if (!cascade) return 0;
    let flushed = 0;
    for (let i = 0; i < 25; i++) {
      const dl = cascade.takeOneDead();
      if (!dl) break;
      const t = this.transports.get(dl.transport);
      if (!t) continue; // transport gone (sub-bot detached) — drop
      try {
        await this.promptAgent(t, dl.chatId, dl.agentId, `[cascade-recover] (queued while all models were down, ${new Date(dl.createdAt).toLocaleTimeString()}):\n${dl.text}`);
        flushed++;
      } catch (e) {
        cascade.unshiftDead(dl); // delivery failed — stop, retry on next probe
        console.error("[cascade] flush failed:", errorMessage(e));
        break;
      }
    }
    if (flushed) this.deps.events.log("system", "system", `cascade recovered — flushed ${flushed} queued message(s)`);
    return flushed;
  }

  /** One recovery probe now, with results as text (used by /cascade probe & retry) */
  async cascadeProbe(): Promise<string> {
    const cascade = this.deps.cascade;
    if (!cascade) return "Cascade is not wired in this build.";
    const agentLike = this.deps.agents.getAgent(this.deps.config.defaultAgentId ?? this.deps.agents.defaultAgentId() ?? "") ?? this.deps.agents.list()[0];
    const chain = cascade.chainFor(agentLike?.manifest ?? {});
    const specs = [cascade.firstHealthy(chain) ?? chain[0]].filter(Boolean) as string[];
    for (const s of chain) if (cascade.isOpen(s) && !specs.includes(s) && specs.length < 3) specs.push(s);
    const results = await cascade.probeAlive(specs);
    const lines = results.map((r) => `${r.ok ? "✓" : "✕"} ${r.spec}${r.ok ? " — alive" : ` — ${truncate(r.error ?? "unreachable", 100)}`}`);
    if (results.some((r) => r.ok)) {
      const n = await this.flushDeadLetters();
      if (n) lines.push(`flushed ${n} queued message(s).`);
    }
    return lines.join("\n");
  }

  /** Human-readable cascade health for an agent's chain (+ queue size) */
  cascadeStatusText(agentId?: string): string {
    const cascade = this.deps.cascade;
    if (!cascade) return "Cascade is not wired in this build.";
    const agent = this.deps.agents.getAgent(agentId ?? "") ?? this.deps.agents.list()[0];
    const chain = cascade.chainFor(agent?.manifest ?? {});
    const lines = [`model cascade for **${agent?.manifest.name ?? "(no agents)"}**:`];
    lines.push(...(chain.length ? cascade.statusLines(chain) : ["(no configured models)"]));
    const queued = cascade.deadLetterCount();
    lines.push(`queued messages: ${queued || "none"}`);
    lines.push("_primary → manifest cascade → PIBOT_MODEL_CASCADE → every authenticated model; breakers auto-expire._");
    return lines.join("\n");
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
      cascade: {
        status: (agentId) => this.cascadeStatusText(agentId),
        probe: () => this.cascadeProbe(),
        retry: async () => {
          const cascade = this.deps.cascade;
          if (!cascade) return "Cascade is not wired in this build.";
          if (!cascade.deadLetterCount()) return "Nothing queued.";
          const probe = await this.cascadeProbe();
          return `probe:\n${probe}`;
        },
        clear: () => {
          const n = this.deps.cascade?.clearBreakers() ?? 0;
          return n ? `Reopened ${n} model(s) — they'll be tried again immediately.` : "No models are marked down.";
        },
      },
    };
  }

  // ── scheduler fire delivery ───────────────────────────────────────────────

  /**
   * Guided /newagent interview: name → job → vibe → proactivity.
   * Uses ask_user buttons; each new question replaces the last; /cancel aborts.
   */
  async runNewAgentWizard(t: Transport, chatId: string): Promise<void> {
    const ck = this.chatKey(t, chatId);
    const chat: ChatRef = { transport: t.name, chatId };
    this.wizardChats.add(ck);
    let aborted = false;

    const ask = async (text: string, options?: string[]): Promise<string | null> => {
      if (aborted) return null;
      const res = await this.questions.ask("system", chat, { text, options: options ?? [], timeoutMs: 600e3 });
      if (!res || res.timedOut || res.replaced) return null;
      return res.choice;
    };

    try {
      await t.push(chatId, { text: "🧙 New agent wizard — answer the questions (taps or typing). /cancel anytime." });

      // 1. name
      let name = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await ask(attempt === 0 ? "What should I call this agent? (lowercase, dashes — e.g. 'coach')" : "That name didn't work. Try another (lowercase, dashes, 2–32 chars):");
        if (raw == null) { aborted = true; break; }
        const err = validateAgentName(raw.trim().toLowerCase(), this.deps.agents.list().map((a) => a.id));
        if (err) { await t.push(chatId, { text: `⚠︎ ${err}` }); continue; }
        name = raw.trim().toLowerCase();
        break;
      }
      if (aborted || !name) { await t.push(chatId, { text: "Wizard aborted — nothing created. /newagent to restart." }); return; }

      // 2. job
      const job = await ask(`What is ${name}'s main job? One or two sentences.`);
      if (job == null) { aborted = true; }
      if (aborted) { await t.push(chatId, { text: "Wizard aborted — nothing created. /newagent to restart." }); return; }

      // 3. vibe
      const vibeRes = await ask(`What vibe should ${name} have?`, VIBE_OPTIONS);
      if (vibeRes == null) { aborted = true; }
      if (aborted || vibeRes == null) { await t.push(chatId, { text: "Wizard aborted — nothing created. /newagent to restart." }); return; }
      const vibe = vibeRes;

      // 4. proactivity
      const proRes = await ask(`How proactive should ${name} be?`, PROACTIVITY_OPTIONS);
      if (proRes == null) { aborted = true; }
      if (aborted || proRes == null) { await t.push(chatId, { text: "Wizard aborted — nothing created. /newagent to restart." }); return; }
      const proactivity: Proactivity = proRes.startsWith("quiet") ? "quiet" : proRes.startsWith("chatty") ? "chatty" : proRes.startsWith("off") ? "off" : "balanced";

      // (sub-bot offer happens after creation below)

      // 5. ambiguity gate (Ouroboros-style): score the draft, ask follow-ups if vague
      let extraAnswers: string[] = [];
      const draft0: AgentDraft = { name, job: job ?? "", vibe, proactivity };
      try {
        const gate = await scorePersonaAmbiguity(buildPersona(draft0), {
          modelRuntime: this.deps.modelRuntime as never,
          model: this.deps.agents.resolveModel(process.env.PIBOT_DEFAULT_MODEL),
          cwd: process.cwd(),
        });
        if (gate.score > AMBIGUITY_THRESHOLD) {
          await t.push(chatId, { text: `🧙 A couple of clarifying questions to make ${name} sharper:` });
          for (const q of gate.questions.slice(0, 2)) {
            const answer = await this.questions.ask("system", chat, { text: q, options: [], timeoutMs: 600e3 });
            if (!answer || answer.replaced) break;
            extraAnswers.push(`Q: ${q}\nA: ${answer.choice}`);
          }
        }
      } catch {
        /* gate failure = proceed with what we have */
      }

      // build
      const draft: AgentDraft = { name, job: [job ?? "", ...extraAnswers].filter(Boolean).join("\n"), vibe, proactivity };
      const err = this.deps.agents.createAgent(name, buildPersona(draft));
      if (err) { await t.push(chatId, { text: `Couldn't create: ${err}` }); return; }
      const agent = this.deps.agents.getAgent(name)!;
      // write the wizard-built manifest (heartbeat rhythm per proactivity)
      writeJsonAtomic(path.join(agent.dir, "agent.json"), buildManifest(draft));
      await this.deps.agents.discover();
      const fresh = this.deps.agents.getAgent(name)!;
      this.ensureHeartbeatJob(fresh);
      this.ensureEvolutionJob(fresh);
      this.rememberChat(name, ck);

      const proLabel = draft.proactivity === "off" ? "react-only (no heartbeat)" : `heartbeat every ${PROACTIVITY_INTERVAL[draft.proactivity]}`;
      await t.push(chatId, {
        text: [
          `Born: **${name}** 🎉`,
          `— ${draft.job}`,
          `— vibe: ${vibe}`,
          `— ${proLabel}${draft.proactivity !== "off" ? `, quiet 23:00–08:00` : ""}`,
          ``,
          `You're talking to it now. Its files: agents/${name}/ (persona, memory, skills — all editable on the dashboard).`,
        ].join("\n"),
      });
      void t.push(chatId, { text: `Say hi to **${name}** — try: "what can you do for me?"` });

      // 5. own Telegram identity (optional)
      const wantBot = await ask(`Give ${name} its own Telegram bot? (separate chat, its own @identity)`, [
        "yes — create it now",
        "skip for now",
      ]);
      if (wantBot?.startsWith("yes") && fresh) {
        await this.setupSubBot(t, chatId, fresh);
      }
    } finally {
      this.wizardChats.delete(ck);
    }
  }

  /**
   * Sub-bot setup for one agent. Manager mode ON → deep link + automatic token
   * fetch. Otherwise: @BotFather instructions + pasted token.
   */
  private async setupSubBot(t: Transport, chatId: string, agent: LoadedAgent): Promise<void> {
    const ck = this.chatKey(t, chatId);
    const tg = this.transports.get("telegram") as import("../transports/telegram.js").TelegramTransport | undefined;
    const suggestedUsername = suggestedSubBotUsername(agent.id, this.telegramUsername());

    if (tg?.managerMode()) {
      const link = this.subBotDeepLink(agent.id, suggestedUsername);
      await t.push(chatId, {
        text: `Give **${agent.id}** its own Telegram identity? Tap — Telegram will create the bot and I'll wire it automatically.`,
        card: { text: "", buttons: [{ label: `Create @${suggestedUsername} bot`, action: `url:${this.subBotDeepLink(agent.id, suggestedUsername, agent.id)}`, url: this.subBotDeepLink(agent.id, suggestedUsername, agent.id) }] },
      });
      this.pendingSubBots.set(agent.id, agent.id);
      return;
    }

    // fallback: manual BotFather + token paste
    await t.push(chatId, {
      text: [
        `Want **${agent.id}** to have its own Telegram identity?`,
        ``,
        `1. Open @BotFather → /newbot`,
        `2. Name: ${agent.id} · Username: must end in "bot" (e.g. ${suggestedUsername})`,
        `3. Paste the token here as your answer.`,
      ].join("\n"),
    });
    const token = await this.questions.ask("system", { transport: t.name, chatId }, { text: "Paste the BotFather token here (or type /cancel to skip):", options: [], timeoutMs: 600e3 });
    if (!token || token.replaced) return;
    const r = await this.attachSubBot(agent.id, token.choice.trim());
    await t.push(chatId, { text: r.ok ? `🟢 ${agent.id} is live as **${r.botName}** — its own bot, its own chat.` : `⚠︎ ${r.error}` });
  }

  private pendingSubBotFor(ck: string): string | undefined {
    return this.pendingSubBots.get(ck);
  }

  /** Manager-mode: register a pending sub-bot creation + push the deep link into the agent's chats */
  async requestSubBotCreation(agentId: string): Promise<void> {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent "${agentId}"`);
    if (!this.managerMode()) throw new Error("manager mode is off — enable bot management mode for @pimother_bot in BotFather's mini app");
    const suggestedUsername = suggestedSubBotUsername(agentId, this.telegramUsername());
    this.pendingSubBots.set(agentId, agentId);
    const link = this.subBotDeepLink(agentId, suggestedUsername, agentId);
    await this.deliverToAgent(agentId, [
      `Tap to give **${agentId}** its own Telegram identity:`,
      ``,
      `Telegram pre-fills @${suggestedUsername} — confirm and I'll fetch the token and wire it automatically. The bot will be restricted to you.`,
    ].join("\n"));
    // deep-link URL button into the agent's registered chats
    for (const ck of this.agentChats.get(agentId) ?? new Set<string>()) {
      const idx = ck.lastIndexOf(":");
      const t = this.transports.get(ck.slice(0, idx));
      if (t) void t.push(ck.slice(idx + 1), {
        text: `🧬 Create **@${suggestedUsername}** for ${agentId}:`,
        card: { text: "", buttons: [{ label: `Create @${suggestedUsername}`, action: `url:${this.subBotDeepLink(agentId, suggestedUsername, agent.id)}`, url: this.subBotDeepLink(agentId, suggestedUsername, agent.id) }] },
      }).catch(() => {});
    }
  }

  private ensureAttendPassJob(agentId: string): void {
    this.deps.scheduler.ensure({
      id: `attend:${agentId}`,
      agentId,
      chat: { transport: "internal", chatId: "attend" },
      title: "attend pass",
      kind: "attend-pass",
      dueAt: nextDailyAt("10:30"),
      repeat: { dailyAt: "10:30" },
      wake: "normal",
      delivery: "direct",
      status: "pending",
      createdAt: Date.now(),
      firedCount: 0,
      internal: true,
    });
  }

  /** Surface one attend item (respects attend's active hours + daily cap) via buttons */
  private async runAttendPass(t: Transport, chatId: string, agentId: string): Promise<void> {
    try {
      const items = await attendCli(["list", "--status", "pending"]);
      const parsed = items ? (JSON.parse(items) as Array<{ id: string; title: string; body?: string; category: string }>) : [];
      if (!parsed.length) return;
      // policy: max 1/day — count today's responses
      const stateDir = path.join(os.homedir(), "attend", "state");
      let answeredToday = 0;
      try {
        const today = new Date().toISOString().slice(0, 10);
        for (const line of fs.readFileSync(path.join(stateDir, "responses.jsonl"), "utf8").split("\n")) {
          if (line.includes(today) && line.includes('"answered"')) answeredToday++;
        }
      } catch {
        /* no responses file */
      }
      if (answeredToday >= 1) return; // attend's default max_per_day
      const item = parsed[0];
      this.pendingAttend.set(this.chatKey(t, chatId), item.id);
      const bodyText = item.body ? `\n\n${item.body}` : "";
      await this.questions.ask(agentId, { transport: t.name, chatId }, {
        text: `🧠 (attend · ${item.category}) ${item.title}${bodyText}`,
        options: [],
        timeoutMs: 12 * 3600e3,
      }).then(async (res) => {
        if (!res || res.timedOut) return;
        await attendCli(["mark", "--id", item.id, "--status", "answered"]).catch(() => {});
        // record for attend's daily-cap policy
        const rec = {
          ts: new Date().toISOString(), item_id: item.id, category: item.category,
          channel: "telegram", machine: process.env.HOST ?? "local", outcome: res.index >= 0 ? "answered" : "answered",
          answer: res.choice, counted: true,
        };
        fs.mkdirSync(path.join(os.homedir(), "attend", "state"), { recursive: true });
        fs.appendFileSync(path.join(stateDir, "responses.jsonl"), JSON.stringify(rec) + "\n");
      });
    } catch (e) {
      this.deps.events.log(agentId, "system", `attend pass failed: ${errorMessage(e)}`);
    }
  }

  private pendingAttend = new Map<string, string>(); // chatKey → attend item id

  private ensureMorningBriefJob(agent: LoadedAgent): void {
    const hb = agent.manifest.heartbeat;
    if (!hb?.enabled) return;
    const at = hb.quietHours?.to ?? "08:00";
    this.deps.scheduler.ensure({
      id: `brief:${agent.id}`,
      agentId: agent.id,
      chat: { transport: "internal", chatId: "brief" },
      title: "morning brief",
      kind: "morning-brief",
      dueAt: nextDailyAt(at),
      repeat: { dailyAt: at },
      wake: "normal",
      delivery: "direct",
      status: "pending",
      createdAt: Date.now(),
      firedCount: 0,
      internal: true,
    });
  }

  private ensureEvolutionJob(agent: LoadedAgent): void {
    const ev = agent.manifest.evolution;
    if (!ev?.enabled) return;
    const everyMs = parseDuration(ev.interval ?? "6h");
    this.deps.scheduler.ensure({
      id: `ev:${agent.id}`,
      agentId: agent.id,
      chat: { transport: "internal", chatId: "evolution" },
      title: "evolution",
      kind: "evolution",
      dueAt: Date.now() + (everyMs ?? 6 * 3600e3),
      repeat: { everyMs: everyMs ?? 6 * 3600e3 },
      wake: "normal",
      delivery: "direct",
      status: "pending",
      createdAt: Date.now(),
      firedCount: 0,
      internal: true,
    });
  }

  /** Cheap periodic probe: retries downed providers + replays queued messages */
  private ensureCascadeProbeJob(): void {
    if (!this.deps.cascade) return;
    this.deps.scheduler.ensure({
      id: "cascade:probe",
      agentId: "system",
      chat: { transport: "internal", chatId: "cascade" },
      title: "cascade probe",
      kind: "cascade-probe",
      dueAt: Date.now() + 5 * 60e3,
      repeat: { everyMs: 5 * 60e3 },
      wake: "normal",
      delivery: "direct",
      status: "pending",
      createdAt: Date.now(),
      firedCount: 0,
      internal: true,
    });
  }

  private ensureHeartbeatJob(agent: LoadedAgent): void {
    const hb = agent.manifest.heartbeat;
    if (!hb?.enabled) return;
    const everyMs = parseDuration(hb.interval) ?? 45 * 60e3;
    this.deps.scheduler.ensure({
      id: `hb:${agent.id}`,
      agentId: agent.id,
      chat: { transport: "internal", chatId: "heartbeat" },
      title: "heartbeat",
      kind: "heartbeat",
      dueAt: Date.now() + everyMs,
      repeat: { everyMs },
      wake: "normal",
      delivery: "direct",
      status: "pending",
      createdAt: Date.now(),
      firedCount: 0,
      internal: true,
    });
  }

  async deliverFire(job: Schedule, snoozed: boolean): Promise<void> {
    if (job.kind === "heartbeat") {
      await this.deps.heartbeat.tick(job.agentId);
      return;
    }
    if (job.kind === "cascade-probe") {
      await this.runCascadeRecovery();
      return;
    }
    if (job.kind === "attend-pass") {
      const ck = this.primaryChat(job);
      if (ck) {
        const idx = ck.lastIndexOf(":");
        const t = this.transports.get(ck.slice(0, idx));
        if (t) await this.runAttendPass(t, ck.slice(idx + 1), job.agentId);
      }
      return;
    }
    if (job.kind === "morning-brief") {
      await this.deps.heartbeat.tick(job.agentId, { brief: true });
      return;
    }
    if (job.kind === "evolution" && this.deps.evolution) {
      const report = await this.deps.evolution.evolve(job.agentId);
      if (report.staged) {
        await this.deliverToAgent(job.agentId, `🧬 Evolution staged **${report.skill}** for your review: ${report.summary}`);
      }
      return;
    }
    this.deps.events.log(job.agentId, "fire", `${job.title} (${job.kind})`);

    if (job.delivery === "agent") {
      const ck = this.primaryChat(job);
      if (ck) {
        const idx = ck.indexOf(":");
        const t = this.transports.get(ck.slice(0, idx));
        if (t) {
          await this.promptAgent(
            t,
            ck.slice(idx + 1),
            job.agentId,
            `[scheduler] It's time for “${job.title}”${job.detail ? ` — ${job.detail}` : ""}. Compose a short, natural message telling the user this is due now${snoozed ? " (it fired during their snooze — acknowledge that lightly)" : ""}.`
          );
          return;
        }
      }
    }

    const t = this.transports.get(job.chat.transport);
    if (!t) return;
    const icon = job.kind === "task" ? "📋" : job.kind === "note" ? "📝" : job.kind === "subject" ? "🧭" : "⏰";
    const lines = [`${icon} **${job.title}**`];
    if (job.detail) lines.push(job.detail);
    if (snoozed) lines.push("_(fired during snooze — marked important)_");
    await t.push(job.chat.chatId, {
      text: lines.join("\n"),
      card: {
        text: "",
        buttons: [
          { label: "⏰ +10m", action: `scd:${job.id}:+10m` },
          { label: "🕒 +1h", action: `scd:${job.id}:+1h` },
          { label: "🗑 Done", action: `scd:${job.id}:cancel` },
        ],
      },
    });
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
      })
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
    await targetSession.prompt(envelope(
      `[handoff from "${fromAgent}"] The user is moving this conversation to you. Continue where this left off — acknowledge in one short line, then pick up the thread.\n\n# Recent context\n${tail}${note ? `\n\n# Note from ${fromAgent}\n${note}` : ""}`
    ));
    this.rememberChat(toAgent, ck);
    this.deps.events.log(toAgent, "system", `handoff from ${fromAgent} (${truncate(tail, 80)})`);
  }

  // ── agent-to-agent messaging ─────────────────────────────────────────────

  /** Run one turn in an agent's inter-agent session and return the reply text */
  private async agentTurn(agentId: string, fromAgent: string, text: string, timeoutMs?: number): Promise<string> {
    const target = this.deps.agents.getAgent(agentId);
    if (!target) throw new Error(`unknown agent "${agentId}"`);
    const ck = `agent::${agentId}::from-${fromAgent}`;
    const session = await this.deps.agents.getOrCreateSession(
      agentId, ck, { transport: "agent", chatId: fromAgent }, this.deps.scheduler
    );
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
    return this.agentTurn(toAgent, fromAgent,
      `[handoff from "${fromAgent}"] The user is moving this thread to you.${note ? ` Note: ${note}` : ""}\n\n# Context from ${fromAgent}\n${tail}\n\nAcknowledge briefly and continue.`,
      10 * 60e3
    );
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
    await this.promptAgent(t, ck.slice(idx + 1), agentId, `[heartbeat] ${instruction}`);
  }

  private primaryChat(job: Pick<Schedule, "agentId" | "chat">): string | null {
    if (job.chat && job.chat.transport !== "internal") return `${job.chat.transport}:${job.chat.chatId}`;
    const cks = this.agentChats.get(job.agentId);
    return cks && cks.size ? [...cks][0] : null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Per-turn bound: primary + at most this many fallback models try one user turn */
const MAX_TURN_MODELS = 3;

/** Prompts issued by the host itself — deterministic fallback for these stays quiet (no toast) */
const INTERNAL_PROMPT_PREFIXES = ["[scheduler]", "[heartbeat]", "[cascade-recover]", "[handoff from"];

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