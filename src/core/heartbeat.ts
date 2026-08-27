import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { calendarPlugin } from "../plugins/calendar-plugin.js";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import type { EventLog } from "./events.js";
import type { Scheduler } from "./scheduler.js";
import { errorMessage, fmtWhen, inQuietHours, truncate } from "./util.js";

export interface HeartbeatHost {
  /** Heartbeat wants to say something short to the user */
  deliverToAgent(agentId: string, text: string): Promise<void>;
  /** Heartbeat flags something that needs the full agent brain */
  escalateToAgent(agentId: string, instruction: string): Promise<void>;
  /** timestamp (ms) of the last message the user actually sent to this agent */
  lastUserMessageAt(agentId: string): number;
}

const BRIEF_SYSTEM_PROMPT = `You deliver the user's MORNING BRIEF. Check calendar_today, then compose a short, warm brief in the agent's voice:
- today's schedule (2-4 bullets, what matters)
- pending items and open promises
- the single most important thing today
Keep it under 10 lines. No lecture, no productivity sermon.`;

const HEARTBEAT_SYSTEM_PROMPT = `You are the heartbeat process of a personal agent companion. You run on a timer, independent of the user — they did NOT write to you just now.

You receive a compact state digest. Decide whether anything is worth surfacing right now.

Principles:
- Be extremely economical. Most ticks say nothing. When in doubt, say nothing.
- Surface at most one thing, briefly, warmly, in the agent's own voice (see persona in the digest).
- Never repeat anything from recent events.
- Light nudges about items due soon are good. Repeating what the user already knows is bad.
- If nothing is worth saying, call heartbeat_act with no fields (or a private note only).

Call the heartbeat_act tool exactly once with your decision.`;

interface HeartbeatAct {
  speak?: string;
  escalate?: string;
  note?: string;
}

export class HeartbeatEngine {
  private inflight = new Set<string>();
  /** proactive speaks that got no user reaction — 2 in a row = back off */
  private unansweredSpeaks = new Map<string, number>();

  /** the user just talked to this agent — reset the backoff */
  noteUserMessage(agentId: string): void {
    this.unansweredSpeaks.delete(agentId);
  }

  /** Should a heartbeat tick run at all? (economics guards, pure) */
  shouldTick(
    agent: LoadedAgent,
    opts: { snoozed: boolean; lastUserMessageAt: number; now?: number }
  ): { ok: boolean; reason?: string } {
    const now = opts.now ?? Date.now();
    const hb = agent.manifest.heartbeat;
    if (!hb?.enabled) return { ok: false, reason: "disabled" };
    if (opts.snoozed) return { ok: false, reason: "snoozed" };
    if (inQuietHours(hb.quietHours, now)) return { ok: false, reason: "quiet hours" };
    // active conversation: don't interrupt mid-chat
    if (opts.lastUserMessageAt && now - opts.lastUserMessageAt < 15 * 60e3) {
      return { ok: false, reason: "recent user activity" };
    }
    return { ok: true };
  }

  constructor(
    private deps: {
      agents: AgentManager;
      scheduler: Scheduler;
      modelRuntime: ModelRuntime;
      events: EventLog;
      host: HeartbeatHost;
    }
  ) {}

  async tick(agentId: string, opts: { brief?: boolean } = {}): Promise<void> {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) return;
    const hb = agent.manifest.heartbeat;
    if (!hb?.enabled) return;
    if (this.inflight.has(agentId)) return; // previous tick still running

    const guard = this.shouldTick(agent, {
      snoozed: Boolean(this.deps.scheduler.snoozeState(agentId)),
      lastUserMessageAt: this.deps.host.lastUserMessageAt(agentId),
    });
    if (!guard.ok) return;

