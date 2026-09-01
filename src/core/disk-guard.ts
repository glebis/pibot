import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * DiskGuard — catches ENOSPC ("no space left on device") failures anywhere in the
 * daemon and automatically reclaims space by running the safe preset of the
 * owner's disk-cleanup skill (default ~/.claude/skills/disk-cleanup).
 *
 * What the automatic response runs (deterministic, audited inside clean.py):
 *
 *   python3 <skill>/scripts/clean.py --preset safe --go --no-quit [--empty-trash] --json
 *
 *   - risk:"safe" targets only (regenerable caches, crash dumps, …). risk:"medium"
 *     and risk:"never" targets are refused by the script itself; advisory targets
 *     only print guidance.
 *   - every trashed path passes clean.py's preflight: canonical realpath under an
 *     allowed root, never a symlink, never $HOME or /; files are trashed via the
 *     `trash` CLI, never rm.
 *   - --no-quit: never auto-quits the user's running apps; targets that need their
 *     app closed are skipped instead.
 *   - --empty-trash (owner-authorized): without it trashed bytes would sit in the
 *     Trash and free nothing on an already-full disk.
 *
 * Triggers:
 *   - process-level uncaughtException / unhandledRejection carrying ENOSPC
 *   - any error funnelled through noteDiskError (wired into util.errorMessage)
 *   - a low-water watcher (default: free space under 2 GB, checked every 10 min
 *     and once at boot) — catches pressure before writes start failing
 *
 * Durable state (data/disk-guard.json) enforces a cooldown (default 30 min), so a
 * full disk can never turn into a cleanup loop and a restart cannot bypass it.
 * Non-ENOSPC uncaught errors keep the previous behavior: log + exit(1).
 */

// ─── detection ──────────────────────────────────────────────────────────────

/** True when an error (or its cause chain) is a disk-full error. */
export function isEnospc(err: unknown): boolean {
  if (typeof err === "string") return /ENOSPC|no space left on device/i.test(err);
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (e.code === "ENOSPC") return true;
  if (typeof e.message === "string" && /ENOSPC|no space left on device/i.test(e.message)) return true;
  if (e.cause !== undefined && e.cause !== err) return isEnospc(e.cause);
  return false;
}

