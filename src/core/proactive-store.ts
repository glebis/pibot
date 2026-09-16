// ─── Proactive analytics store: measurable commitments + metadata-only events ──
// Runtime-private (data/proactive/, gitignored, 0600). Metadata only per the
// privacy rules of pibot-4ji: no message bodies, opaque correlation ids,
// commitment previews ≤160 chars, 90-day event retention.

import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, truncate, uid, writeJsonAtomic } from "./util.js";
import { parseWhen, type ParsedWhen } from "./util.js";

export const COMMITMENT_PREVIEW_MAX = 160;
export const EVENT_RETENTION_MS = 90 * 86_400e3;
/** A delivered proactive message with no seen within this window counts as ignored. */
export const IGNORE_WINDOW_MS = 48 * 3600e3;

export type CommitmentOrigin = "explicit" | "inferred";

export type CommitmentStatus =
  | "proposed" // inferred capture, awaiting owner confirmation
  | "active" // in the follow-through loop
  | "completed" // Done ✓ at deadline
  | "missed" // Not yet at deadline
  | "renegotiated" // owner pushed the deadline; successor commitment carries the loop
  | "dismissed" // owner rejected a proposed capture
  | "cancelled"; // explicit cancel

export interface Commitment {
  id: string;
  agentId: string;
  chat: { transport: string; chatId: string };
  text: string;
  dueAt: number;
  origin: CommitmentOrigin;
  status: CommitmentStatus;
  createdAt: number;
  confirmedAt?: number;
  closedAt?: number;
  /** 👍/👎 tap on the loop's final message */
  rating?: "up" | "down";
  /** a blocked follow-up was already sent (capped at one) */
  blockedFollowUp?: boolean;
  /** scheduler groupId of this commitment's jobs */
  groupId?: string;
}

export type ProactiveLoop = "pilot" | "heartbeat";

export type ProactiveStage =
  | "proposed" // inferred capture awaiting confirmation
  | "confirmed"
  | "delivered"
  | "seen"
  | "acted"
  | "skipped"
  | "dismissed"
  | "ignored";

export interface ProactiveEvent {
  ts: number;
  /** opaque correlation id — carries no content */
  id: string;
  commitmentId?: string;
  agentId: string;
  loop: ProactiveLoop;
  stage: ProactiveStage;
  /** short machine token, e.g. "precheck:block", "deadline:done", "budget:over" */
  outcome?: string;
  channel?: "telegram" | "web";
}

export interface CommitmentFilter {
  agentId?: string;
  origin?: CommitmentOrigin;
  status?: CommitmentStatus;
  since?: number;
}

export interface EventFilter {
  agentId?: string;
  loop?: ProactiveLoop;
  since?: number;
  commitmentId?: string;
}

export interface Summary {
  delivered: number;
  seenPct: number;
  actedPct: number;
  /** completed / (completed + missed) over closed commitments, % */
  completedPct: number;
  /** share of ratings that are 👍 (of rated commitments), % */
  helpfulPct: number;
  /** (ignored + dismissed + 👎 ratings) / delivered, % */
  noisePct: number;
  ignored: number;
  explicitCount: number;
  inferredCount: number;
  /** confirmed inferred captures / proposed inferred captures, % */
  confirmRate: number;
  byStage: Record<string, number>;
}

const PRUNE_CHECK_EVERY = 200;

