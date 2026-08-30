import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, uid } from "./util.js";

/**
 * Persistent improvement backlog (ported from Ouroboros's improvement_backlog.py).
 *
 * One plain markdown file per agent: `memory/improvement-backlog.md`. Items are
 * `### id` blocks with `- key: value` fields. Core semantics, kept intact:
 * - recurrence is counted IN PLACE (a repeated candidate bumps count + last_seen,
 *   it is never dropped as a duplicate);
 * - deduplication by stable fingerprint applies among OPEN items only;
 * - ranking is priority → recurrence → recency;
 * - the backlog is ADVISORY — only a gated evolution cycle may implement items.
 */

export interface BacklogItem {
  id: string;
  status: string;
  priority: string;
  summary: string;
  source?: string;
  count: number;
  created_at: string;
  last_seen: string;
  fingerprint: string;
  /** any extra keys the entry carries, preserved losslessly */
  extra: Record<string, string>;
}

const PRIORITIES = ["high", "med", "low"] as const;

const HEADER = `# Improvement backlog

Durable, deduplicated list of self-improvement candidates. Advisory only:
implementation happens through a gated evolution cycle, never directly.
A repeating irritation should be noted here instead of living in transient events.
`;

export function backlogFile(agentDir: string): string {
  return path.join(agentDir, "memory", "improvement-backlog.md");
}

/** Creates the backlog file with its policy header when missing. Returns the path. */
export function ensureBacklogFile(agentDir: string): string {
  const file = backlogFile(agentDir);
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
  return file;
}

/** Stable dedup key: normalized summary + (optional source/category). */
export function backlogFingerprint(summary: string, category = "", source = ""): string {
  const key = [summary, category, source].map((v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase()).join(" | ");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Parses `### id` blocks with `- key: value` fields. Unrecognized keys survive in `extra`. */
export function parseBacklogItems(text: string): BacklogItem[] {
  const items: BacklogItem[] = [];
  let current: BacklogItem | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("### ")) {
      if (current) items.push(current);
      current = emptyItem(line.slice(4).trim());
      continue;
    }
    if (!current) continue;
    if (line.startsWith("- ") && line.includes(": ")) {
      const key = line.slice(2, line.indexOf(": ")).trim();
      const value = line.slice(line.indexOf(": ") + 2).trim();
      if (key === "count") {
        const n = Number(value);
        if (Number.isFinite(n)) current.count = n;
      } else if (["status", "priority", "summary", "source", "created_at", "last_seen", "fingerprint"].includes(key)) {
        (current as unknown as Record<string, string>)[key] = value;
      } else {
        current.extra[key] = value;
      }
    }
  }
  if (current) items.push(current);
  return items.filter((i) => i.id && i.summary);
}

function emptyItem(id: string): BacklogItem {
  return { id, status: "open", priority: "med", summary: "", count: 1, created_at: new Date().toISOString(), last_seen: new Date().toISOString(), fingerprint: "", extra: {} };
}

