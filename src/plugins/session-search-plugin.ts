import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Host-level, not a capability: every agent should be able to search its OWN past
 * conversation transcripts — agents created before this existed get it too, without
 * editing private manifests (mirrors the autoCompactPlugin wiring argument).
 *
 * Privacy and size guards are part of the contract:
 * - the search is strictly read-only and bound to ONE sessions directory (the agent's own);
 * - results are bounded snippets around the match, never whole transcripts;
 * - only user/assistant text is searched — tool results, thinking and media stay out.
 */
export function sessionSearchPlugin(deps: { sessionsDir: string }): InlineExtension {
  return {
    name: "session-search",
    factory: (pi) => {
      pi.registerTool({
        name: "session_search",
        label: "Search own sessions",
        description:
          "Search your OWN past conversation transcripts (all chats of this agent, stored under your sessions directory) for a keyword or phrase that appeared in a user or assistant message. Use it to recover URLs, file names, decisions or promises from earlier conversations. Results are short snippets with the date and role — never whole transcripts. Other agents' sessions are not readable with this.",
        parameters: Type.Object({
          query: Type.String({ description: "Keyword or phrase to look for, case-insensitive. Use the most distinctive word you have." }),
          limit: Type.Optional(Type.Number({ description: "Maximum matches to return (default 8, max 25)." })),
          after: Type.Optional(Type.String({ description: "Only search transcripts started on or after this date, form 'YYYY-MM-DD' or 'YYYY-MM-DDTHH'. Older files are skipped entirely." })),
        }),
        async execute(_tcid, params): Promise<AgentToolResult<SessionSearchDetails>> {
          const query = params.query.trim();
          if (!query) {
            return { content: [{ type: "text", text: "Empty query — pass the word or phrase you remember, e.g. query: 'linkedin'." }], details: { matches: 0 } satisfies SessionSearchDetails };
          }
          const limit = clampLimit(params.limit);
          const after = normalizeAfter(params.after);
          if (params.after?.trim() && after === undefined) {
            return { content: [{ type: "text", text: `'${params.after}' is not a date I can parse — use form 'YYYY-MM-DD' or 'YYYY-MM-DDTHH'.` }], details: { matches: 0 } satisfies SessionSearchDetails };
          }

          const files = sessionFiles(deps.sessionsDir);
          if (!files.length) {
            return { content: [{ type: "text", text: "No past transcripts found in your sessions directory yet." }], details: { matches: 0, transcripts: 0 } satisfies SessionSearchDetails };
          }

          // chat labels from this agent's own index (chatKey → session file basename)
          const chatByFile = chatIndex(deps.sessionsDir);
          const needle = query.toLowerCase();
          const lines: string[] = [];

          let total = 0;
          let transcriptsSearched = 0;

          for (const file of files) {
            if (after) {
              const started = startedAt(file.name);
              if (started && started < after) continue;
            }
            const hits = searchFile(file.path, needle);
            if (!hits.length) continue;
            transcriptsSearched++;
            const chat = chatByFile[file.name];
            const label = [file.date, chat ? `chat ${chat}` : undefined].filter(Boolean).join(" · ");
            for (const hit of hits) {
              total++;
              if (lines.length < limit) {
                lines.push(`- ${label}\n  ${hit.role}: ${snippet(hit.text, needle)}`);
              }
            }
          }

          if (!total) {
            return {
              content: [{ type: "text", text: `No transcripts of yours contain "${query}".${after ? ` (Only files started on or after ${after} were searched.)` : ""}` }],
              details: { matches: 0, transcripts: files.length } satisfies SessionSearchDetails,
            };
          }
          const truncated = total > lines.length ? `\n(+${total - lines.length} more — raise limit up to 25 or use a more distinctive keyword)` : "";
          return {
            content: [{ type: "text", text: `Searched your own transcripts for "${query}":\n${lines.join("\n")}${truncated}` }],
            details: {
              query,
              matches: total,
              shown: lines.length,
              transcripts: transcriptsSearched,
            } satisfies SessionSearchDetails,
          };
        },
      });
    },
  };
}

interface SessionFile { name: string; path: string; date: string }

/** Every return path reports one details shape so the SDK tool generic stays stable. */
interface SessionSearchDetails { matches: number; transcripts?: number; query?: string; shown?: number }

function sessionFiles(sessionsDir: string): SessionFile[] {
  if (!fs.existsSync(sessionsDir)) return [];
  const names = fs.readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl") && name !== "index.json");
  // newest first: recent conversations are the likeliest recall target
  return names.sort().reverse().map((name) => ({
    name,
    path: path.join(sessionsDir, name),
    date: startedAt(name)?.slice(0, 10) ?? "unknown",
  }));
}

/** 'YYYY-MM-DDTHH-MM-SS-…' → 'YYYY-MM-DDTHH' (comparable against the `after` param). */
function startedAt(name: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-\d{2}/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}` : undefined;
}

function normalizeAfter(after?: string): string | undefined {
  if (!after) return undefined;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(after.trim());
  return dateOnly ? dateOnly[1] : undefined; // day granularity keeps comparability simple
}

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return 8;
  return Math.min(Math.floor(limit), 25);
}

function chatIndex(sessionsDir: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(sessionsDir, "index.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    const byBase: Record<string, string> = {};
    for (const [chatKey, file] of Object.entries(parsed)) {
      const base = typeof file === "string" ? path.basename(file) : "";
      if (base) byBase[base] = chatKey;
    }
    return byBase;
  } catch {
    return {};
  }
}

interface TextHit { role: "user" | "assistant"; text: string }

/** Only user/assistant TEXT is searchable: tool results, thinking and media stay out. */
function searchFile(filePath: string, needleLower: string): TextHit[] {
  let raw: string;
  const maxScan = 20 * 1024 * 1024;
  try {
    const size = fs.statSync(filePath).size;
    if (size > maxScan) raw = "";
    else raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const hits: TextHit[] = [];
  for (const line of raw.split("\n")) {
    if (!line || !line.toLowerCase().includes(needleLower)) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (record.type !== "message") continue;
    const role = record.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    for (const text of messageTexts(record.message?.content)) {
      if (text.toLowerCase().includes(needleLower)) hits.push({ role, text });
    }
  }
  return hits;
}

/** message.content may be a plain string or an array of blocks; only text blocks count. */
function messageTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: string; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text);
}

const SNIPPET_WIDTH = 90;

/** Bounded window around the FIRST match of the message — never the whole transcript. */
export function snippet(text: string, needleLower: string, width = SNIPPET_WIDTH): string {
  const idx = text.toLowerCase().indexOf(needleLower);
  if (idx < 0) return "";
  const start = Math.max(0, idx - width);
  const end = Math.min(text.length, idx + needleLower.length + width);
  const lead = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${lead}${body}${tail}`;
}
