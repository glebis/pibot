import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LedgerEntry, TaskLedger } from "../durable/task-ledger.js";
import type { ChatRef } from "../core/types.js";
import { fmtWhen } from "../core/util.js";

export interface TasksPluginDeps {
  ledger: TaskLedger;
  agentId: string;
  /** owner chat this session serves; task results are posted back here */
  chat: ChatRef;
}

function line(t: LedgerEntry): string {
  const tail = t.status === "done" ? ` — ${t.result?.slice(0, 160) ?? ""}`
    : t.status === "failed" || t.status === "partial" ? ` — ${t.error?.slice(0, 160) ?? t.blocker?.slice(0, 160) ?? ""}`
    : t.status === "blocked" ? ` — blocked: ${t.blocker?.slice(0, 160) ?? ""}`
    : "";
  return `${t.id} [${t.status}] "${t.title}" (started ${fmtWhen(t.createdAt)})${tail}`;
}

/**
 * Durable background tasks: start_task / task_status / list_tasks / cancel_task.
 * The work runs as a separate turn of this agent (own session, full tools) on a
 * pi-durable ledger that survives restarts; the result is posted to this chat.
 */
export function tasksPlugin(deps: TasksPluginDeps): InlineExtension {
  const { ledger, agentId, chat } = deps;
  const chatKey = `${chat.transport}:${chat.chatId}`;
  const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

  return {
    name: "tasks",
    factory: (pi) => {
      pi.registerTool({
        name: "start_task",
        label: "Start task",
        description: "Start a background task that runs on its own (minutes, with your tools) and posts its result to this chat when done. Use for work that takes longer than a quick reply — research, drafting, multi-step tool work. Give self-contained instructions: the task does not see this conversation.",
        parameters: Type.Object({
          title: Type.String({ description: "Short title the owner will recognise, e.g. 'summarise this week's notes'" }),
          instructions: Type.String({ description: "Self-contained instructions with all needed context from this conversation" }),
          timeoutMinutes: Type.Optional(Type.Number({ description: "Hard runtime cap in minutes for this task (default 30, max 480). Set higher for long local media work — a two-hour video transcription needs ~90; fetching + transcribing media counts inside the cap." })),
          expectedMedia: Type.Optional(Type.String({ description: "Set ONLY when the owner explicitly requested one specific medium for the task output (e.g. 'video_note' for a Telegram video note). Then the task completes only when the actually delivered media matches; a mismatch records 'partial', not 'done'." })),
        }),
        async execute(toolCallId, params) {
          try {
            const timeoutMinutes = params.timeoutMinutes && Number.isFinite(params.timeoutMinutes)
              ? Math.max(1, Math.min(480, Math.round(params.timeoutMinutes)))
              : undefined;
            // pi-durable stores strict JSON: omit the key entirely when unset
            const cap = timeoutMinutes !== undefined ? { timeoutMinutes } : {};
            const expected = params.expectedMedia ? { expectedMedia: params.expectedMedia.slice(0, 40) } : {};
            const t = await ledger.start({ agentId, chatKey, title: params.title.slice(0, 120), instructions: params.instructions.slice(0, 8000), ...cap, ...expected }, `${agentId}:${toolCallId}`);
            return text(`Started task ${t.id} "${t.title}". It runs in the background; the result will be posted to this chat. Check it with task_status.`, { taskId: t.id });
          } catch (error) {
            return text(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });
      pi.registerTool({
        name: "task_status",
        label: "Task status",
        description: "Status and result of one background task by id.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, params) {
          const t = await ledger.get(params.id);
          if (!t || t.agentId !== agentId) return text(`No task ${params.id} for this agent.`);
          const body = t.status === "done" ? `\n\nResult:\n${t.result}`
            : t.status === "failed" || t.status === "partial" ? `\n\nError: ${t.error ?? t.blocker ?? ""}`
            : t.status === "blocked" ? `\n\nBlocker: ${t.blocker ?? ""}`
            : "";
          const receipt = t.delivery ? `\n\nDelivery: ${t.delivery.mediaType ?? "text"}${t.delivery.messageId !== undefined ? ` (message ${t.delivery.messageId})` : ""}` : "";
          return text(`${line(t)}; attempts ${t.attempts}${body}${receipt}`, { status: t.status });
        },
      });
      pi.registerTool({
        name: "list_tasks",
        label: "List tasks",
        description: "List this chat's background tasks, newest first (running ones and recent results).",
        parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "default 10" })) }),
        async execute(_id, params) {
          const all = await ledger.list({ agentId, chatKey });
          if (!all.length) return text("No background tasks yet.");
          return text(all.slice(0, Math.max(1, Math.min(30, params.limit ?? 10))).map(line).join("\n"));
        },
      });
      pi.registerTool({
        name: "cancel_task",
        label: "Cancel task",
        description: "Cancel a queued or running background task by id.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, params) {
          const t = await ledger.get(params.id);
          if (!t || t.agentId !== agentId) return text(`No task ${params.id} for this agent.`);
          return text((await ledger.cancel(params.id)) ? `Cancelling task ${t.id} "${t.title}".` : `Task ${t.id} is already ${t.status}.`);
        },
      });
    },
  };
}
