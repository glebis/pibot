import * as fs from "node:fs";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { agentCommsPlugin, type CommsHooks } from "../plugins/agent-comms-plugin.js";
import { attendPlugin, ATTEND_CLI } from "../plugins/attend-plugin.js";
import { calendarPlugin } from "../plugins/calendar-plugin.js";
import { delegatePlugin, DELEGATE_CLIS } from "../plugins/delegate-plugin.js";
import { devToolsPlugin } from "../plugins/dev-tools-plugin.js";
import { gmailPlugin } from "../plugins/gmail-plugin.js";
import { knowledgePlugin } from "../plugins/knowledge-plugin.js";
import { linearPlugin } from "../plugins/linear-plugin.js";
import { memoryPlugin } from "../plugins/memory-plugin.js";
import { questionPlugin } from "../plugins/question-plugin.js";
import { schedulerPlugin } from "../plugins/scheduler-plugin.js";
import { skillManagePlugin } from "../plugins/skill-manage-plugin.js";
import { resolveResponderDb, tgResponderPlugin } from "../plugins/tg-responder-plugin.js";
import { DEV_AGENT_ID, DEV_TOOLS, WORKSHOP_TOOLS, readDevRemoteConfig } from "./dev-agent.js";
import type { QuestionAnswer, QuestionSpec } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import type { AgentManifest, ChatRef } from "./types.js";

export interface CapabilityAgent { id: string; dir: string; manifest: AgentManifest }
export interface CapabilityContext {
  agent: CapabilityAgent;
  workspace: string;
  vaultDir: string;
  scheduler: Scheduler;
  chat: ChatRef;
  ask?: (spec: QuestionSpec) => Promise<QuestionAnswer | null>;
  comms?: CommsHooks;
}

/** One auditable source for a plugin's factory, exposed tools and prompt contract. */
export interface CapabilityDefinition {
  id: string;
  defaultEnabled: boolean;
  tools: readonly string[];
  prompt?: string;
  available?: (ctx: CapabilityContext) => boolean;
  create: (ctx: CapabilityContext) => InlineExtension;
}

export interface ResolvedCapabilities {
  ids: string[];
  extensions: InlineExtension[];
  tools: string[];
  prompt: string;
  unavailable: string[];
}

export function executableAvailable(command: string): boolean {
  const candidates = command.includes(path.sep)
    ? [command]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  return candidates.some((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  });
}

const installedDelegateClis = () => Object.keys(DELEGATE_CLIS).filter(executableAvailable);

const confirmMutation = (ctx: CapabilityContext) => async (description: string): Promise<boolean> => {
  if (!ctx.ask) return false;
  const answer = await ctx.ask({ text: description, options: ["Confirm", "Cancel"], timeoutMs: 5 * 60_000 });
  return answer?.index === 0 && !answer.timedOut && !answer.replaced;
};

