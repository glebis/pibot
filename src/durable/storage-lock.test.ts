// Cross-process ownership of a pi-durable storage directory (bd pibot-cea8).
// The JSONL backend has no lock of its own; before this, anything could open the live
// ledger directory and interleave commits into main.jsonl.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotLiveLedger, STORAGE_LOCK_NAME, StorageLockedError, lockStorageDir } from "./storage-lock.js";
import { openTaskLedger } from "./task-ledger.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-storage-lock-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const lockPath = () => path.join(dir, STORAGE_LOCK_NAME);

describe("lockStorageDir (bd pibot-cea8)", () => {
  it("creates an owner-only lock naming this process", () => {
    const lock = lockStorageDir(dir, { label: "test holder" });
    const holder = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
    expect(holder).toMatchObject({ pid: process.pid, host: os.hostname(), command: "test holder" });
    expect(holder.acquiredAt).toBeGreaterThan(0);
    expect(fs.statSync(lockPath()).mode & 0o777).toBe(0o600);
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("refuses a directory a live process already owns, naming the holder", () => {
    const lock = lockStorageDir(dir, { label: "the daemon" });
    // a lock owned by this very process is live by definition, so re-locking must fail
    let error: unknown;
    try {
      lockStorageDir(dir, { label: "second writer" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(StorageLockedError);
    const locked = error as StorageLockedError;
    expect(locked.holder?.pid).toBe(process.pid);
    expect(locked.message).toContain("the daemon");
    expect(locked.message).toContain(String(process.pid));
    lock.release();
  });

  it("takes over a lock whose holder is provably dead on this host", () => {
    // pid that cannot exist: the lock record of a crashed process
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999_999, host: os.hostname(), command: "crashed", acquiredAt: Date.now() - 60_000 }));
    const taken: Array<number | undefined> = [];
    const lock = lockStorageDir(dir, { onStaleTakeover: (holder) => taken.push(holder?.pid) });
    expect(taken).toEqual([999_999]);
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("never steals a lock recorded on another host, because it cannot probe it", () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 1, host: "some-other-machine", command: "daemon", acquiredAt: Date.now() }));
    expect(() => lockStorageDir(dir)).toThrow(StorageLockedError);
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).host).toBe("some-other-machine");
  });

  it("treats an unreadable lock record as stale rather than blocking forever", () => {
    fs.writeFileSync(lockPath(), "not json at all");
    const lock = lockStorageDir(dir);
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("releases idempotently and never deletes another process's record", () => {
    const lock = lockStorageDir(dir);
    // simulate a takeover that happened while we thought we held the lock
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid + 1, host: os.hostname(), command: "intruder", acquiredAt: Date.now() }));
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(true); // the other record survives
    lock.release(); // second call is a no-op
  });
});

describe("assertNotLiveLedger (bd pibot-cea8)", () => {
  it("allows an empty directory", () => {
    expect(() => assertNotLiveLedger(dir)).not.toThrow();
  });

  it("refuses a directory that already holds a ledger, unless forced", () => {
    fs.writeFileSync(path.join(dir, "main.jsonl"), "");
    expect(() => assertNotLiveLedger(dir)).toThrow(/already contains a pi-durable ledger/);
    expect(() => assertNotLiveLedger(dir, { force: true })).not.toThrow();
  });
});

describe("openTaskLedger ownership (bd pibot-cea8)", () => {
  const runner = { run: async () => "ok", notify: async () => undefined };

  it("holds the directory for the life of the ledger and frees it on close", async () => {
    const ledger = await openTaskLedger({ runner, storageDir: dir, label: "first" });
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).command).toContain("task-ledger first");

    // the second writer the issue is about
    await expect(openTaskLedger({ runner, storageDir: dir, label: "second" })).rejects.toThrow(/is owned by pid/);

    await ledger.close();
    expect(fs.existsSync(lockPath())).toBe(false);
    // and the directory is usable again, with its contents intact
    const reopened = await openTaskLedger({ runner, storageDir: dir, label: "third" });
    expect(await reopened.list({ agentId: "nobody" })).toEqual([]);
    await reopened.close();
  });

  it("stops with an owner-visible error instead of reopening a corrupt ledger", async () => {
    // a main.jsonl with a commit sequence that cannot be read
    fs.writeFileSync(path.join(dir, "main.jsonl"), '{"kind":"commit","seq":2}\n{"kind":"commit","seq":1}\n');
    const errors: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      openTaskLedger({ runner, storageDir: dir, label: "corrupt" }).catch((e) => {
        errors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        throw e;
      }),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(errors[0]).toMatch(/LedgerUnreadableError|JsonlCorruptionError/);
    // and it did not leave the directory locked by a process that failed to open it
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("does not create a lock for an in-memory ledger", async () => {
    const ledger = await openTaskLedger({ runner });
    await ledger.close();
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
