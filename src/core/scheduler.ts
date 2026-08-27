import * as fs from "node:fs";
import * as path from "node:path";
import type { Schedule, ScheduleRepeat } from "./types.js";
import { ensureDir, nextRepeatAt, readJson, uid, writeJsonAtomic } from "./util.js";

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

export class Scheduler {
  private jobs = new Map<string, Schedule>();
  private snoozeByAgent = new Map<string, SnoozeState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private fireCb: (job: Schedule, snoozed: boolean) => void | Promise<void>;
  private stopped = false;

  constructor(dataDir: string, fireCb: (job: Schedule, snoozed: boolean) => void | Promise<void>) {
    this.file = path.join(dataDir, "schedules.json");
    this.fireCb = fireCb;
    this.load();
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private load(): void {
    const store = readJson<{ jobs?: Schedule[]; snooze?: Record<string, SnoozeState> }>(this.file, {});
    const now = Date.now();
    for (const job of store.jobs ?? []) {
      // prune finished jobs, and stale pending one-shots from a previous boot
      if (job.status !== "pending" && now - job.dueAt > PRUNE_MS) continue;
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
      (j) => j.status === "pending" || Date.now() - j.dueAt <= PRUNE_MS
    );
    const snooze: Record<string, SnoozeState> = {};
    for (const [k, v] of this.snoozeByAgent) snooze[k] = v;
    writeJsonAtomic(this.file, { jobs, snooze });
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  create(job: Omit<Schedule, "id" | "createdAt" | "firedCount" | "status"> & { id?: string }): Schedule {
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
    if (!job || job.status !== "pending") return null;
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

  list(agentId?: string): Schedule[] {
    const all = [...this.jobs.values()].filter((j) => j.status === "pending");
    const filtered = agentId ? all.filter((j) => j.agentId === agentId) : all;
    return filtered.sort((a, b) => a.dueAt - b.dueAt);
  }

  /** Jobs the bot owes an inline adjustment card for (drains the pending set) */
  takePendingCards(agentId: string, chatKey: string): Schedule[] {
    const out = [...this.jobs.values()].filter(
      (j) => j.cardPending && j.agentId === agentId && j.chat.transport === chatKey.split(":")[0] && j.chat.chatId === chatKey.split(":")[1]
    );
    for (const j of out) j.cardPending = false;
    if (out.length) this.save();
    return out;
  }

  // ── snooze ────────────────────────────────────────────────────────────────

  snooze(agentId: string, untilMs: number, reason?: string): SnoozeState {
    const st = { until: Math.max(untilMs, Date.now() + 1000), reason };
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
      if (delay <= 0) {
        // due now (or overdue) — fire; fire() handles snooze/recurrence
        const ms = Math.max(0, delay);
        this.timers.set(jid, setTimeout(() => { this.timers.delete(jid); void this.fire(job); }, ms));
      } else {
        this.timers.set(jid, setTimeout(() => { this.timers.delete(jid); void this.fire(job); }, Math.min(delay, MAX_TIMEOUT)));
      }
    }
  }

  private async fire(job: Schedule): Promise<void> {
    if (this.stopped || job.status !== "pending") return;
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

    job.firedCount += 1;

    if (job.repeat) {
      const next = this.nextFire(job, now);
      if (next != null && next > now) {
        job.dueAt = next;
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

    try {
      await this.fireCb(job, Boolean(sn && now < sn.until && job.wake === "important"));
    } catch (e) {
      console.error("[scheduler] fire handler error:", e);
    }
  }

  private nextFire(job: Schedule, from: number): number | null {
    const repeat: ScheduleRepeat | undefined = job.repeat;
    if (!repeat) return null;
    return nextRepeatAt(repeat, from);
  }
}