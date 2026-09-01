import * as fs from "node:fs";
import * as path from "node:path";
import type { Schedule, ScheduleRepeat } from "./types.js";
import { ensureDir, errorMessage, nextRepeatAt, readJson, uid, writeJsonAtomic } from "./util.js";

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

export interface ScheduleFailureNotice {
  kind: "first-failure" | "paused";
  error: string;
}

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
    for (const job of store.jobs ?? []) {
      // prune finished jobs, and stale pending one-shots from a previous boot
      if ((job.status === "done" || job.status === "cancelled") && now - job.dueAt > PRUNE_MS) continue;
      if (job.status === "pending" && !job.repeat && job.dueAt + 86400e3 < now) {
        job.status = "done"; // missed while offline > 1 day; don't spam old fires
        continue;
      }
      this.jobs.set(job.id, job);
    }
    for (const [agentId, sn] of Object.entries(store.snooze ?? {})) {
      if (sn && sn.until > now) this.snoozeByAgent.set(agentId, sn);
    }
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
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

  private async fireOnce(job: Schedule): Promise<void> {
    const now = Date.now();

    // snooze handling
    const sn = this.snoozeByAgent.get(job.agentId);
    if (sn && now < sn.until) {
      if (job.internal) {
        // heartbeats simply skip a beat while snoozed
        const next = this.nextFire(job, sn.until);
        if (next) { job.dueAt = next; this.save(); this.rearm(job.id); }
        else job.status = "done";
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
    try {
      await this.fireCb(job, Boolean(sn && now < sn.until && job.wake === "important"));
    } catch (e) {
      console.error("[scheduler] fire handler error:", e);
      // Never resurrect a job from a stale failure path: if it was cancelled
      // while delivery was in flight, keep the cancelled state (Aug 2026:
      // cancelled "morning brief" resurrected itself from a retry and re-fired).
      if (job.status !== "pending") { this.save(); return; }
      job.deliveryAttempts = (job.deliveryAttempts ?? 0) + 1;
      job.lastDeliveryError = errorMessage(e).slice(0, 300);
      let noticeKind: ScheduleFailureNotice["kind"] | null = null;
      if (job.repeat && job.deliveryAttempts >= MAX_ATTEMPTS_PER_OCCURRENCE) {
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
      this.save();
      this.rearm(job.id);
      if (noticeKind) await this.notifyFailure(job, { kind: noticeKind, error: job.lastDeliveryError });
      return;
    }

    // Respect a cancel (or reschedule) that landed while delivery was in flight
    if (job.status !== "pending") { this.save(); return; }

    job.firedCount += 1;
    job.deliveryAttempts = 0;
    job.consecutiveFailures = 0;
    delete job.lastDeliveryError;
    delete job.pauseReason;
    if (job.repeat) {
      const next = this.nextFire(job, now);
      if (next != null && next > now) {
        if (job.dueAt === dueAtAtFire) job.dueAt = next; // keep a mid-flight reschedule
        this.save();
        this.rearm(job.id);
      } else {
        job.status = "done";
        this.save();
      }
    } else {
      job.status = "done";
      this.save();
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
