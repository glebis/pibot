import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { childEnv } from "../core/child-env.js";
import { truncate } from "../core/util.js";

const run = promisify(execFile);

export const DELEGATE_CLIS: Record<string, { args: (prompt: string) => string[]; label: string; passthrough: string[] }> = {
  // claude/codex authenticate via keychain / ~/.claude / ~/.codex — no env secrets needed
  claude: { args: (p) => ["-p", p, "--output-format", "text"], label: "Claude Code", passthrough: [] },
  codex: { args: (p) => ["exec", p], label: "Codex CLI", passthrough: [] },
  gemini: { args: (p) => ["-p", p], label: "Gemini CLI", passthrough: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
};

/** Resolve a model-supplied cwd; it must live inside `root` (realpath, symlinks followed). */
export function resolveDelegateCwd(requested: string | undefined, root: string | undefined): { ok: true; cwd: string | undefined } | { ok: false; error: string } {
  if (!requested) return { ok: true, cwd: root };
  if (!root) return { ok: false, error: "cwd override is not allowed (no workspace configured)" };
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.resolve(realRoot, requested));
    const rel = path.relative(realRoot, real);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      return { ok: false, error: `cwd "${requested}" is outside the agent workspace` };
    }
    return { ok: true, cwd: real };
  } catch {
    return { ok: false, error: `cwd "${requested}" does not exist or is not accessible` };
  }
}

const TIMEOUT = 10 * 60_000;
const MAX_OUT = 8000;

export interface DelegatePluginDeps {
  /** allowed CLI names; defaults to the installed set */
  allowed?: string[];
  /** working directory for delegated runs (default: cwd of the daemon) */
  cwd?: string;
  agentId?: string;
  /** extra env var names the delegated CLIs may inherit (manifest.envPassthrough) */
  envPassthrough?: string[];
  /** injectable runner (tests) */
  run?: (cmd: string, args: string[], opts: { timeout: number; maxBuffer: number; cwd?: string; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
}

/**
 * Shared plugin: delegate work to external coding CLIs (Claude Code, Codex,
 * Gemini). The delegated CLI runs with ITS OWN auth and permissions — pibot
 * is the dispatcher, the CLI is the worker. Output comes back as the result.
 */
export function delegatePlugin(deps: DelegatePluginDeps = {}): InlineExtension {
  const allowed = new Set(deps.allowed ?? Object.keys(DELEGATE_CLIS));

  return {
    name: "delegate",
    factory: (pi) => {
      pi.registerTool({
        name: "delegate_cli",
        label: "Delegate to CLI",
        description: `Delegate a self-contained task to an external coding CLI and wait for the result. Available: ${Object.entries(DELEGATE_CLIS).map(([k, v]) => `${k} (${v.label})`).join(", ")}. The CLI runs non-interactively with its own auth — use for tasks that benefit from a different agent's toolset (deep code work, research). Prompt must be self-contained.`,
        parameters: Type.Object({
          cli: Type.String({ description: "claude | codex | gemini" }),
          prompt: Type.String({ description: "Self-contained task prompt for the CLI" }),
          cwd: Type.Optional(Type.String({ description: "Working directory for the run; must be inside the agent workspace (default: the workspace)" })),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: Record<string, unknown>;
          let resolved: ReturnType<typeof resolveDelegateCwd>;
          const spec = DELEGATE_CLIS[params.cli];
          if (!spec) {
            text = `ERROR: unknown CLI "${params.cli}" — use ${Object.keys(DELEGATE_CLIS).join(", ")}.`;
            details = { ok: false };
          } else if (deps.allowed && !deps.allowed.includes(params.cli)) {
            text = `ERROR: "${params.cli}" is not in the allowed delegation list.`;
            details = { ok: false };
          } else if (!(resolved = resolveDelegateCwd(params.cwd, deps.cwd)).ok) {
            text = `ERROR: ${resolved.error}.`;
            details = { ok: false };
          } else {
            try {
              const cwd = resolved.cwd;
              const { stdout } = await (deps.run ?? run)(params.cli, spec.args(params.prompt), {
                timeout: TIMEOUT,
                maxBuffer: 4 * 1024 * 1024,
                cwd,
                env: childEnv({ passthrough: [...spec.passthrough, ...(deps.envPassthrough ?? [])] }),
              });
              text = `**${spec.label}** result:\n\n${truncate(stdout.trim() || "(empty)", 4000)}`;
              details = { ok: true, cli: params.cli };
            } catch (e) {
              const err = e as { stdout?: string; message?: string };
              text = `**${spec.label}** failed: ${truncate(err.message ?? String(e), 200)}${err.stdout ? `\n${truncate(err.stdout, 1500)}` : ""}`;
              details = { ok: false };
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });
    },
  };
}