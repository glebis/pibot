// Cross-process lock for a pi-durable storage directory (bd pibot-cea8).
//
// The JSONL backend has no lock of its own: `openNodeJsonlStorage(dir)` opens/creates
// main.jsonl and its doc-/task- sidecars with no O_EXCL and no PID record, so two
// processes pointed at one directory interleave commits and corrupt the ledger.
// Until now the only guard was the daemon PID lock in src/index.ts, which protects
// data/durable/tasks only for as long as every writer happens to be that one daemon —
// `scripts/durable-satellite.mts --storage-dir data/durable/tasks` walked right past it.
//
// The lock is O_EXCL-created, owner-only, and names its holder so a second process
// fails loudly instead of quietly forking the log. It is NOT a mutual-exclusion
// primitive for concurrent appends: it means "this directory has one owner at a time".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const STORAGE_LOCK_NAME = ".pibot-ledger.lock";

/** Why a storage directory is already owned. */
export interface StorageLockHolder {
  pid: number;
  host: string;
  /** what to show the human: process title or the caller-supplied label */
  command: string;
  acquiredAt: number;
}

export class StorageLockedError extends Error {
  readonly holder: StorageLockHolder | undefined;
  readonly dir: string;
  constructor(dir: string, holder: StorageLockHolder | undefined, message: string) {
    super(message);
    this.name = "StorageLockedError";
    this.dir = dir;
    this.holder = holder;
  }
}

export interface StorageLock {
  readonly dir: string;
  readonly path: string;
  release(): void;
}

function readHolder(lockPath: string): StorageLockHolder | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<StorageLockHolder>;
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return undefined;
    return {
      pid: raw.pid,
      host: typeof raw.host === "string" ? raw.host : "unknown",
      command: typeof raw.command === "string" ? raw.command : "unknown",
      acquiredAt: typeof raw.acquiredAt === "number" ? raw.acquiredAt : 0,
    };
  } catch {
    return undefined;
  }
}

/** Is the recorded holder still alive *on this machine*? A lock from another host cannot be probed. */
function holderIsAlive(holder: StorageLockHolder | undefined): boolean {
  if (!holder) return false;
  if (holder.host !== os.hostname()) return true; // cannot disprove: treat as alive, never steal
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is not ours — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function describe(holder: StorageLockHolder | undefined): string {
  if (!holder) return "an unknown process";
  const age = holder.acquiredAt ? ` since ${new Date(holder.acquiredAt).toISOString()}` : "";
  return `pid ${holder.pid} on ${holder.host} (${holder.command})${age}`;
}

/**
 * Take ownership of a pi-durable storage directory.
 *
 * Throws `StorageLockedError` when a live process holds it. A lock whose recorded pid is
 * provably dead on this host is replaced — the stale-lock takeover is done by unlinking and
 * retrying the O_EXCL create, so exactly one of two racing processes wins the create and the
 * loser sees the winner's record.
 */
export function lockStorageDir(dir: string, opts: { label?: string; onStaleTakeover?: (holder: StorageLockHolder | undefined) => void } = {}): StorageLock {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, STORAGE_LOCK_NAME);
  const command = opts.label ?? `${path.basename(process.argv[1] ?? "node")} ${process.argv.slice(2, 4).join(" ")}`.trim();
  const payload = (): string =>
    JSON.stringify({ pid: process.pid, host: os.hostname(), command, acquiredAt: Date.now() } satisfies StorageLockHolder);

  const create = (): void => {
    fs.writeFileSync(lockPath, payload(), { flag: "wx", mode: 0o600 });
  };

  for (let attempt = 0; ; attempt++) {
    try {
      create();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readHolder(lockPath);
      if (holderIsAlive(holder)) {
        throw new StorageLockedError(
          dir,
          holder,
          `storage directory ${dir} is owned by ${describe(holder)}; a second writer would interleave commits. ` +
            `Point this process at its own directory, or stop the holder first.`,
        );
      }
      // Provably stale (dead pid on this host, or an unreadable lock record).
      if (attempt >= 3) {
        throw new StorageLockedError(dir, holder, `could not take over the stale lock ${lockPath} after 3 attempts`);
      }
      opts.onStaleTakeover?.(holder);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* someone else just removed or replaced it — retry the create */
      }
    }
  }

  let released = false;
  return {
    dir,
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        // only remove OUR record: a takeover by another process must not be undone here
        const holder = readHolder(lockPath);
        if (holder && holder.pid !== process.pid) return;
        fs.unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Guard for a directory that already contains a ledger: refuse to open it unless the caller
 * says so explicitly. Used by the satellite entry, where pointing at the daemon's live
 * data/durable/tasks was a plausible one-word mistake with unrecoverable consequences.
 */
export function assertNotLiveLedger(dir: string, opts: { force?: boolean } = {}): void {
  if (opts.force) return;
  const main = path.join(dir, "main.jsonl");
  if (!fs.existsSync(main)) return;
  throw new Error(
    `${dir} already contains a pi-durable ledger (main.jsonl). Refusing to open it: pass an empty directory, ` +
      `or --force-live to acknowledge that you are deliberately writing to an existing ledger.`,
  );
}
