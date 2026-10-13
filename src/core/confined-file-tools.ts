/**
 * Path-confined variants of the pi SDK's built-in read/write/edit tools.
 *
 * The SDK built-ins resolve paths with resolveToCwd, which accepts absolute and
 * `~` paths — fine for an interactive coding session, but not for unattended
 * contexts (heartbeat ticks) whose prompt is partly shaped by untrusted text.
 * These wrappers keep the SDK tool name/description/parameters/rendering and
 * delegate to the SDK `execute`, but first resolve the target exactly as the SDK
 * would, follow symlinks, and refuse anything outside the allowed roots.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface FileToolPolicy {
  /** Directories the read tool may touch (absolute). */
  readRoots: string[];
  /** Directories the write and edit tools may touch (absolute). */
  writeRoots: string[];
}

const UNICODE_SPACES = /[  -   　]/g;
const MAX_SYMLINK_HOPS = 40;

/** Mirrors the SDK's resolveToCwd (normalizePath + resolvePath with unicode-space and `@` handling). */
function resolveLikeSdk(input: string, cwd: string): string {
  let n = input.replace(UNICODE_SPACES, " ");
  if (n.startsWith("@")) n = n.slice(1);
  const home = homedir();
  if (n === "~") n = home;
  else if (n.startsWith("~/")) n = path.join(home, n.slice(2));
  if (/^file:\/\//.test(n)) n = fileURLToPath(n);
  return path.isAbsolute(n) ? path.resolve(n) : path.resolve(cwd, n);
}

/**
 * Canonical form of `p`: realpath of the deepest existing ancestor with the
 * non-existent remainder re-appended. A dangling symlink is followed to its
 * (not yet existing) target so it cannot be used to create files elsewhere.
 * Throws on anything unexpected (caller refuses).
 */
function canonicalize(p: string, hops = 0): string {
  if (hops > MAX_SYMLINK_HOPS) throw new Error("too many symlinks");
  try {
    return fs.realpathSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (st?.isSymbolicLink()) {
    // dangling symlink
    return canonicalize(path.resolve(path.dirname(p), fs.readlinkSync(p)), hops + 1);
  }
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(canonicalize(parent, hops + 1), path.basename(p));
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Variants the SDK read tool falls back to (macOS screenshot names); each must also be inside the roots. */
function readVariants(resolved: string): string[] {
  const amPm = resolved.replace(/ (AM|PM)\./gi, " $1.");
  const nfd = resolved.normalize("NFD");
  const curly = resolved.replace(/'/g, "’");
  const nfdCurly = nfd.replace(/'/g, "’");
  return [...new Set([resolved, amPm, nfd, curly, nfdCurly])];
}

function describeRoots(agentDir: string, roots: string[]): string {
  return (
    roots
      .map((r) => {
        const rel = path.relative(agentDir, r);
        return rel === "" ? "./" : `${rel.split(path.sep).join("/")}/`;
      })
      .join(", ") || "(nothing)"
  );
}

function refusal(tool: string, agentDir: string, roots: string[]) {
  return {
    content: [
      {
        type: "text" as const,
        text: `refused: ${tool} is limited to ${describeRoots(agentDir, roots)} during heartbeat ticks`,
      },
    ],
    details: undefined,
  };
}

function allowed(rawPath: unknown, cwd: string, roots: string[], variants: boolean): boolean {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) return false;
  try {
    const canonRoots = roots.map((r) => canonicalize(path.resolve(r)));
    const resolved = resolveLikeSdk(rawPath, cwd);
    const candidates = variants ? readVariants(resolved) : [resolved];
    return candidates.every((c) => {
      const canon = canonicalize(c);
      return canonRoots.some((root) => isInside(root, canon));
    });
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDefinition = ToolDefinition<any, any>;

function confine(def: AnyToolDefinition, agentDir: string, roots: string[], isRead: boolean): AnyToolDefinition {
  const limit = describeRoots(agentDir, roots);
  const verb = isRead ? "read" : def.name;
  return {
    ...def,
    description: `${def.description} Confined: ${verb} is limited to ${limit} (relative to the agent directory); paths elsewhere are refused.`,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // The SDK resolves relative paths against ctx.cwd (falling back to its factory cwd); do the same.
      const cwd = (ctx as { cwd?: string } | undefined)?.cwd || agentDir;
      if (!allowed((params as { path?: unknown })?.path, cwd, roots, isRead)) {
        return refusal(def.name, agentDir, roots);
      }
      return def.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/** read/write/edit tool definitions confined to the given roots. Pass as `customTools` to override the built-ins. */
export function confinedFileTools(agentDir: string, policy: FileToolPolicy): AnyToolDefinition[] {
  const dir = path.resolve(agentDir);
  const readRoots = policy.readRoots.map((r) => path.resolve(r));
  const writeRoots = policy.writeRoots.map((r) => path.resolve(r));
  return [
    confine(createReadToolDefinition(dir), dir, readRoots, true),
    confine(createWriteToolDefinition(dir), dir, writeRoots, false),
    confine(createEditToolDefinition(dir), dir, writeRoots, false),
  ];
}
