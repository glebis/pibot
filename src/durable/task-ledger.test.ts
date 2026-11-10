import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BlockedError, MAX_ACTIVE_PER_AGENT, openTaskLedger, TaskDeadlineError, taskDecisionKey, type TaskLedger, type TaskDecision, type TaskRun, type TaskRunner, type TaskRunResult, ownerReport } from "./task-ledger.js";
import { formatDelegateEvidence } from "../core/task-reconcile.js";

const input = { agentId: "coach", chatKey: "telegram:42", title: "Draft the weekly note", instructions: "Write it." };

/** a runner that only ends when its task is aborted — including a signal that was aborted before it started */
const untilAborted = (t: TaskRun) => new Promise<string>((_, reject) => {
  if (t.signal.aborted) reject(new Error("aborted"));
  t.signal.addEventListener("abort", () => reject(new Error("aborted")));
});

function runner(run: (t: TaskRun) => Promise<string | TaskRunResult>) {
  const notes: string[] = [];
  const r: TaskRunner = { run: vi.fn(run), notify: vi.fn(async (_ck: string, text: string) => { notes.push(text); }) };
  return { r, notes };
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v as NonNullable<T>;
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

  it("discloses the result cap instead of silently cutting a long output", async () => {
    const { r, notes } = runner(async () => "y".repeat(5000));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done?.result).toMatch(/\[truncated: showing the first 4000 of 5000 characters/);
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toMatch(/\[truncated: showing the first 4000 of 5000 characters/);
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

  // ─── correlated partial output and append-only evidence (bd pibot-jiqv) ───

  it("records a runner-reported partial result and its evidence, never done or failed", async () => {
    const { r, notes } = runner(async () => ({
      text: "Delegate reply: transcript ready",
      status: "partial" as const,
      partialReason: "deadline reached; filing pending",
      evidence: "Delegate pibot-dev returned a reply: /tmp/a.txt",
    }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      const partial = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(partial).toMatchObject({ status: "partial", result: "Delegate reply: transcript ready", error: "deadline reached; filing pending" });
      expect(partial?.evidence).toContain("/tmp/a.txt");
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task partial");
      expect(notes[0]).not.toContain("Task done");
      expect(notes[0]).not.toContain("Task failed");
    } finally { await ledger.close(); }
  });

  it("never flips a done record to partial, but does store appended evidence", async () => {
    const { r } = runner(async () => "work finished");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const done = await ledger.start({ ...input, title: "done task" });
      await until(() => ledger.get(done.id), (e) => e?.status === "done");
      const amended = await ledger.appendEvidence(done.id, "late note /tmp/late.txt", { cause: "deadline" });
      expect(amended).toMatchObject({ status: "done" });
      expect(amended?.evidence).toContain("/tmp/late.txt");
    } finally { await ledger.close(); }
  });

  it("promotes a DEADLINE failure to partial, but preserves an arbitrary failure", async () => {
    const deadlineLedger = await openTaskLedger({ runner: runner(async () => { throw new TaskDeadlineError("Task took longer than X minutes and was stopped."); }).r });
    try {
      const f = await deadlineLedger.start({ ...input, title: "deadline task" });
      await until(() => deadlineLedger.get(f.id), (e) => e?.status === "failed");
      const amended = await deadlineLedger.appendEvidence(f.id, "late delegate reply /tmp/late.txt", { cause: "deadline", usable: true });
      expect(amended).toMatchObject({ status: "partial", evidenceUsable: true });
      expect(amended?.evidence).toContain("/tmp/late.txt");
      expect(amended?.usableReceipt).toContain("/tmp/late.txt");
      expect(amended?.error).toBeUndefined();
      expect(amended?.blocker).toContain("filing/delivery is still unconfirmed");
    } finally { await deadlineLedger.close(); }

    const errorLedger = await openTaskLedger({ runner: runner(async () => { throw new Error("model exploded"); }).r });
    try {
      const f = await errorLedger.start({ ...input, title: "error task" });
      await until(() => errorLedger.get(f.id), (e) => e?.status === "failed");
      // Caller passes deadline+usable, but the RECORD was not a deadline failure: must stay failed.
      const amended = await errorLedger.appendEvidence(f.id, "late delegate reply /tmp/late.txt", { cause: "deadline", usable: true });
      expect(amended).toMatchObject({ status: "failed" }); // never relabel an arbitrary failure a deadline
      expect(amended?.evidence).toContain("/tmp/late.txt");
    } finally { await errorLedger.close(); }
  });

  it("keeps a cancelled outcome cancelled when evidence is appended", async () => {
    const { r } = runner(untilAborted);
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      await until(() => ledger.get(t.id), (e) => e?.status === "running");
      expect(await ledger.cancel(t.id)).toBe(true);
      await until(() => ledger.get(t.id), (e) => e?.status === "cancelled");
      const amended = await ledger.appendEvidence(t.id, "late delegate reply /tmp/late.txt", { cause: "deadline" });
      expect(amended).toMatchObject({ status: "cancelled" });
      expect(amended?.evidence).toContain("/tmp/late.txt");
    } finally { await ledger.close(); }
  });

  it("dedupes concurrent appends inside the commit and bounds the stored evidence", async () => {
    const { r } = runner(async () => "done");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      await until(() => ledger.get(t.id), (e) => e?.status === "done");
      await Promise.all([
        ledger.appendEvidence(t.id, "same note /tmp/x.txt", { cause: "late" }),
        ledger.appendEvidence(t.id, "same note /tmp/x.txt", { cause: "late" }),
      ]);
      let entry = await ledger.get(t.id);
      expect(entry?.evidence?.split("same note /tmp/x.txt").length).toBe(2); // exactly once

      await ledger.appendEvidence(t.id, `${"z".repeat(3500)}A`, { cause: "late" });
      await ledger.appendEvidence(t.id, `${"y".repeat(3500)}B`, { cause: "late" });
      entry = await ledger.get(t.id);
      expect((entry?.evidence ?? "").length).toBeLessThanOrEqual(6000);
      expect(entry?.evidence).toContain("[earlier evidence truncated]");
    } finally { await ledger.close(); }
  });

  it("protects a compact usable path while later refusal context evicts rolling evidence", async () => {
    const { r } = runner(async () => { throw new TaskDeadlineError("Task took longer than X minutes and was stopped."); });
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      await until(() => ledger.get(t.id), (e) => e?.status === "failed");
      await ledger.appendEvidence(t.id, formatDelegateEvidence([{ toAgentId: "child", text: "Saved transcript to /tmp/protected.txt", usable: true }])!, { cause: "deadline", usable: true });
      await ledger.appendEvidence(t.id, `BLOCKED: ${"x".repeat(3600)}`, { cause: "late", usable: false });
      await ledger.appendEvidence(t.id, `REFUSED: ${"y".repeat(3600)}`, { cause: "late", usable: false });
      const entry = await ledger.get(t.id);
      expect(entry?.status).toBe("partial");
      expect(entry?.evidence).not.toContain("/tmp/protected.txt");
      expect(entry?.usableReceipt).toContain("/tmp/protected.txt");
      expect(entry?.usableReceipt?.length).toBeLessThanOrEqual(1500);
      expect(entry?.evidence?.length).toBeLessThanOrEqual(6000);
    } finally { await ledger.close(); }
  });

  it("protects substantive no-path output from a formatted reply after context eviction", async () => {
    const ledger = await openTaskLedger({ runner: runner(async () => "done").r });
    try {
      const t = await ledger.start(input);
      await until(() => ledger.get(t.id), (e) => e?.status === "done");
      const report = formatDelegateEvidence([{ toAgentId: "child", text: "Summary:\nThe interview covers three hiring decisions.", usable: true }])!;
      await ledger.appendEvidence(t.id, report, { usable: true });
      await ledger.appendEvidence(t.id, `BLOCKED: ${"x".repeat(3600)}`, { usable: false });
      await ledger.appendEvidence(t.id, `REFUSED: ${"y".repeat(3600)}`, { usable: false });
      const entry = await ledger.get(t.id);
      expect(entry?.evidence).not.toContain("three hiring decisions");
      expect(entry?.usableReceipt).toContain("Summary: The interview covers three hiring decisions.");
      expect(entry?.usableReceipt).not.toContain("Remaining gate:");
    } finally { await ledger.close(); }
  });

  it("keeps a deadline failure partial when USABLE evidence lands while the run is still running", async () => {
    let ledger!: TaskLedger;
    const r = runner(async (run) => {
      await ledger.appendEvidence(run.taskId, "receipt /tmp/race.txt", { cause: "late", usable: true });
      throw new TaskDeadlineError("Task took longer than X minutes and was stopped.");
    });
    ledger = await openTaskLedger({ runner: r.r });
    try {
      const t = await ledger.start(input);
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry?.evidence).toContain("/tmp/race.txt");
      expect(entry?.result).toContain("/tmp/race.txt");
      expect(entry?.result).toContain("Remaining gate:");
      await until(async () => r.notes.length, (n) => n === 1);
      expect(r.notes[0]).toContain("/tmp/race.txt");
      expect(r.notes[0]).toContain("Remaining gate:");
    } finally { await ledger.close(); }
  });

  it("does NOT promote a deadline failure when only refusal context lands before the terminal commit", async () => {
    let ledger!: TaskLedger;
    const r = runner(async (run) => {
      // The child answered with a refusal/blocker, not usable output.
      await ledger.appendEvidence(run.taskId, "Delegate pibot-dev returned a reply reporting a refusal/blocker: BLOCKED", { cause: "deadline", usable: false });
      throw new TaskDeadlineError("Task took longer than X minutes and was stopped.");
    });
    ledger = await openTaskLedger({ runner: r.r });
    try {
      const t = await ledger.start(input);
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "failed");
      expect(entry?.evidence).toContain("BLOCKED");
      expect(entry?.evidenceUsable).toBeUndefined();
      expect(entry?.failure).toBe("deadline");
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
  // ─── expected-content readback (bd pibot-cida, Nov 4 creator note) ───

  const ADDITION = "as a meta-layer + allows you to see patterns, tensions, changes in quality of interactions";
  const NOTE = "/tmp/agents/creator/shape of work.md";
  const NOTE_BEFORE = "shape of work\n\nA plugin for your agent to illustrate what various parts of work look like";

  it("records partial when an incapable executor reports success but wrote nothing", async () => {
    // The real Nov 4 shape: "Task done" in the result text, "Not saved" in the body, file unchanged.
    const { r, notes } = runner(async () => ({ text: "Task done. Not saved: file access is unavailable, and the agent creating the note is busy.", readback: { path: NOTE, text: NOTE_BEFORE, afterWrite: false } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedContent: ADDITION, outputLocation: NOTE });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial" || e?.status === "done");
      expect(entry!.status).toBe("partial");
      expect(entry!.error).toContain("did not happen after the write");
      expect(entry!.readback).toMatchObject({ path: NOTE, afterWrite: false });
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task partial");
      // the head line decides the owner's read; the run's own "Task done" prose in the body is
      // exactly the claim this gate refuses to trust
      expect(notes[0].split("\n")[0]).not.toContain("Task done");
    } finally { await ledger.close(); }
  });

  it("records partial when the readback is post-write but lacks the exact addition", async () => {
    const { r } = runner(async () => ({ text: "Appended the meta-layer line.", readback: { path: NOTE, text: `${NOTE_BEFORE}\n\nas a meta-layer`, afterWrite: true } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedContent: ADDITION, outputLocation: NOTE });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status !== "running" && e?.status !== "queued");
      expect(entry!.status).toBe("partial");
      expect(entry!.error).toContain("does not contain it");
    } finally { await ledger.close(); }
  });

  it("records partial when the runner supplies no readback at all", async () => {
    const { r } = runner(async () => "Saved and re-read the note.");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedContent: ADDITION, outputLocation: NOTE });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status !== "running" && e?.status !== "queued");
      expect(entry!.status).toBe("partial");
      expect(entry!.error).toContain("no readback");
    } finally { await ledger.close(); }
  });

  it("records done once the readback proves the addition exactly once", async () => {
    const written = `${NOTE_BEFORE}\n\n${ADDITION}`;
    const { r, notes } = runner(async () => ({ text: "Appended and re-read.", readback: { path: NOTE, text: written, afterWrite: true } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedContent: ADDITION, outputLocation: NOTE });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status !== "running" && e?.status !== "queued");
      expect(entry!.status).toBe("done");
      expect(entry!.error).toBeUndefined();
      // exactly once: the continuation appended the sentence a single time
      expect(entry!.readback?.text.split(ADDITION)).toHaveLength(2);
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task done");
    } finally { await ledger.close(); }
  });

  it("matches the requested text across wrapped whitespace but not a partial sentence", async () => {
    const wrapped = `${NOTE_BEFORE}\n\nas a meta-layer + allows you to see\npatterns, tensions, changes in quality of interactions`;
    const { r } = runner(async () => ({ text: "ok", readback: { path: NOTE, text: wrapped, afterWrite: true } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedContent: ADDITION, outputLocation: NOTE });
      expect((await until(() => ledger.get(t.id), (e) => e?.status !== "running" && e?.status !== "queued"))!.status).toBe("done");
    } finally { await ledger.close(); }
  });

  it("records partial when the addition landed twice, so a retry cannot duplicate it silently", async () => {
    // "records the addition once under the same task" — a resumed attempt that appends the same
    // sentence again has changed the note twice, which is not the requested outcome.
    const twice = `${NOTE_BEFORE}\n\n${ADDITION}\n\n${ADDITION}`;
    const { r, notes } = runner(async () => ({ text: "Appended again.", readback: { path: NOTE, text: twice, afterWrite: true } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedContent: ADDITION, outputLocation: NOTE });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status !== "running" && e?.status !== "queued");
      expect(entry!.status).toBe("partial");
      expect(entry!.error).toContain("contains it 2 times");
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0].split("\n")[0]).not.toContain("Task done");
    } finally { await ledger.close(); }
  });

  it("records done on a resumed attempt that leaves the single addition in place", async () => {
    // Continuation shape: attempt 1 could not write; attempt 2 appends once and re-reads the note.
    const { r } = runner(async () => ({ text: "Appended the requested line.", readback: { path: NOTE, text: `${NOTE_BEFORE}\n\n${ADDITION}`, afterWrite: true } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedContent: ADDITION, outputLocation: NOTE });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status !== "running" && e?.status !== "queued");
      expect(entry!.status).toBe("done");
      expect(entry!.readback?.text.split(ADDITION)).toHaveLength(2);
    } finally { await ledger.close(); }
  });

  it("keeps the plain delivery gate when no expected content is named", async () => {
    const { r } = runner(async () => ({ text: "no readback supplied", readback: { path: NOTE, text: "", afterWrite: false } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      expect((await until(() => ledger.get(t.id), (e) => e?.status !== "running" && e?.status !== "queued"))!.status).toBe("done");
    } finally { await ledger.close(); }
  });

  it("records partial when the readback names a different artifact than the task's output location", async () => {
    const { r } = runner(async () => ({ text: "wrote elsewhere", readback: { path: "/tmp/other.md", text: ADDITION, afterWrite: true } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedContent: ADDITION, outputLocation: NOTE });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status !== "running" && e?.status !== "queued");
      expect(entry!.status).toBe("partial");
      expect(entry!.error).toContain("/tmp/other.md");
    } finally { await ledger.close(); }
  });
});

