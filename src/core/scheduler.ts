import * as fs from "node:fs";
import * as path from "node:path";
import type { Schedule, ScheduleRepeat } from "./types.js";
import { ensureDir, errorMessage, nextRepeatAt, readJson, uid, writeJsonAtomic } from "./util.js";

/**
 * Why a job is no longer pending. Kept separate from `status` so "fired" and
 * "missed while offline" stay distinguishable in the persisted state and in what
 * the owner sees (bd pibot-awhs).
 */
export type ScheduleOutcome = "fired" | "missed";

interface SnoozeState {
  until: number;
  reason?: string;
}

interface StoreShape {
  jobs: Schedule[];
  snooze: Record<string, SnoozeState | undefined>; // per agentId
}

const PRUNE_MS = 3 * 86400e3; // drop finished jobs older than 3 days
const MAX_TIMEOUT = 2 ** 31 - 1; // node setTimeout cap ≈ 24.8 days
const MIN_AGENT_REPEAT_MS = 15 * 60_000;
const MAX_ACTIVE_AGENT_SCHEDULES = 20;
const MAX_ATTEMPTS_PER_OCCURRENCE = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
/**
 * A one-shot whose due time is further in the past than this was missed while the
 * daemon was down; it is closed as `missed` instead of firing late. Unchanged policy,
 * now recorded as such rather than as a successful fire (bd pibot-awhs).
 */
export const MISSED_AFTER_MS = 86400e3;

export interface ScheduleFailureNotice {
  kind: "first-failure" | "paused";
  error: string;
}

export class ScheduleRouteError extends Error {}

export class Scheduler {
  private jobs = new Map<string, Schedule>();
  private snoozeByAgent = new Map<string, SnoozeState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private firing = new Set<string>();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private fireCb: (job: Schedule, snoozed: boolean) => void | Promise<void>;
  private noticeCb?: (job: Schedule, event: ScheduleFailureNotice) => void | Promise<void>;
  private stopped = false;
  private routeValidator?: (job: Pick<Schedule, "agentId" | "chat" | "delivery" | "internal">) => string | undefined;

  /** Host checks transport availability and ownership without rerouting a job. */
  setRouteValidator(validate: NonNullable<Scheduler["routeValidator"]>): void {
    this.routeValidator = validate;
  }

  private assertRoute(job: Pick<Schedule, "agentId" | "chat" | "delivery" | "internal">): void {
    if (job.internal) return;
    const error = this.routeValidator?.(job);
    if (error) throw new ScheduleRouteError(error);
  }