export function loadBacklogItems(agentDir: string): BacklogItem[] {
  const file = backlogFile(agentDir);
  try {
    return parseBacklogItems(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function prioritize(p: string | undefined): "high" | "med" | "low" {
  const s = String(p ?? "").toLowerCase();
  return s === "high" || s === "low" ? s : "med";
}

function serializeItem(i: BacklogItem): string {
  const lines = [`### ${i.id}`];
  const push = (k: string, v: string | number) => lines.push(`- ${k}: ${v}`);
  push("status", i.status);
  push("priority", i.priority);
  push("summary", i.summary);
  if (i.source) push("source", i.source);
  push("count", i.count);
  push("created_at", i.created_at);
  push("last_seen", i.last_seen);
  push("fingerprint", i.fingerprint);
  for (const [k, v] of Object.entries(i.extra)) push(k, v);
  lines.push("");
  return lines.join("\n");
}

function serializeAll(items: BacklogItem[]): string {
  return HEADER + "\n" + items.map(serializeItem).join("\n");
}

export interface BacklogCandidate {
  summary: string;
  priority?: string;
  source?: string;
  extra?: Record<string, string>;
}

/**
 * Appends candidates with open-item deduplication: a matching fingerprint bumps
 * `count` and refreshes `last_seen`; otherwise a new item is appended.
 * Returns the number of NEW items added.
 */
export function appendBacklogItems(agentDir: string, candidates: BacklogCandidate[], now = new Date().toISOString()): number {
  ensureBacklogFile(agentDir);
  const items = loadBacklogItems(agentDir);
  let added = 0;
  for (const c of candidates) {
    const summary = String(c.summary ?? "").trim();
    if (!summary) continue;
    const source = String(c.source ?? "").trim();
    const fingerprint = backlogFingerprint(summary, c.extra?.category ?? "", source);
    const open = items.find((i) => i.status === "open" && i.fingerprint === fingerprint);
    if (open) {
      open.count += 1;
      open.last_seen = now;
      continue;
    }
    items.push({
      id: uid("bl", 6),
      status: "open",
      priority: prioritize(c.priority),
      summary,
      source: source || undefined,
      count: 1,
      created_at: now,
      last_seen: now,
      fingerprint,
      extra: { ...(c.extra ?? {}) },
    });
    added += 1;
  }
  fs.writeFileSync(backlogFile(agentDir), serializeAll(items));
  return added;
}

/** Marks open items done by id. Returns the number closed. */
export function closeBacklogItems(agentDir: string, ids: string[]): number {
  const items = loadBacklogItems(agentDir);
  const want = new Set(ids.map(String));
  let closed = 0;
  for (const i of items) {
    if (i.status === "open" && want.has(i.id)) {
      i.status = "done";
      closed += 1;
    }
  }
  if (closed > 0) fs.writeFileSync(backlogFile(agentDir), serializeAll(items));
  return closed;
}

function priorityRank(p: string): number {
  return p === "high" ? 0 : p === "low" ? 2 : 1;
}

function rankOpen(items: BacklogItem[]): BacklogItem[] {
  return items
    .filter((i) => i.status === "open")
    .sort((a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      b.count - a.count ||
      (Date.parse(b.last_seen) || 0) - (Date.parse(a.last_seen) || 0)
    );
}

/** Highest-ranked open backlog item — what a goal-less evolution cycle should target. */
export function topBacklogItem(agentDir: string): BacklogItem | null {
  return rankOpen(loadBacklogItems(agentDir))[0] ?? null;
}

export interface BacklogDigestOpts {
  limit?: number;
  maxChars?: number;
}

/** Ranked digest for context injection (both heartbeat ticks and evolution cycles). */
export function formatBacklogDigest(agentDir: string, opts: BacklogDigestOpts = {}): string {
  const open = rankOpen(loadBacklogItems(agentDir));
  if (!open.length) return "";
  const limit = Math.max(1, opts.limit ?? 5);
  const visible = open.slice(0, limit);
  const lines = [
    "## Improvement backlog (advisory — implement via a gated evolution cycle, never directly)",
    `- open_items: ${open.length}`,
  ];
  for (const i of visible) {
    const bits = [`[${i.id}]`, i.summary];
    const meta = [`priority=${i.priority}`];
    if (i.count > 1) meta.push(`count=${i.count}`);
    if (i.source) meta.push(`source=${i.source}`);
    lines.push(`- ${bits.join(" ")} (${meta.join(", ")})`);
  }
  const omitted = open.length - visible.length;
  if (omitted > 0) lines.push(`- ⚠️ OMISSION NOTE: ${omitted} more open items not shown`);
  let text = lines.join("\n");
  const maxChars = opts.maxChars ?? 2500;
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n⚠️ OMISSION NOTE: backlog digest truncated at ${maxChars} chars`;
  return text;
}

/**
 * Deterministic prune: keeps at most `cap` ranked open items (drops the lowest).
 * Done items are not counted and never dropped here. Returns items removed.
 */
export function pruneBacklog(agentDir: string, cap = 30): number {
  const all = loadBacklogItems(agentDir);
  const done = all.filter((i) => i.status !== "open");
  const open = rankOpen(all);
  if (open.length <= cap) return 0;
  const kept = open.slice(0, cap);
  const removedIds = new Set(open.slice(cap).map((i) => i.id));
  fs.writeFileSync(backlogFile(agentDir), serializeAll([...kept, ...done]));
  return removedIds.size;
}