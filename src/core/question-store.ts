// ─── Durable record of owner questions (bd pibot-jciq) ───────────────────────
// A restart must never turn an answerable question into a timeout. Every
// question is written here BEFORE it is pushed to the owner; an answer is
// written BEFORE the asking turn is woken, so:
//   - a tap/message that arrives while the daemon is down is recorded and
//     replayed at boot (the asking turn is gone, the answer is not),
//   - a resumed ask() with the same questionKey returns the recorded answer
//     instead of asking again,
//   - expiry stays authoritative: a question past pendingUntil never resolves
//     late, no matter when the tap arrives.
// Runtime-private, owner-only (0600), atomic writes.

import { readJson, writeJsonAtomic } from "./util.js";
import type { QuestionAnswer, QuestionSnapshot, QuestionSpec } from "./questions.js";

export interface QuestionRecord {
  snapshot: QuestionSnapshot;
  spec: QuestionSpec;
  /** stable caller key (e.g. `task:<id>:<attempt>`) so a resumed ask() finds this record */
  questionKey?: string;
  /** the one durable answer; absent while the question is pending */
  answer?: QuestionAnswer;
  /** the record changed after the asking turn was already gone (recovered at boot) */
  answeredOffline?: boolean;
  recordedAt: number;
}

/** Settled records stay readable this long so a late resumed ask() still finds its answer. */
export const KEEP_SETTLED_MS = 7 * 86_400e3;
/** Hard cap; the store is a recovery journal, not an audit log. */
export const MAX_RECORDS = 200;

interface Persisted {
  records: QuestionRecord[];
}

/**
 * Durable question journal. Absent `file` keeps everything in memory (tests and
 * agents that never ask the owner). Writes are synchronous and atomic: the
 * caller may treat a returned call as committed.
 */
export class QuestionStore {
  private records = new Map<string, QuestionRecord>();

  constructor(private readonly file?: string) {
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    const stored = readJson<Persisted>(this.file, { records: [] });
    const now = Date.now();
    for (const rec of stored.records ?? []) {
      if (!rec?.snapshot?.qid) continue; // corrupt entry: drop the record, never the whole journal
      if (rec.snapshot.status !== "pending" && now - rec.recordedAt > KEEP_SETTLED_MS) continue;
      this.records.set(rec.snapshot.qid, rec);
    }
    // A question whose wait window elapsed while the process was down is expired,
    // not answerable: mark it before anyone can resolve it late.
    let changed = false;
    for (const rec of this.records.values()) {
      if (rec.snapshot.status === "pending" && rec.snapshot.pendingUntil <= now) {
        rec.snapshot.status = "expired";
        rec.recordedAt = now;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    this.prune();
    writeJsonAtomic(this.file, { records: [...this.records.values()] }, 0o600);
  }

  private prune(): void {
    const now = Date.now();
    for (const [qid, rec] of this.records) {
      if (rec.snapshot.status !== "pending" && now - rec.recordedAt > KEEP_SETTLED_MS) this.records.delete(qid);
    }
    // oldest first; never drop a pending question for capacity
    if (this.records.size > MAX_RECORDS) {
      const settled = [...this.records.values()]
        .filter((r) => r.snapshot.status !== "pending")
        .sort((a, b) => a.recordedAt - b.recordedAt);
      for (const rec of settled) {
        if (this.records.size <= MAX_RECORDS) break;
        this.records.delete(rec.snapshot.qid);
      }
    }
  }

  /** Write a question before it is shown to the owner. */
  save(rec: QuestionRecord): void {
    this.records.set(rec.snapshot.qid, rec);
    this.persist();
  }

  get(qid: string): QuestionRecord | undefined {
    const rec = this.records.get(qid);
    return rec ? structuredClone(rec) : undefined;
  }

  findByKey(questionKey: string): QuestionRecord | undefined {
    for (const rec of this.records.values()) {
      if (rec.questionKey === questionKey) return structuredClone(rec);
    }
    return undefined;
  }

  /** Oldest first, for a deterministic replay order. */
  all(): QuestionRecord[] {
    return [...this.records.values()].sort((a, b) => a.recordedAt - b.recordedAt).map((r) => structuredClone(r));
  }

  listPending(): QuestionRecord[] {
    const now = Date.now();
    return [...this.records.values()]
      .filter((r) => r.snapshot.status === "pending" && r.snapshot.pendingUntil > now)
      .map((r) => structuredClone(r));
  }

  /**
   * Answers recorded while no process was listening (restored question answered
   * by the owner after a restart). Consumed by the boot replay.
   */
  listAnsweredOffline(): QuestionRecord[] {
    return [...this.records.values()]
      .filter((r) => r.answer !== undefined && r.answeredOffline === true)
      .map((r) => structuredClone(r));
  }

  /** Patch the snapshot in place (acceptedMessageAt, status). */
  update(
    qid: string,
    patch: { status?: QuestionSnapshot["status"]; acceptedMessageAt?: number; answeredOffline?: boolean },
  ): QuestionRecord | undefined {
    const rec = this.records.get(qid);
    if (!rec) return undefined;
    if (patch.status !== undefined) rec.snapshot.status = patch.status;
    if (patch.acceptedMessageAt !== undefined) rec.snapshot.acceptedMessageAt = patch.acceptedMessageAt;
    if (patch.answeredOffline !== undefined) rec.answeredOffline = patch.answeredOffline;
    rec.recordedAt = Date.now();
    this.persist();
    return structuredClone(rec);
  }

  /**
   * Record THE answer durably and return the stored record. First answer wins:
   * a second tap on the same question returns the recorded answer unchanged,
   * which is what makes the replay safe.
   */
  recordAnswer(qid: string, answer: QuestionAnswer, opts: { offline?: boolean } = {}): QuestionRecord | undefined {
    const rec = this.records.get(qid);
    if (!rec) return undefined;
    if (rec.answer) return structuredClone(rec);
    rec.answer = answer;
    rec.snapshot.status = "answered";
    rec.recordedAt = Date.now();
    if (opts.offline) rec.answeredOffline = true;
    this.persist();
    return structuredClone(rec);
  }
}
