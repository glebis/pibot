import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BlockedError, MAX_ACTIVE_PER_AGENT, openTaskLedger, type Delivery, type TaskRun, type TaskRunner } from "./task-ledger.js";

const input = { agentId: "coach", chatKey: "telegram:42", title: "Draft the weekly note", instructions: "Write it." };

/** a runner that only ends when its task is aborted — including a signal that was aborted before it started */
const untilAborted = (t: TaskRun) => new Promise<string>((_, reject) => {
  if (t.signal.aborted) reject(new Error("aborted"));
  t.signal.addEventListener("abort", () => reject(new Error("aborted")));
});

function runner(run: (t: TaskRun) => Promise<string | { text: string; delivery?: Omit<Delivery, "deliveredAt"> }>) {
  const notes: string[] = [];
  const r: TaskRunner = { run: vi.fn(run), notify: vi.fn(async (_ck: string, text: string) => { notes.push(text); }) };
  return { r, notes };
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

describe("durable task ledger", () => {
  it("runs a task, records the result and notifies the owner chat", async () => {
    const { r, notes } = runner(async (t) => `done: ${t.title}`);
    const ledger = await openTaskLedger({ runner: r });
    try {
      const started = await ledger.start(input);
      expect(started.status).toBe("queued");
      const done = await until(() => ledger.get(started.id), (e) => e?.status === "done");
      expect(done).toMatchObject({ result: "done: Draft the weekly note", attempts: 1 });
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task done");
      expect((r.run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ attempt: 1, resumed: false, taskId: started.id });
      expect((await ledger.list({ agentId: "coach" })).map((e) => e.id)).toEqual([started.id]);
      expect(await ledger.list({ agentId: "other" })).toEqual([]);
    } finally { await ledger.close(); }
  });

  it("starts a task only once per request id", async () => {
    const { r } = runner(async () => "ok");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const a = await ledger.start(input, "req-1");
      const b = await ledger.start(input, "req-1");
      expect(b.id).toBe(a.id);
      await until(() => ledger.get(a.id), (e) => e?.status === "done");
      expect(r.run).toHaveBeenCalledTimes(1);
    } finally { await ledger.close(); }
  });

  it("treats an empty runner result as a failure instead of a fake success", async () => {
    const { r, notes } = runner(async () => "   ");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      expect(await until(() => ledger.get(t.id), (e) => e?.status === "failed")).toMatchObject({ error: "Task finished without a result summary" });
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task failed");
      expect(notes[0]).not.toContain("finished without a summary");
    } finally { await ledger.close(); }
  });

  it("records a failure and reports it", async () => {
    const { r, notes } = runner(async () => { throw new Error("tool exploded"); });
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      expect(await until(() => ledger.get(t.id), (e) => e?.status === "failed")).toMatchObject({ error: "tool exploded" });
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task failed");
    } finally { await ledger.close(); }
  });

  it("cancels a running task through its abort signal", async () => {
    let seen: AbortSignal | undefined;
    const { r, notes } = runner((t) => { seen = t.signal; return untilAborted(t); });
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      await until(() => ledger.get(t.id), (e) => e?.status === "running");
      expect(await ledger.cancel(t.id)).toBe(true);
      await until(() => ledger.get(t.id), (e) => e?.status === "cancelled");
      expect(seen?.aborted).toBe(true);
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("cancelled");
      expect(await ledger.cancel(t.id)).toBe(false);
    } finally { await ledger.close(); }
  });

  it("resumes after a crash with one more attempt that knows it was interrupted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-ledger-"));
    const first = runner(untilAborted);
    let ledger = await openTaskLedger({ runner: first.r, storageDir: dir });
    const t = await ledger.start(input);
    await until(() => ledger.get(t.id), (e) => e?.status === "running");
    await ledger.close(); // the process "dies" mid-run

    const second = runner(async (run) => `resumed=${run.resumed} attempt=${run.attempt}`);
    ledger = await openTaskLedger({ runner: second.r, storageDir: dir });
    try {
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done).toMatchObject({ result: "resumed=true attempt=2", attempts: 2 });
      expect(second.r.run).toHaveBeenCalledTimes(1);
    } finally { await ledger.close(); }
  });

  it("finds the newest active task for an agent and chat", async () => {
    const { r } = runner(untilAborted);
    const ledger = await openTaskLedger({ runner: r });
    try {
      const first = await ledger.start({ ...input, title: "old" });
      const second = await ledger.start({ ...input, title: "new" });
      expect((await ledger.latestActive(input.agentId, input.chatKey))?.id).toBe(second.id);
      await ledger.cancel(second.id);
      await until(() => ledger.get(second.id), (e) => e?.status === "cancelled");
      expect((await ledger.latestActive(input.agentId, input.chatKey))?.id).toBe(first.id);
    } finally { await ledger.close(); }
  });

  it("limits active tasks per agent", async () => {
    const { r } = runner(untilAborted);
    const ledger = await openTaskLedger({ runner: r });
    try {
      for (let i = 0; i < MAX_ACTIVE_PER_AGENT; i++) await ledger.start({ ...input, title: `t${i}` });
      await expect(ledger.start(input)).rejects.toThrow(/active tasks/);
      await expect(ledger.start({ ...input, agentId: "knower" })).resolves.toBeTruthy();
    } finally { await ledger.close(); }
  });

  // ─── programmatic fact-check (bd pibot-wr9m) ───

  it("persists and annotates inconsistent arithmetic instead of passing it silently", async () => {
    const { r, notes } = runner(async () => "The batch is 15% of 2,000 is 450 — great news.");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!.factCheck).toMatchObject({ checked: 1, inconsistent: 1 });
      expect(done!.result).toContain("⚠️ fact-check");
      expect(notes[0]).toContain("⚠️ fact-check");
    } finally { await ledger.close(); }
  });

  it("keeps clean numeric results fact-check-verified with no annotation", async () => {
    const { r } = runner(async () => "15% of 2,000 is 300, and 40 + 60 = 100.");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!.factCheck).toMatchObject({ checked: 2, inconsistent: 0 });
      expect(done!.result).not.toContain("fact-check");
    } finally { await ledger.close(); }
  });

  // ─── verified completion gate (bd pibot-zy70) ───

  it("marks done and records the delivery receipt when the expected medium matches", async () => {
    const { r, notes } = runner(async () => ({ text: "here is your note", delivery: { messageId: 7, mediaType: "video_note", peer: "telegram:42", account: "@pibot", idProtocol: "bot_api" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!).toMatchObject({ result: "here is your note", delivery: { messageId: 7, mediaType: "video_note", peer: "telegram:42", account: "@pibot", idProtocol: "bot_api" } });
      expect(done!.delivery?.deliveredAt).toBeTruthy();
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task done");
    } finally { await ledger.close(); }
  });

  it("records partial when the delivered medium is not the requested one", async () => {
    const { r, notes } = runner(async () => ({ text: "a normal video", delivery: { messageId: 8, mediaType: "video" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.result).toBe("a normal video");
      expect(entry!.error).toContain("requested video_note but delivered video");
      expect(entry!.delivery).toMatchObject({ messageId: 8, mediaType: "video" });
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task partial");
      expect(notes[0]).not.toContain("Task done");
    } finally { await ledger.close(); }
  });

  it.each([undefined, 0, -1, 1.5])("requires a valid result message id, not just the medium (%s)", async (messageId) => {
    const { r } = runner(async () => ({ text: "round note", delivery: { mediaType: "video_note", ...(messageId !== undefined ? { messageId } : {}) } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial" || e?.status === "done");
      expect(entry!.status).toBe("partial");
      expect(entry!.error).toContain("message ID");
    } finally { await ledger.close(); }
  });

  it("records partial when the runner asked-for medium was never verified", async () => {
    const { r } = runner(async () => "wrote the text only");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.error).toContain("not verified");
    } finally { await ledger.close(); }
  });

  it("keeps a plain text task done with the notice message id as its receipt", async () => {
    const { r } = runner(async () => "plain text result");
    const notes: string[] = [];
    const ledger = await openTaskLedger({
      runner: {
        run: r.run,
        notify: vi.fn(async (ck: string, text: string) => { notes.push(text); return { messageId: 55, peer: ck }; }),
      },
    });
    try {
      const t = await ledger.start(input);
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      // the notice push targets the task's chat, so it is a valid peer for a text receipt
      expect(done!.delivery).toMatchObject({ messageId: 55, peer: input.chatKey, evidence: "ack" });
      expect(done!.delivery?.mediaType).toBeUndefined();
      expect(done!.delivery?.deliveredAt).toBeTruthy();
      await until(async () => notes.length, (n) => n === 1);
    } finally { await ledger.close(); }
  });

  // ─── destination-aware receipt tuple (bd pibot-cida) ───

  it("records the full receipt tuple and marks done when destination, type and id all verify", async () => {
    const delivery = { messageId: 578379, mediaType: "video_note", peer: "telegram:42", account: "@pibot", idProtocol: "bot_api", evidence: "ack" as const };
    const { r } = runner(async () => ({ text: "round note", delivery }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!.delivery).toMatchObject(delivery);
    } finally { await ledger.close(); }
  });

  it("records the id namespace verbatim so Bot API and MTProto ids are never conflated", async () => {
    const { r } = runner(async () => ({ text: "note", delivery: { messageId: 42, mediaType: "video_note", peer: "telegram:42", account: "@pibot", idProtocol: "mtproto" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!.delivery?.idProtocol).toBe("mtproto");
    } finally { await ledger.close(); }
  });

  it("records partial when the receipt names no bot account (an id is not an account)", async () => {
    const { r } = runner(async () => ({ text: "round note", delivery: { messageId: 7, mediaType: "video_note", peer: "telegram:42", idProtocol: "bot_api" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.error).toContain("no sending account");
      expect(entry!.status).toBe("partial");
    } finally { await ledger.close(); }
  });

  it("records partial when the receipt's account is the agent id, not a bot account", async () => {
    // The exact bd pibot-cida failure: the agent's own id must never stand in for the bot identity.
    const { r } = runner(async () => ({ text: "round note", delivery: { messageId: 7, mediaType: "video_note", peer: "telegram:42", account: "coach", idProtocol: "bot_api" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, agentId: "coach", expectedMedia: "video_note" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.error).toContain("agent id \"coach\", not a bot account");
    } finally { await ledger.close(); }
  });

  it("records partial when the receipt names no id namespace", async () => {
    const { r } = runner(async () => ({ text: "round note", delivery: { messageId: 7, mediaType: "video_note", peer: "telegram:42", account: "@pibot" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.error).toContain("no id namespace");
    } finally { await ledger.close(); }
  });

  it("compares the expected bot account and id namespace when the caller defined them", async () => {
    const { r } = runner(async () => ({ text: "note", delivery: { messageId: 7, mediaType: "video_note", peer: "telegram:42", account: "@otherbot", idProtocol: "bot_api" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note", expectedAccount: "@pibot" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.error).toContain("sent as @otherbot instead of @pibot");
    } finally { await ledger.close(); }
  });

  it("checks a deliberately different target against ITSELF, not the origin chat", async () => {
    // Owner asked for Saved Messages: the receipt must attest THAT target. delivered-to-origin is a
    // mismatch against the explicit expectedPeer, and vice versa is a pass.
    const { r } = runner(async () => ({ text: "saved", delivery: { messageId: 7, mediaType: "video_note", peer: "telegram:saved", account: "@pibot", idProtocol: "bot_api" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note", expectedPeer: "telegram:saved" });
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!.delivery).toMatchObject({ peer: "telegram:saved" });

      const t2 = await ledger.start({ ...input, title: "origin is a mismatch here", expectedMedia: "video_note", expectedPeer: "telegram:99" });
      const partial = await until(() => ledger.get(t2.id), (e) => e?.status === "partial");
      expect(partial!.error).toContain("delivered to telegram:saved instead of telegram:99");
    } finally { await ledger.close(); }
  });

  it("records partial when the same message id came from a different destination", async () => {
    // The MHT case: a valid-looking id/type that actually lived in another dialogue than claimed.
    const { r, notes } = runner(async () => ({ text: "round note", delivery: { messageId: 7, mediaType: "video_note", peer: "telegram:99" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.error).toContain("delivered to telegram:99 instead of telegram:42");
      expect(entry!.delivery).toMatchObject({ messageId: 7, mediaType: "video_note", peer: "telegram:99" });
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task partial");
      expect(notes[0]).not.toContain("Task done");
    } finally { await ledger.close(); }
  });

  it("records partial when the receipt names no destination (an id alone is not proof)", async () => {
    const { r } = runner(async () => ({ text: "round note", delivery: { messageId: 7, mediaType: "video_note" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video_note" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.error).toContain("destination unverified");
      expect(entry!.status).toBe("partial");
    } finally { await ledger.close(); }
  });

  it("records blocked when the runner cannot proceed, not failed-with-retry", async () => {
    const { r, notes } = runner(async () => { throw new BlockedError("no telegram token for the lab bot"); });
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "blocked");
      expect(entry!.blocker).toBe("no telegram token for the lab bot");
      expect(entry!.error).toBeUndefined();
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task blocked");
    } finally { await ledger.close(); }
  });

  it("stops claiming done when the result was never delivered", async () => {
    const { r } = runner(async () => "great result nobody saw");
    const notes: string[] = [];
    const ledger = await openTaskLedger({
      runner: {
        run: r.run,
        notify: vi.fn(async (_ck: string, _text: string) => { notes.push(_text); throw new Error("transport wedged"); }),
      },
    });
    try {
      const t = await ledger.start(input);
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.blocker).toContain("delivery failed");
      expect(entry!.blocker).toContain("transport wedged");
      expect(entry!.result).toBe("great result nobody saw");
    } finally { await ledger.close(); }
  });

  // ─── relative-date correction (bd pibot-wr9m) ───

  it("rewrites a mis-stated Russian relative date from the absolute date it sits beside", async () => {
    // The documented incident: on 26 Oct the reminder called the 2 Nov deadline "сегодня".
    const OCT26 = Date.UTC(2026, 9, 26, 7, 32);
    const { r, notes } = runner(async () => "Дедлайн сегодня — 2 ноября. Успеть бы.");
    const ledger = await openTaskLedger({ runner: r, now: () => OCT26 });
    try {
      const t = await ledger.start(input);
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!.result).toContain("через 7 дней");
      expect(done!.result).not.toContain("сегодня");
      expect(done!.dateCheck).toMatchObject({ inconsistent: 1, corrected: true });
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("через 7 дней");
      expect(notes[0]).not.toContain("сегодня");
    } finally { await ledger.close(); }
  });

  it("rewrites an English relative date and leaves an unambiguous correct one untouched", async () => {
    const OCT26 = Date.UTC(2026, 9, 26, 7, 32);
    const { r } = runner(async () => "The deadline is today, November 2 — please confirm.");
    const ledger = await openTaskLedger({ runner: r, now: () => OCT26 });
    try {
      const t = await ledger.start(input);
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!.result).toContain("in 7 days");
      expect(done!.result).not.toMatch(/\btoday\b/);
      expect(done!.dateCheck).toMatchObject({ inconsistent: 1, corrected: true });

      // a claim that agrees with the calendar is left alone (no dateCheck at all)
      const { r: ok } = runner(async () => "The deadline is in 7 days, November 2.");
      const ledger2 = await openTaskLedger({ runner: ok, now: () => OCT26 });
      try {
        const t2 = await ledger2.start({ ...input, title: "clean" });
        const clean = await until(() => ledger2.get(t2.id), (e) => e?.status === "done");
        expect(clean!.dateCheck).toBeUndefined();
        expect(clean!.result).toContain("in 7 days");
      } finally { await ledger2.close(); }
    } finally { await ledger.close(); }
  });

  it("leaves prose where a relative word merely co-occurs with a date untouched (bd pibot-wr9m review)", async () => {
    const OCT26 = Date.UTC(2026, 9, 26, 7, 32);
    const { r } = runner(async () => "Today I checked the page for the November 2 deadline.");
    const ledger = await openTaskLedger({ runner: r, now: () => OCT26 });
    try {
      const t = await ledger.start(input);
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done!.result).toBe("Today I checked the page for the November 2 deadline.");
      expect(done!.dateCheck).toBeUndefined();
    } finally { await ledger.close(); }
  });

  it("does not present an unrewritable relative-date result as done", async () => {
    // A clause we cannot safely rewrite (blocked) must become partial, never ✅ done.
    const OCT26 = Date.UTC(2026, 9, 26, 7, 32);
    const { r, notes } = runner(async () => "today and today, November 2");
    const ledger = await openTaskLedger({ runner: r, now: () => OCT26 });
    try {
      const t = await ledger.start(input);
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry!.error).toContain("could not be corrected safely");
      expect(entry!.dateCheck).toMatchObject({ blocked: true });
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task partial");
      expect(notes[0]).not.toContain("Task done");
    } finally { await ledger.close(); }
  });
});
