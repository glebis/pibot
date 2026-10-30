// Durable outbound delivery ledger (bd pibot-qy88).
// The failure these cover: a restart lost anything accepted-but-not-yet-sent, and
// the 30 s in-memory duplicate guard reset with the process, so a replayed
// dedupeKey was a fresh send. A crash mid-send is deliberately NOT auto-resent.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryLedger, MAX_ROWS, MAX_STORED_TEXT, deliveryRowId } from "./delivery-ledger.js";

let dir: string;
let file: string;
const open = (now?: () => number) => new DeliveryLedger({ file, ...(now ? { now } : {}) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-delivery-"));
  file = path.join(dir, "deliveries.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const send = (l: DeliveryLedger, dedupeKey = "turn:1", chatId = "42") => l.claim({ transport: "telegram", chatId, dedupeKey, text: "hello" });

describe("DeliveryLedger", () => {
  it("writes the row before the send, so a crash leaves a recoverable record", () => {
    const l = open();
    const { id, action } = send(l);
    expect(action).toBe("send");
    expect(open().get(id)?.state).toBe("pending");
    expect(open().owed().map((r) => r.id)).toEqual([id]);
  });

  it("suppresses a dedupeKey that was already delivered, even after a reopen", () => {
    const l = open();
    const { id } = send(l, "question:q_abc");
    l.beginAttempt(id);
    l.markDelivered(id, 99);

    const reopened = open();
    expect(reopened.isDelivered("telegram", "42", "question:q_abc")).toBe(true);
    const again = reopened.claim({ transport: "telegram", chatId: "42", dedupeKey: "question:q_abc", text: "hello" });
    expect(again.action).toBe("suppress");
    expect(again.row.messageId).toBe(99);
    expect(reopened.owed()).toHaveLength(0);
  });

  it("does not confuse the same dedupeKey in another chat or transport", () => {
    const l = open();
    const { id } = send(l, "question:q_abc", "42");
    l.markDelivered(id);
    expect(open().isDelivered("telegram", "84", "question:q_abc")).toBe(false);
    expect(open().isDelivered("telegram:sub", "42", "question:q_abc")).toBe(false);
  });

  it("marks a mid-send crash as ambiguous and never auto-resends it", () => {
    const l = open();
    const { id } = send(l);
    l.beginAttempt(id); // the API call started, then the process died

    const reopened = open();
    expect(reopened.get(id)?.state).toBe("unknown");
    expect(reopened.owed()).toHaveLength(0);
    const claim = reopened.claim({ transport: "telegram", chatId: "42", dedupeKey: "turn:1", text: "hello" });
    expect(claim.action).toBe("review");
    expect(reopened.ambiguous().map((r) => r.id)).toEqual([id]);
  });

  it("keeps a definitive API refusal as failed and reports it for review", () => {
    const l = open();
    const { id } = send(l);
    l.beginAttempt(id);
    l.markFailed(id, "400: chat not found");

    const reopened = open();
    expect(reopened.get(id)?.state).toBe("failed");
    expect(reopened.get(id)?.error).toBe("400: chat not found");
    expect(reopened.owed()).toHaveLength(0);
    expect(reopened.ambiguous().map((r) => r.state)).toEqual(["failed"]);
  });

  it("keeps an unconfirmed attempt replayable inside the process", () => {
    const l = open();
    const { id } = send(l);
    l.beginAttempt(id);
    l.markUnconfirmed(id, "timeout after 30000ms");
    expect(l.owed().map((r) => r.id)).toEqual([id]);
    // a fresh claim reuses the row instead of duplicating it
    expect(send(l).action).toBe("send");
    expect(l.size()).toBe(1);
  });

  it("counts attempts honestly across retries", () => {
    const l = open();
    const { id } = send(l);
    l.beginAttempt(id);
    l.markUnconfirmed(id, "503");
    send(l);
    l.beginAttempt(id);
    expect(open().get(id)?.attempts).toBe(2);
  });

  it("truncates the stored body: the journal is a fallback, not an archive", () => {
    const l = open();
    const long = "x".repeat(MAX_STORED_TEXT + 500);
    const { id } = l.claim({ transport: "telegram", chatId: "42", dedupeKey: "big", text: long });
    expect(l.get(id)?.text.length).toBe(MAX_STORED_TEXT + 1);
  });

  it("expires delivered rows so the guard cannot suppress forever", () => {
    let now = 1_000;
    const l = open(() => now);
    const { id } = send(l, "once");
    l.markDelivered(id);
    now += 8 * 86_400e3;
    const reopened = open(() => now);
    expect(reopened.isDelivered("telegram", "42", "once")).toBe(false);
    expect(reopened.size()).toBe(0);
  });

  it("never evicts a pending row for capacity", () => {
    let now = 1_000;
    const l = open(() => now);
    for (let i = 0; i < MAX_ROWS + 20; i++) {
      const { id } = send(l, `k${i}`);
      now += 1;
      if (i % 2 === 0) l.markDelivered(id);
    }
    const reopened = open(() => now);
    expect(reopened.size()).toBeLessThanOrEqual(MAX_ROWS);
    // the un-delivered half is the half that survives
    expect(reopened.owed().every((r) => Number(r.dedupeKey.slice(1)) % 2 === 1)).toBe(true);
  });

  it("isolates a corrupt row instead of losing the ledger", () => {
    const good = { id: "ok", transport: "telegram", chatId: "42", dedupeKey: "d", text: "t", state: "pending", createdAt: 1, updatedAt: 1, attempts: 0 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{ nope: true }, good] }));
    expect(open().owed().map((r) => r.id)).toEqual(["ok"]);
  });

  it("tolerates an unparseable file", () => {
    fs.writeFileSync(file, "{not json");
    expect(() => open()).not.toThrow();
    expect(open().size()).toBe(0);
  });

  it("keeps the ledger owner-only and derives stable ids", () => {
    const l = open();
    send(l);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(deliveryRowId("telegram", "42", "k")).toBe(deliveryRowId("telegram", "42", "k"));
    expect(deliveryRowId("telegram", "42", "k")).not.toBe(deliveryRowId("telegram", "42", "k2"));
  });

  it("in-memory mode (no file) still guards duplicates within the process", () => {
    const l = new DeliveryLedger();
    const { id } = l.claim({ transport: "telegram", chatId: "42", dedupeKey: "k", text: "t" });
    l.markDelivered(id);
    expect(l.claim({ transport: "telegram", chatId: "42", dedupeKey: "k", text: "t" }).action).toBe("suppress");
  });
});
