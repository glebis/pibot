import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorMessage } from "./util.js";
import { freeBytes, installDiskGuard, isEnospc, type DiskGuardOptions, type ExecuteResult } from "./disk-guard.js";

function enospcErr(message = "write ENOSPC"): Error {
  return Object.assign(new Error(message), { code: "ENOSPC" });
}

function scriptResult(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    mode: "EXECUTED",
    preset: "safe",
    plan: [],
    advisories: [],
    refused: [],
    planned_bytes: 3_400_000_000,
    planned_human: "3.4 GB",
    freed_bytes: 3_400_000_000,
    freed_human: "3.4 GB",
    trash_emptied: true,
    disk_before: { total_gb: 500, avail_gb: 0.8, used_pct: 100 },
    disk_after: { total_gb: 500, avail_gb: 4.2, used_pct: 99 },
    ...over,
  });
}

interface Harness {
  calls: Array<{ cmd: string; args: string[] }>;
  guard: ReturnType<typeof installDiskGuard>;
  notifies: string[];
  exits: number[];
  dataDir: string;
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) fs.rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

/**
 * Install a guard with a fake executor and free-space probe inside a fresh temp
 * data dir. Pass `withScript: true` to also lay down a fake scripts/clean.py so
 * the guard's default skillDir resolution is bypassed.
 */
function makeHarness(over: Partial<DiskGuardOptions> & { executeResult?: ExecuteResult; withScript?: boolean } = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-guard-test-"));
  cleanupDirs.push(dataDir);
  const skillDir = path.join(dataDir, "skill");
  if (over.withScript) {
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "scripts", "clean.py"), "# fake");
  }
  const calls: Harness["calls"] = [];
  const notifies: string[] = [];
  const exits: number[] = [];
  const execute: DiskGuardOptions["execute"] = async (cmd, args) => {
    calls.push({ cmd, args });
    return over.executeResult ?? { code: 0, stdout: scriptResult(), stderr: "" };
  };
  const guard = installDiskGuard({
    dataDir,
    skillDir,
    watch: false, // no timers/instances unless a test opts in
    ...over,
    execute,
    notify: (t) => {
      notifies.push(t);
    },
    exit: (c) => exits.push(c),
    statfsFree: over.statfsFree ?? (() => 500 * 1024 * 1024 * 1024),
  });
  return { calls, guard, notifies, exits, dataDir };
}

describe("isEnospc", () => {
  it("detects ENOSPC by code", () => {
    expect(isEnospc(enospcErr())).toBe(true);
  });

  it("detects by message text", () => {
    expect(isEnospc(new Error("ENOSPC: no space left on device, write"))).toBe(true);
    expect(isEnospc(new Error("no space left on device"))).toBe(true);
    expect(isEnospc("Error: ENOSPC: no space left on device, write")).toBe(true);
  });

  it("follows the cause chain", () => {
    const wrapped = new Error("agent run failed", { cause: enospcErr() });
    expect(isEnospc(wrapped)).toBe(true);
  });

  it("rejects unrelated errors and junk", () => {
    expect(isEnospc(new Error("ECONNRESET"))).toBe(false);
    expect(isEnospc(undefined)).toBe(false);
    expect(isEnospc(null)).toBe(false);
    expect(isEnospc(42)).toBe(false);
    expect(isEnospc({ code: "EACCES" })).toBe(false);
  });
});

describe("freeBytes", () => {
  it("returns a positive number on a real mount", () => {
    const n = freeBytes("/");
    expect(n).not.toBeNull();
    expect(n!).toBeGreaterThan(0);
  });
});

