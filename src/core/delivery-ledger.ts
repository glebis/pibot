// ─── Durable outbound delivery ledger (bd pibot-qy88) ────────────────────────
// The live Telegram path used to serialise sends through a process-local promise
// chain and dedupe through a 30 s in-memory map. Neither survives a restart, so:
//   • a crash between "the turn produced a message" and "Telegram received it"
//     lost the message with no record that it was ever owed, and
//   • a dedupeKey replayed after a reopen was a fresh send, so the backstop could
//     not protect the one case it exists for.
//
// This ledger is that record. Rules, in order of importance:
//
//  1. A message is written as `pending` BEFORE the first API call, so a crash at
//     any later point leaves a recoverable row rather than silence.
//  2. `delivered` is written only after the API returned a message. `failed`
//     means the API definitively refused it (4xx that is not a 429) — those are
//     reported at boot, never auto-resent.
//  3. A crash in the middle of an API call leaves the row `pending` with
//     `attempts >= 1`. That is genuinely ambiguous: Telegram may or may not have
//     taken it. Such a row is marked `unknown` at load and NOT resent
//     automatically — a duplicate outbound message is worse than a human review.
//  4. `delivered` is durable for DELIVERED_RETENTION_MS (7 days), which is what
//     makes the duplicate guard survive restarts: a replayed dedupeKey sees the
//     delivered row and is suppressed.
//
// Runtime-private and owner-only (0600), atomic writes, corrupt rows isolated.

import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "./util.js";

export type DeliveryState = "pending" | "delivered" | "failed" | "unknown";

export interface DeliveryRow {
  /** stable identity: `<transport>:<chatId>:<dedupeKey>` hashed */
  id: string;
  transport: string;
  chatId: string;
  /** caller's dedupeKey, or the payload hash when the caller supplied none */
  dedupeKey: string;
  /** outbound body, so an owed message can actually be replayed */
  text: string;
  state: DeliveryState;
  createdAt: number;
  updatedAt: number;
  /** how many API calls have been started for this row */
  attempts: number;
  messageId?: number;
  /** last error text, truncated; never a token (grammy errors carry the method, not the secret) */
  error?: string;
}

/** How long a settled row keeps suppressing its dedupeKey. */
export const DELIVERED_RETENTION_MS = 7 * 86_400e3;
export const FAILED_RETENTION_MS = 7 * 86_400e3;
/** Hard cap; the ledger is a delivery journal, not a transcript archive. */
export const MAX_ROWS = 500;
/** Bodies are truncated for the journal: a replayed row is a fallback, not an archive. */
export const MAX_STORED_TEXT = 4_000;

interface Persisted {
  version: 1;
  rows: DeliveryRow[];
}

export function deliveryRowId(transport: string, chatId: string, dedupeKey: string): string {
  return createHash("sha256").update(`${transport}\u0000${chatId}\u0000${dedupeKey}`).digest("hex").slice(0, 32);
}

export interface DeliveryLedgerOptions {
  /** Omitted = in-memory only (tests, transports that never persist). */
  file?: string;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * Durable record of every outbound message the transport accepted responsibility
 * for. Synchronous and atomic on every transition; a returned call is committed.
 */
export class DeliveryLedger {
  private rows = new Map<string, DeliveryRow>();
  private readonly now: () => number;

  constructor(private readonly opts: DeliveryLedgerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.load();
  }

  private load(): void {
    if (!this.opts.file) return;
    const stored = readJson<Persisted>(this.opts.file, { version: 1, rows: [] });
    const now = this.now();
    for (const row of Array.isArray(stored.rows) ? stored.rows : []) {
      if (!row?.id || typeof row.chatId !== "string") continue; // corrupt row: drop it, keep the ledger
      if (row.state === "pending" && row.attempts > 0) {
        // The process died mid-send: Telegram may already have this message.
        row.state = "unknown";
        row.error = "process stopped during the send; delivery unconfirmed";
      }
      if (row.state !== "pending" && now - row.updatedAt > DELIVERED_RETENTION_MS) continue;
      this.rows.set(row.id, row);
    }
    this.persist();
  }

