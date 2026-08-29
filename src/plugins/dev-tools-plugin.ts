import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  appendStageLog,
  evaluateStageGate,
  type CheckResult,
  type StageLogEntry,
} from "../core/dev-agent.js";
import { errorMessage, truncate } from "../core/util.js";

const runDefault = promisify(execFile);

const CHECK_TIMEOUT = 8 * 60_000; // full vitest suite can take a while
const COMMIT_TIMEOUT = 30_000;

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface DevPluginDeps {
  /** pibot repo root — the agent's workspace */
  repoRoot: string;
  /** the dev agent's own dir (staging log lives here) */
  agentDir: string;
  /** injectable runner (unit tests); defaults to real execFile */
  exec?: ExecFn;
  now?: () => number;
}

/** Run `npm run typecheck` in the repo */
export async function runTypecheck(deps: DevPluginDeps): Promise<CheckResult> {
  const exec = deps.exec ?? runDefault;
  try {
    await exec("npm", ["run", "typecheck", "--silent"], { cwd: deps.repoRoot, timeout: CHECK_TIMEOUT });
    return { ok: true, summary: "tsc --noEmit clean" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = [err.stdout, err.stderr].filter(Boolean).join("\n");
    return { ok: false, summary: truncate(out || err.message || "unknown error", 4000) };
  }
}

/** Run the vitest suite (optionally scoped to a path filter) */
export async function runTests(deps: DevPluginDeps, filter?: string): Promise<CheckResult> {
  const exec = deps.exec ?? runDefault;
  try {
    const { stdout } = await exec("npm", ["test", "--silent", ...(filter ? ["--", filter] : [])], {
      cwd: deps.repoRoot,
      timeout: CHECK_TIMEOUT,
    });
    return { ok: true, summary: extractVitestSummary(stdout) || "all tests passed" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = [err.stdout, err.stderr].filter(Boolean).join("\n") || err.message || "unknown error";
    return { ok: false, summary: truncate(out, 6000) };
  }
}

/** Vitest prints Test Files/Tests lines we can surface cheaply */
export function extractVitestSummary(stdout: string): string {
  const lines = stdout.split("\n").filter((l) => /^(Test Files|Tests|Duration)\s/.test(l.trim()));
  return lines.join(" · ").trim();
}

function isInsideRepo(repoRoot: string, target: string): boolean {
  // git status outputs repo-relative paths — resolve against the workspace root
  const rel = path.relative(path.resolve(repoRoot), path.resolve(repoRoot, target));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const FORBIDDEN = [
  /(^|\/)\.env($|\.)/, // .env, .env.local — secrets
  /(^|\/)\.git\//, // git internals
  /^data\//, // runtime state at repo root
  /(^|\/)node_modules\//,
  /(^|\/)sessions\//, // any agent's session files are runtime state
];

/** Guard: refuse to stage changes that touch runtime state or secrets */
export function stagingBlockers(repoRoot: string, files: string[]): string[] {
  return files.filter((f) => !isInsideRepo(repoRoot, f) || FORBIDDEN.some((re) => re.test(f)));
}

/**
 * Built-in plugin for the pibot-dev agent only: a tight toolset for
 * developing, testing, and staging the bot's own source.
 */
export function devToolsPlugin(deps: DevPluginDeps): InlineExtension {
  const exec = deps.exec ?? runDefault;

  async function git(args: string[], timeout = COMMIT_TIMEOUT): Promise<string> {
    const { stdout } = await exec("git", args, { cwd: deps.repoRoot, timeout });
    return stdout;
  }

  return {
    name: "dev-tools",
    factory: (pi) => {
      pi.registerTool({
        name: "dev_status",
        label: "Dev status",
        description:
          "Show the pibot repo's working state: branch, modified files (git status), diff stat, and the last 5 commits. Call this before starting work and before staging.",
        parameters: Type.Object({}),
        async execute() {
          let text: string;
          try {
            const [branch, status, stat, log] = await Promise.all([
              git(["rev-parse", "--abbrev-ref", "HEAD"]),
              git(["status", "--porcelain"]),
              git(["diff", "--stat"]),
              git(["log", "--oneline", "-5"]),
            ]);
            text = [
              `branch: ${branch.trim()}`,
              status.trim() ? `changes:\n${status.trim()}` : "working tree clean",
              stat.trim() ? `\ndiff stat:\n${truncate(stat.trim(), 1500)}` : "",
              `\nrecent commits:\n${log.trim()}`,
            ].join("\n");
          } catch (e) {
            text = `git status failed (is the repo intact?): ${errorMessage(e)}`;
          }
          return { content: [{ type: "text", text }], details: {} };
        },
      });

      pi.registerTool({
        name: "dev_test",
        label: "Run checks",
        description:
          "Run pibot's verification: TypeScript typecheck + vitest test suite (optionally scoped to a file/dir filter). Always run before claiming anything works.",
        parameters: Type.Object({
          filter: Type.Optional(
            Type.String({ description: "Optional vitest path filter, e.g. 'src/core/agent-manager' — full suite runs when omitted" })
          ),
        }),
        async execute(_tcid, params) {
          const tc = await runTypecheck(deps);
          if (!tc.ok) {
            return {
              content: [{ type: "text", text: `❌ typecheck failed:\n${tc.summary}` }],
              details: { typecheck: false, tests: false },
            };
          }
          const tests = await runTests(deps, params.filter);
          const text = tests.ok
            ? `✅ typecheck clean · ✅ tests pass (${tests.summary})`
            : `✅ typecheck clean\n❌ tests failed:\n${tests.summary}`;
          return { content: [{ type: "text", text }], details: { typecheck: tc.ok, tests: tests.ok } };
        },
      });

      pi.registerTool({
        name: "dev_stage",
        label: "Stage change",
        description:
          "Land the current change as a reviewable git checkpoint. Re-runs typecheck + FULL test suite first and refuses when either is red. Only stage after dev_test passes and the tree contains exactly your intended change.",
        parameters: Type.Object({
          title: Type.String({ description: "Short imperative title, e.g. 'fix: cascade retry double-pushes dead letters'" }),
          rationale: Type.String({ description: "One or two sentences: why this change, what it fixes/adds" }),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: Record<string, unknown>;

          const title = params.title.trim();
          if (!title) {
            text = "ERROR: empty title.";
            details = { ok: false };
            return { content: [{ type: "text", text }], details };
          }

          // 1. what's about to be staged
          let status: string;
          try {
            status = await git(["status", "--porcelain"]);
          } catch (e) {
            return { content: [{ type: "text", text: `git failed: ${errorMessage(e)}` }], details: { ok: false } as Record<string, unknown> };
          }
          const files = status
            .split("\n")
            .map((l) => l.trim().replace(/^\S+\s+/, "").replace(/^"|"$/g, ""))
            .filter(Boolean);
          if (!files.length) {
            text = "Nothing to stage — the working tree is clean.";
            details = { ok: false };
          } else if (stagingBlockers(deps.repoRoot, files).length) {
            const blockers = stagingBlockers(deps.repoRoot, files);
            text = `🛑 Refusing to stage — these paths are off-limits (runtime state/secrets):\n${blockers.join("\n")}\nUndo those changes first.`;
            details = { ok: false, blocked: blockers };
          } else {
            // 2. gate: full verification must be green — no exceptions
            const typecheck = await runTypecheck(deps);
            const tests = typecheck.ok ? await runTests(deps) : { ok: false as const, summary: "skipped (typecheck red)" };
            const gate = evaluateStageGate(typecheck, tests);
            if (!gate.ok) {
              text = `🛑 Stage refused — ${gate.reason}. Fix and re-run dev_test first.\n\nDetails:\n${[typecheck.summary, tests.summary].filter((s) => s).join("\n")}`;
              details = { ok: false, gate: gate.reason };
            } else {
              // 3. checkpoint
              try {
                await git(["add", "-A"]);
                await git(["commit", "-m", title, "-m", params.rationale]);
                const commit = (await git(["rev-parse", "--short", "HEAD"])).trim();
                const entry: StageLogEntry = { ts: deps.now?.() ?? Date.now(), commit, title, rationale: params.rationale, files };
                appendStageLog(deps.agentDir, entry);
                text = `✅ Staged as commit **${commit}** — ${title}\n${files.length} file(s). Typecheck + tests were green. The owner reviews via git history; rollback = \`git revert\`.`;
                details = { ok: true, commit, files: entry.files };
              } catch (e) {
                text = `git commit failed: ${errorMessage(e)}`;
                details = { ok: false };
              }
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });
    },
  };
}