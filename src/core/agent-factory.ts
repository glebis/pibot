import * as path from "node:path";
import { CAPABILITY_REGISTRY } from "./capabilities.js";
import { defaultManifest, type AgentManifest } from "./types.js";
import { parseDuration, writeJsonAtomic } from "./util.js";

// ─── drafts (shared by the chat wizard and the web form) ────────────────────

export type Proactivity = "quiet" | "balanced" | "chatty" | "off";

export interface AgentDraft {
  name: string;
  /** one or two sentences: what this agent is for */
  job: string;
  vibe: string;
  proactivity: Proactivity;
}

export const VIBE_OPTIONS = [
  "warm & casual",
  "dry & efficient",
  "coach-like: encouraging but demanding",
  "custom (type it)",
];

export const PROACTIVITY_OPTIONS = [
  "quiet — a couple of proactive messages a day",
  "balanced — the default rhythm",
  "chatty — checks in often",
  "off — react only, never initiate",
];

export const PROACTIVITY_INTERVAL: Record<Proactivity, string> = {
  quiet: "90m",
  balanced: "45m",
  chatty: "20m",
  off: "45m",
};

/** kebab-case, 2–32 chars, not colliding with existing agents */
export function validateAgentName(name: string, existing: string[] = []): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) {
    return "Name must be 2–32 chars: lowercase letters, digits, dashes (e.g. 'coach', 'research-2').";
  }
  if (name.includes("--")) return "No double dashes in the name.";
  if (existing.includes(name)) return `"${name}" already exists — pick another name.`;
  return null;
}

/**
 * Suggested sub-bot username, namespaced under the parent bot:
 * agent "tax" + manager "pimother_bot" → "pimother_tax_bot"
 * (Telegram: 5–32 chars, ends in "bot", letters/digits/underscores)
 */
export function suggestedSubBotUsername(agentId: string, managerUsername?: string): string {
  const parent = (managerUsername ?? "pimother_bot").toLowerCase().replace(/_?bot$/, "");
  const agentSlug = agentId.replace(/-/g, "_");
  const agentBudget = Math.max(32 - 4 - parent.length - 1, 4); // "_bot" + separator
  const agentPart = agentSlug.slice(0, agentBudget).replace(/[\s_-]+$/, "");
  return `${parent}_${agentPart}_bot`;
}

export function buildManifest(draft: AgentDraft): AgentManifest {
  const base = defaultManifest(draft.name);
  return {
    ...base,
    description: draft.job.slice(0, 80),
    heartbeat: {
      ...base.heartbeat!,
      enabled: draft.proactivity !== "off",
      interval: PROACTIVITY_INTERVAL[draft.proactivity],
    },
  };
}

export function buildPersona(draft: AgentDraft): string {
  const vibe: Record<string, string> = {
    "warm & casual": "You are warm, brief, and a little wry.",
    "dry & efficient": "You are dry, precise, and efficient. No fluff, no filler.",
    "coach-like: encouraging but demanding": "You are encouraging but demanding — you push gently and never accept excuses from yourself.",
  };
  const vibeLine = vibe[draft.vibe] ?? draft.vibe; // custom vibes are used verbatim
  return [
    `You are ${draft.name}. ${draft.job}`,
    vibeLine,
    `You know their time: check the calendar before making plans and treat deadlines and promises seriously.`,
    `Never dump reports — talk like a good colleague on chat. When unsure whether to speak up, err toward silence.`,
    ``,
  ].join("\n");
}
// ─── programmatic creation (dashboard API / CLI) ────────────────────────────

export interface CreateAgentSpec {
  id: string;
  /** one or two sentences: what this agent is for — anchors the persona */
  description: string;
  vibe?: string;
  proactivity?: string;
  capabilities?: string[] | string;
  model?: string;
  providers?: string[] | string;
}

export type AgentCreateResult =
  | { ok: true; id: string; dir: string; manifest: AgentManifest }
  | { ok: false; error: string };

export interface CreateAgentDeps {
  agents: {
    list(): Array<{ id: string }>;
    createAgent(name: string, persona?: string): string | undefined;
    getAgent(id: string): { id: string; dir: string; manifest: AgentManifest } | undefined;
    discover(): Promise<void>;
  };
  scheduler?: { ensure(job: never): unknown };
  telegram?: { requestSubBotCreation(agentId: string): Promise<void>; managerMode(): boolean };
}

export const DEFAULT_API_PROACTIVITY: Proactivity = "quiet";
export const DEFAULT_API_VIBE = "dry & efficient";

