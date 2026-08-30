import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { calendarPlugin } from "../plugins/calendar-plugin.js";
import type { ModelCascade } from "./cascade.js";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import type { EventLog } from "./events.js";
import type { Scheduler } from "./scheduler.js";
import { errorMessage, fmtWhen, inQuietHours, parseDuration, readJson, truncate, writeJsonAtomic } from "./util.js";

/** Adaptive-wakeup bounds (Ouroboros set_next_wakeup pattern): the agent may
 *  compress the next gap when something is brewing, stretch it when idle.
 *  Manifest heartbeat.minInterval/maxInterval narrows these further. */
const MIN_WAKEUP_MS = 5 * 60e3;
const MAX_WAKEUP_MS = 12 * 3600e3;

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

Adaptive rhythm — you pace yourself:
- heartbeat_act also accepts wakeup: how long until you want your next wakeup (e.g. "10m", "45m", "2h").
- Request a SHORTER delay when something interesting or unfinished is brewing that does not yet justify interrupting the user. Request a LONGER one (hours) when nothing is happening and everything is fresh — this saves budget.
- Omit wakeup to keep your normal cadence. Hard floor and ceiling are enforced automatically, so you cannot disable yourself.

Call the heartbeat_act tool exactly once with your decision.`;

interface HeartbeatAct {
  speak?: string;
  escalate?: string;
  note?: string;
  /** requested delay until this agent's next heartbeat tick (e.g. "10m", "3h") */
  wakeup?: string;
}

interface PersistedHeartbeatAgentState {
  lastSpeakFingerprint?: string;
  unansweredSpeaks?: number;
}

interface PersistedHeartbeatState {
  agents: Record<string, PersistedHeartbeatAgentState>;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class HeartbeatEngine {
  private inflight = new Set<string>();
  /** proactive speaks that got no user reaction — 2 in a row = back off */
  private unansweredSpeaks = new Map<string, number>();
  /** per-agent next-wakeup delay (ms) requested by the last tick; consumed by the host */
  private pendingWakeup = new Map<string, number>();
  private lastSpeakFingerprint = new Map<string, string>();
  private hydratedAgents = new Set<string>();
  private persistedState: PersistedHeartbeatState;

  /** the user just talked to this agent — reset the backoff */
  noteUserMessage(agentId: string): void {
    this.hydrateAgent(agentId);
    this.unansweredSpeaks.delete(agentId);
    this.persistAgent(agentId);
  }

  /** Should a heartbeat tick run at all? (economics guards, pure) */
  shouldTick(
    agent: LoadedAgent,
    opts: { snoozed: boolean; lastUserMessageAt: number; now?: number }
  ): { ok: boolean; reason?: string } {
    this.hydrateAgent(agent.id);
    const now = opts.now ?? Date.now();
    const hb = agent.manifest.heartbeat;
    if (!hb?.enabled) return { ok: false, reason: "disabled" };
    if (opts.snoozed) return { ok: false, reason: "snoozed" };
    if (inQuietHours(hb.quietHours, now)) return { ok: false, reason: "quiet hours" };
    // backoff: 2 proactive speaks with no user reaction — pause until user responds
    if ((this.unansweredSpeaks.get(agent.id) ?? 0) >= 2) {
      return { ok: false, reason: "backoff: 2 unanswered speaks" };
    }
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
      vaultDir: string;
      host: HeartbeatHost;
      /** optional model cascade — breakers + fallback selection for tick models */
      cascade?: ModelCascade;
      /** private fingerprint/counter state; omitted for in-memory-only operation */
      statePath?: string;
    }
  ) {
    this.persistedState = deps.statePath
      ? readJson<PersistedHeartbeatState>(deps.statePath, { agents: {} })
      : { agents: {} };
    if (!this.persistedState.agents) this.persistedState.agents = {};
  }

  async tick(agentId: string, opts: { brief?: boolean } = {}): Promise<void> {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) return;
    const hb = agent.manifest.heartbeat;
    if (!hb?.enabled) return;
    if (this.inflight.has(agentId)) return; // previous tick still running
    // fast-path backoff without invoking shouldTick (covers cases where caller bypasses it)
    if ((this.unansweredSpeaks.get(agentId) ?? 0) >= 2) return;
    // any new tick invalidates a previous request (only the latest beat may pace)
    this.pendingWakeup.delete(agentId);

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
        ...(opts.brief
          ? {}
          : {
              wakeup: Type.Optional(Type.String({ description: 'Delay until your next wakeup, e.g. "10m", "45m", "2h". Shorter when something is brewing, longer when idle. Omit to keep the normal rhythm.' })),
            }),
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
    let choice: { model?: CreateAgentSessionOptions["model"]; spec?: string } = {};
    try {
      choice = this.heartbeatModelWithFallback(agent);
      if (this.deps.cascade && !choice.model) {
        this.deps.events.log(agent.id, "system", "heartbeat skipped: no permitted model available");
        return null;
      }
      session = (
        await createAgentSession({
          cwd: agent.dir,
          agentDir: getAgentDir(),
          modelRuntime: this.deps.modelRuntime,
          model: choice.model,
          thinkingLevel: "off",
          tools: opts.brief ? ["heartbeat_act", "calendar_today"] : ["heartbeat_act"],
          customTools: [actTool],
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(agent.dir),
          settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
        })
      ).session;
    } catch (e) {
      if (choice.spec) this.deps.cascade?.noteFailure(choice.spec, errorMessage(e));
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
      if (choice.spec) this.deps.cascade?.noteSuccess(choice.spec);
    } catch (e) {
      if (choice.spec) this.deps.cascade?.noteFailure(choice.spec, errorMessage(e));
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

    if (!opts.brief && act.wakeup) {
      const ms = this.clampWakeup(agent, parseDuration(act.wakeup));
      if (ms != null) this.pendingWakeup.set(agent.id, ms);
    }

    const summary = act.speak ?? act.escalate ?? act.note ?? "(silent)";
    this.deps.events.log(agent.id, "heartbeat", summary);

    if (act.escalate) {
      await this.deps.host.escalateToAgent(agent.id, act.escalate);
    } else if (act.speak) {
      const speakFingerprint = fingerprint(act.speak);
      if (this.lastSpeakFingerprint.get(agent.id) === speakFingerprint) return;
      // backoff: proactive speaks that go unanswered make the heartbeat quieter
      const n = (this.unansweredSpeaks.get(agent.id) ?? 0) + 1;
      await this.deps.host.deliverToAgent(agent.id, act.speak);
      this.unansweredSpeaks.set(agent.id, n);
      this.lastSpeakFingerprint.set(agent.id, speakFingerprint);
      this.persistAgent(agent.id);
    }
  }

  /**
   * The next-wakeup delay (ms) requested by this agent's last heartbeat tick,
   * or null when the tick did not ask for a change. Consumes the request — the
   * host applies it by re-arming the heartbeat job before the scheduler's
   * post-fire repeat computation runs.
   */
  takeNextWakeup(agentId: string): number | null {
    const ms = this.pendingWakeup.get(agentId);
    this.pendingWakeup.delete(agentId);
    return ms ?? null;
  }

  /** Clamp a requested wakeup delay to the global bounds, narrowed by the manifest window. */
  private clampWakeup(agent: LoadedAgent, ms: number | null): number | null {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
    const hb = agent.manifest.heartbeat;
    const min = Math.max(MIN_WAKEUP_MS, parseDuration(hb?.minInterval ?? "") ?? 0);
    const manifestMax = parseDuration(hb?.maxInterval ?? "");
    const max = Math.min(MAX_WAKEUP_MS, manifestMax ?? Number.POSITIVE_INFINITY);
    return min > max ? min : Math.min(Math.max(ms, min), max);
  }

  private hydrateAgent(agentId: string): void {
    if (this.hydratedAgents.has(agentId)) return;
    this.hydratedAgents.add(agentId);
    const saved = this.persistedState.agents[fingerprint(agentId)];
    if (saved?.lastSpeakFingerprint) this.lastSpeakFingerprint.set(agentId, saved.lastSpeakFingerprint);
    if (saved?.unansweredSpeaks) this.unansweredSpeaks.set(agentId, saved.unansweredSpeaks);
  }

  private persistAgent(agentId: string): void {
    if (!this.deps.statePath) return;
    const key = fingerprint(agentId);
    const lastSpeakFingerprint = this.lastSpeakFingerprint.get(agentId);
    const unansweredSpeaks = this.unansweredSpeaks.get(agentId) ?? 0;
    this.persistedState.agents[key] = { lastSpeakFingerprint, unansweredSpeaks };
    writeJsonAtomic(this.deps.statePath, this.persistedState, 0o600);
  }

  /**
   * Cheap model for this tick, cascade-aware: skip breaker-open models and
   * fall down the agent's chain. Falls back to the agent's main model.
   */
  private heartbeatModelWithFallback(agent: LoadedAgent): {
    model?: CreateAgentSessionOptions["model"];
    spec?: string;
  } {
    const hb = agent.manifest.heartbeat;
    const wanted = hb?.model && hb.model !== "same" ? hb.model : agent.manifest.model;
    const cascade = this.deps.cascade;
    if (!cascade) {
      try {
        return { model: this.deps.agents.heartbeatModel(agent) ?? this.deps.agents.resolveModel(agent.manifest.model) };
      } catch {
        return {};
      }
    }
    const chain = cascade.chainFor({ model: wanted, cascade: agent.manifest.cascade, providers: agent.manifest.providers });
    const healthy = cascade.firstHealthy(chain) ?? "";
    if (!healthy) return {};
    const model = cascade.resolveModel(healthy);
    return model ? { model, spec: healthy } : {};
  }

  private buildDigest(agent: LoadedAgent): string {
    return buildHeartbeatDigest(agent, this.deps.scheduler, this.deps.events, this.deps.vaultDir);
  }
}

/** Pure digest builder — exported for tests and reuse (evolution plugin reuses it) */
export function buildHeartbeatDigest(
  agent: LoadedAgent,
  scheduler: Pick<Scheduler, "list">,
  events: Pick<EventLog, "tail">,
  vaultDir?: string
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

  // rhythm awareness (adaptive wakeups)
  if (agent.manifest.heartbeat?.enabled) {
    const minI = agent.manifest.heartbeat.minInterval ?? "5m";
    const maxI = agent.manifest.heartbeat.maxInterval ?? "12h";
    parts.push(`# Heartbeat rhythm\nBase cadence: every ${agent.manifest.heartbeat.interval}. You may request your next wakeup sooner or later via "wakeup" in heartbeat_act (allowed: ${minI} … ${maxI}).`);
  }

  return parts.join("\n\n");
}
