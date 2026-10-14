import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_ACTIVE_PER_AGENT, openTaskLedger, type TaskRun, type TaskRunner } from "./task-ledger.js";

const input = { agentId: "coach", chatKey: "telegram:42", title: "Draft the weekly note", instructions: "Write it." };

/** a runner that only ends when its task is aborted — including a signal that was aborted before it started */
const untilAborted = (t: TaskRun) => new Promise<string>((_, reject) => {
  if (t.signal.aborted) reject(new Error("aborted"));
  t.signal.addEventListener("abort", () => reject(new Error("aborted")));
});

function runner(run: (t: TaskRun) => Promise<string>) {
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

  it("limits active tasks per agent", async () => {
    const { r } = runner(untilAborted);
    const ledger = await openTaskLedger({ runner: r });
    try {
      for (let i = 0; i < MAX_ACTIVE_PER_AGENT; i++) await ledger.start({ ...input, title: `t${i}` });
      await expect(ledger.start(input)).rejects.toThrow(/active tasks/);
      await expect(ledger.start({ ...input, agentId: "knower" })).resolves.toBeTruthy();
    } finally { await ledger.close(); }
  });
});