  private persist(): void {
    if (!this.opts.file) return;
    this.prune();
    writeJsonAtomic(this.opts.file, { version: 1, rows: [...this.rows.values()] } satisfies Persisted, 0o600);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, row] of this.rows) {
      if (row.state === "pending") continue;
      const retention = row.state === "failed" ? FAILED_RETENTION_MS : DELIVERED_RETENTION_MS;
      if (now - row.updatedAt > retention) this.rows.delete(id);
    }
    if (this.rows.size <= MAX_ROWS) return;
    // oldest settled first; a pending row is never evicted for capacity
    const settled = [...this.rows.values()].filter((r) => r.state !== "pending").sort((a, b) => a.updatedAt - b.updatedAt);
    for (const row of settled) {
      if (this.rows.size <= MAX_ROWS) break;
      this.rows.delete(row.id);
    }
  }

  get(id: string): DeliveryRow | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  /**
   * Claim a send. Returns the row that governs this push:
   *  - `delivered` / `unknown` → the caller must NOT send (durable duplicate guard;
   *    `unknown` is surfaced for review, never auto-resent)
   *  - `pending` with no attempts → a fresh claim, the caller sends
   *  - `pending` with attempts → left over from a dead process; treated as unknown
   *    on load, so this only happens in-process and is safe to resend
   */
  claim(input: { transport: string; chatId: string; dedupeKey: string; text: string }): { id: string; row: DeliveryRow; action: "send" | "suppress" | "review" } {
    const id = deliveryRowId(input.transport, input.chatId, input.dedupeKey);
    const now = this.now();
    const existing = this.rows.get(id);
    if (existing) {
      if (existing.state === "delivered") return { id, row: { ...existing }, action: "suppress" };
      if (existing.state === "unknown") return { id, row: { ...existing }, action: "review" };
      // failed or in-process-retryable: reuse the row so the attempt count stays honest
      existing.text = truncateStored(input.text);
      existing.updatedAt = now;
      this.persist();
      return { id, row: { ...existing }, action: "send" };
    }
    const row: DeliveryRow = {
      id,
      transport: input.transport,
      chatId: input.chatId,
      dedupeKey: input.dedupeKey,
      text: truncateStored(input.text),
      state: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    this.rows.set(id, row);
    this.persist();
    return { id, row: { ...row }, action: "send" };
  }

  /** Record that an API call for this row is starting. Called BEFORE the call. */
  beginAttempt(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.attempts += 1;
    row.state = "pending";
    row.updatedAt = this.now();
    this.persist();
  }

  markDelivered(id: string, messageId?: number): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.state = "delivered";
    row.updatedAt = this.now();
    delete row.error;
    if (messageId !== undefined) row.messageId = messageId;
    this.persist();
  }

  /** The API definitively refused this send; keep the reason for the owner's review. */
  markFailed(id: string, error: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.state = "failed";
    row.updatedAt = this.now();
    row.error = error.slice(0, 300);
    this.persist();
  }

  /**
   * An attempt ended without a definitive answer (timeout, 5xx, connection reset).
   * NOT a failure: the row stays `pending` so an in-process retry may reuse it, but
   * a crash from here is resolved to `unknown` rather than resent.
   */
  markUnconfirmed(id: string, error: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.updatedAt = this.now();
    row.error = error.slice(0, 300);
    this.persist();
  }

  /** Rows a previous process owed and never sent. Replay candidates at boot. */
  owed(): DeliveryRow[] {
    return [...this.rows.values()].filter((r) => r.state === "pending").sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r }));
  }

  /** Rows needing a human: ambiguous delivery or a definitive API refusal. */
  ambiguous(): DeliveryRow[] {
    return [...this.rows.values()]
      .filter((r) => r.state === "unknown" || r.state === "failed")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }

  /** True when this dedupeKey was already delivered (the durable duplicate guard). */
  isDelivered(transport: string, chatId: string, dedupeKey: string): boolean {
    return this.rows.get(deliveryRowId(transport, chatId, dedupeKey))?.state === "delivered";
  }

  size(): number {
    return this.rows.size;
  }
}

function truncateStored(text: string): string {
  return text.length > MAX_STORED_TEXT ? `${text.slice(0, MAX_STORED_TEXT)}…` : text;
}
