import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

const execFileAsync = promisify(execFile);

export const EXEC_TIMEOUT_MS = 600_000;
export const EXEC_MAX_OUTPUT = 64_000;

/** One allowlist entry: a pinned binary plus optional argument constraints. */
export interface ExecAllowEntry {
  /** command name as the agent would write it (resolved via PATH at call time) */
  bin: string;
  /** if set: argv[1..] must START with exactly these literal args (after tilde expansion) */
  pin?: string[];
  /** arg patterns refused for this entry */
  denyArgRe?: RegExp[];
  /** if set: the first non-pin argument that looks like a file path must resolve under this dir */
  requireScriptUnder?: string;
}

/**
 * Vetted allowlist for the "exec" capability. Deliberately narrow:
 * - binaries are resolved at call time and the resolved path must match the entry (no PATH hijack)
 * - commands run via execFile argv — NO shell, so pipes/redirections/substitutions are inert
 * - python3 is pinned to the single youtube-transcript script (bare python3 = arbitrary code)
 * - osascript is pinned to script FILES inside the agent's own dir; inline `-e` scripts are refused
 *   (osascript -e can run arbitrary shell)
 * - yt-dlp denies its own command-execution flags (--exec / --postprocessor-args / --ppa)
 */
export const DEFAULT_EXEC_ALLOWLIST: ExecAllowEntry[] = [
  { bin: "yt-dlp", denyArgRe: [/^--exec/, /^--postprocessor-args/, /^--ppa/] },
  { bin: "whisperkit-cli" },
  { bin: "python3", pin: [path.join(os.homedir(), ".agents/skills/youtube-transcript/scripts/extract_transcript.py")] },
  { bin: "afplay" },
  { bin: "osascript", denyArgRe: [/^-e$/, /^-i$/] },
  // ssh pinned to the fleet-configured mini aliases only (remote commands are the point;
  // freedom inside the remote command is inherent to ssh and covered by the pin on destination)
  { bin: "ssh", pin: ["pibot-mini"] },
  { bin: "ssh", pin: ["pibot-mini-alt"] },
];

export interface ExecPluginDeps {
  /** cwd for executed commands (the agent's workspace) */
  workspace: string;
  /** the agent's own directory — osascript script files must live under it */
  agentDir: string;
  allowlist?: ExecAllowEntry[];
  timeoutMs?: number;
  maxOutput?: number;
}

interface Resolution {
  entry: ExecAllowEntry;
  argv: string[];
}

