import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

const run = promisify(execFile);

export const DELEGATE_CLIS: Record<string, { args: (prompt: string) => string[]; label: string }> = {
  claude: { args: (p) => ["-p", p, "--output-format", "text"], label: "Claude Code" },
  codex: { args: (p) => ["exec", p], label: "Codex CLI" },
  gemini: { args: (p) => ["-p", p], label: "Gemini CLI" },
};

const TIMEOUT = 10 * 60_000;
const MAX_OUT = 8000;

export interface DelegatePluginDeps {
  /** allowed CLI names; defaults to the installed set */
  allowed?: string[];
  /** working directory for delegated runs (default: cwd of the daemon) */
  cwd?: string;
  agentId?: string;
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
          cwd: Type.Optional(Type.String({ description: "Working directory for the run (defaults to the daemon cwd)" })),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: Record<string, unknown>;
          const spec = DELEGATE_CLIS[params.cli];
          if (!spec) {
            text = `ERROR: unknown CLI "${params.cli}" — use ${Object.keys(DELEGATE_CLIS).join(", ")}.`;
            details = { ok: false };
          } else if (deps.allowed && !deps.allowed.includes(params.cli)) {
            text = `ERROR: "${params.cli}" is not in the allowed delegation list.`;
            details = { ok: false };
          } else {
            try {
              const { stdout } = await run(params.cli, spec.args(params.prompt), {
                timeout: TIMEOUT,
                maxBuffer: 4 * 1024 * 1024,
                cwd: params.cwd || deps.cwd,
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