  constructor(
    dataDir: string,
    fireCb: (job: Schedule, snoozed: boolean) => void | Promise<void>,
    noticeCb?: (job: Schedule, event: ScheduleFailureNotice) => void | Promise<void>,
  ) {
    this.file = path.join(dataDir, "schedules.json");
    this.fireCb = fireCb;
    this.noticeCb = noticeCb;
    this.load();
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private load(): void {
    const store = readJson<{ jobs?: Schedule[]; snooze?: Record<string, SnoozeState> }>(this.file, {});
    const now = Date.now();
    let prunedMissed = 0;
    const interrupted: Schedule[] = [];
    for (const job of store.jobs ?? []) {
      // prune finished jobs, and stale pending one-shots from a previous boot
      if ((job.status === "done" || job.status === "cancelled") && now - job.dueAt > PRUNE_MS) continue;
      if (job.status === "pending" && !job.repeat && job.dueAt + MISSED_AFTER_MS < now) {
        // Missed while the daemon was down past the catch-up window: firing it days
        // late would be worse than silence. Recorded as `missed`, NOT as a fire, so
        // the owner-facing state and the logs stop lying about what happened.
        job.status = "done";
        job.outcome = "missed";
        job.missedAt = now;
        prunedMissed += 1;
        this.jobs.set(job.id, job);
        continue;
      }
      if (job.status === "pending" && job.firing) {
        // The process died holding a claimed occurrence. The claim said what this fire
        // resolves to BEFORE dispatching it, so finish that transition instead of
        // re-deciding: an already-delivered reminder can never be re-fired (the bug),
        // and a job that died before delivery is not repeated either (the trade the
        // issue asks for). Report it — silence would hide the lost occurrence.
        interrupted.push(job);
        const claim = job.firing;
        delete job.firing;
        job.firedCount = claim.firedCount;
        job.deliveryAttempts = 0;
        job.consecutiveFailures = 0;
        if (claim.nextDueAt != null) {
          if (job.dueAt === claim.dueAtAtFire) job.dueAt = claim.nextDueAt;
        } else if (job.status === "pending") {
          job.status = "done";
          job.outcome = "fired";
        }
      }
      this.jobs.set(job.id, job);
    }
    for (const [agentId, sn] of Object.entries(store.snooze ?? {})) {
      if (sn && sn.until > now) this.snoozeByAgent.set(agentId, sn);
    }
    if (prunedMissed) {
      console.warn(`[scheduler] ${prunedMissed} one-shot schedule(s) came due while offline and were closed as missed`);
      // persist the outcome now: leaving it in memory would let the next boot re-decide
      this.flush();
    }
    if (interrupted.length) {
      // Persist the completed transition: the claim must not survive into another boot.
      this.flush();
    }
    for (const job of interrupted) {
      console.warn(
        `[scheduler] schedule ${job.id} ("${job.title}") was mid-fire when the process stopped; its delivery is unconfirmed, and the occurrence is settled (not repeated) to avoid a duplicate`,
      );
    }
  }

  /**
   * Batched persistence for changes where a lost frame is harmless (a new job, a
   * cancel, a snooze window). NEVER used for a fire transition: see `saveNow`.
   */
  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
  }

