// Offline maintenance for the durable task ledger (bd pibot-b708).
//
//   npx tsx scripts/ledger-compact.mts --measure
//   npx tsx scripts/ledger-compact.mts --compact
//
// main.jsonl only grows: the pi-durable JSONL backend appends one commit marker per commit
// and never rewrites it (only doc-/task- sidecars are reclaimed). These two operations are
// the supported answer:
//
//   --measure  read-only. Boot replay cost, marker count, bytes, task counts.
//   --compact  stop the daemon first. Rebuilds the ledger into a fresh directory with the
//              same live state, one commit, verifies it, swaps it in and leaves the
//              original as <dir>.pre-compact-<ts>. Refuses while any task is active.
//
// The directory is locked by the pibot-cea8 lock, so a running daemon makes --compact fail
// loudly instead of racing it.

import * as fs from "node:fs";
import * as path from "node:path";
import { compactTaskLedger, measureLedgerReplay } from "../src/durable/compact-ledger.js";

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = argOf("--data-dir") ?? process.env.PIBOT_DATA_DIR ?? path.join(process.cwd(), "data");
const ledgerDir = argOf("--ledger-dir") ?? path.join(dataDir, "durable", "tasks");
/**
 * Which agents' tasks to carry. Defaults to every agentId present in the ledger — deriving
 * the list by hand dropped 100 of 116 tasks in a dry run, which is exactly the kind of
 * silent loss a compaction must not have.
 */
async function ledgerAgentIds(): Promise<string[]> {
  const explicit = argOf("--agents");
  if (explicit) return explicit.split(",").map((s) => s.trim()).filter(Boolean);
  const { openTaskLedger } = await import("../src/durable/task-ledger.js");
  const ledger = await openTaskLedger({ runner: { run: async () => "", notify: async () => undefined }, storageDir: ledgerDir, label: "agent discovery" });
  try {
    const { tasks } = await ledger.exportSnapshot();
    return [...new Set(Object.values(tasks).map((t) => t.agentId))].sort();
  } finally {
    await ledger.close();
  }
}
const agentIds = await ledgerAgentIds();
const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;
const ms = (n: number): string => `${n.toFixed(0)} ms`;

if (!fs.existsSync(ledgerDir)) {
  console.error(`[ledger] no ledger at ${ledgerDir}`);
  process.exit(2);
}

if (process.argv.includes("--measure")) {
  const before = await measureLedgerReplay(ledgerDir, agentIds);
  console.log(`[ledger] ${ledgerDir}`);
  console.log(`  main.jsonl      ${before.lines} commit markers, ${kb(before.bytes)} (${(before.bytes / Math.max(before.lines, 1)).toFixed(0)} B/marker)`);
  console.log(`  boot replay     ${ms(before.openMs)} open + ${ms(before.listMs)} first list`);
  console.log(`  tasks           ${before.tasks} across ${agentIds.join(", ")}`);
  // projection: replay is linear in markers (each marker is parsed and replayed), so a 10x
  // log costs about 10x. Reported as an estimate, never as a measurement.
  console.log(`  projected 10x   ${before.lines * 10} markers, ~${ms(before.openMs * 10)} open, ~${kb(before.bytes * 10)}`);
  process.exit(0);
}

if (process.argv.includes("--compact")) {
  try {
    const result = await compactTaskLedger({ storageDir: ledgerDir, agentIds });
    console.log(`[ledger] compacted ${result.dir}`);
    console.log(`  markers  ${result.linesBefore} → ${result.linesAfter}`);
    console.log(`  bytes    ${kb(result.bytesBefore)} → ${kb(result.bytesAfter)}`);
    console.log(`  carried  ${result.tasks} tasks, ${result.requests} requestIds`);
    console.log(`  backup   ${result.backupDir}  (delete it once the daemon boots clean)`);
  } catch (e) {
    console.error(`[ledger] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  process.exit(0);
}

console.error("usage: ledger-compact.mts (--measure | --compact) [--data-dir DIR] [--ledger-dir DIR] [--agents a,b]");
process.exit(2);
