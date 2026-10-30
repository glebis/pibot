// Offline compaction of a pi-durable task ledger (bd pibot-b708).
//
// WHY THIS IS A REWRITE AND NOT A BACKEND CALL
// The JSONL backend appends one commit marker per commit to main.jsonl and never rewrites
// it: `reclaimSidecars()` (node_modules/@earendil-works/pi-durable/dist/storage/jsonl/
// storage.js:382) prunes doc-/task- sidecars, and `document.retire` empties a retired
// doc's sidecar, but the marker log itself only grows. `KEEP_FINISHED` in task-ledger.ts
// bounds the document's logical size, not the log. There is no public `compact()` on
// Storage, JsonlStorage or the Harness — so the only supported way to shrink main.jsonl is
// to build a NEW storage directory that holds the same live state and swap it in while
// nothing holds the ledger.
//
// That is what this module does, and it is deliberately conservative:
//   • it refuses to run while any task is active — rebuilding mid-flight would either
//     restart or orphan real work, and a compacted ledger is not worth that;
//   • it refuses to run while another process holds the directory (the pibot-cea8 lock);
//   • it verifies the rebuilt ledger reads back identically BEFORE swapping anything;
//   • the original directory is kept as `<dir>.pre-compact-<ts>`, never deleted;
//   • the swap is two renames of directories that only this function can be holding.
// Worst case the daemon boots on the untouched original.

import * as fs from "node:fs";
import * as path from "node:path";
import { openTaskLedger, rewriteLedgerStorage, type TaskLedger } from "./task-ledger.js";
import { StorageLockedError } from "./storage-lock.js";

export interface CompactResult {
  dir: string;
  backupDir: string;
  /** main.jsonl byte size before/after */
  bytesBefore: number;
  bytesAfter: number;
  /** commit markers before/after */
  linesBefore: number;
  linesAfter: number;
  /** tasks and requestIds carried into the rebuilt ledger */
  tasks: number;
  requests: number;
}

export class LedgerBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerBusyError";
  }
}

function mainPath(dir: string): string {
  return path.join(dir, "main.jsonl");
}

function measure(file: string): { bytes: number; lines: number } {
  try {
    const text = fs.readFileSync(file, "utf8");
    return { bytes: Buffer.byteLength(text), lines: text.split("\n").filter((l) => l.trim()).length };
  } catch {
    return { bytes: 0, lines: 0 };
  }
}

const noRunner = { run: async () => "", notify: async () => undefined };

/**
 * Rebuild a task ledger directory with the same live state and a fresh marker log.
 *
 * Quiescence is the caller's problem in principle, but this function enforces what it can:
 * it refuses while any task of `agentIds` is still queued/running, and it refuses while a
 * live process holds the directory (the pibot-cea8 lock). Everything after that point is
 * verified before the original is moved aside, and the original is never deleted.
 */
export async function compactTaskLedger(opts: {
  storageDir: string;
  agentIds: readonly string[];
  now?: () => number;
}): Promise<CompactResult> {
  const dir = path.resolve(opts.storageDir);
  const now = opts.now ?? Date.now;
  if (!fs.existsSync(mainPath(dir))) throw new Error(`${dir} holds no ledger (no main.jsonl) — nothing to compact`);
  const before = measure(mainPath(dir));

  // 1. Refuse to touch a ledger that is still doing work.
  let source: TaskLedger;
  try {
    source = await openTaskLedger({ runner: noRunner, storageDir: dir, label: "compaction (inspect)" });
  } catch (e) {
    if (e instanceof StorageLockedError) throw new LedgerBusyError(`cannot compact ${dir}: ${e.message} Stop the daemon first.`);
    throw e;
  }
  try {
    for (const agentId of opts.agentIds) {
      const tasks = await source.list({ agentId });
      const busy = tasks.filter((t) => t.status === "queued" || t.status === "running");
      if (busy.length) {
        throw new LedgerBusyError(
          `refusing to compact ${dir}: ${busy.length} task(s) are still active (${busy
            .slice(0, 3)
            .map((t) => `"${t.title}" (${t.status})`)
            .join(", ")}). A rebuilt ledger would restart or orphan them. Let them finish, or cancel them first.`,
        );
      }
    }
  } finally {
    await source.close();
  }

  // 2. Build the replacement in a sibling directory, then verify it.
  const staging = `${dir}.compact-${now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  let counts: { tasks: number; requests: number };
  try {
    counts = await rewriteLedgerStorage({ storageDir: dir, stagingDir: staging, label: "compaction" });
    // Verify against the ORIGINAL, re-read fresh: every agent's task set must survive.
    const original = await openTaskLedger({ runner: noRunner, storageDir: dir, label: "compaction (verify source)" });
    const verify = await openTaskLedger({ runner: noRunner, storageDir: staging, label: "compaction (verify copy)" });
    try {
      for (const agentId of opts.agentIds) {
        const want = (await original.list({ agentId })).length;
        const got = (await verify.list({ agentId })).length;
        if (got !== want) {
          throw new Error(`compaction verification failed for ${agentId}: rebuilt ledger holds ${got} tasks, original has ${want}`);
        }
      }
    } finally {
      await verify.close();
      await original.close();
    }
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  // 3. Swap two directories this function still owns, and keep the original.
  const backupDir = `${dir}.pre-compact-${now()}`;
  fs.renameSync(dir, backupDir);
  try {
    fs.renameSync(staging, dir);
  } catch (e) {
    fs.renameSync(backupDir, dir); // never leave the operator without a ledger
    throw e;
  }

  const after = measure(mainPath(dir));
  return {
    dir,
    backupDir,
    bytesBefore: before.bytes,
    linesBefore: before.lines,
    bytesAfter: after.bytes,
    linesAfter: after.lines,
    tasks: counts.tasks,
    requests: counts.requests,
  };
}

/** Boot cost of replaying a ledger, measured rather than assumed (bd pibot-b708). */
export async function measureLedgerReplay(storageDir: string, agentIds: readonly string[]): Promise<{ openMs: number; listMs: number; tasks: number; bytes: number; lines: number }> {
  const dir = path.resolve(storageDir);
  const file = measure(mainPath(dir));
  const t0 = performance.now();
  const ledger = await openTaskLedger({ runner: noRunner, storageDir: dir, label: "replay measurement" });
  const openMs = performance.now() - t0;
  const t1 = performance.now();
  let tasks = 0;
  for (const agentId of agentIds) tasks += (await ledger.list({ agentId })).length;
  const listMs = performance.now() - t1;
  await ledger.close();
  return { openMs, listMs, tasks, bytes: file.bytes, lines: file.lines };
}
