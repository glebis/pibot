/**
 * Field-level, compare-and-swap agent manifest updates (bd pibot-4wq1).
 *
 * The incident this guards against: an "emergency replacement" rewrote
 * agents/<id>/agent.json wholesale and kept only the fields the editor knew
 * about, silently dropping the agent's `tasks` and `commitments` capability
 * grants. A whole-file save can only ever preserve what its author enumerated.
 *
 * Rules encoded here:
 *  - only keys present in a patch change; every other authorised field is
 *    preserved exactly as it was on disk;
 *  - concurrent edits are refused with compare-and-swap (`expectedSha`);
 *  - removals from capability/tool/provider lists are DIFFED and must be
 *    acknowledged explicitly — an accidental drop is a refusal, not a save;
 *  - nothing is ever restored from history or widened automatically: the patch
 *    is the only source of new grants.
 */
import { createHash } from "node:crypto";
import type { AgentManifest } from "./types.js";

/** Manifest fields whose replacement is diffed element-wise. */
export const MANIFEST_LIST_FIELDS = ["capabilities", "tools", "providers", "cascade", "envPassthrough"] as const;

export interface ManifestDiff {
  /** scalar/object/list fields whose value changed */
  changed: string[];
  /** list field -> entries the patch adds */
  added: Record<string, string[]>;
  /** list field -> entries the patch removes */
  removed: Record<string, string[]>;
  /** fields present on the current manifest and left untouched */
  preserved: string[];
}

export interface ManifestPatchOptions {
  /** sha256 of the manifest bytes this patch was planned against (compare-and-swap) */
  currentSha?: string;
  /** the sha the caller read; a mismatch refuses the write */
  expectedSha?: string;
  /** capability/tool/provider ids whose removal is explicitly intended */
  acknowledgeRemovals?: readonly string[];
}

/** Recursive partial: a field-level patch may carry any subset of a nested object. */
type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * A field-level manifest patch. Nested plain objects are MERGED into the manifest
 * on disk (sibling keys are preserved), so a one-field save such as
 * `{ speech: { allowExternalStt: true } }` cannot drop `speech.sttProviders`.
 */
export type ManifestPatch = DeepPartial<AgentManifest>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge one patch value into the current value. Nested plain objects merge key by
 * key; arrays and scalars replace; `undefined` deletes the key at whichever level it
 * appears. This is what makes a nested one-field patch preserve unrelated siblings.
 */
function mergeManifestValue(current: unknown, patchValue: unknown): unknown {
  if (patchValue === undefined) return undefined;
  if (isPlainObject(current) && isPlainObject(patchValue)) {
    const merged: Record<string, unknown> = { ...current };
    for (const key of Object.keys(patchValue)) {
      const value = mergeManifestValue(current[key], patchValue[key]);
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }
  return patchValue;
}

export interface ManifestPatchPlan {
  ok: boolean;
  manifest?: AgentManifest;
  diff: ManifestDiff;
  /** precise reason when ok=false */
  error?: string;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

/** Element-wise diff of two manifests. Pure; never touches disk. */
export function diffManifest(current: AgentManifest, next: AgentManifest): ManifestDiff {
  const before = current as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  const changed: string[] = [];
  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  const preserved: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) === JSON.stringify(b)) {
      if (key in before) preserved.push(key);
      continue;
    }
    const aList = asList(a);
    const bList = asList(b);
    if (aList || bList) {
      const plus = (bList ?? []).filter((entry) => !(aList ?? []).includes(entry));
      const minus = (aList ?? []).filter((entry) => !(bList ?? []).includes(entry));
      if (plus.length) added[key] = plus;
      if (minus.length) removed[key] = minus;
    }
    changed.push(key);
  }
  return { changed, added, removed, preserved };
}

/**
 * Plan a field-level manifest patch. Pure — the caller owns the write.
 *
 * A key set to `undefined` clears that field; an absent key is untouched. Nested
 * plain objects (speech, heartbeat, evolution, proactive, comms) are MERGED into the
 * current manifest key by key, so a one-field patch never drops an unrelated sibling.
 * Returns ok:false (with the full diff) when the machinery refuses: a failed
 * compare-and-swap, or a removal the caller did not acknowledge.
 */
export function planManifestPatch(
  current: AgentManifest,
  patch: ManifestPatch,
  opts: ManifestPatchOptions = {},
): ManifestPatchPlan {
  const currentRecord = current as unknown as Record<string, unknown>;
  const next = { ...currentRecord };
  const patchRecord = patch as unknown as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    const value = mergeManifestValue(currentRecord[key], patchRecord[key]);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const manifest = next as unknown as AgentManifest;
  const diff = diffManifest(current, manifest);

  if (opts.expectedSha && opts.currentSha && opts.expectedSha !== opts.currentSha) {
    return {
      ok: false,
      diff,
      error: `manifest changed on disk since it was read (compare-and-swap mismatch: expected ${opts.expectedSha.slice(0, 12)}..., found ${opts.currentSha.slice(0, 12)}...) — refresh and retry`,
    };
  }

  const acknowledged = new Set(opts.acknowledgeRemovals ?? []);
  const unacknowledged = [...new Set(Object.values(diff.removed).flat())].filter((id) => !acknowledged.has(id));
  if (unacknowledged.length) {
    return {
      ok: false,
      diff,
      error: `patch would remove list entries without explicit acknowledgement: ${unacknowledged.join(", ")} — pass acknowledgeRemovals to confirm an intentional removal`,
    };
  }

  return { ok: true, manifest, diff };
}
