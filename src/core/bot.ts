import * as fs from "node:fs";
import * as path from "node:path";
import { listSkillDirs } from "./agent-manager.js";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { TelegramTransport } from "../transports/telegram.js";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import type { EvolutionEngine } from "./evolution.js";
import type { EventLog } from "./events.js";
import type { HeartbeatEngine, HeartbeatHost } from "./heartbeat.js";
import { QuestionBus, type QuestionSpec } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import type { Config } from "../config.js";
import type { Card, ChatRef, Schedule, Transport } from "./types.js";
import { errorMessage, fmtWhen, parseDuration, readJson, truncate, uid, writeJsonAtomic } from "./util.js";

const HELP = [
  `**pibot** — your agents. Talk normally; ask to schedule anything ("remind me to stretch in 20m", "daily standup note at 9am").`,
  ``,
  `/agents — list agents  ·  /agent <name> — switch  ·  /newagent <name> <persona> — create`,
  `/schedules — pending items  ·  /cancel <id>`,
  `/snooze <2h|until 18:00> — pause the whole rhythm  ·  /wake`,
  `/status — what's running`,
].join("\n");

export class PiBot implements HeartbeatHost {
  private transports = new Map<string, Transport>();
  private wired = new Set<string>();
  private chatAgent = new Map<string, string>(); // chatKey → agentId
  private agentChats = new Map<string, Set<string>>(); // agentId → chatKeys
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

  // ── live transport control (used by web dashboard) ───────────────────────────

  hasTransport(name: string): boolean {
    return this.transports.has(name);
  }

  telegramUsername(): string | undefined {
    const t = this.transports.get("telegram");
    return t instanceof TelegramTransport ? t.botUsername() : undefined;
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
    return this.chatAgent.get(ck) ?? this.deps.config.defaultAgentId ?? this.deps.agents.defaultAgentId();
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

      case "newagent": {
        const m = arg.match(/^([a-z0-9][a-z0-9-]{1,31})\s*([\s\S]*)$/i);
        if (!m) {
          await reply("Usage: /newagent <name> <persona instructions — who it is, how it talks, what it cares about>");
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
        const st = this.deps.scheduler.snooze(agentId, Date.now() + ms, "manual");
        this.deps.events.log(agentId, "snooze", `until ${new Date(st.until).toLocaleTimeString()}`);
        await reply(`😴 Everything paused until **${fmtWhen(st.until)}**. Important items still come through. /wake to end early.`);
        return;
      }

      case "wake": {
        const had = agentId ? this.deps.scheduler.unsnooze(agentId) : false;
        await reply(had ? "☀️ Rhythm resumed." : "Nothing was snoozed.");
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
        const idx = ck.indexOf(":");
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
    const idx = ck.indexOf(":");
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