describe("recovery decision + verified artifact (bd pibot-0xpf.5)", () => {
  const decisionFor = (taskId: string, overrides: Partial<TaskDecision> = {}): TaskDecision => ({
    action: "restore the launch note",
    options: ["Restore from trash", "Leave it"],
    choice: "Restore from trash",
    optionIndex: 0,
    outcome: "approved",
    qid: "q_owner",
    questionKey: taskDecisionKey(taskId, "telegram:worker", "approval:abc"),
    source: "owner_question",
    ownerChatKey: "telegram:worker",
    answeredAt: 1_700_000_000_000,
    executor: "coach",
    ...overrides,
  });
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  it("persists an owner decision and reuses it on a resumed attempt after a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-decision-"));
    const first = runner(untilAborted);
    let ledger = await openTaskLedger({ runner: first.r, storageDir: dir });
    const t = await ledger.start(input);
    await until(() => ledger.get(t.id), (e) => e?.status === "running");
    const decision = decisionFor(t.id);
    const saved = await ledger.recordDecision(t.id, input.agentId, decision);
    expect(saved?.decisions?.[0]).toMatchObject({ source: "owner_question", choice: "Restore from trash", executor: "coach", outcome: "approved" });
    await ledger.close(); // the process "dies" mid-run

    let seen: TaskDecision[] | undefined;
    const second = runner(async (run) => { seen = run.decisions; return "restored"; });
    ledger = await openTaskLedger({ runner: second.r, storageDir: dir });
    try {
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(seen).toMatchObject([{ qid: "q_owner", choice: "Restore from trash", questionKey: decision.questionKey }]);
      expect(done.decisions?.[0]).toMatchObject({ source: "owner_question", choice: "Restore from trash" });
    } finally { await ledger.close(); }
  });

  it("keeps two distinct approvals separate and replays only the SAME decision after a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-decisions-"));
    const first = runner(untilAborted);
    let ledger = await openTaskLedger({ runner: first.r, storageDir: dir });
    const t = await ledger.start(input);
    await until(() => ledger.get(t.id), (e) => e?.status === "running");
    const restore = decisionFor(t.id);
    const remove = decisionFor(t.id, {
      action: "delete the draft",
      options: ["Delete", "Keep"],
      choice: "Delete",
      optionIndex: 0,
      questionKey: taskDecisionKey(t.id, "telegram:worker", "approval:delete"),
    });
    await ledger.recordDecision(t.id, input.agentId, restore);
    await ledger.recordDecision(t.id, input.agentId, remove);
    // a retried/late record of the SAME question cannot rewrite the accepted answer
    await ledger.recordDecision(t.id, input.agentId, { ...restore, choice: "Leave it", optionIndex: 1, outcome: "declined" });
    expect((await ledger.get(t.id))?.decisions).toHaveLength(2);
    expect((await ledger.get(t.id))?.decisions?.[0]?.choice).toBe("Restore from trash");
    expect((await ledger.get(t.id))?.decisions?.[1]?.action).toBe("delete the draft");
    await ledger.close();

    let seen: TaskDecision[] | undefined;
    const second = runner(async (run) => { seen = run.decisions; return "restored"; });
    ledger = await openTaskLedger({ runner: second.r, storageDir: dir });
    try {
      await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(seen?.map((d) => d.questionKey)).toEqual([restore.questionKey, remove.questionKey]);
    } finally { await ledger.close(); }
  });

  it("rejects a forged/relayed approval and never rewrites an accepted decision", async () => {
    const { r } = runner(untilAborted);
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      await until(() => ledger.get(t.id), (e) => e?.status === "running");
      // A sibling's "owner said yes" is not the canonical answer channel.
      await expect(ledger.recordDecision(t.id, input.agentId, { ...decisionFor(t.id), source: "sibling_relay" as never })).rejects.toThrow(/canonical owner answer/);
      expect((await ledger.get(t.id))?.decisions).toBeUndefined();
      await ledger.recordDecision(t.id, input.agentId, decisionFor(t.id));
      // another agent cannot stamp a decision onto someone else's task
      expect(await ledger.recordDecision(t.id, "knower", decisionFor(t.id))).toBeUndefined();
      // a non-namespaced or fabricated key is rejected before it can become provenance
      await expect(ledger.recordDecision(t.id, input.agentId, { ...decisionFor(t.id), questionKey: "global:decision" })).rejects.toThrow(/namespaced/);
      await expect(ledger.recordDecision(t.id, input.agentId, { ...decisionFor(t.id), qid: decisionFor(t.id).questionKey })).rejects.toThrow(/canonical question id/);
    } finally { await ledger.close(); }
  });

  it("keeps incomplete when only bookkeeping text changed and no artifact was verified", async () => {
    const { r, notes } = runner(async () => "Ledger updated: restore decision recorded, file pending.");
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedArtifactPath: "/tmp/never-restored.md" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry.error).toContain("bookkeeping text is not a restored artifact");
      expect(entry.artifact).toBeUndefined();
      await until(async () => notes.length, (n) => n === 1);
      expect(notes[0]).toContain("Task partial");
    } finally { await ledger.close(); }
  });

  it("permits done only with a host artifact readback receipt", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "task-artifact-")), "note.md");
    const bytes = Buffer.from("# restored\n");
    fs.writeFileSync(file, bytes);
    const { r } = runner(async () => ({ text: "restored", artifact: { path: file, bytes: bytes.length, sha256: hash(bytes), evidence: "readback", verification: "existence" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedArtifactPath: file });
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done.artifact).toMatchObject({ path: file, bytes: bytes.length, evidence: "readback", verification: "existence" });
      expect(done.artifact?.verifiedAt).toBeTruthy();
    } finally { await ledger.close(); }
  });

  it("records the byte-exact verification only when the declared original hash matches", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "task-artifact-exact-")), "note.md");
    const bytes = Buffer.from("# restored exactly\n");
    fs.writeFileSync(file, bytes);
    const digest = hash(bytes);
    const { r } = runner(async () => ({ text: "restored", artifact: { path: file, bytes: bytes.length, sha256: digest, evidence: "readback", verification: "byte-exact" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedArtifactPath: file, expectedArtifactSha256: digest });
      const done = await until(() => ledger.get(t.id), (e) => e?.status === "done");
      expect(done.artifact).toMatchObject({ verification: "byte-exact" });
      expect(done.artifact?.reconstructed).toBeUndefined();
    } finally { await ledger.close(); }
  });

  it("rejects a relative artifact path or a deliverable outside the declared scope", async () => {
    const { r } = runner(untilAborted);
    const ledger = await openTaskLedger({ runner: r });
    try {
      await expect(ledger.start({ ...input, expectedArtifactPath: "relative/note.md" })).rejects.toThrow(/absolute/);
      await expect(ledger.start({ ...input, expectedArtifactPath: "/tmp/outside/note.md", artifactScope: "/tmp/inside" })).rejects.toThrow(/outside the declared artifactScope/);
    } finally { await ledger.close(); }
  });

  it("labels a reconstructed artifact and stays partial when the original hash is known", async () => {
    const bytes = Buffer.from("rebuilt from the transcript\n");
    const { r } = runner(async () => ({ text: "reconstructed", artifact: { path: "/tmp/note.md", bytes: bytes.length, sha256: hash(bytes), evidence: "readback", verification: "existence", reconstructed: true } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedArtifactPath: "/tmp/note.md", expectedArtifactSha256: "0".repeat(64) });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry.error).toContain("reconstruction");
      expect(entry.artifact?.reconstructed).toBe(true);
    } finally { await ledger.close(); }
  });

  it("rejects a non-readback artifact claim as unverified", async () => {
    const { r } = runner(async () => ({ text: "restored", artifact: { path: "/tmp/note.md", bytes: 10, sha256: "ab", evidence: "ack" as never, verification: "existence" as const } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedArtifactPath: "/tmp/note.md" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry.error).toContain("not a host readback");
    } finally { await ledger.close(); }
  });

  it("preserves the accepted decision when execution is blocked by a missing capability", async () => {
    let ledger: import("./task-ledger.js").TaskLedger;
    const { r } = runner(async (run) => {
      await ledger.recordDecision(run.taskId, run.agentId, decisionFor(run.taskId));
      throw new BlockedError("this executor has no restore tool");
    });
    ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(input);
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "blocked");
      expect(entry.blocker).toContain("no restore tool");
      expect(entry.decisions?.[0]).toMatchObject({ source: "owner_question", choice: "Restore from trash" });
    } finally { await ledger.close(); }
  });

  it("records a wrong-bot-peer delivery as partial, never done (worker→dev→knower)", async () => {
    const task = { ...input, chatKey: "telegram:worker:8900", expectedMedia: "video" };
    const delivery = { messageId: 9, mediaType: "video", peer: "telegram:knower:8817", account: "@knower", idProtocol: "bot_api" };
    const { r } = runner(async () => ({ text: "two clips", delivery }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start(task);
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry.error).toContain("delivered to telegram:knower:8817 instead of telegram:worker:8900");
    } finally { await ledger.close(); }

    // the same content attested to the invoking peer is done
    const { r: ok } = runner(async () => ({ text: "two clips", delivery: { ...delivery, peer: "telegram:worker:8900", account: "@worker" } }));
    const ledger2 = await openTaskLedger({ runner: ok });
    try {
      const t = await ledger2.start(task);
      const done = await until(() => ledger2.get(t.id), (e) => e?.status === "done");
      expect(done.delivery).toMatchObject({ peer: "telegram:worker:8900" });
    } finally { await ledger2.close(); }
  });

  it("treats a different id namespace as unverified", async () => {
    const { r } = runner(async () => ({ text: "note", delivery: { messageId: 7, mediaType: "video", peer: "telegram:42", account: "@pibot", idProtocol: "mtproto" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedMedia: "video", expectedIdProtocol: "bot_api" });
      const entry = await until(() => ledger.get(t.id), (e) => e?.status === "partial");
      expect(entry.error).toContain("id protocol mtproto instead of bot_api");
    } finally { await ledger.close(); }
  });

  it("does not duplicate a text/delivery on a repeated start request", async () => {
    const { r } = runner(async () => ({ text: "clip", delivery: { messageId: 1, mediaType: "video", peer: "telegram:42", account: "@pibot", idProtocol: "bot_api" } }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const a = await ledger.start({ ...input, expectedMedia: "video" }, "req-once");
      const b = await ledger.start({ ...input, expectedMedia: "video" }, "req-once");
      expect(b.id).toBe(a.id);
      await until(() => ledger.get(a.id), (e) => e?.status === "done");
      expect(r.run).toHaveBeenCalledTimes(1);
    } finally { await ledger.close(); }
  });
});