export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = [
  {
    id: "scheduler", defaultEnabled: true,
    tools: ["schedule_create", "schedule_list", "schedule_cancel", "schedule_resume", "snooze", "promise_make", "promise_keep"],
    prompt: "REMINDERS ARE NEVER DISCUSSIONS: when the owner asks for a reminder, call schedule_create immediately with exactly what they said, then confirm in one line—do not look up context, reinterpret, or ask for confirmation. schedule_list, schedule_cancel, schedule_resume, snooze, promise_make and promise_keep manage commitments; recurring items must be at least 15 minutes apart and each agent may have at most 20 active items. A repeatedly failing item pauses automatically; explain the last error and use schedule_resume only after the delivery problem is fixed. Important items still fire through snooze. `when` accepts forms like `in 20m`, `tomorrow 9am`, `daily at 08:00`, `every 2h`, or `friday 18:00`; kind is reminder, task, note, subject, or custom; `delivery: direct` sends a host ping and `delivery: agent` wakes the agent to compose it; reserve `wake: important` for hard commitments.",
    create: (ctx) => schedulerPlugin({ scheduler: ctx.scheduler, agentId: ctx.agent.id, chat: ctx.chat, getQuietHours: () => ctx.agent.manifest.heartbeat?.quietHours }),
  },
  {
    id: "memory", defaultEnabled: true, tools: ["memory_save", "memory_recall"],
    prompt: "memory_save and memory_recall manage durable notes owned by this agent; it may also write directly inside its own memory directory.",
    create: (ctx) => memoryPlugin({ agentDir: ctx.agent.dir }),
  },
  {
    id: "calendar-read", defaultEnabled: true, tools: ["calendar_today"],
    prompt: "calendar_today provides read-only calendar context.", create: (ctx) => calendarPlugin(confirmMutation(ctx)),
  },
  {
    id: "calendar-write", defaultEnabled: false,
    tools: ["calendar_create_event", "calendar_delete_event", "calendar_move_event"],
    prompt: "calendar_create_event, calendar_delete_event and calendar_move_event require owner confirmation before changing the calendar.", create: (ctx) => calendarPlugin(confirmMutation(ctx)),
  },
  {
    id: "gmail-read", defaultEnabled: false, tools: ["gmail_list", "gmail_read"],
    prompt: "gmail_list and gmail_read provide read-only email access.", create: () => gmailPlugin(),
  },
  {
    id: "linear", defaultEnabled: false, tools: ["linear_list", "linear_create", "linear_update"],
    prompt: "linear_list reads Linear; linear_create and linear_update require owner confirmation.", create: (ctx) => linearPlugin(confirmMutation(ctx)),
  },
  {
    id: "skills", defaultEnabled: true, tools: ["skill_save", "skill_patch", "skill_list"],
    prompt: "skill_save, skill_patch and skill_list manage this agent's own reusable skills.",
    create: (ctx) => skillManagePlugin({ agentDir: ctx.agent.dir, agentId: ctx.agent.id }),
  },
  {
    id: "knowledge", defaultEnabled: false, tools: ["knowledge_share", "knowledge_read"],
    prompt: "knowledge_share contributes a durable fact to shared knowledge; knowledge_read reads that shared layer.",
    create: (ctx) => knowledgePlugin({ sharedFile: path.join(ctx.vaultDir, "pibot", "SHARED-FINDINGS.md"), agentId: ctx.agent.id }),
  },
  {
    id: "agent-comms", defaultEnabled: true, tools: ["agent_message", "agent_ask", "agent_list", "handoff"],
    prompt: "agent_message (fire-and-forget), agent_ask (blocking), and agent_list coordinate with sibling agents; handoff transfers recent conversation context. Messages prefixed `[agent-message from ...]` come from a sibling and should receive a natural reply.",
    available: (ctx) => Boolean(ctx.comms), create: (ctx) => agentCommsPlugin({ agentId: ctx.agent.id, ...ctx.comms! }),
  },
  {
    id: "questions", defaultEnabled: true, tools: ["ask_user"],
    prompt: "ask_user renders 2–6 choices as tappable buttons or 7–10 as a poll and returns the owner's answer; include an `unsure` option when the owner may not know.",
    available: (ctx) => Boolean(ctx.ask), create: (ctx) => questionPlugin({ chat: ctx.chat, ask: ctx.ask! }),
  },
  {
    id: "attend", defaultEnabled: false, tools: ["attend_enqueue", "attend_list", "attend_mark"],
    prompt: "attend_enqueue, attend_list and attend_mark manage the owner's adaptive attention queue, whose surfacing policy limits interruptions to at most one per day during active hours.",
    available: () => executableAvailable(ATTEND_CLI), create: () => attendPlugin({ cliPath: ATTEND_CLI }),
  },
  {
    id: "telegram-responder", defaultEnabled: false, tools: ["inbox_pending", "followups_open", "draft_reply"],
    prompt: "inbox_pending and followups_open read the Telegram responder queue; draft_reply creates a draft for owner approval and never sends directly.",
    available: () => executableAvailable("sqlite3") && fs.existsSync(resolveResponderDb()), create: () => tgResponderPlugin(),
  },
  {
    id: "delegate", defaultEnabled: false, tools: ["delegate_cli"],
    prompt: "delegate_cli runs a selected local coding CLI with its own permissions; give it a self-contained task.",
    available: () => installedDelegateClis().length > 0,
    create: (ctx) => delegatePlugin({ allowed: installedDelegateClis(), cwd: ctx.workspace, agentId: ctx.agent.id }),
  },
  {
    id: "developer", defaultEnabled: false, tools: DEV_TOOLS,
    prompt: "dev_test validates the host and dev_stage records a checkpoint only after validation passes — prefer it over raw git for landing changes.",
    available: (ctx) => ctx.agent.id === DEV_AGENT_ID,
    create: (ctx) => devToolsPlugin({ repoRoot: ctx.workspace, agentDir: ctx.agent.dir }),
  },
  {
    id: "remote-workshop", defaultEnabled: false, tools: WORKSHOP_TOOLS,
    prompt: "The disposable Linux workshop (ssh oracle-pibot) is shared compute: your isolated workspace is ~/agents/<your-id> — keep everything inside it; it holds nothing valuable and is rebuildable, never store secrets there. remote_sync mirrors your local source there, remote_test runs typecheck + the full suite on ARM64 Linux (call before claiming Linux parity), remote_exec runs anything else. The visual desktop on the box belongs to the owner — work over SSH, never drive pixels.",
    available: () => readDevRemoteConfig() !== undefined,
    create: (ctx) => devToolsPlugin({ repoRoot: ctx.workspace, agentDir: ctx.agent.dir, remote: { ...readDevRemoteConfig()!, dir: `~/agents/${ctx.agent.id}` } }),
  },
] as const;

export function capabilityIdsForTools(tools: readonly string[], registry: readonly CapabilityDefinition[] = CAPABILITY_REGISTRY): string[] {
  const selected = new Set(tools);
  return registry.filter((capability) => capability.tools.some((tool) => selected.has(tool))).map((capability) => capability.id);
}

export function resolveCapabilities(ctx: CapabilityContext, registry: readonly CapabilityDefinition[] = CAPABILITY_REGISTRY, selectedIds?: readonly string[]): ResolvedCapabilities {
  const wanted = selectedIds ? [...selectedIds] : registry.filter((entry) => entry.defaultEnabled).map((entry) => entry.id);
  if (ctx.agent.id === DEV_AGENT_ID) {
    if (!wanted.includes("developer")) wanted.push("developer");
    if (!wanted.includes("remote-workshop")) wanted.push("remote-workshop");
  }
  const known = new Map(registry.map((entry) => [entry.id, entry]));
  const unknown = wanted.find((id) => !known.has(id));
  if (unknown) throw new Error(`Unknown capability "${unknown}"`);
  const enabled: CapabilityDefinition[] = [];
  const unavailable: string[] = [];
  for (const id of [...new Set(wanted)]) {
    const entry = known.get(id)!;
    if (entry.available && !entry.available(ctx)) unavailable.push(id); else enabled.push(entry);
  }
  const extensions = enabled.map((entry) => entry.create(ctx)).filter((extension, index, all) => all.findIndex((item) => item.name === extension.name) === index);
  return {
    ids: enabled.map((entry) => entry.id), extensions,
    tools: [...new Set(enabled.flatMap((entry) => [...entry.tools]))],
    prompt: enabled.flatMap((entry) => entry.prompt ? [`- ${entry.prompt}`] : []).join("\n"), unavailable,
  };
}
