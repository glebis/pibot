/**
 * Capability profiles (bd pibot-4wq1) — an accept/delegate-time snapshot of what
 * an agent can actually do, so acceptance decisions are made against evidence
 * instead of hope:
 *   - session class (interactive / background / heartbeat / voice / remote)
 *   - resolved tools + capabilities (manifest + capability registry)
 *   - permission surface relevant to tasks (media send, exec, scheduling)
 *   - credential PRESENCE (booleans by env name — values never read)
 *   - resource headroom (disk + lane slots, from the preflight singleton)
 *
 * Planned accept-time integration (not wired yet) supplies evidence: an agent that can't exec says so honestly instead of
 * attempting the task with unavailable tools (the hn90 routing feed).
 */
import path from "node:path";
import type { AgentManager } from "./agent-manager.js";
import { resolveCapabilities, type CapabilityContext } from "./capabilities.js";
import { KNOWN_CREDENTIALS, credentialPresence } from "./preflight.js";
import { freeBytes } from "./disk-guard.js";
import type { Scheduler } from "./scheduler.js";

export type SessionClass = "interactive" | "background" | "heartbeat" | "voice" | "remote";

export interface CapabilityProfile {
  agentId: string;
  sessionClass: SessionClass;
  tools: string[];
  capabilities: string[];
  permissions: {
    /** can deliver media files (voice/audio/video-note) */
    canSendMedia: boolean;
    /** allowlisted exec_run, not shell */
    canExecAllowlist: boolean;
    /** schedule_create / task_start families */
    canSchedule: boolean;
    /** can start durable background tasks */
    canStartTasks: boolean;
    /** can interact with the owner (questions / direct chat) */
    canAskOwner: boolean;
  };
  /** credential env-name → presence boolean (never values) */
  credentials: Record<string, boolean>;
  resources: {
    diskFreeBytes: number | null;
    laneFree: Record<string, number>;
  };
}

export interface ProfileDeps {
  agents: AgentManager;
  scheduler: Scheduler;
  dataDir: string;
}

/** Infer the session class from hints the caller already knows. */
export function sessionClassOf(hints: { transport?: string; heartbeatTick?: boolean; taskId?: string }): SessionClass {
  if (hints.heartbeatTick) return "heartbeat";
  if (hints.taskId) return "background";
  const t = hints.transport ?? "";
  if (t.startsWith("telegram")) return "interactive";
  if (t === "agent") return "remote";
  return "background";
}

/** Snapshot one agent's real capability surface. Never throws — incomplete profiles degrade. */
export function profileAgent(deps: ProfileDeps, agentId: string, hints: { transport?: string; heartbeatTick?: boolean; taskId?: string } = {}): CapabilityProfile {
  const agent = deps.agents.getAgent(agentId);
  let capabilities: string[] = [];
  let tools: string[] = [];
  if (agent) {
    try {
      const ctx: CapabilityContext = {
        agent: { id: agentId, dir: agent.dir, manifest: agent.manifest },
        workspace: agent.dir,
        vaultDir: path.join(agent.dir, "vault"),
        scheduler: deps.scheduler,
        chat: { transport: hints.transport ?? "telegram", chatId: "profile" },
      };
      const resolved = resolveCapabilities(ctx, undefined, agent.manifest.capabilities);
      capabilities = resolved.ids;
      tools = [...resolved.tools, ...(agent.manifest.tools ?? [])];
    } catch {
      /* profile degrades to manifest-only facts below */
    }
  }

  const canSendMedia = capabilities.includes("speech");
  const canExecAllowlist = capabilities.includes("exec");
  const canSchedule = capabilities.includes("scheduler");
  const canStartTasks = capabilities.includes("tasks");
  const canAskOwner = capabilities.includes("questions") || sessionClassOf(hints) === "interactive";

  const credentials = credentialPresence([...KNOWN_CREDENTIALS]);
  const resources = { diskFreeBytes: freeBytes(deps.dataDir), laneFree: {} as Record<string, number> };

  return { agentId, sessionClass: sessionClassOf(hints), tools, capabilities, permissions: { canSendMedia, canExecAllowlist, canSchedule, canStartTasks, canAskOwner }, credentials, resources };
}

/** Compact, evidence-shaped rendering for an accept envelope. */
export function formatProfile(p: CapabilityProfile): string {
  return [
    `[capability-profile] ${p.agentId} · session=${p.sessionClass}`,
    `tools: ${p.tools.length ? p.tools.join(", ") : "(none)"}`,
    `capabilities: ${p.capabilities.length ? p.capabilities.join(", ") : "(defaults)"}`,
    `can: [${Object.entries(p.permissions).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing special"}]`,
    `credentials: [${Object.entries(p.credentials).filter(([, v]) => v).map(([k]) => k).join(", ") || "none present"}] (presence only)`,
    `resources: disk ${p.resources.diskFreeBytes != null ? `${(p.resources.diskFreeBytes / 1e9).toFixed(1)} GB free` : "unknown"}`,
  ].join("\n");
}