// Offline compaction of the pi-durable task ledger (bd pibot-b708).
//
// The backend appends one marker per commit to main.jsonl and never rewrites it; only
// doc-/task- sidecars are reclaimed. There is no supported compaction entry point, so the
// safe path is: export the document value, write it into a FRESH directory in one commit,
// verify, and swap the directories while nothing else holds the ledger.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactTaskLedger, measureLedgerReplay, LedgerBusyError } from "./compact-ledger.js";
import { openTaskLedger } from "./task-ledger.js";

const runner = { run: async () => "done", notify: async () => undefined };

let root: string;
let dir: string;
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-compact-"));
  dir = path.join(root, "tasks");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
});
afterEach(() => {
  vi.mocked(console.warn).mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

const lines = (file: string): number => fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;

/** Build a ledger with `n` finished tasks, so its marker log has real history. */
async function seedLedger(n: number): Promise<void> {
  const ledger = await openTaskLedger({ runner, storageDir: dir, label: "seed" });
  for (let i = 0; i < n; i++) {
    const task = await ledger.start({ agentId: "pibot-dev", chatKey: "telegram:1", title: `task ${i}`, instructions: "do the thing" }, `req-${i}`);
    await ledger.cancel(task.id);
  }
  await new Promise((r) => setTimeout(r, 200));
  await ledger.close();
}

describe("compactTaskLedger (bd pibot-b708)", () => {
  it("rebuilds history into a single marker and keeps the original as a backup", async () => {
    await seedLedger(12);
    const mainFile = path.join(dir, "main.jsonl");
    const linesBefore = lines(mainFile);
    const bytesBefore = fs.statSync(mainFile).size;
    expect(linesBefore).toBeGreaterThan(12); // one marker per commit, as advertised

    const result = await compactTaskLedger({ storageDir: dir, agentIds: ["pibot-dev"] });

    expect(result.linesBefore).toBe(linesBefore);
    expect(result.linesAfter).toBeLessThan(result.linesBefore);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.tasks).toBe(12);
    // the original directory survives untouched next to the rebuilt one
    expect(fs.existsSync(path.join(result.backupDir, "main.jsonl"))).toBe(true);
    expect(fs.statSync(path.join(result.backupDir, "main.jsonl")).size).toBe(bytesBefore);

    // and the rebuilt ledger reads back the same task history
    const reopened = await openTaskLedger({ runner, storageDir: dir, label: "verify" });
    const tasks = await reopened.list({ agentId: "pibot-dev" });
    expect(tasks).toHaveLength(12);
    expect(new Set(tasks.map((t) => t.title))).toEqual(new Set(Array.from({ length: 12 }, (_, i) => `task ${i}`)));
    await reopened.close();
  });

  it("preserves the requestId idempotency map, so a retried start still replays", async () => {
    let calls = 0;
    const counting = { run: async () => { calls += 1; return "ran"; }, notify: async () => undefined };
    const ledger = await openTaskLedger({ runner: counting, storageDir: dir, label: "seed" });
    const first = await ledger.start({ agentId: "pibot-dev", chatKey: "telegram:1", title: "once", instructions: "x" }, "req-once");
    await ledger.cancel(first.id);
    // the abort settles the ledger entry on a later commit: wait for it to reach a
    // terminal state, exactly as an operator would before compacting
    for (let i = 0; i < 100 && (await ledger.get(first.id))?.status !== "cancelled"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await ledger.get(first.id))?.status).toBe("cancelled");
    await ledger.close();

    await compactTaskLedger({ storageDir: dir, agentIds: ["pibot-dev"] });

    const reopened = await openTaskLedger({ runner: counting, storageDir: dir, label: "verify" });
    const replayed = await reopened.start({ agentId: "pibot-dev", chatKey: "telegram:1", title: "once", instructions: "x" }, "req-once");
    expect(replayed.id).toBe(first.id); // exactly-once survived the rewrite
    expect(calls).toBe(0);
    await reopened.close();
  });

  it("refuses while a task is still active instead of restarting or orphaning it", async () => {
    const ledger = await openTaskLedger({ runner, storageDir: dir, label: "seed" });
    const live = await ledger.start({ agentId: "pibot-dev", chatKey: "telegram:1", title: "long job", instructions: "x" }, "req-live");
    await ledger.close();
    expect(live.status === "queued" || live.status === "running").toBe(true);

    await expect(compactTaskLedger({ storageDir: dir, agentIds: ["pibot-dev"] })).rejects.toThrow(LedgerBusyError);
    await expect(compactTaskLedger({ storageDir: dir, agentIds: ["pibot-dev"] })).rejects.toThrow(/still active/);
    // nothing was touched
    expect(fs.readdirSync(root).filter((n) => n.includes(".compact-"))).toEqual([]);
  });

  it("refuses while another process holds the directory", async () => {
    await seedLedger(3);
    const holder = await openTaskLedger({ runner, storageDir: dir, label: "the daemon" });
    await expect(compactTaskLedger({ storageDir: dir, agentIds: ["pibot-dev"] })).rejects.toThrow(LedgerBusyError);
    await expect(compactTaskLedger({ storageDir: dir, agentIds: ["pibot-dev"] })).rejects.toThrow(/Stop the daemon first/);
    await holder.close();
  });

  it("reports the measured boot replay cost of the ledger it just shrank", async () => {
    await seedLedger(15);
    const before = await measureLedgerReplay(dir, ["pibot-dev"]);
    expect(before.tasks).toBe(15);
    expect(before.lines).toBeGreaterThan(15);
    expect(before.openMs).toBeGreaterThanOrEqual(0);

    const result = await compactTaskLedger({ storageDir: dir, agentIds: ["pibot-dev"] });
    const after = await measureLedgerReplay(dir, ["pibot-dev"]);
    expect(after.tasks).toBe(15);
    expect(after.lines).toBeLessThan(before.lines);
    expect(after.bytes).toBeLessThan(before.bytes);
    expect(result.linesAfter).toBe(after.lines);
  });
});

describe("ledger snapshot round-trip (bd pibot-b708)", () => {
  it("writes the whole document in one commit and refuses a non-empty target", async () => {
    await seedLedger(4);
    const source = await openTaskLedger({ runner, storageDir: dir, label: "source" });
    const snapshot = await source.exportSnapshot();
    await source.close();
    expect(Object.keys(snapshot.tasks)).toHaveLength(4);

    const other = path.join(root, "target");
    fs.mkdirSync(other, { recursive: true });
    const target = await openTaskLedger({ runner, storageDir: other, label: "target" });
    await target.importSnapshot(snapshot);
    expect(await target.list({ agentId: "pibot-dev" })).toHaveLength(4);
    // a second import is a rebase onto a populated ledger: refused, not merged
    await expect(target.importSnapshot(snapshot)).rejects.toThrow(/already holds a ledger/);
    await target.close();
  });
});
