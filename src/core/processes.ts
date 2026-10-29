import { basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LedgerEntry } from "../durable/task-ledger.js";
import type { Activity } from "./activity.js";

const run = promisify(execFile);

/** An active /goal autonomy loop (keyed by chat). */
export interface LiveGoal {
  chatKey: string;
  objective: string;
  turnsUsed: number;
  maxTurns: number;
  createdAt: number;
  lastTurnAt: number;
}

/** A descendant OS process of the daemon (delegate CLIs, exec_run shells, MCP servers). */
export interface ChildProcess {
  pid: number;
  ppid: number;
  /** depth below the daemon: 1 = direct child */
  depth: number;
  elapsedSec: number;
  rssKb: number;
  command: string;
}

export interface ProcessSnapshot {
  takenAt: number;
  daemon: { pid: number; uptimeSec: number; rssKb: number };
  /** every model turn in flight, whatever started it */
  turns: Activity[];
  tasks: { active: LedgerEntry[]; recent: LedgerEntry[] };
  goals: LiveGoal[];
  voiceCalls: Array<{ agentId: string; chatKey: string }>;
  children: ChildProcess[];
  /** set when the OS process listing failed (children is then empty) */
  childrenError?: string;
}

/** `ps` etime: [[dd-]hh:]mm:ss → seconds */
export function parseEtime(s: string): number {
  const [days, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, sec] = parts;
  return Number(days) * 86400 + h * 3600 + m * 60 + sec;
}

/**
 * Descendants of `rootPid` from `ps -A -o pid=,ppid=,etime=,rss=,command=` output,
 * in tree order (each child right after its parent).
 */
export function descendantsFromPs(psOutput: string, rootPid: number): ChildProcess[] {
  const rows = psOutput.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), elapsedSec: parseEtime(m[3]), rssKb: Number(m[4]), command: m[5] }));
  const byParent = new Map<number, typeof rows>();
  for (const r of rows) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r]);
  const out: ChildProcess[] = [];
  const walk = (pid: number, depth: number) => {
    for (const r of (byParent.get(pid) ?? []).sort((a, b) => a.pid - b.pid)) {
      if (r.pid === process.pid && depth > 1) continue; // never loop back
      if (basename(r.command.split(/\s+/)[0]) === "ps") continue; // this listing itself
      // Never publish argv: delegate prompts and tokens can be command arguments.
      out.push({ ...r, command: basename(r.command.split(/\s+/)[0]), depth });
      if (depth < 8) walk(r.pid, depth + 1);
    }
  };
  walk(rootPid, 1);
  return out;
}

/** Live descendants of this daemon process. */
export async function listChildProcesses(rootPid = process.pid): Promise<ChildProcess[]> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,etime=,rss=,comm="], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 });
  return descendantsFromPs(stdout, rootPid);
}

/** Facade the web dashboard reads; the bot owns the live state behind it. */
export interface ProcessControl {
  snapshot(): Promise<ProcessSnapshot>;
  /** request an abort of a durable task; false when it is not live */
  cancelTask(id: string): Promise<boolean>;
}
