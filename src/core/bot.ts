import * as fs from "node:fs";
import * as path from "node:path";
import { buildManifest, buildPersona, validateAgentName, type AgentDraft, type Proactivity } from "./agent-factory.js";
import { listSkillDirs } from "./agent-manager.js";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { TelegramTransport } from "../transports/telegram.js";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import type { EvolutionEngine } from "./evolution.js";
import type { EventLog } from "./events.js";
import type { HeartbeatEngine, HeartbeatHost } from "./heartbeat.js";
import { QuestionBus, type QuestionSpec } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import { loadSettings, saveSettings, type Config } from "../config.js";
import type { Card, ChatRef, Schedule, Transport } from "./types.js";
import { PROACTIVITY_INTERVAL, PROACTIVITY_OPTIONS, VIBE_OPTIONS, suggestedSubBotUsername } from "./agent-factory.js";
import { errorMessage, fmtWhen, nextQuietEnd, parseDuration, readJson, truncate, uid, writeJsonAtomic } from "./util.js";

const HELP = [
  `**pibot** — your agents. Talk normally; ask to schedule anything ("remind me to stretch in 20m", "daily standup note at 9am").`,
  ``,
  `/agents — list agents  ·  /agent <name> — switch  ·  /newagent — guided wizard`,
  `/schedules — pending items  ·  /cancel <id>`,
  `/snooze <2h|until 18:00> — pause the whole rhythm  ·  /wake`,
  `/status — what's running`,
].join("\n");

