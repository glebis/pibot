import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Scheduler } from "../core/scheduler.js";
import type { ChatRef } from "../core/types.js";
import { fmtWhen, nextQuietEnd, parseDuration, parseWhen, uid } from "../core/util.js";

export interface SchedulerPluginDeps {
  scheduler: Scheduler;
  agentId: string;
  /** chat that owns the session this plugin instance is bound to */
  chat: ChatRef;
  /** the agent's quiet hours — night snoozes are capped at the wake time */
  getQuietHours?: () => { from: string; to: string } | undefined;
}

const KINDS = `one of: reminder (ping me), task (something I must do), note (capture this later), subject (recurring topic to think about), custom`;

/**
 * Shared plugin: schedule_create / schedule_list / schedule_cancel / snooze tools.
 * Created jobs are auto-confirmed; the host renders an adjustment card
 * (✅ / +10m / +1h / Cancel) right after the agent's turn.
 */
export function schedulerPlugin(deps: SchedulerPluginDeps): InlineExtension {
  const { scheduler, agentId, chat } = deps;

  return {
    name: "scheduler",
    factory: (pi) => {
      pi.registerTool({
        name: "schedule_create",
        label: "Schedule",
        description: [
          `Schedule a future event: reminders, tasks, notes to take, subjects to revisit, anything.`,
          `"when" accepts natural language: "in 20m", "2h30m", "at 18:00", "tomorrow 9am", "daily at 08:00", "every 2h", "hourly", "friday 18:00".`,
          `Scheduling is immediate — no user confirmation needed. Use wake:"important" only for hard commitments (deadlines, meds).`,
        ].join(" "),
        parameters: Type.Object({
          title: Type.String({ description: "Short title of the item, e.g. 'stretch break' or 'take meds'" }),
          when: Type.String({ description: 'When it should fire. Examples: "in 20m", "tomorrow 9am", "daily at 08:00", "every 2h", "friday 18:00"' }),
          kind: Type.Optional(Type.String({ description: KINDS })),
          detail: Type.Optional(Type.String({ description: "Optional extra context included when it fires" })),
          wake: Type.Optional(Type.String({ description: '"normal" (default) or "important" — important fires even when the user snoozed everything' })),
          delivery: Type.Optional(Type.String({ description: '"direct" (default, quick ping) or "agent" (you compose the message when it fires)' })),
        }),
        async execute(_toolCallId, params) {
          const parsed = parseWhen(params.when);
          let text: string;
          let details: { scheduleId: string; dueAt: number };
          if (!parsed) {
            text = `ERROR: could not understand when "${params.when}". Ask the user for a clearer time.`;
            details = { scheduleId: "", dueAt: 0 };
          } else {
            try {
              const wake = params.wake === "important" ? "important" : "normal";
              const delivery = params.delivery === "agent" ? "agent" : "direct";
              const kind = (params.kind as never) ?? "reminder";
              const job = scheduler.create({
                agentId,
                chat,
                title: params.title,
                detail: params.detail,
                kind,
                dueAt: parsed.dueAt,
                repeat: parsed.repeat,
                wake,
                delivery,
                cardPending: !jobIsInternal(kind),
              });
              const when = fmtWhen(job.dueAt) + (job.repeat ? " ↻" : "");
              text = `Scheduled ✅ "${job.title}" fires ${when} (id ${job.id})${wake === "important" ? ", pierces snooze" : ""}`;
              details = { scheduleId: job.id, dueAt: job.dueAt };
            } catch (error) {
              text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
              details = { scheduleId: "", dueAt: 0 };
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });

      pi.registerTool({
        name: "promise_make",
        label: "Make promise",
        description: [
          `Track a commitment ("I'll send the report by Friday", "gym 3x this week").`,
          `Creates the promise (fires at the deadline — you compose a keep-or-broken message) plus an automatic pre-check before the deadline where you ask the user if they're on track and offer help.`,
          `Use calendar_today first if the deadline is tight. Mark kept with promise_keep when fulfilled.`,
        ].join(" "),
        parameters: Type.Object({
          title: Type.String({ description: 'The commitment, e.g. "send invoice to Anna"' }),
          deadline: Type.String({ description: 'When it must be done: "friday 18:00", "tomorrow", "in 3d"' }),
          detail: Type.Optional(Type.String({ description: "Context: who, what exactly, how to verify it's done" })),
        }),
        async execute(_tcid, params) {
          const parsed = parseWhen(params.deadline);
          let text: string;
          let details: { groupId: string; promiseId: string };
          if (!parsed) {
            text = `ERROR: could not understand deadline "${params.deadline}".`;
            details = { groupId: "", promiseId: "" };
          } else {
            // pre-check: 24h before, or midway if that's already past
            let preCheck = parsed.dueAt - 86400e3;
            if (preCheck <= Date.now()) preCheck = Date.now() + Math.max(5 * 60e3, (parsed.dueAt - Date.now()) / 2);
            const neededSlots = preCheck < parsed.dueAt ? 2 : 1;
            try {
              scheduler.assertCapacity(agentId, neededSlots);
              const groupId = uid("pr", 6);
              const promise = scheduler.create({
                agentId,
                chat,
                title: params.title,
                detail: params.detail,
                kind: "promise",
                dueAt: parsed.dueAt,
                repeat: parsed.repeat,
                wake: "important",
                delivery: "agent",
                groupId,
                cardPending: true,
              });
              if (preCheck < promise.dueAt) {
                scheduler.create({
                  agentId,
                  chat,
                  title: `pre-check: ${params.title}`,
                  detail: `A promise is due ${fmtWhen(promise.dueAt)}. Check in with the user: are they on track? Offer help, don't nag.`,
                  kind: "promise",
                  dueAt: preCheck,
                  wake: "normal",
                  delivery: "agent",
                  groupId,
                  cardPending: false,
                });
              }
              text = `Promise tracked ✅ "${params.title}" — due ${fmtWhen(promise.dueAt)}, I'll pre-check ${fmtWhen(preCheck)} (id ${promise.id})`;
              details = { groupId, promiseId: promise.id };
            } catch (error) {
              text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
              details = { groupId: "", promiseId: "" };
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });

      pi.registerTool({
        name: "promise_keep",
        label: "Keep promise",
        description: "Mark a promise as fulfilled — removes it and its pre-check.",
        parameters: Type.Object({
          id: Type.String({ description: "Promise id (from promise_make or schedule_list)" }),
          note: Type.Optional(Type.String({ description: "How it was fulfilled" })),
        }),
        async execute(_tcid, params) {
          const job = scheduler.get(params.id);
          if (!job || !job.groupId) {
            const c = scheduler.cancel(params.id);
            return { content: [{ type: "text", text: c ? "Removed." : "No promise matches that id." }], details: {} };
          }
          let n = 0;
          for (const j of scheduler.list(agentId)) {
            if (j.groupId === job.groupId) {
              scheduler.cancel(j.id);
              n++;
            }
          }
          return { content: [{ type: "text", text: `Promise kept 🎉${params.note ? ` (${params.note})` : ""} — removed ${n} item(s).` }], details: {} };
        },
      });

      pi.registerTool({
        name: "schedule_list",
        label: "List schedule",
        description: "List your pending scheduled items, soonest first.",
        parameters: Type.Object({}),
        async execute() {
          const jobs = scheduler.list(agentId, { includePaused: true }).filter((j) => !j.internal);
          if (!jobs.length) {
            return { content: [{ type: "text", text: "Nothing scheduled." }], details: {} };
          }
          const lines = jobs.slice(0, 30).map(
            (j) => `- [${j.id}]${j.status === "paused" ? " PAUSED" : ""} ${j.title} — ${fmtWhen(j.dueAt)}${j.repeat ? " ↻" : ""}${j.wake === "important" ? " (!)" : ""}${j.detail ? ` — ${j.detail}` : ""}${j.status === "paused" && j.lastDeliveryError ? ` — last error: ${j.lastDeliveryError}` : ""}`
          );
          return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
        },
      });

      pi.registerTool({
        name: "schedule_resume",
        label: "Resume schedule",
        description: "Resume an automatically paused schedule after its delivery problem has been fixed.",
        parameters: Type.Object({
          id: Type.String({ description: "Paused schedule id, prefixes allowed" }),
        }),
        async execute(_tcid, params) {
          const job = scheduler.resume(params.id);
          if (!job) return { content: [{ type: "text", text: `No paused schedule matching "${params.id}".` }], details: {} };
          return { content: [{ type: "text", text: `Resumed "${job.title}" (${job.id}).` }], details: {} };
        },
      });

      pi.registerTool({
        name: "schedule_cancel",
        label: "Cancel schedule",
        description: "Cancel a scheduled item by id (see schedule_list).",
        parameters: Type.Object({
          id: Type.String({ description: "Schedule id, prefixes allowed" }),
        }),
        async execute(_tcid, params) {
          const job = scheduler.cancel(params.id);
          if (!job) return { content: [{ type: "text", text: `No pending schedule matching "${params.id}".` }], details: {} };
          return { content: [{ type: "text", text: `Cancelled "${job.title}" (${job.id}).` }], details: {} };
        },
      });

      pi.registerTool({
        name: "snooze",
        label: "Snooze rhythm",
        description: [
          `Snooze EVERYTHING: the heartbeat rhythm and all normal scheduled items pause until the time passes.`,
          `Use when the user asks to snooze / pause / go quiet. "important" items still fire.`,
        ].join(" "),
        parameters: Type.Object({
          duration: Type.String({ description: 'How long to snooze, e.g. "2h", "until tomorrow", "30m", "evening"' }),
          reason: Type.Optional(Type.String({ description: "Optional reason, e.g. 'focus block', 'sleeping'" })),
        }),
        async execute(_tcid, params) {
          let until = parseDuration(params.duration);
          let whenText = params.duration;
          if (until == null) {
            const parsed = parseWhen(params.duration.replace(/^until\s+/, "in ").replace(/^tomorrow$/, "tomorrow 09:00"));
            if (!parsed) {
              return { content: [{ type: "text", text: `ERROR: could not understand snooze duration "${params.duration}".` }], details: {} };
            }
            until = parsed.dueAt;
          }
          const quietEnd = nextQuietEnd(deps.getQuietHours?.());
          const st = scheduler.snooze(agentId, Date.now() + until, params.reason, quietEnd ?? undefined);
          return {
            content: [{ type: "text", text: `Snoozed everything until ${fmtWhen(st.until)}${params.reason ? ` (${params.reason})` : ""}. Important items still come through.` }],
            details: {},
          };
        },
      });
    },
  };
}

function jobIsInternal(kind: string): boolean {
  return kind === "heartbeat";
}