  /**
   * Persist immediately (bd pibot-awhs). Used where a crash between the in-memory
   * change and the flush would make the daemon redo a side effect it cannot redo
   * safely: every job-state transition inside `fireOnce`, and every missed-prune.
   * A 20-job set serialises to a few KB, so the synchronous write is cheap next to
   * the delivery it protects.
   */
  private saveNow(): void {
    this.flush();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const jobs = [...this.jobs.values()].filter(
      (j) => j.status === "pending" || j.status === "paused" || Date.now() - j.dueAt <= PRUNE_MS
    );
    const snooze: Record<string, SnoozeState> = {};
    for (const [k, v] of this.snoozeByAgent) snooze[k] = v;
    writeJsonAtomic(this.file, { jobs, snooze });
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  create(job: Omit<Schedule, "id" | "createdAt" | "firedCount" | "status"> & { id?: string }): Schedule {
    if (!job.internal) {
      this.assertRoute(job);
      if (job.repeat?.everyMs != null && job.repeat.everyMs < MIN_AGENT_REPEAT_MS) {
        throw new Error("Recurring schedules must be at least 15 minutes apart.");
      }
      this.assertCapacity(job.agentId, 1);
    }
    const full: Schedule = {
      status: "pending",
      createdAt: Date.now(),
      firedCount: 0,
      ...job,
      id: job.id ?? uid("sc", 6),
    };
    this.jobs.set(full.id, full);
    this.save();
    this.rearm(full.id);
    return full;
  }

  assertCapacity(agentId: string, requested = 1): void {
    const active = [...this.jobs.values()].filter(
      (job) => job.agentId === agentId && !job.internal && (job.status === "pending" || job.status === "paused"),
    ).length;
    if (active + requested > MAX_ACTIVE_AGENT_SCHEDULES) {
      throw new Error(`An agent may have at most 20 active schedules; this action needs ${requested} free slot${requested === 1 ? "" : "s"}.`);
    }
  }

  /** Create or replace a job by id (used for heartbeat rhythm jobs) */
  ensure(job: Schedule & { id: string }): Schedule {
    this.jobs.set(job.id, job);
    this.save();
    this.rearm(job.id);
    return job;
  }

  get(id: string): Schedule | undefined {
    return this.jobs.get(id) ?? [...this.jobs.values()].find((j) => j.id.startsWith(id));
  }

  cancel(id: string): Schedule | null {
    const job = this.get(id);
    if (!job || (job.status !== "pending" && job.status !== "paused")) return null;
    job.status = "cancelled";
    this.save();
    this.rearm(job.id);
    return job;
  }

  reschedule(id: string, dueAt: number): Schedule | null {
    const job = this.get(id);
    if (!job || job.status !== "pending") return null;
    job.dueAt = Math.max(dueAt, Date.now() + 1000);
    this.save();
    this.rearm(job.id);
    return job;
  }

  resume(id: string): Schedule | null {
    const job = this.get(id);
    if (!job || job.status !== "paused") return null;
    this.assertRoute(job);
    job.status = "pending";
    job.deliveryAttempts = 0;
    job.consecutiveFailures = 0;
    delete job.lastDeliveryError;
    delete job.pauseReason;
    job.dueAt = job.repeat ? (this.nextFire(job, Date.now()) ?? Date.now() + 1000) : Date.now() + 1000;
    this.save();
    this.rearm(job.id);
    return job;
  }

  list(agentId?: string, opts: { includePaused?: boolean } = {}): Schedule[] {
    const all = [...this.jobs.values()].filter((j) => j.status === "pending" || (opts.includePaused && j.status === "paused"));
    const filtered = agentId ? all.filter((j) => j.agentId === agentId) : all;
    return filtered.sort((a, b) => a.dueAt - b.dueAt);
  }

  /**
   * Jobs closed as missed rather than fired (bd pibot-awhs). These used to be
   * indistinguishable from delivered ones; the owner can now see that a reminder was
   * skipped while the daemon was down instead of assuming it went out.
   */
  recentMissed(agentId?: string, withinMs = 7 * 86400e3): Schedule[] {
    const since = Date.now() - withinMs;
    return [...this.jobs.values()]
      .filter((j) => j.outcome === "missed" && (j.missedAt ?? 0) > since && (!agentId || j.agentId === agentId))
      .sort((a, b) => (b.missedAt ?? 0) - (a.missedAt ?? 0));
  }

  /** Jobs the bot owes an inline adjustment card for (drains the pending set) */
  takePendingCards(agentId: string, chatKey: string): Schedule[] {
    const separator = chatKey.lastIndexOf(":");
    const transport = chatKey.slice(0, separator);
    const chatId = chatKey.slice(separator + 1);
    const out = [...this.jobs.values()].filter(
      (j) => j.cardPending && j.agentId === agentId && j.chat.transport === transport && j.chat.chatId === chatId
    );
    for (const j of out) j.cardPending = false;
    if (out.length) this.save();
    return out;
  }

  // ── snooze ────────────────────────────────────────────────────────────────

  snooze(agentId: string, untilMs: number, reason?: string, capAt?: number): SnoozeState {
    let until = Math.max(untilMs, Date.now() + 1000);
    // a snooze never survives past the agent's wake time (end of quiet hours)
    if (capAt && until > capAt) until = capAt;
    const st = { until, reason };
    this.snoozeByAgent.set(agentId, st);
    this.save();
    this.rearm(); // re-evaluate pending jobs against the new snooze window
    return st;
  }

  unsnooze(agentId: string): boolean {
    const had = this.snoozeByAgent.delete(agentId);
    if (had) {
      this.save();
      this.rearm();
    }
    return had;
  }

  /** Morning wake: clear every agent's snooze; returns the agents resumed */
  unsnoozeAll(): string[] {
    const resumed = [...this.snoozeByAgent.keys()];
    if (resumed.length) {
      this.snoozeByAgent.clear();
      this.save();
      this.rearm();
    }
    return resumed;
  }

  snoozeState(agentId: string): SnoozeState | null {
    return this.snoozeByAgent.get(agentId) ?? null;
  }

  // ── timer wheel ───────────────────────────────────────────────────────────

  stop(): void {
    this.stopped = true;
    this.flush();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** (Re)arm timers; pass an id to rearm just that job */
  rearm(id?: string): void {
    if (this.stopped) return;
    const targets = id ? [id] : [...this.timers.keys(), ...this.jobs.keys()];
    for (const jid of targets) {
      const t = this.timers.get(jid);
      if (t) {
        clearTimeout(t);
        this.timers.delete(jid);
      }
      const job = this.jobs.get(jid);
      if (!job || job.status !== "pending") continue;
      const delay = job.dueAt - Date.now();
      this.scheduleTimeout(jid, delay);
    }
  }

  private scheduleTimeout(id: string, delay: number): void {
    if (delay <= 0) {
      this.timers.set(id, setTimeout(() => {
        this.timers.delete(id);
        const job = this.jobs.get(id);
        if (job) void this.fire(job);
      }, Math.max(0, delay)));
      return;
    }
    if (delay > MAX_TIMEOUT) {
      this.timers.set(id, setTimeout(() => {
        this.timers.delete(id);
        if (this.stopped) return;
        const job = this.jobs.get(id);
        if (!job || job.status !== "pending") return;
        const remaining = job.dueAt - Date.now();
        if (remaining <= 0) void this.fire(job);
        else this.scheduleTimeout(id, remaining);
      }, MAX_TIMEOUT));
      return;
    }
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      const job = this.jobs.get(id);
      if (job) void this.fire(job);
    }, delay));
  }

  private async fire(job: Schedule): Promise<void> {
    if (this.stopped || job.status !== "pending") return;
    if (this.firing.has(job.id)) return;
    this.firing.add(job.id);
    try {
      await this.fireOnce(job);
    } finally {
      this.firing.delete(job.id);
    }
  }

  /**
   * Close a job as done for an explicit reason (bd pibot-awhs). `fired` means the side
   * effect was dispatched, `missed` means it never was — the two used to look identical
   * on disk, which made a missed reminder indistinguishable from a delivered one.
   */
  private finish(job: Schedule, outcome: ScheduleOutcome): void {
    job.status = "done";
    job.outcome = outcome;
    if (outcome === "missed") job.missedAt = Date.now();
  }

  /**
   * Write the post-fire state to disk BEFORE the side effect leaves the process
   * (bd pibot-awhs).
   *
   * The old order was: deliver → mutate → debounced save. A kill inside that 250 ms
   * window left `schedules.json` still saying `pending`, so the reopened daemon fired an
   * already-delivered reminder a second time. The claim inverts the failure: a job that
   * dies mid-fire is settled on the next boot exactly as if the delivery had happened.
   * One occurrence may therefore be lost in that crash window; a duplicate is never
   * sent. The issue asks for precisely this trade — a missed reminder is recoverable,
   * an uninvited repeat is not.
   *
   * `nextDueAt` is computed at claim time so the claim fully determines the outcome and
   * the boot has nothing left to decide.
   */
  private claimOccurrence(job: Schedule, dueAtAtFire: number, nextDueAt: number | null): void {
    job.firing = {
      claimedAt: Date.now(),
      dueAtAtFire,
      firedCount: job.firedCount + 1,
      ...(nextDueAt != null ? { nextDueAt } : {}),
    };
    this.saveNow();
  }

  private settleOccurrence(job: Schedule): void {
    delete job.firing;
  }

  private async fireOnce(job: Schedule): Promise<void> {
    const now = Date.now();

    // snooze handling
    const sn = this.snoozeByAgent.get(job.agentId);
    if (sn && now < sn.until) {
      if (job.internal) {
        // heartbeats simply skip a beat while snoozed
        const next = this.nextFire(job, sn.until);
        if (next) { job.dueAt = next; this.save(); this.rearm(job.id); }
        else { this.finish(job, "fired"); this.saveNow(); }
        return;
      }
      if (job.wake !== "important") {
        // defer to end of snooze window (once)
        job.dueAt = Math.max(sn.until, now + 1000);
        this.save();
        this.rearm(job.id);
        return;
      }
      // important: fire despite snooze
    }

    // Delivery can take minutes (agent-composed messages, transport timeouts).
    // Snapshot the due time so a cancel/reschedule that lands mid-flight is respected
    // instead of being clobbered by the post-delivery bookkeeping below.
    const dueAtAtFire = job.dueAt;
    // What this fire resolves to is fixed BEFORE dispatching the side effect
    // (bd pibot-awhs): a kill from here on can no longer resurrect an already-delivered
    // reminder, because the boot finishes this transition instead of re-deciding it.
    const claimedNext = job.repeat ? this.nextFire(job, now) : null;
    this.claimOccurrence(job, dueAtAtFire, claimedNext != null && claimedNext > now ? claimedNext : null);
    try {
      this.assertRoute(job);
      await this.fireCb(job, Boolean(sn && now < sn.until && job.wake === "important"));
    } catch (e) {
      console.error("[scheduler] fire handler error:", e);
      this.settleOccurrence(job);
      // Never resurrect a job from a stale failure path: if it was cancelled
      // while delivery was in flight, keep the cancelled state (Aug 2026:
      // cancelled "morning brief" resurrected itself from a retry and re-fired).
      if (job.status !== "pending") { this.saveNow(); return; }
      job.deliveryAttempts = (job.deliveryAttempts ?? 0) + 1;
      job.lastDeliveryError = errorMessage(e).slice(0, 300);
      let noticeKind: ScheduleFailureNotice["kind"] | null = null;
      if (e instanceof ScheduleRouteError) {
        job.status = "paused";
        job.pauseReason = `Delivery route needs repair: ${job.lastDeliveryError}`;
        noticeKind = "paused";
      } else if (job.repeat && job.deliveryAttempts >= MAX_ATTEMPTS_PER_OCCURRENCE) {
        job.deliveryAttempts = 0;
        job.consecutiveFailures = (job.consecutiveFailures ?? 0) + 1;
        if (job.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          job.status = "paused";
          job.pauseReason = `Paused after ${job.consecutiveFailures} consecutive failed occurrences.`;
          noticeKind = "paused";
        } else {
          if (job.dueAt === dueAtAtFire) job.dueAt = this.nextFire(job, Date.now()) ?? Date.now() + MIN_AGENT_REPEAT_MS;
          if (job.consecutiveFailures === 1) noticeKind = "first-failure";
        }
      } else if (!job.repeat && job.deliveryAttempts >= MAX_CONSECUTIVE_FAILURES) {
        job.status = "paused";
        job.pauseReason = `Paused after ${job.deliveryAttempts} failed delivery attempts.`;
        noticeKind = "paused";
      } else {
        if (job.dueAt === dueAtAtFire) {
          job.dueAt = Date.now() + Math.min(5 * 60_000, 10_000 * 2 ** Math.min(job.deliveryAttempts - 1, 5));
        }
        if (!job.repeat && job.deliveryAttempts === 1) noticeKind = "first-failure";
      }
      // a failed occurrence is retried, so it must not stay claimed on disk
      this.saveNow();
      this.rearm(job.id);
      if (noticeKind) await this.notifyFailure(job, { kind: noticeKind, error: job.lastDeliveryError });
      return;
    }

    this.settleOccurrence(job);

    // Respect a cancel (or reschedule) that landed while delivery was in flight
    if (job.status !== "pending") { this.saveNow(); return; }

    // The claim already recorded firedCount, the reset counters and the next occurrence;
    // settlement drops the claim and commits that state.
    job.firedCount = (job.firing?.firedCount ?? job.firedCount + 1);
    job.deliveryAttempts = 0;
    job.consecutiveFailures = 0;
    delete job.lastDeliveryError;
    delete job.pauseReason;
    const next = claimedNext != null && claimedNext > now ? claimedNext : null;
    this.settleOccurrence(job);
    if (next != null) {
      if (job.dueAt === dueAtAtFire) job.dueAt = next; // keep a mid-flight reschedule
      this.saveNow();
      this.rearm(job.id);
    } else {
      this.finish(job, "fired");
      this.saveNow();
    }
  }

  private async notifyFailure(job: Schedule, event: ScheduleFailureNotice): Promise<void> {
    if (!this.noticeCb) return;
    try {
      await this.noticeCb(job, event);
    } catch (e) {
      console.error("[scheduler] failure notice error:", e);
    }
  }

  private nextFire(job: Schedule, from: number): number | null {
    const repeat: ScheduleRepeat | undefined = job.repeat;
    if (!repeat) return null;
    return nextRepeatAt(repeat, from);
  }
}