export class PiBot implements HeartbeatHost {
  private transports = new Map<string, Transport>();
  private wired = new Set<string>();
  private chatAgent = new Map<string, string>(); // chatKey → agentId
  private agentChats = new Map<string, Set<string>>(); // agentId → chatKeys
  private wizardChats = new Set<string>(); // chats running /newagent interview
  private pendingSubBots = new Map<string, string>(); // chatKey → agentId awaiting its sub-bot creation
  private subBots = new Map<string, { token: string; username?: string }>(); // agentId → token
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
      if (agent.manifest.evolution?.enabled) this.ensureEvolutionJob(agent);
    }

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

  private persistSubBot(agentId: string, token: string, username?: string): void {
    const cur = loadSettings(this.deps.config.dataDir);
    const subBots = { ...(cur.telegram?.subBots ?? {}), [agentId]: { token, username } };
    saveSettings(this.deps.config.dataDir, { telegram: { ...cur.telegram, subBots } });
  }

  private removeSubBotFromSettings(agentId: string): void {
    const cur = loadSettings(this.deps.config.dataDir);
    const subBots = { ...(cur.telegram?.subBots ?? {}) };
    delete subBots[agentId];
    saveSettings(this.deps.config.dataDir, { telegram: { ...cur.telegram, subBots } });
  }

  /** Wire a dedicated bot for one agent (token verified against Telegram first) */
  async attachSubBot(agentId: string, token: string): Promise<{ ok: boolean; botName?: string; error?: string }> {
    const existingName = `telegram:${agentId}`;
    if (this.transports.has(existingName)) {
      await this.transports.get(existingName)?.stop().catch(() => {});
      this.transports.delete(existingName);
    }
    const t = new TelegramTransport(token, [], { nameSuffix: agentId, boundAgentId: agentId });
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
    this.persistSubBot(agentId, token, botName.startsWith("@") ? botName.slice(1) : botName);
    this.deps.events.log("system", "system", `sub-bot attached for ${agentId} as ${botName}`);
    return { ok: true, botName };
  }

  async detachSubBot(agentId: string): Promise<boolean> {
    const t = this.transports.get(`telegram:${agentId}`);
    if (!t) return false;
    await t.stop().catch(() => {});
    this.transports.delete(`telegram:${agentId}`);
    this.persistSubBot; // keep the record removal explicit:
    const cur = loadSettings(this.deps.config.dataDir);
    const subBots = { ...(cur.telegram?.subBots ?? {}) };
    delete subBots[agentId];
    saveSettings(this.deps.config.dataDir, { telegram: { ...cur.telegram, subBots } });
    this.deps.events.log("system", "system", `sub-bot detached for ${agentId}`);
    return true;
  }

  /** Deep link that lets the chat owner create a managed sub-bot for an agent */
  subBotDeepLink(agentId: string, username: string, displayName?: string): string {
    const usernameT = this.telegramUsername() ?? "";
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
      }
    }
  }

  async handleIncoming(t: Transport, chatId: string, raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    const ck = this.chatKey(t, chatId);
    // slash commands always work, even with a question pending
    if (text.startsWith("/")) return void (await this.handleCommand(t, chatId, text));
    // a pending structured question eats the next plain message in this chat
    if (this.questions.answerViaText(ck, text)) return;
    const agentId = this.currentAgent(ck);
    if (!agentId) {
      await t.notifyError(chatId, "No agents yet. Create one: /newagent myfriend <persona text>");
      return;
    }
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

  private async handleCommand(t: Transport, chatId: string, text: string): Promise<void> {
    const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = rest.join(" ").trim();
    const ck = this.chatKey(t, chatId);
    const agentId = this.currentAgent(ck);
    const reply = (s: string) => t.push(chatId, { text: s });

    switch (cmd) {
      case "start":
      case "help":
        await reply(HELP);
        return;
        return;

      case "agents": {
        await this.deps.agents.discover(); // pick up agents added on disk since boot
        const lines = this.deps.agents.list().map((a) => {
          const cur = a.id === agentId ? " ← here" : "";
          return `• **${a.id}** — ${a.manifest.description ?? "agent"}${cur}`;
        });
        await reply(lines.join("\n") || "No agents.");
        return;
      }

      case "agent": {
        if (!arg) {
          await reply(`Current agent: **${agentId ?? "none"}**. Switch with /agent <name>.`);
          return;
        }
        if (!this.deps.agents.getAgent(arg)) {
          await reply(`No agent "${arg}". /agents for the list.`);
          return;
        }
        this.rememberChat(arg, ck);
        await reply(`Switched to **${arg}**. Its memory and rhythm are its own.`);
        return;
      }

      case "cancel":
        if (this.wizardChats.has(ck)) {
          this.questions.cancelPending(ck);
          await reply("Wizard cancelled. Nothing was created.");
        } else if (this.questions.cancelPending(ck)) {
          await reply("Question dismissed.");
        } else {
          await reply("Nothing to cancel.");
        }
        return;

      case "newagent": {
        if (!arg) {
          void this.runNewAgentWizard(t, chatId).catch((e) => console.error("[wizard]", e));
          return;
        }
        const m = arg.match(/^([a-z0-9][a-z0-9-]{1,31})\s*([\s\S]*)$/i);
        if (!m) {
          await reply("Usage: /newagent (guided wizard) or /newagent <name> <persona instructions>");
          return;
        }
        const err = this.deps.agents.createAgent(m[1].toLowerCase(), m[2] || undefined);
        if (err) {
          await reply(err);
          return;
        }
        const agent = this.deps.agents.getAgent(m[1].toLowerCase())!;
        this.ensureHeartbeatJob(agent);
        this.ensureEvolutionJob(agent);
        this.rememberChat(agent.id, ck);
        await reply(
          `Born: **${agent.id}** 🎉\nPersona: ${agent.dir}/AGENTS.md · plugins: agent.json · memory: memory/\nYou're talking to it now. It wakes every ${agent.manifest.heartbeat?.interval ?? "45m"}.`
        );
        return;
      }

      case "snooze": {
        if (!agentId) return void (await reply("No agent selected."));
        const ms = arg ? parseDuration(arg) : 3600e3;
        if (!ms) {
          await reply(`Couldn't parse "${arg}". Try /snooze 2h or /snooze 30m.`);
          return;
        }
        const agent = this.deps.agents.getAgent(agentId);
        const quietEnd = nextQuietEnd(agent?.manifest.heartbeat?.quietHours);
        const st = this.deps.scheduler.snooze(agentId, Date.now() + ms, "manual", quietEnd ?? undefined);
        this.deps.events.log(agentId, "snooze", `until ${new Date(st.until).toLocaleTimeString()}`);
        const nightNote = quietEnd && st.until >= (quietEnd ?? 0) ? "" : quietEnd ? " (capped at your wake time)" : "";
        await reply(`😴 Everything paused until **${fmtWhen(st.until)}**${nightNote}. Important items still come through. /wake to end early.`);
        return;
      }

      case "wake": {
        const resumed = this.deps.scheduler.unsnoozeAll();
        await reply(resumed.length ? `☀️ Rhythm resumed for: ${resumed.map((a) => `**${a}**`).join(", ")}` : "Nothing was snoozed.");
        return;
      }

      case "evolve": {
        if (!this.deps.evolution) {
          await reply("Evolution engine not wired.");
          return;
        }
        if (!agentId) return void (await reply("No agent selected."));
        const sub = arg.split(/\s+/)[0];
        if (sub === "status") {
          const staged = this.deps.evolution.staged(agentId);
          await reply(staged.length ? `Staged: ${staged.map((s) => `**${s}**`).join(", ")}\nPromote: /evolve promote <name>` : "Nothing staged.");
          return;
        }
        if (sub === "promote" || sub === "reject") {
          const name = arg.split(/\s+/)[1] ?? "";
          const done = sub === "promote" ? this.deps.evolution.promote(agentId, name) : this.deps.evolution.reject(agentId, name);
          await reply(done ? `${sub === "promote" ? "Promoted" : "Rejected"} **${name}**.` : `Nothing staged named "${name}".`);
          return;
        }
        const goal = arg.trim() || undefined;
        await reply(`🧬 Running an evolution cycle${goal ? ` — goal: “${goal}”` : " (self-directed)"}. This runs cheap probes, takes a minute…`);
        const report = await this.deps.evolution.evolve(agentId, goal, { force: true });
        this.deps.events.log(agentId, "system", `evolution run: ${report.summary}`);
        await reply(`${report.ok ? "🧬" : "⛔"} ${report.summary}${report.staged ? "\nReview: /evolve status → /evolve promote <name>" : ""}`);
        return;
      }

      case "skills": {
        if (!agentId) return void (await reply("No agent selected."));
        const agent = this.deps.agents.getAgent(agentId);
        const skills = agent ? listSkillDirs(path.join(agent.dir, "skills")) : [];
        await reply(skills.length ? skills.map((s) => `• **${s.name}** — ${s.description}`).join("\n") : `No skills yet for **${agentId}**. /evolve can create some.`);
        return;
      }

      case "schedules": {
        if (!agentId) return void (await reply("No agent selected."));
        const jobs = this.deps.scheduler.list(agentId).filter((j) => !j.internal);
        if (!jobs.length) {
          await reply("Nothing pending. Ask the agent to schedule something.");
          return;
        }
        await reply(
          jobs
            .slice(0, 20)
            .map((j) => `• [${j.id}] **${j.title}** — ${fmtWhen(j.dueAt)}${j.repeat ? " ↻" : ""}${j.wake === "important" ? " ⚡" : ""}`)
            .join("\n")
        );
        return;
      }

      case "cancel": {
        if (!agentId) return void (await reply("No agent selected."));
        const job = this.deps.scheduler.cancel(arg);
        await reply(job ? `🗑 Cancelled: ${job.title}` : `Nothing matches "${arg}". /schedules for ids.`);
        return;
      }

      case "promises": {
        if (!agentId) return void (await reply("No agent selected."));
        const jobs = this.deps.scheduler.list(agentId).filter((j) => j.kind === "promise");
        await reply(jobs.length ? jobs.map((j) => `• [${j.id}] **${j.title}** — ${fmtWhen(j.dueAt)}`).join("\n") : "No open promises.");
        return;
      }

      case "status": {
        if (!agentId) return void (await reply("No agent selected."));
        const agent = this.deps.agents.getAgent(agentId)!;
        const hb = agent.manifest.heartbeat;
        const sn = this.deps.scheduler.snoozeState(agentId);
        const pending = this.deps.scheduler.list(agentId);
        const next = pending[0];
        await reply(
          [
            `**${agent.id}** — ${agent.manifest.description ?? ""}`,
            `model: ${agent.manifest.model ?? "auto"} · thinking: ${agent.manifest.thinking ?? "off"}`,
            `heartbeat: ${hb?.enabled ? `every ${hb.interval}${hb.model ? ` (${hb.model})` : ""}` : "off"}${hb?.quietHours ? ` · quiet ${hb.quietHours.from}–${hb.quietHours.to}` : ""}`,
            `snoozed: ${sn ? `until ${fmtWhen(sn.until)}` : "no"}`,
            `pending: ${pending.filter((j) => !j.internal).length}${next && !next.internal ? ` · next: “${next.title}” ${fmtWhen(next.dueAt)}` : ""}`,
          ].join("\n")
        );
        return;
      }

      case "quit":
        if (t.name === "cli") process.exit(0);
        await reply("/quit only works in the CLI.");
        return;

      default:
        await reply(`Unknown /${cmd} — try /help`);
    }
  }

  // ── scheduler fire delivery ───────────────────────────────────────────────

  /**
   * Guided /newagent interview: name → job → vibe → proactivity.
   * Uses ask_user buttons; each new question replaces the last; /cancel aborts.
   */
  private async runNewAgentWizard(t: Transport, chatId: string): Promise<void> {
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

      // build
      const draft: AgentDraft = { name, job: job ?? "", vibe, proactivity };
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

  // ── HeartbeatHost ─────────────────────────────────────────────────────────

  async deliverToAgent(agentId: string, text: string): Promise<void> {
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