export class ProactiveStore {
  private dir: string;
  private commitmentList: Commitment[];
  private appendsSincePrune = 0;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "proactive");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.dir, 0o700);
    } catch {
      /* best effort */
    }
    this.commitmentList = readJson<Commitment[]>(path.join(this.dir, "commitments.json"), []);
    this.prune();
  }

  // ── commitments ───────────────────────────────────────────────────────────

  createCommitment(
    c: Omit<Commitment, "id" | "createdAt" | "status"> & { status?: CommitmentStatus; id?: string; createdAt?: number }
  ): Commitment {
    const full: Commitment = {
      status: "active",
      ...c,
      id: c.id ?? uid("cm", 6),
      createdAt: c.createdAt ?? Date.now(),
      text: truncate(c.text.trim(), COMMITMENT_PREVIEW_MAX),
    };
    this.commitmentList.push(full);
    this.saveCommitments();
    return full;
  }

  getCommitment(id: string): Commitment | undefined {
    return this.commitmentList.find((c) => c.id === id);
  }

  updateCommitment(id: string, patch: Partial<Commitment>): Commitment | undefined {
    const c = this.getCommitment(id);
    if (!c) return undefined;
    Object.assign(c, patch);
    this.saveCommitments();
    return c;
  }

  commitments(f?: CommitmentFilter): Commitment[] {
    return this.commitmentList.filter((c) => {
      if (f?.agentId && c.agentId !== f.agentId) return false;
      if (f?.origin && c.origin !== f.origin) return false;
      if (f?.status && c.status !== f.status) return false;
      if (f?.since && c.createdAt < f.since) return false;
      return true;
    });
  }

  private saveCommitments(): void {
    writeJsonAtomic(path.join(this.dir, "commitments.json"), this.commitmentList, 0o600);
  }

  // ── events ────────────────────────────────────────────────────────────────

  private eventsFile(): string {
    return path.join(this.dir, "events.jsonl");
  }

  appendEvent(e: Omit<ProactiveEvent, "id" | "ts"> & { id?: string; ts?: number }): ProactiveEvent {
    const full: ProactiveEvent = {
      ...e,
      id: e.id ?? uid("ev", 8),
      ts: e.ts ?? Date.now(),
    };
    const line = JSON.stringify(full);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.eventsFile(), line + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(this.eventsFile(), 0o600);
    } catch {
      /* best effort */
    }
    if (++this.appendsSincePrune >= PRUNE_CHECK_EVERY) {
      this.appendsSincePrune = 0;
      this.prune();
    }
    return full;
  }

  events(f: { agentId?: string; loop?: ProactiveLoop; since?: number; commitmentId?: string } = {}): ProactiveEvent[] {
    return this.readEvents().filter((e) => {
      if (f.agentId && e.agentId !== f.agentId) return false;
      if (f.loop && e.loop !== f.loop) return false;
      if (f.since && e.ts < f.since) return false;
      if (f.commitmentId && e.commitmentId !== f.commitmentId) return false;
      return true;
    });
  }

  private readEvents(): ProactiveEvent[] {
    try {
      const raw = fs.readFileSync(this.eventsFile(), "utf8").trimEnd();
      if (!raw) return [];
      const out: ProactiveEvent[] = [];
      for (const line of raw.split("\n")) {
        try {
          out.push(JSON.parse(line) as ProactiveEvent);
        } catch {
          /* skip corrupt line */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Drop events older than the retention window; returns how many were removed. */
  prune(now = Date.now(), retentionMs = EVENT_RETENTION_MS): number {
    const all = this.readEvents();
    const kept = all.filter((e) => now - e.ts <= retentionMs);
    if (kept.length === all.length) return 0;
    fs.writeFileSync(this.eventsFile(), kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
    return all.length - kept.length;
  }
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

/** Split "/commit <text> by <when>" — delegates when-parsing to parseWhen. */
export function parseCommitDue(
  rest: string,
  now = Date.now()
): { text: string; whenRaw: string; dueAt: number; repeat?: ParsedWhen["repeat"] } | undefined {
  const m = rest.trim().match(/^(.+?)\s+by\s+(.+)$/i);
  if (!m) {
    // tolerate a bare duration: "/commit X in 2d"
    const bare = rest.trim().match(/^(.+?)\s+(in\s+.+)$/i);
    if (!bare) return undefined;
    const parsedBare = parseWhen(bare[2], now);
    if (!parsedBare) return undefined;
    return { text: bare[1].trim(), whenRaw: bare[2].trim(), dueAt: parsedBare.dueAt, repeat: parsedBare.repeat };
  }
  const parsed = parseWhen(m[2]);
  if (!parsed) return undefined;
  return { text: m[1].trim(), whenRaw: m[2].trim(), dueAt: parsed.dueAt, repeat: parsed.repeat };
}

/**
 * Pure metrics over metadata events + commitments (spec "dashboard" section).
 * - delivered: pushes in window (per agent/loop filter)
 * - seen/acted: % of delivered that got any touch / a meaningful choice
 * - ignored: delivered with no seen event for the same commitmentId and no
 *   standalone touch, within 48h before `now`
 * - completedPct: completed / (completed + missed) commitments in window
 * - helpfulPct: share of rated commitments that are 👍
 * - noisePct: (ignored + dismissed + 👎) / delivered
 */
export function summarize(
  source: { events: ProactiveEvent[]; commitments: Commitment[] },
  opts: { since: number; now: number; agentId?: string; loop?: ProactiveLoop }
): Summary {
  const by = (e: ProactiveEvent): boolean => {
    if (opts.agentId && e.agentId !== opts.agentId) return false;
    if (opts.loop && e.loop !== opts.loop) return false;
    return true;
  };
  const events = source.events.filter((e) => e.ts >= opts.since && e.ts <= opts.now && by(e));

  const deliveredEvents = events.filter((e) => e.stage === "delivered");
  const delivered = deliveredEvents.length;

  const seenKeys = new Set<string>();
  const actedKeys = new Set<string>();
  for (const e of events) {
    const key = e.commitmentId ?? e.id;
    if (e.stage === "seen" || e.stage === "acted") seenKeys.add(key);
    if (e.stage === "acted") actedKeys.add(key);
  }
  // a delivered event keyed by its own id: correlate seen/acted via commitmentId, or
  // (heartbeat speaks) by falling into the same key set
  let seen = 0;
  let ignored = 0;
  for (const d of deliveredEvents) {
    const key = d.commitmentId ?? d.id;
    if (seenKeys.has(key)) seen++;
    else if (opts.now - d.ts > IGNORE_WINDOW_MS) ignored++;
  }
  const acted = actedKeys.size;

  const commitments = source.commitments.filter((c) => {
    if (opts.agentId && c.agentId !== opts.agentId) return false;
    return c.createdAt >= opts.since || (c.closedAt != null && c.closedAt >= opts.since);
  });
  const completed = commitments.filter((c) => c.status === "completed").length;
  const missed = commitments.filter((c) => c.status === "missed").length;
  const closed = completed + missed;
  const rated = commitments.filter((c) => c.rating);
  const up = rated.filter((c) => c.rating === "up").length;
  const dismissed = events.filter((e) => e.stage === "dismissed").length;
  const downCount = rated.length - up;

  const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 100));

  const proposed = commitments.filter((c) => c.origin === "inferred" && (c.status === "proposed" || c.confirmedAt || c.status === "dismissed")).length;
  const confirmed = commitments.filter((c) => c.origin === "inferred" && c.confirmedAt != null).length;

  const byStage: Record<string, number> = {};
  for (const e of events) byStage[e.stage] = (byStage[e.stage] ?? 0) + 1;

  return {
    delivered,
    seenPct: pct(seen, delivered),
    actedPct: pct(acted, delivered),
    completedPct: pct(completed, closed),
    helpfulPct: pct(up, rated.length),
    noisePct: pct(ignored + dismissed + downCount, Math.max(delivered, 1)),
    ignored,
    explicitCount: commitments.filter((c) => c.origin === "explicit").length,
    inferredCount: commitments.filter((c) => c.origin === "inferred").length,
    confirmRate: pct(confirmed, proposed),
    byStage,
  };
}