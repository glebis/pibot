// ─── Chat commands: the /command layer of pibot ─────────────────────────────
// Satisfied by PiBot via a narrow context interface — keeps this file
// independent of the routing/wiring in bot.ts.

import { listSkillDirs, type AgentManager, type LoadedAgent } from "./agent-manager.js";
import type { ConsolidationEngine } from "./consolidation.js";
import type { EvolutionEngine } from "./evolution.js";
import type { EventLog } from "./events.js";
import type { QuestionBus } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import type { Schedule, Transport, Card } from "./types.js";
import type { Config } from "../config.js";
import { errorMessage, fmtWhen, nextDailyAt, nextQuietEnd, parseDuration, readJson, truncate, writeJsonAtomic } from "./util.js";
import * as path from "node:path";
import type { LoadedAgentShape } from "./agent-shapes.js";

const HELP = [
  `**pibot** — your agents. Talk normally; ask to schedule anything ("remind me to stretch in 20m", "daily standup note at 9am").`,
  ``,
  `/agents — list agents  ·  /agent <name> — switch  ·  /new — fresh session  ·  /issue — file a tracked issue  ·  /newagent — guided wizard`,
  `/schedules — active and paused items  ·  /cancel <id>  ·  /resume <id>  ·  /new — fresh session`,
  `/evolve status — review staged skill proposals (accept/reject from the buttons)  ·  /evolve <goal> — run a cycle`,
  `/handoff <agent> [note] — move this conversation (with a task brief) to another agent`,
  `/snooze <2h|until 18:00> — pause the whole rhythm  ·  /wake`,
  `/cascade — model fallback health  ·  /cascade probe|retry|clear`,
  `/providers — cloud providers, keys & subscription logins`,
  `/consolidate [status] — distill the event log into durable memory`,
  `/status — what's running`,
].join("\n");

/** The 3-button accept/reject/peek card for a staged candidate's review token. */
export function evolutionReviewCard(token: string): Card {
  return {
    text: "",
    buttons: [
      { label: "✅ Accept", action: `evo:${token}:y` },
      { label: "✖ Reject", action: `evo:${token}:n` },
      { label: "📄 Full text", action: `evo:${token}:peek` },
    ],
  };
}

