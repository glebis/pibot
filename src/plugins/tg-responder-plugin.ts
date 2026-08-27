import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

const run = promisify(execFile);

export const DEFAULT_RESPONDER_DB = path.join(os.homedir(), "Brains/data/telegram/responder.db");
const CONFIG = path.join(os.homedir(), ".agents/skills/tg-responder/config.yaml");

/** Resolve the responder DB path from tg-responder's config.yaml (db_path key) */
export function resolveResponderDb(explicit?: string): string {
  if (explicit) return explicit.replace("~", os.homedir());
  try {
    const cfg = fs.readFileSync(CONFIG, "utf8");
    const m = cfg.match(/db_path:\s*([^\n]+)/);
    if (m) return m[1].trim().replace("~", os.homedir());
  } catch {
    /* fall through */
  }
  return DEFAULT_RESPONDER_DB;
}

type Row = Record<string, unknown>;

/** Run a query through the sqlite3 CLI (-json). Read-only for SELECTs. */
export async function query(dbPath: string, sql: string): Promise<Row[]> {
  const { stdout } = await run("sqlite3", ["-json", dbPath, sql], { timeout: 10_000 });
  return stdout.trim() ? (JSON.parse(stdout) as Row[]) : [];
}

/** Write path: INSERT (draft rows only — tg-responder owns sending/approval) */
async function exec(dbPath: string, sql: string): Promise<void> {
  await run("sqlite3", [dbPath, sql], { timeout: 10_000 });
}

const AGO = (epochSeconds: number): string => {
  const mins = Math.round((Date.now() / 1000 - epochSeconds) / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export interface TgResponderPluginDeps {
  /** defaults to the path from tg-responder's config.yaml */
  dbPath?: string;
}

/**
 * Shared plugin: bridge to the tg-responder queue (~/Brains/data/telegram/responder.db).
 * pibot READS pending inbox/follow-ups and WRITES drafts for review; tg-responder
 * remains the sole sender/approver — pibot never sends anything directly.
 */
export function tgResponderPlugin(deps: { dbPath?: string } = {}): InlineExtension {
  const dbPath = resolveResponderDb(deps.dbPath);

  return {
    name: "tg-responder",
    factory: (pi) => {
      pi.registerTool({
        name: "inbox_pending",
        label: "Inbox pending",
        description: "Unanswered messages in the user's Telegram responder inbox (who is waiting for a reply). Check this before morning briefs and when the user asks what's pending.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const rows = await query(
              dbPath,
              `SELECT i.id, i.sender_name, i.received_at, i.urgency, i.text,
                      (SELECT o.status FROM outbox o WHERE o.inbox_id = i.id ORDER BY o.id DESC LIMIT 1) AS reply_status
               FROM inbox i
               WHERE i.status NOT IN ('sent','cancelled','dead')
               ORDER BY i.received_at DESC LIMIT 10`
            );
            const pending = rows.filter((r) => r.reply_status !== "sent" && r.reply_status !== "approved");
            if (!pending.length) return { content: [{ type: "text", text: "Inbox clear — nobody is waiting." }], details: { count: 0 } };
            const lines = pending.map((r) => {
              const draft = r.reply_status === "draft" ? " (draft awaiting approval)" : "";
              return `- [${r.id}] ${r.sender_name} — ${AGO(Number(r.received_at))}${r.urgency ? ` (${r.urgency})` : ""}${draft}\n  ${truncate(String(r.text), 140)}`;
            });
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: pending.length } };
          } catch (e) {
            return { content: [{ type: "text", text: `inbox unavailable: ${String(e)}` }], details: { count: 0 } };
          }
        },
      });

      pi.registerTool({
        name: "followups_open",
        label: "Open follow-ups",
        description: "Open follow-up reminders (people the user hasn't heard back from) and contacts overdue per their reply cadence.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const rows = await query(
              dbPath,
              `SELECT sender_name, outbound_at, next_reminder_at, reminder_count, status
               FROM follow_ups WHERE status = 'active' ORDER BY next_reminder_at ASC LIMIT 10`
            );
            if (!rows.length) return { content: [{ type: "text", text: "No open follow-ups." }], details: { count: 0 } };
            const lines = rows.map((r) => {
              const due = Number(r.next_reminder_at) * 1000;
              const overdue = due < Date.now() ? " ⚠︎ overdue" : "";
              return `- ${r.sender_name} — awaiting reply since ${AGO(Number(r.outbound_at))}, reminder ${due < Date.now() ? "due now" : new Date(due).toLocaleDateString()}${overdue}`;
            });
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: rows.length } };
          } catch (e) {
            return { content: [{ type: "text", text: `follow-ups unavailable: ${String(e)}` }], details: { count: 0 } };
          }
        },
      });

      pi.registerTool({
        name: "draft_reply",
        label: "Draft reply",
        description:
          "Write a reply DRAFT for an inbox message. It lands in the responder's review queue — the user approves and sends it there; you never send directly. Keep drafts in the user's voice, short.",
        parameters: Type.Object({
          inboxId: Type.String({ description: "Inbox message id (from inbox_pending)" }),
          text: Type.String({ description: "Draft reply text" }),
        }),
        async execute(_tcid, params) {
          const inboxId = parseInt(params.inboxId, 10);
          if (!Number.isInteger(inboxId)) {
            return { content: [{ type: "text", text: "ERROR: inboxId must be a number." }], details: { ok: false } };
          }
          try {
            const rows = await query(dbPath, `SELECT chat_id FROM inbox WHERE id = ${inboxId}`);
            if (!rows.length) {
              return { content: [{ type: "text", text: `No inbox message ${params.inboxId}.` }], details: { ok: false } };
            }
            const chatId = String(rows[0].chat_id).replace(/'/g, "''");
            const text = params.text.replace(/'/g, "''");
            const now = Math.floor(Date.now() / 1000);
            await exec(
              dbPath,
              `INSERT INTO outbox (inbox_id, chat_id, draft_text, status, source, draft_created_at, created_at, updated_at)
               VALUES (${inboxId}, '${chatId}', '${text}', 'draft', 'pibot', ${now}, datetime('now'), datetime('now'))`
            );
            return {
              content: [{ type: "text", text: `Draft saved for review — the user approves and sends it from the responder flow.` }],
              details: { ok: true },
            };
          } catch (e) {
            return { content: [{ type: "text", text: `draft failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });
    },
  };
}