    this.inflight.add(agentId);
    try {
      await this.tickInner(agent, opts);
    } finally {
      this.inflight.delete(agentId);
    }
  }

  private async tickOnce(agent: LoadedAgent, opts: { brief?: boolean } = {}): Promise<HeartbeatAct | null> {
    const digest = this.buildDigest(agent);
    const act: HeartbeatAct = {};
    let called = false;

    const actTool = defineTool({
      name: "heartbeat_act",
      label: "Heartbeat decision",
      description: "Report this heartbeat's decision. Call exactly once. All fields optional — omit everything for a silent tick.",
      parameters: Type.Object({
        speak: Type.Optional(Type.String({ description: "Short message to send to the user (1-3 sentences, in the agent's voice). Omit if nothing is worth saying." })),
        escalate: Type.Optional(Type.String({ description: "Something needs the full agent brain — describe what and why; the main session will be prompted with it." })),
        note: Type.Optional(Type.String({ description: "Private observation for the event log; never shown to the user." })),
      }),
      execute: async (_toolCallId, params) => {
        called = true;
        Object.assign(act, params);
        return { content: [{ type: "text", text: "decision logged" }], details: {} };
      },
    });

    const loader = new DefaultResourceLoader({
      cwd: agent.dir,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: opts.brief ? BRIEF_SYSTEM_PROMPT : HEARTBEAT_SYSTEM_PROMPT,
      extensionFactories: opts.brief ? [calendarPlugin()] : [],
    });
    await loader.reload();

    let session: AgentSession;
    try {
      session = (
        await createAgentSession({
          cwd: agent.dir,
          agentDir: getAgentDir(),
          modelRuntime: this.deps.modelRuntime,
          model: this.heartbeatModelWithFallback(agent),
          thinkingLevel: "off",
          tools: opts.brief ? ["heartbeat_act", "calendar_today"] : ["heartbeat_act"],
          customTools: [actTool],
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(agent.dir),
          settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
        })
      ).session;
    } catch (e) {
      this.deps.events.log(agent.id, "system", `heartbeat session error: ${errorMessage(e)}`);
      return null;
    }

    try {
      await session.prompt(
        opts.brief
          ? `MORNING BRIEF — ${new Date().toLocaleString([], { weekday: "long", hour: "2-digit", minute: "2-digit" })}\n\n${digest}\n\nCompose the user's morning brief: check calendar_today first, then cover pending items and open promises, and suggest the single most important thing today. Keep it short.`
          : `HEARTBEAT TICK — ${new Date().toLocaleString([], { weekday: "long", hour: "2-digit", minute: "2-digit" })}\n\n${digest}\n\nDecide. Call heartbeat_act exactly once.`,
        {}
      );
    } catch (e) {
      this.deps.events.log(agent.id, "system", `heartbeat prompt error: ${errorMessage(e)}`);
      return null;
    } finally {
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
    }

    return called ? act : null;
  }

  private async tickInner(agent: LoadedAgent, opts: { brief?: boolean } = {}): Promise<void> {
    const act = await this.tickOnce(agent, opts);
    if (!act) return;

    const summary = act.speak ?? act.escalate ?? act.note ?? "(silent)";
    this.deps.events.log(agent.id, "heartbeat", summary);

    if (act.escalate) {
      await this.deps.host.escalateToAgent(agent.id, act.escalate);
    } else if (act.speak) {
      // backoff: proactive speaks that go unanswered make the heartbeat quieter
      const n = (this.unansweredSpeaks.get(agent.id) ?? 0) + 1;
      this.unansweredSpeaks.set(agent.id, n);
      await this.deps.host.deliverToAgent(agent.id, act.speak);
    }
  }

  /** Configured cheap heartbeat model; falls back to the agent's main model if unavailable */
  private heartbeatModelWithFallback(agent: LoadedAgent) {
    try {
      return this.deps.agents.heartbeatModel(agent) ?? this.deps.agents.resolveModel(agent.manifest.model);
    } catch {
      this.deps.events.log(agent.id, "system", "heartbeat model unavailable — using agent default");
      return undefined;
    }
  }

  private buildDigest(agent: LoadedAgent): string {
    return buildHeartbeatDigest(agent, this.deps.scheduler, this.deps.events);
  }
}

/** Pure digest builder — exported for tests and reuse (evolution plugin reuses it) */
export function buildHeartbeatDigest(
  agent: LoadedAgent,
  scheduler: Pick<Scheduler, "list">,
  events: Pick<EventLog, "tail">
): string {
  const parts: string[] = [];

  // persona digest
  const personaFile = path.join(agent.dir, "AGENTS.md");
  if (fs.existsSync(personaFile)) {
    parts.push(`# Who you are\n${truncate(fs.readFileSync(personaFile, "utf8").trim(), 800)}`);
  }

  // memory digest
  const memoryFile = path.join(agent.dir, "memory", "MEMORY.md");
  if (fs.existsSync(memoryFile)) {
    parts.push(`# Memory digest\n${truncate(fs.readFileSync(memoryFile, "utf8").trim(), 1200)}`);
  }

  // pending schedule
  const jobs = scheduler.list(agent.id).filter((j) => !j.internal).slice(0, 6);
  if (jobs.length) {
    parts.push(
      `# Pending scheduled items\n${jobs.map((j) => `- "${j.title}" — ${fmtWhen(j.dueAt)}${j.wake === "important" ? " (!important)" : ""}`).join("\n")}`
    );
  } else {
    parts.push("# Pending scheduled items\n(none)");
  }

  // recent events
  const evts = events.tail(agent.id, 8);
  if (evts.length) {
    parts.push(
      `# Recent activity (avoid repeating any of this)\n${evts.map((e) => `- [${e.type}] ${e.summary}`).join("\n")}`
    );
  }

  return parts.join("\n\n");
}