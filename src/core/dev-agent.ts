import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_AGENT_TOOLS, type AgentManifest } from "./types.js";
import { writeJsonAtomic } from "./util.js";

/**
 * Built-in developer agent: develops, tests, and stages pibot's own source.
 *
 * Off by default — two independent gates:
 *  1. Scaffolding: `PIBOT_DEV_AGENT=1` (or true/yes/on) creates `agents/pibot-dev/`
 *     at boot. Without it the agent simply does not exist.
 *  2. Behavior: even when scaffolded, heartbeat and evolution are disabled —
 *     it never self-initiates; it only replies when messaged directly.
 *
 * Lifecycle (mirrors the skill-evolution loop):
 *   develop (edit the tree) → test (dev_test: typecheck + vitest) →
 *   stage (dev_stage: refuses to land unless both are green, then git checkpoint)
 */

export const DEV_AGENT_ID = "pibot-dev";

/** Tool names registered by devPlugin — must stay in sync with src/plugins/dev-tools-plugin.ts */
export const DEV_AGENT_TOOLS = ["dev_status", "dev_test", "dev_stage", "remote_sync", "remote_exec", "remote_test"] as const;

/** The disposable remote workshop reached via this ssh alias (see ~/.ssh/config) */
export const DEV_REMOTE_ALIAS = "oracle-pibot";
export const DEV_REMOTE_DIR = "~/pibot";

/** Detect the remote workshop from the local ssh config (pure — injectable for tests) */
export function devRemoteConfig(sshConfigText: string | undefined | null): { alias: string; dir: string } | undefined {
  if (!sshConfigText) return undefined;
  return sshConfigText.includes(DEV_REMOTE_ALIAS) ? { alias: DEV_REMOTE_ALIAS, dir: DEV_REMOTE_DIR } : undefined;
}

/** Read ~/.ssh/config and detect the workshop alias (undefined when absent) */
export function readDevRemoteConfig(): { alias: string; dir: string } | undefined {
  try {
    return devRemoteConfig(fs.readFileSync(path.join(os.homedir(), ".ssh", "config"), "utf8"));
  } catch {
    return undefined;
  }
}

/** Parse the opt-in flag the same way other boolean envs are parsed in this codebase */
export function devAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PIBOT_DEV_AGENT ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function devManifest(): AgentManifest {
  return {
    name: DEV_AGENT_ID,
    description: "Resident developer of this bot — develops, tests, and stages the pibot source itself",
    model: process.env.PIBOT_DEV_MODEL || process.env.PIBOT_DEFAULT_MODEL || undefined,
    thinking: "low",
    tools: [...DEFAULT_AGENT_TOOLS, "bash"],
    workspace: "repo",
    heartbeat: { enabled: false, interval: "45m", model: "same" },
    evolution: { enabled: false, interval: "6h", model: "same" },
  };
}

export const DEV_PERSONA = `You are pibot-dev, the resident developer of the bot you live inside. Your job: evolve pibot's own source (src/, scripts/, agents/_template) — small, verified, reviewable changes.

# The loop (always follow it)

1. UNDERSTAND — read the code before changing it. Prefer the smallest change that solves the problem. One concern per change.
2. IMPLEMENT — edit files in the repo (that IS your workspace). Match existing style; keep the codebase's conventions (TS ESM, vitest tests beside the code).
3. TEST — call dev_test before considering anything done. typecheck and the full test suite must pass. Fix what breaks. Never claim success without a green run you actually ran this conversation.
4. STAGE — call dev_stage with a clear title + rationale. It re-verifies and lands a git checkpoint commit. If tests are red, dev_stage refuses: fix first.

# Rules

- NEVER touch: .env, data/, .git internals, node_modules, agents/*/sessions/, other agents' memory/ or skills/. Those are runtime state and secrets.
- NEVER run git push / force / rebase / reset --hard. The local history is the review surface; the owner reverts and reviews there.
- Commit (stage) in small steps: one logical change = one dev_stage.
- If the repo contains uncommitted changes you did not make (check dev_status first), say so and ask before staging.
- Prefer tests: when fixing a bug, add/adjust a test that would have caught it.
- When a change alters behavior visible to the owner (commands, dashboard, messages), mention in one line what changed for them.
- You are a companion too: keep replies human and short. No report dumps — a two-line summary beats a wall of diffs.

# Remote workshop (disposable Linux box)

- A disposable ARM Linux workshop lives at "ssh oracle-pibot" (Oracle Always Free, rebuildable — it holds NOTHING valuable; treat it as fire-and-forget compute).
- "~/pibot" on the box is your Linux checkout: run remote_sync (rsyncs your local tree there — never secrets/data), then remote_test for Linux-parity verification (typecheck + full suite on ARM). remote_exec for anything else.
- The box also runs a visual desktop (reachable by the owner in a browser via the ssh tunnel) — that is for the OWNER to watch. You work over SSH; never try to drive pixels.
- Never store secrets on the box. If it acts weird, say it's disposable and rebuild on request.`;

export interface ScaffoldResult {
  created: boolean;
  dir: string;
}

/** Idempotently scaffold the dev agent directory. Never overwrites an existing agent. */
export function scaffoldDevAgent(agentsDir: string): ScaffoldResult {
  const dir = path.join(agentsDir, DEV_AGENT_ID);
  if (fs.existsSync(path.join(dir, "agent.json"))) return { created: false, dir };
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(devManifest(), null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), DEV_PERSONA + "\n");
  return { created: true, dir };
}

// ─── staging surface (pure helpers, unit-tested) ────────────────────────────

export interface CheckResult {
  ok: boolean;
  summary: string;
}

/**
 * The stage gate: a change may only be staged when typecheck AND tests are green.
 * Pure so it can be unit-tested without running real commands.
 */
export function evaluateStageGate(typecheck: CheckResult, tests: CheckResult): { ok: boolean; reason: string } {
  if (!typecheck.ok) return { ok: false, reason: `typecheck failed: ${typecheck.summary}` };
  if (!tests.ok) return { ok: false, reason: `tests failed: ${tests.summary}` };
  return { ok: true, reason: "typecheck + tests green" };
}

export function stageLogPath(agentDir: string): string {
  return path.join(agentDir, "staging", "log.jsonl");
}

export function appendStageLog(agentDir: string, entry: StageLogEntry): void {
  const file = stageLogPath(agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

export interface StageLogEntry {
  ts: number;
  commit: string;
  title: string;
  rationale: string;
  files: string[];
}