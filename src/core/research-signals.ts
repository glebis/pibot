// ─── Research-signals panel: metadata-only heartbeat fuel ─────────────────────
// Surfaces what the owner recently RESEARCHED (Codex sessions, vault research
// notes) so the heartbeat can suggest the next research subject. Metadata only:
// session counts, first-user-message topics, note titles — redacted, never
// transcript bodies. Read-only; no external calls; manifest-gated (research.signals).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactEventSummary } from "./events.js";

const DAY = 86_400e3;
/** Rescan at most every 30 minutes — heartbeat ticks are minutes apart. */
const CACHE_TTL_MS = 30 * 60e3;

export interface ResearchSignalsOpts {
  vaultDir?: string;
  /** defaults to $CODEX_HOME or ~/.codex */
  codexHome?: string;
  now?: number;
  windowDays?: number;
  maxCodex?: number;
  maxVault?: number;
}

/** Cached panel + the bucket it was built for (invalidated when the window slides). */
let cache: { at: number; windowDays: number; panel: string } | null = null;

export function clearSignalsCache(): void {
  cache = null;
}

/** Pure: codex session rollout files within the window, newest first. */
export function recentCodexSessions(codexHome: string, now: number, windowDays: number): string[] {
  const out: Array<{ path: string; ts: number }> = [];
  const since = now - windowDays * DAY;
  const root = path.join(codexHome, "sessions");
  if (!fs.existsSync(root)) return [];
  for (const year of fs.readdirSync(root)) {
    const yearDir = path.join(root, year);
    if (!/^\d{4}$/.test(year) || !fs.existsSync(yearDir)) continue;
    for (const month of fs.readdirSync(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!/^\d{2}$/.test(month) || !fs.existsSync(monthDir)) continue;
      for (const day of fs.readdirSync(monthDir)) {
        const dayDir = path.join(monthDir, day);
        if (!/^\d{2}$/.test(day) || !fs.existsSync(dayDir)) continue;
        let files: string[];
        try {
          files = fs.readdirSync(dayDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const f of files) {
          // filenames carry the timestamp: rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl
          const m = f.match(/rollout-(\d{4})-(\d{2})-(\d{2})/);
          if (!m) continue;
          const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
          if (Number.isNaN(ts) || ts < since - DAY) continue;
          out.push({ path: path.join(dayDir, f), ts });
        }
      }
    }
  }
  return out.sort((a, b) => b.ts - a.ts).map((e) => e.path);
}

/** First user topic of a rollout: skip meta/instruction preambles, take the first
 *  real user text, bounded. Metadata only — at most ~64KB read per file. */
export function codexSessionTopic(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> } };
        if (e.type !== "response_item" || e.payload?.type !== "message" || e.payload?.role !== "user") continue;
        const text = (e.payload.content ?? []).map((c) => c.text ?? "").join(" ").trim();
        if (!text || text.startsWith("<user_instructions>") || text.startsWith("<environment_context>") || text.startsWith("<user_info>")) continue;
        return truncateLine(text);
      } catch {
        continue; // not JSON — skip the line
      }
    }
    return undefined;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function truncateLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

function recentVaultNotes(vaultDir: string, now: number, windowDays: number, max: number): Array<{ title: string; ts: number }> {
  const since = now - windowDays * DAY;
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(vaultDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Array<{ title: string; ts: number }> = [];
  for (const f of files) {
    try {
      const ts = fs.statSync(path.join(vaultDir, f.name)).mtimeMs;
      if (ts >= since) out.push({ title: f.name.replace(/\.md$/, ""), ts });
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, max);
}

export function buildResearchSignals(opts: ResearchSignalsOpts = {}): string {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? 7;
  const maxCodex = opts.maxCodex ?? 5;
  const maxVault = opts.maxVault ?? 5;

  // rescan at most every CACHE_TTL within the same window size
  if (cache && now - cache.at < CACHE_TTL_MS && cache.windowDays === windowDays) return cache.panel;

  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sessions = recentCodexSessions(codexHome, now, windowDays);
  const topics: string[] = [];
  for (const file of sessions.slice(0, maxCodex * 4)) {
    if (topics.length >= maxCodex) break;
    const topic = codexSessionTopic(file);
    if (topic) topics.push(redactEventSummary(truncateLine(topic)));
  }

  const vaultDir = opts.vaultDir;
  const notes = vaultDir ? recentVaultNotes(vaultDir, now, windowDays, maxVault) : [];

  const lines: string[] = [];
  if (sessions.length || topics.length) {
    lines.push(`- Codex: ${sessions.length} sessions in the last ${windowDays}d${topics.length ? ` · topics: ${topics.map((t) => `"${t}"`).join("; ")}` : ""}`);
  }
  if (notes.length) {
    lines.push(`- Vault: ${notes.length} changed notes${notes.length ? ` · titles: ${notes.map((n) => n.title).join("; ")}` : ""}`);
  }
  if (!lines.length) {
    const panel = "";
    cache = { at: now, windowDays, panel };
    return panel;
  }
  const panel = [
    `# Research signals (last ${windowDays}d — metadata only: session counts, first-message topics, note titles)`,
    ...lines,
  ].join("\n");
  cache = { at: now, windowDays, panel };
  return panel;
}