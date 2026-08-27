// ─── Chat commands: the /command layer of pibot ─────────────────────────────
// Satisfied by PiBot via a narrow context interface — keeps this file
// independent of the routing/wiring in bot.ts.

import { listSkillDirs, type AgentManager, type LoadedAgent } from "./agent-manager.js";
import type { EvolutionEngine } from "./evolution.js";
import type { EventLog } from "./events.js";
import type { QuestionBus } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import type { Schedule, Transport } from "./types.js";
import type { Config } from "../config.js";
import { errorMessage, fmtWhen, nextDailyAt, nextQuietEnd, parseDuration, readJson, truncate, writeJsonAtomic } from "./util.js";
import * as path from "node:path";
import type { LoadedAgentShape } from "./agent-shapes.js";

const HELP = [
  `**pibot** — your agents. Talk normally; ask to schedule anything ("remind me to stretch in 20m", "daily standup note at 9am").`,
  ``,
  `/agents — list agents  ·  /agent <name> — switch  ·  /newagent — guided wizard`,
  `/schedules — pending items  ·  /cancel <id>`,
  `/snooze <2h|until 18:00> — pause the whole rhythm  ·  /wake`,
  `/status — what's running`,
].join("\n");

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
  heartbeat: { tick: (agentId: string, opts?: { brief?: boolean }) => Promise<void>; noteUserMessage?: (agentId: string) => void };
  telegram?: {
    managerMode(): boolean;
    managerUsername(): string | undefined;
    subBotFor(agentId: string): { username?: string } | undefined;
    attachSubBot(agentId: string, token: string): Promise<{ ok: boolean; botName?: string; error?: string }>;
    detachSubBot(agentId: string): Promise<boolean>;
    requestSubBotCreation(agentId: string): Promise<void>;
  };
  currentAgent(ck: string): string | undefined;
  chatKey(t: Transport, chatId: string): string;
  rememberChat(agentId: string, ck: string): void;
  ensureHeartbeatJob(agent: LoadedAgentShape): void;
  ensureEvolutionJob(agent: LoadedAgentShape): void;
  ensureMorningBriefJob(agent: LoadedAgentShape): void;
  deliverToAgent(agentId: string, text: string): Promise<void>;
  questions: Pick<QuestionBus, "cancelPending">;
  wizard: { runNewAgentWizard(t: Transport, chatId: string): Promise<void> };
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
        } else {
          await reply("Nothing to cancel.");
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
        await reply(
          `Born: **${agent.id}** 🎉\nPersona: ${agent.dir}/AGENTS.md · plugins: agent.json · memory: memory/\nYou're talking to it now. It wakes every ${agent.manifest.heartbeat?.interval ?? "45m"}.`
        );
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
        if (!agentId) return void (await reply("No agent selected."));
        const sub = arg.split(/\s+/)[0];
        if (sub === "status") {
          const staged = deps.evolution.staged(agentId);
          await reply(staged.length ? `Staged: ${staged.map((s) => `**${s}**`).join(", ")}\nPromote: /evolve promote <name>` : "Nothing staged.");
          return;
        }
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
        await reply(`${report.ok ? "🧬" : "⛔"} ${report.summary}${report.staged ? "\nReview: /evolve status → /evolve promote <name>" : ""}`);
        return;
      }

      case "skills": {
        if (!agentId) return void (await reply("No agent selected."));
        const agent = deps.agents.getAgent(agentId);
        const skills = agent ? listSkillDirs(path.join(agent.dir, "skills")) : [];
        await reply(skills.length ? skills.map((s) => `• **${s.name}** — ${s.description}`).join("\n") : `No skills yet for **${agentId}**. /evolve can create some.`);
        return;
      }

      case "schedules": {
        if (!agentId) return void (await reply("No agent selected."));
        const jobs = deps.scheduler.list(agentId).filter((j) => !j.internal);
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
        const job = deps.scheduler.cancel(arg);
        await reply(job ? `🗑 Cancelled: ${job.title}` : `Nothing matches "${arg}". /schedules for ids.`);
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
        const pending = deps.scheduler.list(agentId);
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
  };
}