/** Free bytes on a mounted filesystem, or null when unknowable. */
export function freeBytes(mount = "/"): number | null {
  try {
    const s = fs.statfsSync(mount);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

// ─── options & state ────────────────────────────────────────────────────────

export interface ExecuteResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type ExecuteFn = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecuteResult>;

export interface DiskGuardOptions {
  /** runtime data dir — guard state persists here as disk-guard.json */
  dataDir: string;
  /** disk-cleanup skill dir (default ~/.claude/skills/disk-cleanup, PIBOT_DISK_CLEANUP_DIR overrides) */
  skillDir?: string;
  /** append --empty-trash after the safe preset (owner-authorized). Default true. */
  emptyTrash?: boolean;
  /** min interval between automatic runs. Default 30 min. */
  cooldownMs?: number;
  /** low-water threshold in bytes. Default 2 GiB. */
  minFreeBytes?: number;
  /** low-water poll interval. Default 10 min. */
  watchIntervalMs?: number;
  /** periodic low-water check. Default true. */
  watch?: boolean;
  /** owner-facing push (wired to the bot after construction). */
  notify?: (text: string) => void | Promise<void>;
  log?: (...args: unknown[]) => void;
  /** injectable executor (tests). */
  execute?: ExecuteFn;
  /** injectable free-space probe (tests). */
  statfsFree?: () => number | null;
  /** injectable exit for non-ENOSPC fatal errors (tests). Default process.exit. */
  exit?: (code: number) => void;
}

export interface GuardRun {
  at: string;
  reason: string;
  ok: boolean;
  freedHuman?: string;
  diskBeforeGb?: number;
  diskAfterGb?: number;
  error?: string;
}

interface GuardState {
  lastRunAt?: string;
  runs: GuardRun[];
}

export type ResponseOutcome =
  | { ran: true; freedHuman: string; diskBeforeGb?: number; diskAfterGb?: number }
  | { ran: false; skipped: "cooldown" | "in-flight" | "missing-script" | "failed"; error?: string };

interface ScriptResult {
  freed_human?: string;
  trash_emptied?: boolean;
  refused?: unknown[];
  disk_before?: { avail_gb?: number };
  disk_after?: { avail_gb?: number };
}

const DEFAULT_MIN_FREE = 2 * 1024 * 1024 * 1024; // 2 GiB
const DEFAULT_COOLDOWN = 30 * 60_000;
const DEFAULT_WATCH = 10 * 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000; // clean.py caps each target at 300s

// ─── guard ──────────────────────────────────────────────────────────────────

export class DiskGuard {
  readonly opts: Required<Pick<DiskGuardOptions, "dataDir" | "emptyTrash" | "cooldownMs" | "minFreeBytes" | "watchIntervalMs" | "watch">> & DiskGuardOptions;
  private state: GuardState;
  private inFlight: Promise<ResponseOutcome> | null = null;
  private missingScriptNotified = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private onUncaught: (err: Error) => void;
  private onRejection: (reason: unknown) => void;

  constructor(opts: DiskGuardOptions) {
    this.opts = {
      emptyTrash: true,
      cooldownMs: DEFAULT_COOLDOWN,
      minFreeBytes: DEFAULT_MIN_FREE,
      watchIntervalMs: DEFAULT_WATCH,
      watch: true,
      ...opts,
    };
    this.state = this.loadState();
    this.onUncaught = (err: Error) => {
      if (isEnospc(err)) {
        this.log(`[disk-guard] ENOSPC reached the process level: ${err.message}`);
        this.checkNow("uncaughtException");
        return;
      }
      this.opts.log?.("[pibot] uncaught exception:", err);
      this.opts.exit?.(1);
    };
    this.onRejection = (reason: unknown) => {
      if (isEnospc(reason)) {
        this.log(`[disk-guard] ENOSPC in an unhandled rejection: ${errText(reason)}`);
        this.checkNow("unhandledRejection");
        return;
      }
      this.opts.log?.("[pibot] unhandled rejection:", reason);
      this.opts.exit?.(1);
    };
  }

  private get log(): (...args: unknown[]) => void {
    return this.opts.log ?? (() => {});
  }

  private get statePath(): string {
    return path.join(this.opts.dataDir, "disk-guard.json");
  }

  private get skillDir(): string {
    return path.resolve(
      this.opts.skillDir
        ?? process.env.PIBOT_DISK_CLEANUP_DIR
        ?? path.join(os.homedir(), ".claude", "skills", "disk-cleanup"),
    );
  }

  private get scriptPath(): string {
    return path.join(this.skillDir, "scripts", "clean.py");
  }

  private loadState(): GuardState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as GuardState;
      if (raw && Array.isArray(raw.runs)) return { lastRunAt: raw.lastRunAt, runs: raw.runs.slice(0, 10) };
    } catch {
      /* fresh state */
    }
    return { runs: [] };
  }

  private saveState(): void {
    try {
      fs.mkdirSync(this.opts.dataDir, { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
    } catch (e) {
      this.log("[disk-guard] could not persist state:", errText(e));
    }
  }

  setNotify(notify: DiskGuardOptions["notify"]): void {
    this.opts.notify = notify;
  }

  /** Fire-and-forget trigger used from sync contexts (error hooks, process events). */
  checkNow(reason: string): void {
    void this.respondToDiskPressure(reason).catch((e) => this.log("[disk-guard] response failed:", e));
  }

  /** Run the safe cleanup if the cooldown allows it. Concurrent triggers coalesce. */
  async respondToDiskPressure(reason: string): Promise<ResponseOutcome> {
    if (this.inFlight) return { ran: false, skipped: "in-flight" };
    const last = this.state.lastRunAt ? Date.parse(this.state.lastRunAt) : NaN;
    if (Number.isFinite(last) && Date.now() - last < this.opts.cooldownMs) {
      this.log(`[disk-guard] cleanup skipped — cooldown active (last run ${this.state.lastRunAt})`);
      return { ran: false, skipped: "cooldown" };
    }

    const job = this.runCleanup(reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = job;
    return job;
  }

  private async runCleanup(reason: string): Promise<ResponseOutcome> {
    if (!fs.existsSync(this.scriptPath)) {
      this.log(`[disk-guard] cleanup script missing: ${this.scriptPath} — install the disk-cleanup skill or set PIBOT_DISK_CLEANUP_DIR`);
      if (!this.missingScriptNotified) {
        this.missingScriptNotified = true;
        await this.push(`⚠︎ Disk pressure detected but the disk-cleanup skill was not found at ${this.skillDir} — no automatic cleanup is possible.`);
      }
      return { ran: false, skipped: "missing-script" };
    }

    const args = [this.scriptPath, "--preset", "safe", "--go", "--no-quit", "--json"];
    if (this.opts.emptyTrash) args.push("--empty-trash");

    this.log(`[disk-guard] ENOSPC response (${reason}): running safe disk cleanup…`);
    const r = await (this.opts.execute ?? defaultExecute)("python3", args, RUN_TIMEOUT_MS);
    let outcome: ResponseOutcome;
    if (r.error || r.code !== 0) {
      const error = r.error || `clean.py exited ${r.code}: ${r.stderr.slice(-300) || "(no stderr)"}`;
      this.log("[disk-guard] cleanup failed:", error);
      outcome = { ran: false, skipped: "failed", error };
    } else {
      let parsed: ScriptResult = {};
      try {
        parsed = JSON.parse(r.stdout) as ScriptResult;
      } catch {
        this.log("[disk-guard] could not parse clean.py output");
      }
      const freedHuman = parsed.freed_human ?? "0 B";
      const diskBeforeGb = parsed.disk_before?.avail_gb;
      const diskAfterGb = parsed.disk_after?.avail_gb;
      outcome = { ran: true, freedHuman, diskBeforeGb, diskAfterGb };
      this.log(
        `[disk-guard] cleanup done: freed ${freedHuman} (trash emptied: ${parsed.trash_emptied ?? false})`,
        diskBeforeGb !== undefined && diskAfterGb !== undefined ? `· disk ${diskBeforeGb} GB → ${diskAfterGb} GB free` : "",
        parsed.refused?.length ? `· ${parsed.refused.length} target(s) refused` : "",
      );
    }

    const free = this.opts.statfsFree?.() ?? freeBytes();
    const run: GuardRun = {
      at: new Date().toISOString(),
      reason,
      ok: outcome.ran,
      ...(outcome.ran ? { freedHuman: outcome.freedHuman, diskBeforeGb: outcome.diskBeforeGb, diskAfterGb: outcome.diskAfterGb } : { error: outcome.error }),
    };
    this.state = { lastRunAt: run.at, runs: [run, ...this.state.runs].slice(0, 10) };
    this.saveState();
    await this.push(resultMessage(reason, outcome, free, this.opts.minFreeBytes, this.scriptPath));
    return outcome;
  }

  private async push(text: string): Promise<void> {
    try {
      await this.opts.notify?.(text);
    } catch {
      /* notification is best effort */
    }
  }

  /** Low-water check: run the same auto-cleanup when free space is below threshold. */
  checkLowWater(): void {
    const free = this.opts.statfsFree?.() ?? freeBytes();
    if (free === null || free >= this.opts.minFreeBytes) return;
    this.log(`[disk-guard] low water: ${humanBytes(free)} free (threshold ${humanBytes(this.opts.minFreeBytes)})`);
    this.checkNow("low-water");
  }

  /** Register process-level hooks + start the low-water watcher. */
  install(): this {
    process.on("uncaughtException", this.onUncaught);
    process.on("unhandledRejection", this.onRejection);
    if (this.opts.watch) {
      this.watchTimer = setInterval(() => this.checkLowWater(), this.opts.watchIntervalMs);
      this.watchTimer.unref?.();
      this.checkLowWater(); // boot check — the durable cooldown prevents restart abuse
    }
    return this;
  }

  dispose(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    process.off("uncaughtException", this.onUncaught);
    process.off("unhandledRejection", this.onRejection);
    if (active === this) active = null;
  }
}

function resultMessage(
  reason: string,
  outcome: ResponseOutcome,
  freeNow: number | null,
  minFreeBytes: number,
  scriptPath: string,
): string {
  if (!outcome.ran) {
    const why = outcome.skipped === "cooldown"
      ? "cleanup skipped (cooldown active — will retry on the next check)"
      : outcome.skipped === "in-flight"
        ? "cleanup already running"
        : `cleanup failed: ${outcome.error ?? "unknown error"}`;
    return `💾 Disk pressure (${reason}) — ${why}`;
  }
  const disk = outcome.diskBeforeGb !== undefined && outcome.diskAfterGb !== undefined
    ? ` · disk ${outcome.diskBeforeGb} GB → ${outcome.diskAfterGb} GB free`
    : freeNow !== null
      ? ` · ${humanBytes(freeNow)} free now`
      : "";
  let text = `💾 Disk pressure (${reason}) — ran the disk-cleanup safe preset. Freed ${outcome.freedHuman}${disk}. Details in daemon.log.`;
  const stillLow = freeNow !== null && freeNow < minFreeBytes
    || (outcome.diskAfterGb !== undefined && outcome.diskAfterGb * 1e9 < minFreeBytes);
  if (stillLow) {
    text += `\n⚠︎ Still low on space. Medium targets (ML models, project node_modules) need a human call:\npython3 ${scriptPath} --preset full --allow-medium --go --empty-trash`;
  }
  return text;
}

// ─── default executor ───────────────────────────────────────────────────────

function defaultExecute(cmd: string, args: string[], timeoutMs: number): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", error: errText(e) });
      return;
    }
    const done = (r: ExecuteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      done({ code: child.exitCode, stdout, stderr, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e) => done({ code: null, stdout, stderr, error: errText(e) }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

// ─── global hook (wired into util.errorMessage) ─────────────────────────────

let active: DiskGuard | null = null;

/**
 * Tripwire for the app-wide error formatter: reacts only to ENOSPC, only while a
 * guard is installed, never throws. Errors swallowed by inner catch blocks (agent
 * runs, transports, plugins) reach the harness through here.
 */
export function noteDiskError(err: unknown): void {
  if (!active || !isEnospc(err)) return;
  try {
    active.checkNow("error-hook");
  } catch {
    /* never throw from an error formatter */
  }
}

/** Install the process-level guard. A previously installed guard is disposed. */
export function installDiskGuard(opts: DiskGuardOptions): DiskGuard {
  active?.dispose();
  const guard = new DiskGuard(opts);
  active = guard;
  return guard.install();
}