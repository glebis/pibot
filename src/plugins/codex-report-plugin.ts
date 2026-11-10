import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { promisify } from "node:util";
import { truncate } from "../core/util.js";

const run = promisify(execFile);

const BRCTL = "/usr/bin/brctl";
const DEFAULT_MAX_BYTES = 256 * 1024;
const READ_CHAR_LIMIT = 20_000;
/** Bounded materialization: brctl download + poll-reads (≈5s worst case). */
const MATERIALIZE_POLLS = 10;
const MATERIALIZE_POLL_MS = 500;

/** macOS iCloud dataless files fail data reads with libuv "Unknown system error -11" (metadata reads fine). */
export const DATALESS_ERROR_HINT = "iCloud placeholder (dataless) file — brctl download failed to materialize it";

const isDatalessReadError = (e: unknown): boolean => {
  const text = String((e as { message?: string })?.message ?? e);
  return /unknown system error -11\b|EAGAIN|dataless/i.test(text);
};

export interface CodexReportPluginDeps {
  /** absolute path to the owner's Codex activity-report root; the only accessible root */
  reportsDir: string;
  /** max bytes accepted by codex_report_read */
  maxBytes?: number;
  /** override materialization for tests; default shells out to /usr/bin/brctl download */
  materialize?: (file: string) => Promise<void>;
  /** override the raw read for tests; throwing a dataless-shaped error exercises the retry */
  readRaw?: (file: string) => string;
  /** wall-clock stub for tests */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Opt-in plugin: READ-ONLY access to the owner's Codex-generated activity
 * reports (~/Documents/Codex/<date>/...). The owner asked for exactly this in
 * Oct 2026 — agents (focuscoach) need weekly screen-time/activity data without
 * getting generic filesystem access. Strictly path-scoped like the vault
 * plugin; no write tool exists here.
 */
export function codexReportPlugin(deps: CodexReportPluginDeps): InlineExtension {
  const reportsDir = path.resolve(deps.reportsDir);
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const readRaw = deps.readRaw ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const materialize =
    deps.materialize ??
    (async (file: string) => {
      try {
        await run(BRCTL, ["download", file], { timeout: 30_000 });
      } catch {
        /* exit code is unreliable across macOS versions; the poll decides */
      }
    });
  const brctlLikelyAvailable = fs.existsSync(BRCTL);
  const canMaterialize = Boolean(deps.materialize) || brctlLikelyAvailable;

  const readWithMaterialization = async (target: string): Promise<string> => {
    try {
      return readRaw(target);
    } catch (e) {
      if (!isDatalessReadError(e) || !canMaterialize) throw e;
    }
    await materialize(target);
    for (let attempt = 0; attempt < MATERIALIZE_POLLS; attempt++) {
      await sleep(MATERIALIZE_POLL_MS);
      try {
        return readRaw(target);
      } catch (e) {
        if (!isDatalessReadError(e)) throw e;
      }
    }
    throw new Error(DATALESS_ERROR_HINT);
  };

  /**
   * Same traversal/symlink discipline as vault-plugin: refuse anything that
   * does not stay strictly inside the reports root, including `..`, absolute
   * paths outside, and symlink escapes (realpath of the nearest existing
   * ancestor catches symlinked directories; lstat catches symlinked leaves).
   */
  const resolveInsideRoot = (requested: string): string | null => {
    if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) return null;
    if (!fs.existsSync(reportsDir)) return null;
    const resolved = path.resolve(reportsDir, requested);
    const rel = path.relative(reportsDir, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const realRoot = fs.realpathSync(reportsDir);
    const real = fs.realpathSync(probe);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    const leaf = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (leaf?.isSymbolicLink()) return null;
    return resolved;
  };

  const refuse = (reason: string) => ({ content: [{ type: "text" as const, text: `refused: ${reason}` }], details: { ok: false } });

  return {
    name: "codex-reports",
    factory: (pi) => {
      pi.registerTool({
        name: "codex_report_list",
        label: "List Codex reports",
        description:
          "List the owner's Codex activity-report directory (~/Documents/Codex): report dates at the root, or files inside one report dir. Read-only.",
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: "Optional report subdir to list (e.g. '2026-10-27'); omit for the date overview" })),
        }),
        async execute(_tcid, params) {
          const target = params.path ? resolveInsideRoot(params.path) : reportsDir;
          if (!target) return refuse("path must stay inside the Codex reports dir");
          try {
            const stat = fs.statSync(target);
            if (!stat.isDirectory()) return refuse("not a directory");
            const entries = fs
              .readdirSync(target, { withFileTypes: true })
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((e) => (e.isDirectory() ? `dir ${e.name}/` : `file ${e.name}`));
            return {
              content: [{ type: "text", text: entries.join("\n") || "(empty)" }],
              details: { ok: true, path: params.path ?? "(root)" },
            };
          } catch (e) {
            return { content: [{ type: "text", text: `list failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });

      pi.registerTool({
        name: "codex_report_read",
        label: "Read Codex report",
        description:
          "Read one text file (md/json/csv/txt) from the owner's Codex activity reports (~/Documents/Codex). Read-only; no write tool exists. Use codex_report_list to discover paths. Reports may live as iCloud placeholders: the first read of an old file may download it (a few seconds); later reads are instant.",
        parameters: Type.Object({
          path: Type.String({ description: "Path relative to the Codex reports root (or absolute inside it), e.g. '2026-10-27/report.md'" }),
        }),
        async execute(_tcid, params) {
          const target = resolveInsideRoot(params.path);
          if (!target) return refuse("path must resolve to a file inside the Codex reports dir");
          try {
            const stat = fs.statSync(target);
            if (!stat.isFile()) return refuse("not a file");
            if (stat.size > maxBytes) return refuse(`file is ${stat.size} bytes, codex_report_read caps at ${maxBytes}`);
            const raw = await readWithMaterialization(target);
            const text = raw.length > READ_CHAR_LIMIT ? `${truncate(raw, READ_CHAR_LIMIT)}\n\n[truncated — read in sections via smaller files or ask the owner]` : raw;
            return { content: [{ type: "text", text }], details: { ok: true, path: path.relative(reportsDir, target) } };
          } catch (e) {
            return { content: [{ type: "text", text: `read failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });
    },
  };
}