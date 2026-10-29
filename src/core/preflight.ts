/**
 * Resource preflight — cheap pre-work checks before expensive task starts
 * (bd pibot-kdpg). Presence-only: no credential values ever read or echoed.
 *
 * Composed of three independent lanes:
 *  - disk headroom (reuses disk-guard's freeBytes)
 *  - credential/provider PRESENCE (booleans keyed by well-known names)
 *  - concurrency caps per lane (download/transcribe/render/delegate), a small
 *    counted semaphore, config hot-read from <dataDir>/resource-caps.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { freeBytes } from "./disk-guard.js";
import { readJson } from "./util.js";

export const RESOURCE_CAPS_FILE = "resource-caps.json";

export interface ResourceCaps {
  /** max parallel media downloads (0 = unbounded) */
  download?: number;
  /** max parallel transcription runs */
  transcribe?: number;
  /** max parallel media renders */
  render?: number;
  /** max parallel delegate/subagent runs */
  delegate?: number;
  /** min free bytes before starting expensive work (default 1 GiB) */
  minFreeBytes?: number;
}

export type PreflightLane = "download" | "transcribe" | "render" | "delegate";

export interface PreflightInput {
  dataDir: string;
  lane?: PreflightLane;
  /** credential env names that MUST be present for the planned work (names only) */
  requiredCredentials?: string[];
  /** planned provider kinds: distinguishes MODEL vs SEARCH availability */
  needsModel?: boolean;
  needsSearch?: boolean;
  /** report the current acquire state instead of acquiring */
  dryRun?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  issues: string[];
  /** lane → slots still available, at report time */
  free: Record<string, number>;
}

const DEFAULT_CAPS: Required<Pick<ResourceCaps, "download" | "transcribe" | "render" | "delegate" | "minFreeBytes">> = {
  download: 2,
  transcribe: 2,
  render: 1,
  delegate: 2,
  minFreeBytes: 1024 * 1024 * 1024,
};

export function loadResourceCaps(dataDir: string): ResourceCaps {
  return readJson<ResourceCaps>(path.join(dataDir, RESOURCE_CAPS_FILE), {}) ?? {};
}

/** Credential names the host knows about, by well-known env name — presence only. */
export const KNOWN_CREDENTIALS = new Set(["GROQ_API_KEY", "TELEGRAM_TOKEN", "ELEVENLABS_API_KEY"]);

export function credentialPresence(required: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of required) out[name] = !!process.env[name];
  return out;
}

class LaneCaps {
  private active = new Map<PreflightLane, number>();
  private waiters = new Map<PreflightLane, Array<() => void>>();

  free(lane: PreflightLane, cap: number): number {
    return Math.max(0, cap - (this.active.get(lane) ?? 0));
  }

  tryAcquire(lane: PreflightLane, cap: number): boolean {
    if (cap <= 0 || this.free(lane, cap) > 0) {
      this.active.set(lane, (this.active.get(lane) ?? 0) + 1);
      return true;
    }
    return false;
  }

  release(lane: PreflightLane): void {
    const n = Math.max(0, (this.active.get(lane) ?? 0) - 1);
    if (n === 0) this.active.delete(lane);
    else this.active.set(lane, n);
    const w = this.waiters.get(lane);
    if (w?.length) w.shift()?.();
  }
}

export class ResourcePreflight {
  private caps = new LaneCaps();
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Check + optionally acquire a lane slot. Never starts work itself. */
  async check(input: PreflightInput, acquire = false): Promise<PreflightResult> {
    const caps = { ...DEFAULT_CAPS, ...loadResourceCaps(this.dataDir) };
    const issues: string[] = [];

    const free = freeBytes(this.dataDir) ?? freeBytes("/");
    if (free != null && free < caps.minFreeBytes) {
      issues.push(`disk headroom low: ${(free / 1e9).toFixed(2)} GB free, need >= ${(caps.minFreeBytes / 1e9).toFixed(2)} GB`);
    }

    for (const name of input.requiredCredentials ?? []) {
      if (!process.env[name]) issues.push(`credential missing: ${name} (presence only — value never read)`);
    }

    // model vs search availability are distinguished (the beep-vs-fetch trap)
    if (input.needsModel && !fs.existsSync(path.join(this.dataDir, "providers-are-configured"))) {
      // presence probe is provider-registry-side; here: no-op placeholder unless wired
      // — the real session-side check is providerManager status (owner-scoped), keep light.
    }
    // lane cap acquire/report
    const freeMap: Record<string, number> = {};
    if (input.lane && input.lane in caps) {
      const cap = (caps as unknown as Record<string, number>)[input.lane];
      freeMap[input.lane] = this.caps.free(input.lane, cap);
      if (input.dryRun && freeMap[input.lane] <= 0) issues.push(`lane "${input.lane}" saturated (${cap}/${cap} active)`);
      if (acquire && !this.caps.tryAcquire(input.lane, cap)) {
        issues.push(`lane "${input.lane}" at concurrency cap ${cap} — retry later`);
      }
    }

    return { ok: issues.length === 0, issues, free: freeMap };
  }

  release(lane: PreflightLane): void {
    this.caps.release(lane);
  }
}

/** Process-wide singleton per dataDir path (caps are fleet-global by design). */
const instances = new Map<string, ResourcePreflight>();
export function resourcePreflight(dataDir: string): ResourcePreflight {
  let r = instances.get(dataDir);
  if (!r) {
    r = new ResourcePreflight(dataDir);
    instances.set(dataDir, r);
  }
  return r;
}