function proactivityOrError(raw: string): Proactivity | null {
  const s = raw.toLowerCase().trim();
  for (const p of ["quiet", "balanced", "chatty", "off"] as const) {
    if (s.startsWith(p)) return p;
  }
  return null;
}

function capabilitiesIssue(ids: string[]): string | null {
  const known = CAPABILITY_REGISTRY.map((e) => e.id);
  const unknown = ids.filter((id) => !known.includes(id));
  return unknown.length ? `Unknown capabilities: ${unknown.join(", ")} — known: ${known.join(", ")}` : null;
}

/** Arm the internal heartbeat/evolution rhythm for a fresh agent (idempotent). */
export function armRhythmJobs(scheduler: { ensure(job: never): unknown } | undefined, agent: { id: string; manifest: AgentManifest }): void {
  if (!scheduler) return;
  const hb = agent.manifest.heartbeat;
  if (hb?.enabled) {
    const everyMs = parseDuration(hb.interval) ?? 45 * 60e3;
    scheduler.ensure({
      id: `hb:${agent.id}`, agentId: agent.id, chat: { transport: "internal", chatId: "heartbeat" },
      title: "heartbeat", kind: "heartbeat", dueAt: Date.now() + everyMs, repeat: { everyMs },
      wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0, internal: true,
    } as never);
  }
  if (agent.manifest.evolution?.enabled) {
    const everyMs = parseDuration(agent.manifest.evolution.interval ?? "6h") ?? 6 * 3600e3;
    scheduler.ensure({
      id: `ev:${agent.id}`, agentId: agent.id, chat: { transport: "internal", chatId: "evolution" },
      title: "evolution", kind: "evolution", dueAt: Date.now() + everyMs, repeat: { everyMs },
      wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0, internal: true,
    } as never);
  }
}

/**
 * Programmatic agent creation with the chat wizard's guarantees: id validation
 * + collision check, 0700 layout, persona from the description, capability
 * selection (explicit list replaces the conservative defaults), quiet-heartbeat
 * default. Used by the dashboard API; the interactive wizard stays separate.
 */
export async function createAgentFromSpec(deps: CreateAgentDeps, spec: CreateAgentSpec): Promise<AgentCreateResult> {
  const id = String(spec.id ?? "").toLowerCase().trim();
  const description = String(spec.description ?? "").trim();
  const nameErr = validateAgentName(id, deps.agents.list().map((a) => a.id));
  if (nameErr) return { ok: false, error: nameErr };
  if (!description) return { ok: false, error: "The description (job) is required — it anchors the persona." };

  let proactivity: Proactivity = DEFAULT_API_PROACTIVITY;
  if (spec.proactivity != null && String(spec.proactivity).trim()) {
    const p = proactivityOrError(String(spec.proactivity));
    if (!p) return { ok: false, error: `proactivity must be one of quiet|balanced|chatty|off — got "${spec.proactivity}"` };
    proactivity = p;
  }

  let capabilities: string[] | undefined;
  if (spec.capabilities != null) {
    const caps = (Array.isArray(spec.capabilities) ? spec.capabilities : String(spec.capabilities).split(","))
      .map((s) => String(s).trim())
      .filter(Boolean);
    const issue = capabilitiesIssue(caps);
    if (issue) return { ok: false, error: issue };
    capabilities = [...new Set(caps)];
  }

  const draft: AgentDraft = { name: id, job: description, vibe: spec.vibe?.trim() || DEFAULT_API_VIBE, proactivity };
  const err = deps.agents.createAgent(id, buildPersona(draft));
  if (err) return { ok: false, error: err };
  const agent = deps.agents.getAgent(id);
  if (!agent) return { ok: false, error: `Agent "${id}" vanished after creation` };

  const manifest = buildManifest(draft);
  if (capabilities) manifest.capabilities = capabilities;
  if (spec.model != null && String(spec.model).trim()) manifest.model = String(spec.model).trim();
  if (spec.providers != null) {
    const providers = (Array.isArray(spec.providers) ? spec.providers : String(spec.providers).split(",")).map((s) => String(s).trim()).filter(Boolean);
    if (providers.length) manifest.providers = providers;
  }
  writeJsonAtomic(path.join(agent.dir, "agent.json"), manifest);
  await deps.agents.discover();
  const fresh = deps.agents.getAgent(id)!;
  armRhythmJobs(deps.scheduler, fresh);
  return { ok: true, id, dir: agent.dir, manifest };
}
