import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const run = promisify(execFile);

export const CATEGORIES = [
  "calendar", "task", "daily-ask", "invoice", "numbers",
  "daily-win", "reflection", "confrontation", "ema",
];

export type Category = (typeof CATEGORIES)[number];

export const ATTEND_CLI = "/opt/homebrew/bin/attend";

export interface AttendItem {
  id: string;
  title: string;
  category: string;
  body?: string;
  due?: string;
  urgency?: string;
  status: string;
}

async function attendCli(args: string[]): Promise<string> {
  return attendCliAt(ATTEND_CLI, args);
}

async function attendCliAt(cli: string, args: string[]): Promise<string> {
  const { stdout } = await run(cli, args, { timeout: 15_000, cwd: "/Users/glebkalinin/ai_projects/attend" });
  return stdout.trim();
}

async function attendJson(args: string[]): Promise<Array<Record<string, unknown>>> {
  const out = await attendCli(args);
  try {
    return JSON.parse(out) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

/**
 * Shared plugin: the attend attention queue (policy-driven question surfacing).
 * Agents can enqueue questions/items and read what's waiting; the actual
 * surfacing policy (max/day, active hours) stays in attend.
 */
export function attendPlugin(deps: { cliPath?: string } = {}): InlineExtension {
  const cli = deps.cliPath ?? ATTEND_CLI;

  return {
    name: "attend",
    factory: (pi) => {
      pi.registerTool({
        name: "attend_list",
        label: "Attend queue",
        description: "List items in the user's attention queue (pending = to be surfaced, surfaced = waiting for an answer). Use to see what questions/decisions are queued for the user.",
        parameters: Type.Object({
          status: Type.Optional(Type.String({ description: "pending,surfaced (default) | answered | all" })),
        }),
        async execute(_tcid, params) {
          const status = params.status ?? "pending,surfaced";
          try {
            const out = await attendCliAt(cli, ["list", "--status", status]);
            const items = (() => { try { return JSON.parse(out) as Array<Record<string, unknown>>; } catch { return []; } })();
            if (!items.length) return { content: [{ type: "text", text: "Attention queue is empty." }], details: { count: 0 } };
            const lines = items.map((i) => `- [${String(i.id).slice(0, 8)}] (${i.category}, ${i.status}) ${String(i.title)}${i.body ? ` — ${String(i.body).slice(0, 100)}` : ""}`);
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: items.length } };
          } catch (e) {
            return { content: [{ type: "text", text: `attend unavailable: ${String(e)}` }], details: { count: 0 } };
          }
        },
      });

      pi.registerTool({
        name: "attend_enqueue",
        label: "Enqueue question",
        description: `Add a question/item to the user's attention queue — it will be surfaced adaptively (max 1/day, active hours 10:00–18:00). Categories: ${CATEGORIES.join(", ")}. Use for things worth asking later, not urgent requests.`,
        parameters: Type.Object({
          title: Type.String({ description: "The question or prompt to surface" }),
          category: Type.String({ description: `One of: ${CATEGORIES.join(", ")}` }),
          body: Type.Optional(Type.String({ description: "Extra context shown with the question" })),
          due: Type.Optional(Type.String({ description: "Due date YYYY-MM-DD" })),
          urgency: Type.Optional(Type.String({ description: "low | normal | high" })),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: Record<string, unknown>;
          if (!CATEGORIES.includes(params.category as Category)) {
            text = `ERROR: category must be one of ${CATEGORIES.join(", ")}.`;
            details = { ok: false };
          } else {
            try {
              const args = ["enqueue", "--title", params.title, "--category", params.category];
              if (params.body) args.push("--body", params.body);
              if (params.due) args.push("--due", params.due);
              if (params.urgency) args.push("--urgency", params.urgency);
              const out = await attendCliAt(cli, args);
              const item = JSON.parse(out) as { id: string; category?: string };
              text = `Enqueued (${item.category ?? params.category}) — will surface adaptively.`;
              details = { id: item.id, ok: true };
            } catch (e) {
              text = `enqueue failed: ${String(e)}`;
              details = { ok: false };
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });

      pi.registerTool({
        name: "attend_mark",
        label: "Mark item",
        description: "Update an attend item's status: answered (the user responded), snoozed (not now), surfaced (shown).",
        parameters: Type.Object({
          id: Type.String({ description: "Item id" }),
          status: Type.String({ description: "pending | surfaced | answered | snoozed" }),
        }),
        async execute(_tcid, params) {
          try {
            await attendCliAt(cli, ["mark", "--id", params.id, "--status", params.status]);
            return { content: [{ type: "text", text: `Marked ${params.status}.` }], details: { ok: true } };
          } catch (e) {
            return { content: [{ type: "text", text: `mark failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });
    },
  };
}

export { attendCli };