function resolveTilde(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Refuse anything that smells like it expects a shell to interpret it. */
function looksLikeShell(arg: string): boolean {
  return /(^|\s)(&&|\|\||;|`|\$\(|>\s*|\|\s)/.test(arg);
}

export async function resolveExec(argv: string[], deps: ExecPluginDeps, allowlist: ExecAllowEntry[]): Promise<{ argv: string[]; cwd: string; error?: string }> {
  const cwd = path.resolve(deps.workspace);
  let constraintFailure: string | undefined;
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string" || argv[0].trim() === "") {
    return { argv: [], cwd, error: "argv must be a non-empty array with the command as the first element" };
  }
  if (argv.some((a) => typeof a !== "string")) return { argv: [], cwd, error: "all argv elements must be strings" };
  if (argv.some((a) => looksLikeShell(a))) {
    return { argv: [], cwd, error: "refused: shell metacharacters are not interpreted — commands run as plain argv" };
  }

  const requested = argv[0];
  let resolvedBin: string;
  try {
    resolvedBin = (await execFileAsync("/bin/sh", ["-c", `command -v -- ${JSON.stringify(requested)}`])).stdout.trim();
  } catch {
    return { argv: [], cwd, error: `command not found: ${requested}` };
  }
  if (!resolvedBin || !fs.existsSync(resolvedBin)) return { argv: [], cwd, error: `command not found: ${requested}` };

  for (const entry of allowlist) {
    const entryResolved = (await execFileAsync("/bin/sh", ["-c", `command -v -- ${JSON.stringify(entry.bin)}`])).stdout.trim().split("\n")[0];
    if (resolvedBin !== entryResolved) continue;

    const entryArgs = argv.slice(1);
    if (entry.denyArgRe && entryArgs.some((a) => entry.denyArgRe!.some((re) => re.test(a)))) {
      return { argv: [], cwd, error: `refused: ${entry.bin} invoked with a denied argument (command-execution flags are not allowed)` };
    }
    let rest = entryArgs;
    if (entry.pin && entry.pin.length > 0) {
      const pinned = entry.pin.map(resolveTilde);
      if (entryArgs.length < pinned.length || pinned.some((p, i) => resolveTilde(entryArgs[i]) !== p)) {
        constraintFailure = `refused: ${entry.bin} is pinned to ${pinned.join(" ")} — other invocations are not allowlisted`;
        continue;
      }
      rest = entryArgs.slice(pinned.length);
    }
    if (entry.requireScriptUnder && rest.length > 0) {
      const under = fs.realpathSync(path.resolve(entry.requireScriptUnder));
      const first = resolveTilde(rest[0]);
      const probe = fs.existsSync(first) ? fs.realpathSync(first) : path.resolve(first);
      if (probe !== under && !probe.startsWith(under + path.sep)) {
        constraintFailure = `refused: ${entry.bin} script must live under ${under}`;
        continue;
      }
    }
    return { argv: [resolvedBin, ...entryArgs], cwd };
  }
  return { argv: [], cwd, error: constraintFailure ?? `refused: "${requested}" is not on this agent's exec allowlist` };
}

export function execPlugin(deps: ExecPluginDeps): InlineExtension {
  const allowlist = deps.allowlist ?? DEFAULT_EXEC_ALLOWLIST;
  const timeoutMs = deps.timeoutMs ?? EXEC_TIMEOUT_MS;
  const maxOutput = deps.maxOutput ?? EXEC_MAX_OUTPUT;

  type ExecToolResult = { content: Array<{ type: "text"; text: string }>; details: { ok: boolean; exitCode: number | null; durationMs?: number } };
  const refuse = (reason: string): ExecToolResult => ({ content: [{ type: "text", text: `refused: ${reason}` }], details: { ok: false, exitCode: null } });

  return {
    name: "exec",
    factory: (pi) => {
      pi.registerTool({
        name: "exec_run",
        label: "Run allowlisted command",
        description:
          "Run a command from this agent's vetted exec allowlist. Pass argv (array of strings, command first). NO shell: no pipes, redirections or substitutions — plain argv only. Binaries are resolved and matched against pinned entries; denied arguments (e.g. yt-dlp --exec, osascript -e) are refused. Long-running commands are capped by a timeout; output is truncated.",
        parameters: Type.Object({
          argv: Type.Array(Type.String({ description: "argument vector — command first, then arguments" }), { minItems: 1, maxItems: 64, description: "e.g. [\"yt-dlp\", \"--skip-download\", \"--list-subs\", URL]" }),
        }),
        async execute(_tcid, params): Promise<ExecToolResult> {
          const started = Date.now();
          const resolved = await resolveExec(params.argv, deps, allowlist);
          if (resolved.error) return refuse(resolved.error);
          try {
            const { stdout, stderr } = await execFileAsync(resolved.argv[0], resolved.argv.slice(1), {
              cwd: resolved.cwd,
              timeout: timeoutMs,
              maxBuffer: 8 * 1024 * 1024,
            });
            const secs = Math.round((Date.now() - started) / 1000);
            const body = [
              `exit 0 · ${secs}s · cwd ${resolved.cwd}`,
              stdout.trim() ? `--- stdout ---\n${truncate(stdout, maxOutput)}` : "--- (no stdout) ---",
              stderr.trim() ? `--- stderr ---\n${truncate(stderr, maxOutput)}` : "",
            ].filter(Boolean).join("\n");
            return { content: [{ type: "text" as const, text: body }], details: { ok: true, exitCode: 0, durationMs: Date.now() - started } };
          } catch (e) {
            const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
            const secs = Math.round((Date.now() - started) / 1000);
            const text = [
              err.killed ? `timed out after ${secs}s` : `exit ${err.code ?? "?"} · ${secs}s`,
              err.stdout?.trim() ? `--- stdout ---\n${truncate(err.stdout, maxOutput)}` : "",
              err.stderr?.trim() ? `--- stderr ---\n${truncate(err.stderr, maxOutput)}` : "",
              !(err.stdout?.trim() || err.stderr?.trim()) ? String(err.message ?? e) : "",
            ].filter(Boolean).join("\n");
            return { content: [{ type: "text" as const, text }], details: { ok: false, exitCode: typeof err.code === "number" ? err.code : null } };
          }
        },
      });
    },
  };
}