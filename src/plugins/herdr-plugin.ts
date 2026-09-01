import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

const run = promisify(execFile);

/** Agents a pane may launch; anything else would be an arbitrary shell command in a pane. */
export const HERDR_AGENTS = ["claude", "codex", "pi", "opencode"] as const;
export type HerdrAgent = (typeof HERDR_AGENTS)[number];

/** Wait between `pane run <agent>` and the first prompt (agent TUIs need time to paint). */
const DEFAULT_SETTLE_MS = 14_000;

const READ_TIMEOUT = 15_000;

export type HerdrExecFn = (
  cmd: string,
  args: string[],
  opts: { timeout: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface HerdrPluginDeps {
  /** injectable runner (unit tests); defaults to real execFile of `herdr` */
  exec?: HerdrExecFn;
  /** herdr binary (default "herdr") */
  bin?: string;
  /** env used for HERDR_ENV detection (injectable for tests) */
  env?: NodeJS.ProcessEnv;
  /** ms to let an agent TUI paint before prompting (injectable for tests) */
  settleMs?: number;
  /** injectable sleep (tests) */
  sleep?: (ms: number) => Promise<void>;
}

/** Run herdr, returning parsed JSON; throws with stderr on nonzero exit. */
async function herdrJson(deps: Required<Pick<HerdrPluginDeps, "exec" | "bin">>, args: string[], timeout = READ_TIMEOUT): Promise<any> {
  const { stdout } = await deps.exec(deps.bin, args, { timeout });
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return stdout;
  }
}

/** Run herdr tolerating nonzero exit (wait helpers signal timeouts that way). */
async function herdrTry(deps: Required<Pick<HerdrPluginDeps, "exec" | "bin">>, args: string[], timeout: number): Promise<{ stdout: string; failed: boolean }> {
  try {
    const { stdout } = await deps.exec(deps.bin, args, { timeout });
    return { stdout, failed: false };
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    return { stdout: err.stdout ?? "", failed: true };
  }
}

interface PaneInfo { pane_id: string; workspace_id?: string; focused?: boolean }
interface WorkspaceInfo { workspace_id: string; label?: string }

function panesOf(json: any): PaneInfo[] {
  return json?.result?.panes ?? [];
}

function workspacesOf(json: any): WorkspaceInfo[] {
  return json?.result?.workspaces ?? [];
}

/**
 * Resolve the herdr workspace subagents are spawned into.
 * Order: explicit value (workspace id or exact label), else the focused
 * pane's workspace when running inside herdr, else undefined.
 */
/**
 * Resolve the herdr workspace subagents are spawned into.
 * Order: explicit value (workspace id or exact label), else the focused
 * pane's workspace when running inside herdr, else $PIBOT_HERDR_WORKSPACE,
 * else undefined (the caller errors with the available list).
 */
export async function resolveWorkspaceId(deps: Required<HerdrPluginDeps>, wanted?: string): Promise<string | undefined> {
  const byIdOrLabel = (list: WorkspaceInfo[], value: string): WorkspaceInfo | undefined =>
    list.find((w) => w.workspace_id === value || w.label === value);
  if (wanted) {
    return byIdOrLabel(workspacesOf(await herdrJson(deps, ["workspace", "list"])), wanted)?.workspace_id;
  }
  if ((deps.env.HERDR_ENV ?? "").trim() === "1") {
    const focused = panesOf(await herdrJson(deps, ["pane", "list"])).find((p: any) => p.focused);
    if (focused) return focused.workspace_id ?? String(focused.pane_id ?? "").split(":")[0];
  }
  const configured = deps.env.PIBOT_HERDR_WORKSPACE?.trim();
  if (configured) {
    return byIdOrLabel(workspacesOf(await herdrJson(deps, ["workspace", "list"])), configured)?.workspace_id;
  }
  return undefined;
}

export function deriveLabel(brief: string, explicit?: string): string {
  if (explicit) return explicit;
  const words = brief.toLowerCase().match(/[\w-]+/g) ?? [];
  return words.slice(0, 3).join("-").slice(0, 24) || "task";
}

/** List workspaces as "id (label)" for error messages. */
async function workspaceSummary(deps: Required<HerdrPluginDeps>): Promise<string> {
  try {
    const list = workspacesOf(await herdrJson(deps, ["workspace", "list"]));
    return list.map((w) => `${w.workspace_id} (${w.label ?? "?"})`).join(", ");
  } catch {
    return "(could not list workspaces — is herdr running?)";
  }
}

const BRIEF_INSTRUCTION = (briefPath: string) =>
  `Read ${briefPath} and carry out exactly what it specifies. Work autonomously to completion.`;

export interface DispatchParams {
  brief: string;
  agent?: string;
  label?: string;
  workspace?: string;
  timeoutSeconds?: number;
  lines?: number;
  detach?: boolean;
  closeWhenDone?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  paneId?: string;
  tabId?: string;
  briefPath?: string;
  timedOut?: boolean;
  text: string;
}

/**
 * The full herdr-task loop: brief → tab → agent TUI → prompt → wait → collect.
 * On a mid-loop failure the opened tab is closed again (best effort) so a
 * broken dispatch never leaves stray tabs behind.
 */
export async function dispatchTask(deps: Required<HerdrPluginDeps>, params: {
  brief: string;
  agent: string;
  label?: string;
  workspace?: string;
  timeoutSeconds: number;
  lines: number;
  detach: boolean;
  closeWhenDone: boolean;
}): Promise<DispatchResult> {
  const { brief, agent, label, workspace, timeoutSeconds, lines, detach, closeWhenDone } = params;

  const workspaceId = await resolveWorkspaceId(deps, workspace);
  if (!workspaceId) {
    return {
      ok: false,
      text: `ERROR: could not resolve a herdr workspace to spawn into. Pass an explicit \`workspace\` (id or label). Available: ${await workspaceSummary(deps)}.`,
    };
  }

  const briefPath = path.join(os.tmpdir(), `herdr-brief-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
  fs.writeFileSync(briefPath, brief, { mode: 0o600 });

  let tabId: string | undefined;
  let paneId: string | undefined;
  try {
    const created = await herdrJson(deps, [
      "tab", "create", "--workspace", workspaceId, "--label", deriveLabel(brief, label), "--no-focus",
    ]);
    tabId = created?.result?.tab?.tab_id;
    paneId = created?.result?.root_pane?.pane_id;
    if (!paneId) throw new Error("tab create returned no root pane");

    await deps.exec(deps.bin, ["pane", "run", paneId, agent], { timeout: READ_TIMEOUT });
    await deps.sleep(deps.settleMs);

    // A first-run agent TUI may sit on a trust/onboarding dialog; sending the
    // brief into it would get eaten (and Enter could dismiss it wrong). Fail
    // fast and leave the dialog on screen for the owner to accept once.
    const settleRead = await herdrTry(deps, ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "30"], 15_000);
    if (/trust this folder|new MCP servers found|wish to enable|allow codex to run/i.test(settleRead.stdout)) {
      return {
        ok: false,
        paneId,
        tabId,
        briefPath,
        text: `ERROR: spawned \`${agent}\` is showing a first-run trust/onboarding dialog in tab \`${tabId}\` (pane \`${paneId}\`) and never reached a prompt. The tab is left open — ask the owner to accept it once; afterwards re-dispatch into the same workspace. Brief (not delivered): ${briefPath}`,
      };
    }

    await deps.exec(deps.bin, ["pane", "run", paneId, BRIEF_INSTRUCTION(briefPath)], { timeout: READ_TIMEOUT });
    await deps.sleep(2_000);
    await deps.exec(deps.bin, ["pane", "send-keys", paneId, "Enter"], { timeout: READ_TIMEOUT });
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if (tabId) await herdrTry(deps, ["tab", "close", tabId], READ_TIMEOUT).catch(() => undefined);
    fs.rmSync(briefPath, { force: true });
    return { ok: false, paneId, tabId, text: `ERROR: herdr dispatch failed: ${truncate(message, 300)}` };
  }

  if (params.detach) {
    return {
      ok: true, paneId, tabId, briefPath,
      text: `Subagent \`${agent}\` started detached in herdr tab \`${tabId}\` (pane \`${paneId}\`). Brief: ${briefPath}\nCollect later with herdr_read on pane \`${paneId}\` or herdr_wait for status \`done\`.`,
    };
  }

  const waited = await herdrTry(deps, ["wait", "agent-status", paneId, "--status", "done", "--timeout", String(timeoutSeconds * 1000)], timeoutSeconds * 1000 + 30_000);
  const timedOut = waited.failed;

  const read = await herdrTry(deps, ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], READ_TIMEOUT);
  const transcript = truncate(read.stdout.trim() || "(no output)", 4000);

  if (params.closeWhenDone && !timedOut) {
    await herdrTry(deps, ["tab", "close", tabId!], READ_TIMEOUT);
    fs.rmSync(briefPath, { force: true });
    return {
      ok: true, paneId, tabId, briefPath, timedOut,
      text: `Subagent \`${agent}\` finished; tab \`${tabId}\` closed.\n\n${transcript}`,
    };
  }

  return {
    ok: true, paneId, tabId, briefPath, timedOut,
    text: timedOut
      ? `Subagent \`${agent}\` did not reach \`done\` within ${timeoutSeconds}s — tab \`${tabId}\` (pane \`${paneId}\`) left open. Observe it with herdr_read/herdr_wait. Brief: ${briefPath}`
      : `Subagent \`${agent}\` finished in tab \`${tabId}\` (pane \`${paneId}\`, left open). Brief: ${briefPath}\n\n${transcript}`,
  };
}

