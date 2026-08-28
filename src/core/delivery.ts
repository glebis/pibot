import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attendCli } from "../plugins/attend-plugin.js";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import type { EventLog } from "./events.js";
import type { HeartbeatEngine } from "./heartbeat.js";
import type { QuestionBus } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import type { Schedule, Transport } from "./types.js";
import { errorMessage, nextDailyAt, parseDuration } from "./util.js";

export interface DeliveryDeps {
  agents: AgentManager;
  scheduler: Scheduler;
  heartbeat: HeartbeatEngine;
  events: EventLog;
  evolution?: import("./evolution.js").EvolutionEngine;
  transports: Map<string, Transport>;
  agentChats: Map<string, Set<string>>;
  questions: QuestionBus;
  /** PiBot-provided callbacks to avoid circular deps */
  promptAgent(t: Transport, chatId: string, agentId: string, text: string): Promise<void>;
  deliverToAgent(agentId: string, text: string): Promise<void>;
  primaryChat(job: Pick<Schedule, "agentId" | "chat">): string | null;
}

export class Delivery {
  private pendingAttend = new Map<string, string>(); // chatKey → attend item id

  constructor(private deps: DeliveryDeps) {}

  ensureAttendPassJob(agentId: string): void {
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

  ensureMorningBriefJob(agent: LoadedAgent): void {
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

  ensureEvolutionJob(agent: LoadedAgent): void {
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

  ensureHeartbeatJob(agent: LoadedAgent): void {
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
    if (job.kind === "attend-pass") {
      const ck = this.deps.primaryChat(job);
      if (ck) {
        const idx = ck.lastIndexOf(":");
        const t = this.deps.transports.get(ck.slice(0, idx));
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
        await this.deps.deliverToAgent(job.agentId, `🧬 Evolution staged **${report.skill}** for your review: ${report.summary}`);
      }
      return;
    }
    this.deps.events.log(job.agentId, "fire", `${job.title} (${job.kind})`);

    if (job.delivery === "agent") {
      const ck = this.deps.primaryChat(job);
      if (ck) {
        const idx = ck.indexOf(":");
        const t = this.deps.transports.get(ck.slice(0, idx));
        if (t) {
          await this.deps.promptAgent(
            t,
            ck.slice(idx + 1),
            job.agentId,
            `[scheduler] It's time for “${job.title}”${job.detail ? ` — ${job.detail}` : ""}. Compose a short, natural message telling the user this is due now${snoozed ? " (it fired during their snooze — acknowledge that lightly)" : ""}.`,
          );
          return;
        }
      }
    }

    const t = this.deps.transports.get(job.chat.transport);
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
      const ck = `${t.name}:${chatId}`;
      this.pendingAttend.set(ck, item.id);
      const bodyText = item.body ? `\n\n${item.body}` : "";
      await this.deps.questions
        .ask(
          agentId,
          { transport: t.name, chatId },
          {
            text: `🧠 (attend · ${item.category}) ${item.title}${bodyText}`,
            options: [],
            timeoutMs: 12 * 3600e3,
          },
        )
        .then(async (res) => {
          if (!res || res.timedOut) return;
          await attendCli(["mark", "--id", item.id, "--status", "answered"]).catch(() => {});
          // record for attend's daily-cap policy
          const rec = {
            ts: new Date().toISOString(),
            item_id: item.id,
            category: item.category,
            channel: "telegram",
            machine: process.env.HOST ?? "local",
            outcome: res.index >= 0 ? "answered" : "answered",
            answer: res.choice,
            counted: true,
          };
          fs.mkdirSync(path.join(os.homedir(), "attend", "state"), { recursive: true });
          fs.appendFileSync(path.join(stateDir, "responses.jsonl"), JSON.stringify(rec) + "\n");
        });
    } catch (e) {
      this.deps.events.log(agentId, "system", `attend pass failed: ${errorMessage(e)}`);
    }
  }
}
