// Durable outbound delivery on the live Telegram push path (bd pibot-qy88).
// Before this, dedupe lived in a 30 s in-memory map and the send chain was a
// process-local promise, so a restart both forgot what it owed and forgot what it
// had already sent. These tests drive the real `push`/`notifyError` paths.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramTransport } from "./telegram.js";

let dir: string;
let ledger: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-ledger-"));
  ledger = path.join(dir, "deliveries.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A transport whose Bot API is a scripted fake; `sent` records what actually left. */
function transportWith(api: Record<string, unknown>, ledgerPath: string | undefined = ledger) {
  const t = new TelegramTransport("123:test", ["42"], { nameSuffix: "coach", ...(ledgerPath ? { deliveryLedgerPath: ledgerPath } : {}) });
  (t as unknown as { bot: { api: Record<string, unknown> } }).bot = { api };
  (t as unknown as { me: { id: number; username: string; first_name: string } }).me = { id: 4242, username: "pibot", first_name: "PiBot" };
  return t;
}

const okApi = (sent: Array<{ chatId: string; text: string }>) => ({
  sendMessage: async (chatId: string, text: string) => {
    sent.push({ chatId, text });
    return { message_id: sent.length, chat: { id: Number(chatId) } };
  },
});

const read = () => JSON.parse(fs.readFileSync(ledger, "utf8")) as { rows: Array<Record<string, unknown>> };

describe("durable delivery on push (bd pibot-qy88)", () => {
  it("records the message before it sends and marks it delivered after", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const t = transportWith(okApi(sent));
    await t.push("42", { text: "hello", dedupeKey: "turn:1" });
    expect(sent).toHaveLength(1);
    const rows = read().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chatId: "42", dedupeKey: "turn:1", state: "delivered", attempts: 1 });
  });

  it("suppresses a dedupeKey already delivered by a PREVIOUS process", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const first = transportWith(okApi(sent));
    await first.push("42", { text: "only once", dedupeKey: "question:q_abc" });
    expect(sent).toHaveLength(1);

    // a new process with the same on-disk ledger
    const second = transportWith(okApi(sent));
    await second.push("42", { text: "only once", dedupeKey: "question:q_abc" });
    expect(sent).toHaveLength(1); // no second send
  });

  it("does not treat the same dedupeKey in a different chat as a duplicate", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const t = transportWith(okApi(sent));
    await t.push("42", { text: "hi", dedupeKey: "turn:1" });
    await t.push("84", { text: "hi", dedupeKey: "turn:1" });
    expect(sent.map((s) => s.chatId)).toEqual(["42", "84"]);
  });

  it("still sends two identical replies that carry different turn keys", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const t = transportWith(okApi(sent));
    await t.push("42", { text: "same text", dedupeKey: "turn:1" });
    await t.push("42", { text: "same text", dedupeKey: "turn:2" });
    expect(sent).toHaveLength(2);
  });

  it("marks a definitive refusal failed and does not resend it at boot", async () => {
    const t = transportWith({
      sendMessage: async () => {
        throw Object.assign(new Error("Bad Request: chat not found"), { error_code: 400, description: "Bad Request: chat not found" });
      },
    });
    await expect(t.push("42", { text: "nope", dedupeKey: "turn:9" })).rejects.toThrow(/chat not found/);
    const recovery = t.deliveryRecovery();
    expect(recovery.owed).toHaveLength(0);
    expect(recovery.ambiguous.map((r) => r.state)).toEqual(["failed"]);
    expect(recovery.ambiguous[0].error).toMatch(/chat not found/);
  });

  it("leaves an ambiguous send unconfirmed, never as owed, and refuses to resend it", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const t = transportWith({
      sendMessage: async () => {
        throw new Error("telegram api call timed out after 30000ms (chat 42)");
      },
    });
    await expect(t.push("42", { text: "maybe", dedupeKey: "turn:3" })).rejects.toThrow(/timed out/);
    // the in-process retry already re-claimed the row; after a restart it reads as unknown
    const reopened = transportWith(okApi(sent));
    const recovery = reopened.deliveryRecovery();
    expect(recovery.owed).toHaveLength(0);
    expect(recovery.ambiguous.map((r) => r.state)).toEqual(["unknown"]);
    await reopened.push("42", { text: "maybe", dedupeKey: "turn:3" });
    expect(sent).toHaveLength(0); // not resent: the outcome is unknown
  });

  it("replays a message a previous process owed but never sent", async () => {
    // a row that exists and was never attempted: exactly the crash-before-send case
    const t = transportWith(okApi([]));
    const guard = (t as unknown as { deliveries: { claim: (i: { transport: string; chatId: string; dedupeKey: string; text: string }) => unknown } }).deliveries;
    guard.claim({ transport: "telegram:coach", chatId: "42", dedupeKey: "turn:owed", text: "I owed this" });

    const sent: Array<{ chatId: string; text: string }> = [];
    const reopened = transportWith(okApi(sent));
    const { owed } = reopened.deliveryRecovery();
    expect(owed.map((r) => r.dedupeKey)).toEqual(["turn:owed"]);
    expect(await reopened.replayOwed(owed[0])).toBe(true);
    expect(sent.map((s) => s.text)).toEqual(["I owed this"]);
    expect(reopened.deliveryRecovery().owed).toHaveLength(0);
  });

  it("keeps error notices deduped durably instead of in a 30 s map", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const t = transportWith(okApi(sent));
    await t.notifyError("42", "provider down");
    await t.notifyError("42", "provider down");
    expect(sent).toHaveLength(1); // repeated notice suppressed within the process

    const second = transportWith(okApi(sent));
    await second.notifyError("42", "provider down");
    expect(sent).toHaveLength(1); // and still suppressed after a restart
  });

  it("does not let the ledger block a different notice", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const t = transportWith(okApi(sent));
    await t.notifyError("42", "first failure");
    await t.notifyError("42", "second failure");
    expect(sent).toHaveLength(2);
  });

  it("works without a ledger file (in-memory) so tests and owner-less runs are unaffected", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const t = transportWith(okApi(sent), undefined);
    await t.push("42", { text: "no file", dedupeKey: "k" });
    expect(sent).toHaveLength(1);
  });

  it("writes the ledger owner-only", async () => {
    const t = transportWith(okApi([]));
    await t.push("42", { text: "secret-ish", dedupeKey: "k" });
    expect(fs.statSync(ledger).mode & 0o777).toBe(0o600);
  });
});