export function herdrPlugin(deps: HerdrPluginDeps = {}): InlineExtension {
  const bin = deps.bin ?? "herdr";
  const execFn = deps.exec ?? ((cmd, args, opts) => run(cmd, args, { timeout: opts.timeout, maxBuffer: 4 * 1024 * 1024 }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const resolved: Required<HerdrPluginDeps> = {
    bin,
    exec: execFn,
    env: deps.env ?? process.env,
    settleMs: deps.settleMs ?? DEFAULT_SETTLE_MS,
    sleep,
  };

  return {
    name: "herdr",
    factory: (pi) => {
      pi.registerTool({
        name: "herdr_dispatch",
        label: "Dispatch herdr subagent",
        description: `Spawn a subagent (claude, codex, pi, opencode) in a new tab of the owner's running herdr terminal and collect its result. The subagent inherits NOTHING: the brief must be fully self-contained — absolute paths, explicit do-not-touch constraints, and where to write output. Use for code work you want visible and inspectable in the owner's herdr UI, or to parallelize long jobs. Prefer detach for long jobs, then herdr_wait/herdr_read.`,
        parameters: Type.Object({
          brief: Type.String({ description: "Self-contained task brief for the subagent (it sees only this)" }),
          agent: Type.Optional(Type.String({ description: `claude | codex | pi | opencode (default: claude)` })),
          label: Type.Optional(Type.String({ description: "Tab label (default: derived from the brief)" })),
          workspace: Type.Optional(Type.String({ description: "herdr workspace id or label (default: focused workspace when inside herdr, else PIBOT_HERDR_WORKSPACE)" })),
          timeout_seconds: Type.Optional(Type.Number({ description: "Max seconds to wait for done (default 1800)" })),
          lines: Type.Optional(Type.Number({ description: "Transcript lines to return (default 60)" })),
          detach: Type.Optional(Type.Boolean({ description: "Start and return immediately (default false)" })),
          close_when_done: Type.Optional(Type.Boolean({ description: "Close the tab once the agent reports done (default false)" })),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: { ok: boolean; paneId?: string; tabId?: string; briefPath?: string; timedOut?: boolean };
          const agent = params.agent ?? "claude";
          if (!(HERDR_AGENTS as readonly string[]).includes(agent)) {
            text = `ERROR: unknown agent "${agent}" — use ${HERDR_AGENTS.join(", ")}.`;
            details = { ok: false };
          } else if (params.detach && params.close_when_done) {
            text = "ERROR: detach and close_when_done are mutually exclusive.";
            details = { ok: false };
          } else {
            const outcome = await dispatchTask(resolved, {
              brief: params.brief,
              agent,
              label: params.label,
              workspace: params.workspace,
              timeoutSeconds: params.timeout_seconds ?? 1800,
              lines: params.lines ?? 60,
              detach: params.detach ?? false,
              closeWhenDone: params.close_when_done ?? false,
            });
            text = outcome.text;
            details = { ok: outcome.ok, paneId: outcome.paneId, tabId: outcome.tabId, briefPath: outcome.briefPath, timedOut: outcome.timedOut };
          }
          return { content: [{ type: "text", text }], details };
        },
      });

      pi.registerTool({
        name: "herdr_read",
        label: "Read herdr pane",
        description: "Read what is on a herdr pane's screen (a subagent you dispatched, a server, test output). Use pane ids returned by herdr_dispatch.",
        parameters: Type.Object({
          pane: Type.String({ description: "Pane id, e.g. w5:p7" }),
          lines: Type.Optional(Type.Number({ description: "How many lines (default 60)" })),
          source: Type.Optional(Type.Union([
            Type.Literal("visible"),
            Type.Literal("recent"),
            Type.Literal("recent-unwrapped"),
          ], { description: "visible = current viewport (default), recent = scrollback, recent-unwrapped = joined wraps" })),
        }),
        async execute(_tcid, params) {
          const source = params.source ?? "recent-unwrapped";
          try {
            const { stdout } = await resolved.exec(resolved.bin, ["pane", "read", params.pane, "--source", source, "--lines", String(params.lines ?? 60)], { timeout: READ_TIMEOUT });
            return { content: [{ type: "text", text: truncate(stdout.trim() || "(empty)", 4000) }], details: { ok: true } };
          } catch (e) {
            return { content: [{ type: "text", text: `ERROR: herdr pane read failed: ${truncate((e as Error).message, 300)}` }], details: { ok: false } };
          }
        },
      });

      pi.registerTool({
        name: "herdr_wait",
        label: "Wait on herdr pane",
        description: "Block until a herdr pane's agent reaches a status (idle/working/blocked/done) or specific output appears. Use after herdr_dispatch --detach to collect a finished subagent.",
        parameters: Type.Object({
          pane: Type.String({ description: "Pane id, e.g. w5:p7" }),
          status: Type.Optional(Type.Union([
            Type.Literal("idle"), Type.Literal("working"), Type.Literal("blocked"), Type.Literal("done"),
          ], { description: "Wait until the agent reaches this status" })),
          match: Type.Optional(Type.String({ description: "Wait until this text appears in the pane (use instead of status)" })),
          regex: Type.Optional(Type.Boolean({ description: "Treat match as regex" })),
          timeout_seconds: Type.Optional(Type.Number({ description: "Give up after N seconds (default 300)" })),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: { ok: boolean; timedOut?: boolean };
          if (!params.status && !params.match) {
            text = "ERROR: give me a status or a match.";
            details = { ok: false };
          } else {
            const timeout = Math.round((params.timeout_seconds ?? 300) * 1000);
            const args = params.match
              ? ["wait", "output", params.pane, "--match", params.match, "--timeout", String(timeout), ...(params.regex ? ["--regex"] : [])]
              : ["wait", "agent-status", params.pane, "--status", params.status!, "--timeout", String(timeout)];
            const result = await herdrTry(resolved, args, timeout + 30_000);
            if (result.failed) {
              text = `Timed out after ${Math.round(timeout / 1000)}s waiting on pane \`${params.pane}\`. The pane is untouched — inspect with herdr_read.`;
              details = { ok: false, timedOut: true };
            } else {
              text = result.stdout.trim() || `Condition met on pane \`${params.pane}\`.`;
              details = { ok: true };
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });
    },
  };
}