// Telegram surface for the Pi Durable satellite: chat messages become exactly-once
// satellite submissions, and settled answers are pushed back into the chat.
//
// The surface is deliberately transport-agnostic (anything with onMessage/push) —
// production wires the real TelegramTransport; tests use fakes.
//
// Delivery guarantee (with `outboxPath`): at-least-once. Each request is persisted
// to a JSON outbox BEFORE satellite.ask; on the next attach every still-"pending"
// entry is replayed via ask(text, sameRequestId) — the satellite is exactly-once by
// requestId, so that returns the ORIGINAL answer without re-running the model — and
// pushed. A crash between a successful push and the "delivered" write therefore
// yields one duplicate reply after restart; that trade-off is accepted (a lost
// reply is worse). Without `outboxPath` nothing is persisted: a crash between the
// answer settling and the push loses the reply (Telegram will not redeliver).

import * as fs from "node:fs";
import type { PushOptions, Transport } from "../core/types.js";
import { writeJsonAtomic } from "../core/util.js";

/** The sliver of the satellite the surface needs (openSatellite returns a superset). */
export interface SatelliteLike {
  ask(content: string, requestId?: string): Promise<string>;
}

export type OutboxStatus = "pending" | "delivered" | "failed";

export interface OutboxEntry {
  chatId: string;
  text: string;
  status: OutboxStatus;
  createdAt: number;
  /** Set when status leaves "pending"; used for pruning. */
  settledAt?: number;
}

/** On-disk schema: { version: 1, entries: { [requestId]: OutboxEntry } } */
interface OutboxFile {
  version: 1;
  entries: Record<string, OutboxEntry>;
}

const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TelegramSurface {
  dispose(): void;
  /** Resolves once the startup replay of pending outbox entries has finished. */
  ready: Promise<void>;
}

/** A missing outbox is empty; an unreadable one is moved aside (never overwritten),
 *  so the pending replies it may hold stay recoverable by hand. */
function loadOutbox(file: string): Partial<OutboxFile> {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OutboxFile>;
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    console.error(`[durable-surface] outbox unreadable (${(e as Error).message}); moved to ${aside} — pending replies in it were NOT replayed`);
    return {};
  }
}

export function attachTelegramSurface(opts: {
  transport: Transport;
  satellite: SatelliteLike;
  /** JSON file for the durable delivery outbox; omitted = in-memory only. */
  outboxPath?: string;
}): TelegramSurface {
  const { transport: t, satellite, outboxPath } = opts;
  let disposed = false;

  const loaded = outboxPath ? loadOutbox(outboxPath) : {};
  const entries: Record<string, OutboxEntry> = { ...(loaded.entries ?? {}) };

  // Serialized writes: every mutation runs through one promise chain so concurrent
  // messages cannot clobber each other's entries on disk.
  let chain: Promise<void> = Promise.resolve();
  const mutate = (fn: () => void): Promise<void> => {
    const next = chain.then(() => {
      fn();
      if (!outboxPath) return;
      const cutoff = Date.now() - SETTLED_RETENTION_MS;
      for (const [id, e] of Object.entries(entries)) {
        if (e.status !== "pending" && (e.settledAt ?? e.createdAt) < cutoff) delete entries[id];
      }
      writeJsonAtomic(outboxPath, { version: 1, entries } satisfies OutboxFile, 0o600);
    });
    chain = next.catch((e) => console.error("[durable-surface] outbox write failed:", e));
    return chain;
  };
  const settle = (requestId: string, status: "delivered" | "failed"): Promise<void> =>
    mutate(() => {
      const e = entries[requestId];
      if (e) {
        e.status = status;
        e.settledAt = Date.now();
      }
    });

  /** ask → push → mark delivered. ask failure → "failed" + warning; push failure leaves it pending. */
  const deliver = async (requestId: string, chatId: string, text: string): Promise<void> => {
    let answer: string;
    try {
      answer = await satellite.ask(text, requestId);
    } catch (e) {
      await settle(requestId, "failed");
      await t.push(chatId, { text: `⚠️ satellite failed to answer: ${(e as Error).message}` }).catch(() => {});
      return;
    }
    await t.push(chatId, { text: answer } satisfies PushOptions);
    await settle(requestId, "delivered");
  };

  const onMessage = async (text: string, chatId: string, _reply?: unknown, messageId?: number): Promise<void> => {
    if (disposed || !text.trim()) return;
    if (messageId === undefined) {
      console.warn(`[durable-surface] message in chat ${chatId} has no messageId; requestId is non-idempotent (no exactly-once)`);
    }
    const requestId = `telegram:${chatId}:${messageId ?? Date.now()}`;
    await mutate(() => {
      const prev = entries[requestId];
      entries[requestId] = { chatId, text, status: "pending", createdAt: prev?.createdAt ?? Date.now() };
    });
    await deliver(requestId, chatId, text);
  };

  t.onMessage(async (text, chatId, reply, messageId) => {
    await onMessage(text, chatId, reply, messageId).catch((e) => console.error("[durable-surface] message error:", e));
  });

  // Replay anything a previous process accepted but never delivered (async; attach stays sync).
  const ready = (async () => {
    const pending = Object.entries(entries).filter(([, e]) => e.status === "pending");
    for (const [requestId, e] of pending) {
      if (disposed) return;
      await deliver(requestId, e.chatId, e.text).catch((err) =>
        console.error("[durable-surface] replay error:", requestId, err),
      );
    }
  })();

  return {
    ready,
    dispose() {
      disposed = true;
    },
  };
}