function ago(ms: number, now = Date.now()): string {
  const s = Math.max(1, Math.round((now - ms) / 1e3));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export interface CommandContext {
  config: Config;
  agents: AgentManager;
  scheduler: Scheduler;
  events: EventLog;
  transports: Map<string, Transport>;
  agentChats: Map<string, Set<string>>;
  pendingSubBots: Map<string, string>;
  wizardChats: Set<string>;
  evolution?: EvolutionEngine;
  consolidation?: ConsolidationEngine;
  heartbeat: { tick: (agentId: string, opts?: { brief?: boolean }) => Promise<void>; noteUserMessage?: (agentId: string) => void };
  telegram?: {
    managerMode(): boolean;
    managerUsername(): string | undefined;
    subBotFor(agentId: string): { username?: string } | undefined;
    attachSubBot(agentId: string, token: string, allowedChats?: string[]): Promise<{ ok: boolean; botName?: string; error?: string }>;
    detachSubBot(agentId: string): Promise<boolean>;
    requestSubBotCreation(agentId: string, fromChat?: { transport: string; chatId: string }): Promise<void>;
  };
  currentAgent(ck: string): string | undefined;
  chatKey(t: Transport, chatId: string): string;
  resetSession(agentId: string, ck: string): Promise<void>;
  /** run the bd CLI (repo cwd) — used by the /issue intake wizard */
  runBd?: (args: string[]) => Promise<string>;
  rememberChat(agentId: string, ck: string): void;
  ensureHeartbeatJob(agent: LoadedAgentShape): void;
  ensureEvolutionJob(agent: LoadedAgentShape): void;
  ensureMorningBriefJob(agent: LoadedAgentShape): void;
  deliverToAgent(agentId: string, text: string): Promise<void>;
  handoff?(t: Transport, chatId: string, fromAgent: string, toAgent: string, note?: string): Promise<{ ok: true; ack: string } | { ok: false; error: string }>;
  questions: Pick<QuestionBus, "cancelPending" | "ask">;
  wizard: { runNewAgentWizard(t: Transport, chatId: string): Promise<void> };
  cascade?: {
    status(agentId?: string): string;
    probe(): Promise<string>;
    retry(): Promise<string>;
    clear(): string;
  };
  providers?: {
    statusText(): Promise<string>;
  };
}

export function createCommandHandler(ctx: CommandContext) {
  const deps = ctx;
  return async (t: Transport, chatId: string, text: string): Promise<void> => {
    const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = rest.join(" ").trim();
    const ck = ctx.chatKey(t, chatId);
    const agentId = ctx.currentAgent(ck);
    const reply = (s: string) => t.push(chatId, { text: s });

    switch (cmd) {
      case "start":
      case "help":
        await reply(HELP);
        return;

      case "agents": {
        await deps.agents.discover(); // pick up agents added on disk since boot
        const lines = deps.agents.list().map((a) => {
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
        if (!deps.agents.getAgent(arg)) {
          await reply(`No agent "${arg}". /agents for the list.`);
          return;
        }
        ctx.rememberChat(arg, ck);
        await reply(`Switched to **${arg}**. Its memory and rhythm are its own.`);
        return;
      }

      case "cancel":
        if (ctx.wizardChats.has(ck)) {
          ctx.questions.cancelPending(ck);
          await reply("Wizard cancelled. Nothing was created.");
        } else if (ctx.questions.cancelPending(ck)) {
          await reply("Question dismissed.");
        } else if (arg && agentId) {
          const job = deps.scheduler.cancel(arg);
          await reply(job ? `🗑 Cancelled: ${job.title}` : `Nothing matches "${arg}". /schedules for ids.`);
        } else {
          await reply("Nothing to cancel. Use /cancel <schedule-id> for a scheduled item.");
        }
        return;

      case "newagent": {
        if (!arg) {
          void Promise.resolve(ctx.wizard.runNewAgentWizard(t, chatId)).catch((e: unknown) => console.error("[wizard]", e));
          return;
        }
        const m = arg.match(/^([a-z0-9][a-z0-9-]{1,31})\s*([\s\S]*)$/i);
        if (!m) {
          await reply("Usage: /newagent (guided wizard) or /newagent <name> <persona instructions>");
          return;
        }
        const err = deps.agents.createAgent(m[1].toLowerCase(), m[2] || undefined);
        if (err) {
          await reply(err);
          return;
        }
        const agent = deps.agents.getAgent(m[1].toLowerCase())!;
        ctx.ensureHeartbeatJob(agent);
        ctx.ensureEvolutionJob(agent);
        ctx.rememberChat(agent.id, ck);
        await t.push(chatId, {
          text: `Born: **${agent.id}** 🎉\nPersona: ${agent.dir}/AGENTS.md · plugins: agent.json · memory: memory/\nYou're talking to it now. It wakes every ${agent.manifest.heartbeat?.interval ?? "45m"}.`,
          card: {
            text: "",
            buttons: [
              { label: `🤖 talk to ${agent.id} later`, action: `agt:${agent.id}` },
              { label: "🪪 own Telegram identity", action: `subbot:${agent.id}` },
            ],
          },
        });
        return;
      }

      case "handoff": {
        if (!agentId) return void (await reply("No agent selected."));
        if (!deps.handoff) return void (await reply("Handoff is not wired in this build."));
        const target = arg.split(/\s+/)[0]?.toLowerCase() ?? "";
        if (!target) {
          await reply("Usage: /handoff <agent> [note] — move this conversation (with a task brief) to another agent. /agents for the list.");
          return;
        }
        const note = arg.slice(target.length).trim() || undefined;
        const r = await deps.handoff(t, chatId, agentId, target, note);
        await reply(r.ok ? `🤝 Handed to **${target}** — your next message reaches them.\n\n${truncate(r.ack, 300)}` : `⚠︎ ${r.error}`);
        return;
      }

      case "issue": {
        let title = arg.trim();
        if (!title) {
          const a = await ctx.questions.ask(agentId ?? "", { transport: t.name, chatId }, { text: "📋 What's the issue? One line that says what's wrong or missing.", options: [] });
          title = (a?.choice ?? "").trim();
          if (!title) return;
        }
        const pain = await ctx.questions.ask(agentId ?? "", { transport: t.name, chatId }, { text: "Why — what's the pain or context?", options: [] });
        const scope = await ctx.questions.ask(agentId ?? "", { transport: t.name, chatId }, { text: "Where does it apply? (this bot / an agent by name / host-level)", options: [] });
        const prio = await ctx.questions.ask(agentId ?? "", { transport: t.name, chatId }, { text: "Priority?", options: ["P1 — now", "P2 — soon", "P3 — backlog"] });
        const done = await ctx.questions.ask(agentId ?? "", { transport: t.name, chatId }, { text: "Done when — what should happen when it works?", options: [] });
        const priority = prio?.index === 0 ? 1 : prio?.index === 2 ? 3 : 2;
        if (!ctx.runBd) {
          await reply("Issue filing is unavailable in this build (no bd runner wired).");
          return;
        }
        const description = [
          pain?.choice ? `Pain/context: ${pain.choice}` : "",
          scope?.choice ? `Scope: ${scope.choice}` : "",
          done?.choice ? `Done when: ${done.choice}` : "",
        ].filter(Boolean).join("\n");
        try {
          const out = await ctx.runBd(["create", "--title", title, "--type", "feature", "--priority", String(priority), "--description", description || "(no description)"]);
          const id = out.match(/\b[a-z]+-[a-z0-9]+\b/i)?.[0] ?? "created";
          await t.push(chatId, {
            text: `📋 Filed as **${id}**\n— ${title}\n— priority ${priority}`,
            card: { text: "", buttons: [{ label: "👀 show it", action: `bdshow:${id}` }] },
          });
        } catch (e) {
          await reply(`Couldn't file the issue: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      case "new": {
        if (!agentId) return void (await reply("No agent selected for this chat."));
        await ctx.resetSession(agentId, ck);
        await reply(`🆕 Fresh session for **${agentId}** — memory, files, and schedules kept; the conversation starts clean.`);
        return;
      }

      case "snooze": {
        if (!agentId) return void (await reply("No agent selected."));
        if (!arg) {
          // button-first: render duration choices
          await t.push(chatId, {
            text: "😴 Snooze the whole rhythm for…",
            card: {
              text: "",
              buttons: [
                { label: "30 min", action: "snz:30m" },
                { label: "1 h", action: "snz:1h" },
                { label: "3 h", action: "snz:3h" },
                { label: "Until morning", action: "snz:morning" },
              ],
            },
          });
          return;
        }
        const ms = parseDuration(arg);
        if (!ms) {
          await reply(`Couldn't parse "${arg}". Try /snooze 2h or /snooze 30m.`);
          return;
        }
        const agent = deps.agents.getAgent(agentId);
        const quietEnd = nextQuietEnd(agent?.manifest.heartbeat?.quietHours);
        const st = deps.scheduler.snooze(agentId, Date.now() + ms, "manual", quietEnd ?? undefined);
        deps.events.log(agentId, "snooze", `until ${new Date(st.until).toLocaleTimeString()}`);
        const nightNote = quietEnd && st.until >= (quietEnd ?? 0) ? "" : quietEnd ? " (capped at your wake time)" : "";
        await reply(`😴 Everything paused until **${fmtWhen(st.until)}**${nightNote}. Important items still come through. /wake to end early.`);
        return;
      }

      case "wake": {
        const resumed = deps.scheduler.unsnoozeAll();
        await reply(resumed.length ? `☀️ Rhythm resumed for: ${resumed.map((a) => `**${a}**`).join(", ")}` : "Nothing was snoozed.");
        return;
      }

      case "evolve": {
        if (!deps.evolution) {
          await reply("Evolution engine not wired.");
          return;
        }
        const sub = arg.split(/\s+/)[0];
        if (sub === "status") {
          // admin review: staged candidates across ALL agents, one tappable card each —
          // no agent binding required, the review is global
          let shown = 0;
          for (const a of deps.agents.list()) {
            for (const c of deps.evolution.stagedDetail(a.id)) {
              shown++;
              const tok = deps.evolution.reviewToken(a.id, c.name);
              const meta = [
                c.scores?.length ? `probes ${c.scores.join(", ")}` : "",
                c.closesBacklog.length ? `closes ${c.closesBacklog.join(", ")}` : "",
                `staged ${ago(c.stagedAt)}`,
              ].filter(Boolean).join(" · ");
              await t.push(chatId, {
                text: [
                  `🧬 **${a.id}** staged **${c.name}** (${c.mode})`,
                  c.description ? `_${c.description}_` : "",
                  "",
                  c.preview || "(empty body)",
                  "",
                  meta,
                ].filter(Boolean).join("\n"),
                card: evolutionReviewCard(tok),
              });
            }
          }
          if (!shown) {
            await reply("Nothing staged for review. Candidates land here when probes score <4 or a risky pattern needs a human yes — or run a cycle now: /evolve <goal>");
          }
          return;
        }
        if (!agentId) return void (await reply("No agent selected."));
        if (sub === "promote" || sub === "reject") {
          const name = arg.split(/\s+/)[1] ?? "";
          const done = sub === "promote" ? deps.evolution.promote(agentId, name) : deps.evolution.reject(agentId, name);
          await reply(done ? `${sub === "promote" ? "Promoted" : "Rejected"} **${name}**.` : `Nothing staged named "${name}".`);
          return;
        }
        const goal = arg.trim() || undefined;
        await reply(`🧬 Running an evolution cycle${goal ? ` — goal: “${goal}”` : " (self-directed)"}. This runs cheap probes, takes a minute…`);
        const report = await deps.evolution.evolve(agentId, goal, { force: true });
        deps.events.log(agentId, "system", `evolution run: ${report.summary}`);
        await reply(`${report.ok ? "🧬" : "⛔"} ${report.summary}${report.staged ? "\nReview it: /evolve status — accept or reject right from the card." : ""}`);
        return;
      }

      case "skills": {
        if (!agentId) return void (await reply("No agent selected."));
        const agent = deps.agents.getAgent(agentId);
        const skills = agent ? listSkillDirs(path.join(agent.dir, "skills")) : [];
        await reply(skills.length ? skills.map((s) => `• **${s.name}** — ${s.description}`).join("\n") : `No skills yet for **${agentId}**. /evolve can create some.`);
        return;
      }

      case "consolidate": {
        if (!deps.consolidation) {
          await reply("Consolidation engine not wired.");
          return;
        }
        if (!agentId) return void (await reply("No agent selected."));
        const sub = arg.split(/\s+/)[0];
        if (sub === "status") {
          await reply(deps.consolidation.statusText(agentId));
          return;
        }
        await reply("🧠 Distilling the event log into durable memory…");
        const report = await deps.consolidation.consolidate(agentId);
        await reply(`${report.ok ? "🧠" : "⛔"} ${report.summary}`);
        return;
      }

      case "schedules": {
        if (!agentId) return void (await reply("No agent selected."));
        const jobs = deps.scheduler.list(agentId, { includePaused: true }).filter((j) => !j.internal);
        if (!jobs.length) {
          await reply("Nothing pending. Ask the agent to schedule something.");
          return;
        }
        await reply(
          jobs
            .slice(0, 20)
            .map((j) => `• [${j.id}]${j.status === "paused" ? " **PAUSED**" : ""} **${j.title}** — ${fmtWhen(j.dueAt)}${j.repeat ? " ↻" : ""}${j.wake === "important" ? " ⚡" : ""}${j.status === "paused" && j.lastDeliveryError ? ` — ${j.lastDeliveryError}` : ""}`)
            .join("\n")
        );
        return;
      }

      case "resume": {
        if (!agentId) return void (await reply("No agent selected."));
        const job = deps.scheduler.resume(arg);
        await reply(job ? `▶️ Resumed: ${job.title}` : `No paused schedule matches "${arg}". /schedules for ids.`);
        return;
      }

      case "promises": {
        if (!agentId) return void (await reply("No agent selected."));
        const jobs = deps.scheduler.list(agentId).filter((j) => j.kind === "promise");
        await reply(jobs.length ? jobs.map((j) => `• [${j.id}] **${j.title}** — ${fmtWhen(j.dueAt)}`).join("\n") : "No open promises.");
        return;
      }

      case "status": {
        if (!agentId) return void (await reply("No agent selected."));
        const agent = deps.agents.getAgent(agentId)!;
        const hb = agent.manifest.heartbeat;
        const sn = deps.scheduler.snoozeState(agentId);
        const active = deps.scheduler.list(agentId, { includePaused: true });
        const pending = active.filter((j) => j.status === "pending");
        const paused = active.filter((j) => j.status === "paused" && !j.internal);
        const next = pending[0];
        await reply(
          [
            `**${agent.id}** — ${agent.manifest.description ?? ""}`,
            `model: ${agent.manifest.model ?? "auto"} · thinking: ${agent.manifest.thinking ?? "off"}`,
            `heartbeat: ${hb?.enabled ? `every ${hb.interval}${hb.model ? ` (${hb.model})` : ""}` : "off"}${hb?.quietHours ? ` · quiet ${hb.quietHours.from}–${hb.quietHours.to}` : ""}`,
            `snoozed: ${sn ? `until ${fmtWhen(sn.until)}` : "no"}`,
            `pending: ${pending.filter((j) => !j.internal).length} · paused: ${paused.length}${next && !next.internal ? ` · next: “${next.title}” ${fmtWhen(next.dueAt)}` : ""}`,
          ].join("\n")
        );
        return;
      }

      case "cascade": {
        const cascade = deps.cascade;
        if (!cascade) {
          await reply("Cascade is not wired in this build.");
          return;
        }
        const sub = (rest[0] ?? "").toLowerCase();
        if (sub === "probe") {
          await reply(`Probing models…\n${await cascade.probe()}`);
        } else if (sub === "retry" || sub === "flush") {
          await reply(await cascade.retry());
        } else if (sub === "clear") {
          await reply(cascade.clear());
        } else {
          await reply(cascade.status(agentId));
        }
        return;
      }

      case "providers": {
        if (!deps.providers) {
          await reply("Providers view is not wired in this build.");
          return;
        }
        await reply(await deps.providers.statusText());
        return;
      }

      case "subbot": {
        const target = (arg || agentId || "").trim().toLowerCase();
        if (!target) {
          await reply("Usage: /subbot <agent-id> — give that agent its own Telegram identity. /agents for the list.");
          return;
        }
        if (!deps.agents.getAgent(target)) {
          await reply(`No agent "${target}". /agents for the list.`);
          return;
        }
        if (!deps.telegram) {
          await reply("Telegram transport is not wired in this build.");
          return;
        }
        const existing = deps.telegram.subBotFor(target);
        if (existing?.username) {
          await reply(`**${target}** already has its own bot: @${existing.username.replace("@", "")} — use the dashboard's Detach button first if you want to replace it.`);
          return;
        }
        try {
          await deps.telegram.requestSubBotCreation(target, { transport: t.name, chatId });
          return;
        } catch (e) {
          await reply(`⚠︎ ${errorMessage(e)}`);
        }
        return;
      }

      case "quit":
        if (t.name === "cli") process.exit(0);
        await reply("/quit only works in the CLI.");
        return;

      default:
        await reply(`Unknown /${cmd} — try /help`);
    }
  };
}