describe("owner-facing task completion report (attention budget)", () => {
  it("keeps a short report whole", () => {
    const head = "✅ Task done: **x**";
    const text = ["Вердин verdict", "note path", "provenance"].join("\n");
    expect(ownerReport(head, text)).toBe(`${head}\n\n${text}`);
  });
  it("caps a long operational memo to its first lines plus a ledger pointer", () => {
    const head = "✅ Task done: **transcription**";
    const text = ["line one", "line two", "line three", "line four", "line five", "line twenty"].join("\n");
    const out = ownerReport(head, text);
    expect(out).toContain(head);
    expect(out).toContain("line one");
    expect(out).toContain("line four");
    expect(out).not.toContain("line five");
    expect(out).not.toContain("line twenty");
    expect(out).toContain("task log");
  });
});

// The merge combines independent append-content and restore-artifact contracts. Neither proof
// substitutes for the other when a task asks for both.
describe("combined content and artifact completion contracts", () => {
  const file = "/tmp/pibot-merge-contract-note.md";
  const addition = "Verified restoration provenance.";
  const artifact = { path: file, bytes: 34, sha256: "1".repeat(64), evidence: "readback" as const, verification: "existence" as const };

  it.each([
    { label: "content only", includeArtifact: false, content: addition, expected: "partial", reason: "no post-run readback" },
    { label: "artifact only", includeArtifact: true, content: "old content", expected: "partial", reason: "does not contain it" },
    { label: "both proofs", includeArtifact: true, content: addition, expected: "done", reason: undefined },
  ])("requires both proofs: $label", async ({ includeArtifact, content, expected, reason }) => {
    const { r } = runner(async () => ({
      text: "Restoration completed.",
      readback: { path: file, text: content, afterWrite: true },
      ...(includeArtifact ? { artifact } : {}),
    }));
    const ledger = await openTaskLedger({ runner: r });
    try {
      const t = await ledger.start({ ...input, expectedArtifactPath: file, expectedContent: addition, outputLocation: file });
      const entry = await until(() => ledger.get(t.id), (e) => Boolean(e && e.status !== "queued" && e.status !== "running"));
      expect(entry.status).toBe(expected);
      if (reason) expect(entry.error).toContain(reason);
      else expect(entry.error).toBeUndefined();
      expect(entry.readback?.text).toBe(content);
      if (includeArtifact) expect(entry.artifact).toMatchObject(artifact);
    } finally { await ledger.close(); }
  });
});
