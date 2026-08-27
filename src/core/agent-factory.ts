import { defaultManifest, type AgentManifest } from "./types.js";

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