describe("DiskGuard response", () => {
  it("runs the safe preset with --go, --no-quit and --empty-trash by default", async () => {
    const h = makeHarness({ withScript: true });
    const outcome = await h.guard.respondToDiskPressure("uncaughtException");
    expect(outcome).toMatchObject({ ran: true, freedHuman: "3.4 GB", diskBeforeGb: 0.8, diskAfterGb: 4.2 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].cmd).toBe("python3");
    expect(h.calls[0].args[0]).toMatch(/clean\.py$/);
    expect(h.calls[0].args[h.calls[0].args.indexOf("--preset") + 1]).toBe("safe");
    expect(h.calls[0].args).toContain("--go");
    expect(h.calls[0].args).toContain("--no-quit");
    expect(h.calls[0].args).toContain("--empty-trash");
    expect(h.calls[0].args).toContain("--json");
    expect(h.notifies[0]).toContain("Freed 3.4 GB");
    h.guard.dispose();
  });

  it("omits --empty-trash when emptyTrash is false", async () => {
    const h = makeHarness({ withScript: true, emptyTrash: false });
    await h.guard.respondToDiskPressure("test");
    expect(h.calls[0].args).not.toContain("--empty-trash");
    h.guard.dispose();
  });

  it("persists durable state and enforces the cooldown across guard instances", async () => {
    const first = makeHarness({ withScript: true });
    await first.guard.respondToDiskPressure("first");
    expect(first.calls).toHaveLength(1);
    const stateFile = path.join(first.dataDir, "disk-guard.json");
    expect(fs.existsSync(stateFile)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(persisted.lastRunAt).toBeTruthy();
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0].ok).toBe(true);
    first.guard.dispose();

    // a fresh guard (as after a daemon restart) must honor the persisted cooldown
    const second = makeHarness({ dataDir: first.dataDir, skillDir: path.join(first.dataDir, "skill"), withScript: true });
    const outcome = await second.guard.respondToDiskPressure("after-restart");
    expect(outcome).toEqual({ ran: false, skipped: "cooldown" });
    expect(second.calls).toHaveLength(0);
    second.guard.dispose();
  });

  it("reports failure when clean.py exits non-zero", async () => {
    const h = makeHarness({ withScript: true, executeResult: { code: 2, stdout: "", stderr: "boom" } });
    const outcome = await h.guard.respondToDiskPressure("test");
    expect(outcome).toMatchObject({ ran: false, skipped: "failed" });
    expect(h.notifies[0]).toContain("cleanup failed");
    h.guard.dispose();
  });

  it("warns once (not per trigger) when the skill is missing", async () => {
    const h = makeHarness({});
    const o1 = await h.guard.respondToDiskPressure("a");
    const o2 = await h.guard.respondToDiskPressure("b");
    expect(o1).toMatchObject({ ran: false, skipped: "missing-script" });
    expect(o2).toMatchObject({ ran: false, skipped: "missing-script" });
    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0]).toContain("disk-cleanup skill was not found");
    h.guard.dispose();
  });

  it("appends an escalation hint when space is still low afterwards", async () => {
    const h = makeHarness({ withScript: true, statfsFree: () => 300 * 1024 * 1024 });
    await h.guard.respondToDiskPressure("test");
    expect(h.notifies[0]).toContain("Still low on space");
    expect(h.notifies[0]).toContain("--allow-medium");
    h.guard.dispose();
  });

  it("low-water watcher triggers the same cleanup", async () => {
    const h = makeHarness({ withScript: true, statfsFree: () => 100 * 1024 * 1024 });
    h.guard.checkLowWater();
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), { timeout: 2000 });
    h.guard.dispose();
  });

  it("non-ENOSPC process errors keep the exit(1) behavior", () => {
    const h = makeHarness({});
    const g = h.guard as unknown as { onUncaught: (e: Error) => void; onRejection: (r: unknown) => void };
    g.onUncaught(new Error("boom"));
    g.onRejection(new Error("boom"));
    expect(h.exits).toEqual([1, 1]);
    h.guard.dispose();
  });

  it("ENOSPC process errors trigger cleanup instead of exit", async () => {
    const h = makeHarness({ withScript: true });
    const g = h.guard as unknown as { onUncaught: (e: Error) => void };
    g.onUncaught(enospcErr());
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), { timeout: 2000 });
    expect(h.exits).toEqual([]);
    h.guard.dispose();
  });
});

describe("errorMessage tripwire", () => {
  it("funnels ENOSPC through the installed guard", async () => {
    const h = makeHarness({ withScript: true });
    errorMessage(enospcErr()); // sync formatter call — guard fires async
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), { timeout: 2000 });
    expect(h.exits).toEqual([]);
    h.guard.dispose();
  });

  it("is inert for unrelated errors and after dispose", () => {
    const h = makeHarness({});
    expect(errorMessage(new Error("ECONNRESET"))).toBe("ECONNRESET");
    expect(h.calls).toHaveLength(0);
    h.guard.dispose();
    // after dispose the tripwire is inert even for ENOSPC
    errorMessage(enospcErr());
    expect(h.calls).toHaveLength(0);
  });
});

describe("process hooks", () => {
  it("install adds and dispose removes process listeners", () => {
    const beforeU = process.listenerCount("uncaughtException");
    const beforeR = process.listenerCount("unhandledRejection");
    const h = makeHarness({});
    expect(process.listenerCount("uncaughtException")).toBe(beforeU + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeR + 1);
    h.guard.dispose();
    expect(process.listenerCount("uncaughtException")).toBe(beforeU);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeR);
  });
});