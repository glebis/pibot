import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CommsHooks } from "../plugins/agent-comms-plugin.js";
import { autoCompactPlugin } from "../plugins/auto-compact-plugin.js";
import type { TelegramSendHooks } from "../plugins/telegram-send-plugin.js";
import { AvatarArtifactStore, createDefaultAvatarProviders } from "./avatar.js";
import { createDefaultSpeechProviders, SpeechArtifactStore, type SpeechKind } from "./speech.js";
import { CAPABILITY_REGISTRY, resolveCapabilities, type CapabilityContext, type CapabilityDefinition, type CommitmentPluginEngine } from "./capabilities.js";
import type { IntakeStore } from "./research-intake.js";
import type { TaskLedger } from "../durable/task-ledger.js";
import { childEnv } from "./child-env.js";
import { EventLog } from "./events.js";
import { planManifestPatch, sha256Hex, type ManifestDiff, type ManifestPatch } from "./manifest-policy.js";
import type { Scheduler } from "./scheduler.js";
import { DEFAULT_AGENT_TOOLS, defaultManifest, type AgentManifest, type ChatRef } from "./types.js";
import { ensureDir, errorMessage, readJson, truncate, writeJsonAtomic } from "./util.js";

export interface LoadedAgent {
  id: string;
  dir: string;
  manifest: AgentManifest;
}

/** Outcome of a field-level manifest update (bd pibot-4wq1). */
export interface ManifestUpdateResult {
  ok: boolean;
  /** sha256 of the manifest bytes on disk after a successful write */
  sha?: string;
  manifest?: AgentManifest;
  diff?: ManifestDiff;
  /** precise reason when ok=false */
  error?: string;
}

/**
 * What a session WOULD enable for an agent's live manifest (bd pibot-4wq1).
 *
 * This is a would-resolve inventory, not proof of the actual running session: it
 * re-reads the manifest from disk and resolves the registry against the caller's
 * host context. The `session*` flags state exactly how far that is from a live
 * session, so an accept/delegate check never claims more than it can prove.
 */
export interface SessionCapabilityInventory {
  agentId: string;
  /** always true — this is a would-resolve computation, never a live-session read */
  resolved: true;
  /** capability ids as requested on disk (null = the conservative default set) */
  requested: string[] | null;
  /** capability ids a session would actually enable on this host right now */
  capabilities: string[];
  /** tool names the session would load */
  tools: string[];
  /** requested ids this host cannot provide (missing hook, executable or policy) */
  unavailable: string[];
  /** true when a session has been built for this agent (a build-time fingerprint exists) */
  sessionBuilt: boolean;
  /** true when the on-disk manifest differs from the build-time fingerprint (session needs a rebuild) */
  sessionStale: boolean;
  /** true when a live session object is currently held for this agent (any chat) */
  sessionActive: boolean;
}

/**
 * Evidence strength of a live session-inventory reading (bd pibot-4wq1):
 *   - `"live-session"`: the built session object exposed its own active tool names
 *     (`getActiveToolNames`), so the reading describes the session that is actually held;
 *   - `"unknown"`: the session object exposed no introspection, so the ACTUAL active tools
 *     are explicitly unknown. The authorised set the build requested is still recorded — it
 *     is never presented as a live reading.
 */
export type SessionInventoryEvidence = "live-session" | "unknown";

/**
 * What one BUILT session actually holds, keyed by agent + chat (bd pibot-4wq1).
 *
 * Unlike {@link SessionCapabilityInventory} (a would-resolve computation with no live
 * caller), this describes a session the host created: the authorised capability ids the
 * build resolved, the unavailable ids it had to skip, the authorised capability context it
 * built into the system prompt, and the ACTUAL active tool names read from the live session
 * when the SDK exposes them. Staleness is judged per session — a manifest patch leaves THIS
 * session stale until it is rebuilt, and rebuilding one session never refreshes another.
 */
export interface SessionInventory {
  agentId: string;
  /** `${agentId}::${chatKey}` — the exact built session this snapshot describes */
  sessionKey: string;
  chatKey: string;
  /** capability ids the build actually authorised (the same resolve the system prompt used) */
  capabilities: string[];
  /** requested ids this host could not provide at build time — recorded, never granted */
  unavailable: string[];
  /** the authorised capability context built into this session (preserved verbatim) */
  capabilityContext: string;
  /** the full tool set the build authorised */
  authorisedTools: string[];
  /** active tool names read from the live session, or null when introspection was unavailable */
  activeTools: string[] | null;
  /** how the reading was obtained — a non-live reading is never claimed as live proof */
  evidence: SessionInventoryEvidence;
  /** sha256 of the manifest this session was built from */
  builtManifestSha?: string;
  /** sha256 of the manifest on disk right now (recomputed on query) */
  currentManifestSha?: string;
  /** true when currentManifestSha differs from builtManifestSha (a rebuild is required) */
  stale: boolean;
  builtAt: number;
}

export class AgentManager {
  private agents = new Map<string, LoadedAgent>();
  private sessions = new Map<string, AgentSession>(); // `${agentId}::${chatKey}` → session
  private builtManifestShas = new Map<string, string>(); // `${agentId}::${chatKey}` → manifest sha at that session's build time
  /** per-session capability inventory captured at build/refresh (bd pibot-4wq1) */
  private sessionInventories = new Map<string, SessionInventory>();
  /** measurable commitment loop (proactive pilot); set by the host after wiring */
  commitments?: CommitmentPluginEngine;
  /** durable research-intake sessions (wizard persistence) */
  intake?: IntakeStore;
  /** durable background-task ledger; set by the host after wiring */
  tasks?: TaskLedger;
  private agentsDir: string;
  private vaultDir: string;
  /** shared docs site source root (read-only course content); set by the host from config */
  docsDir?: string;
  private repoRoot: string;
  private dataDir: string;
  private modelRuntime: ModelRuntime;

  constructor(agentsDir: string, modelRuntime: ModelRuntime, vaultDir?: string, repoRoot = process.cwd(), dataDir?: string) {
    this.agentsDir = path.resolve(agentsDir);
    this.vaultDir = vaultDir ?? path.join(os.homedir(), "Brains", "brain");
    this.repoRoot = path.resolve(repoRoot);
    this.dataDir = dataDir ? path.resolve(dataDir) : path.join(this.repoRoot, "data");
    this.modelRuntime = modelRuntime;
  }

  get vault(): string {
    return this.vaultDir;
  }

  /** directory agents are discovered from (**repo root sibling** of pibot itself) */
  get agentsRoot(): string {
    return this.agentsDir;
  }

  /** session working directory for an agent: its own dir, or the repo root when it develops the host (workspace: "repo") */
  workspaceFor(agent: { dir: string; manifest: { workspace?: "agent-dir" | "repo" } }): string {
    return agent.manifest.workspace === "repo" ? this.repoRoot : agent.dir;
  }

  // ── discovery & scaffolding ───────────────────────────────────────────────

  async discover(): Promise<void> {
    this.agents.clear();
    ensureDir(this.agentsDir);
    fs.chmodSync(this.agentsDir, 0o700);
    for (const e of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const dir = path.join(this.agentsDir, e.name);
      if (!fs.existsSync(path.join(dir, "agent.json"))) continue;
      fs.chmodSync(dir, 0o700);
      const manifest = { ...defaultManifest(e.name), ...readJson<Partial<AgentManifest>>(path.join(dir, "agent.json"), {}) };
      manifest.name = manifest.name || e.name;
      this.agents.set(e.name, { id: e.name, dir, manifest });
      this.ensureMemoryBaseline(dir); // fix up agents created before the scaffold existed
    }
  }

  list(): LoadedAgent[] {
    return [...this.agents.values()];
  }

  getAgent(id: string): LoadedAgent | undefined {
    return this.agents.get(id);
  }

  defaultAgentId(): string | undefined {
    return this.list()[0]?.id;
  }

  /** Scaffold a new agent from the template. Returns error message or undefined. */
  createAgent(name: string, persona?: string): string | undefined {
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) {
      return "Name must be 2–32 chars: lowercase letters, digits, dashes.";
    }
    if (this.agents.has(name)) return `Agent "${name}" already exists.`;
    const templateDir = path.join(this.agentsDir, "_template");
    const dir = path.join(this.agentsDir, name);
    ensureDir(dir);
    fs.chmodSync(dir, 0o700);
    if (fs.existsSync(templateDir)) {
      fs.cpSync(templateDir, dir, { recursive: true });
    } else {
      ensureDir(path.join(dir, "extensions"));
    }
    if (persona?.trim()) {
      fs.writeFileSync(path.join(dir, "AGENTS.md"), persona.trim() + "\n");
    }
    const manifest = { ...defaultManifest(name), name };
    writeJsonAtomic(path.join(dir, "agent.json"), manifest);
    this.ensureMemoryBaseline(dir);
    this.agents.set(name, { id: name, dir, manifest });
    return undefined;
  }

  /**
   * Guarantee the memory baseline (memory/MEMORY.md + memory/notes/) exists.
   * Both the heartbeat digest ("# Memory digest") and the maintenance panel
   * read MEMORY.md — without this scaffold young agents have no durable memory
   * file at all and the maintenance rotation has nothing to service. Idempotent;
   * never overwrites existing content.
   */
  private ensureMemoryBaseline(dir: string): void {
    try {
      const memoryDir = path.join(dir, "memory");
      const notesDir = path.join(memoryDir, "notes");
      ensureDir(notesDir);
      const memoryFile = path.join(memoryDir, "MEMORY.md");
      if (!fs.existsSync(memoryFile)) {
        fs.writeFileSync(
          memoryFile,
          ["# Long-term memory", "", "Durable facts, preferences, decisions and people — distilled over time.", "Agents keep this current (heartbeat maintenance rotation checks its freshness).", ""].join("\n"),
          { mode: 0o600 }
        );
      }
    } catch {
      /* best effort — a missing scaffold must never break agent creation or discovery */
    }
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  /**
   * Get (or lazily create) the persistent session for one agent in one chat.
   * Each session binds: persona (AGENTS.md), per-agent extensions dir,
   * shared plugins (scheduler + memory), and a per-chat session file.
   */
  async getOrCreateSession(
    agentId: string,
    chatKey: string,
    chat: ChatRef,
    scheduler: Scheduler,
    ask?: (spec: import("./questions.js").QuestionSpec) => Promise<import("./questions.js").QuestionAnswer | null>,
    comms?: CommsHooks,
    applyProfilePhoto?: (transport: string, filePath: string) => Promise<void>,
    sendSpeech?: (transport: string, chatId: string, kind: SpeechKind, filePath: string, caption?: string) => Promise<void>,
    sendVideoNote?: (transport: string, chatId: string, filePath: string) => Promise<void | import("./types.js").DeliveryReceipt>,
    telegramSend?: TelegramSendHooks,
    /** minimal-voice shaping applied to spoken text before synthesis (bd: minimal voice).
     *  Last on purpose: the call site appends it without disturbing existing arg positions. */
    styleSpeech?: (text: string) => string,
    /**
     * Extra inline extensions for THIS session build only (bd pibot-0xpf.4 exec guard).
     * The host appends a per-task policy guard here for a background task's own run;
     * kept last so existing positional call sites are unaffected.
     */
    extraExtensions: InlineExtension[] = [],
  ): Promise<AgentSession> {
    const key = `${agentId}::${chatKey}`;
    const cached = this.sessions.get(key);
    if (cached) return cached;

    const agent = this.refreshAgentFromDisk(agentId);
    if (!agent) throw new Error(`Unknown agent "${agentId}"`);

    const sessionsDir = path.join(agent.dir, "sessions");
    ensureDir(sessionsDir);
    const indexPath = path.join(sessionsDir, "index.json");
    const index = readJson<Record<string, string>>(indexPath, {});

    const manager =
      index[chatKey] && fs.existsSync(index[chatKey])
        ? SessionManager.open(index[chatKey])
        : SessionManager.create(agent.dir, sessionsDir);

    // pibot-dev works on the host repo; everyone else lives inside their own dir
    const sessionCwd = this.workspaceFor(agent);
    const capabilitySet = resolveAgentCapabilitySet({
      agent,
      workspace: sessionCwd,
      vaultDir: this.vaultDir,
      docsDir: this.docsDir,
      scheduler,
      chat,
      ask,
      comms,
      telegramSend,
      dictionary: { dataDir: this.dataDir },
      commitments: this.commitments,
      intake: this.intake,
      tasks: this.tasks,
      avatar: applyProfilePhoto && chat.transport.startsWith("telegram") && agent.manifest.capabilities?.includes("avatar") ? {
        providers: createDefaultAvatarProviders(),
        store: new AvatarArtifactStore(path.join(agent.dir, "runtime", "avatars")),
        applyProfilePhoto,
      } : undefined,
      speech: sendSpeech && chat.transport.startsWith("telegram") && agent.manifest.capabilities?.includes("speech") ? {
        providers: createDefaultSpeechProviders(),
        store: new SpeechArtifactStore(path.join(agent.dir, "runtime", "speech")),
        send: sendSpeech,
        sendVideoNote: sendVideoNote,
        ...(styleSpeech ? { styleText: styleSpeech } : {}),
      } : undefined,
    });
    if (capabilitySet.unavailable.length) {
      console.warn(`[${agentId}] unavailable capabilities skipped: ${capabilitySet.unavailable.join(", ")}`);
    }

    // one sink for this session's compaction telemetry
    const sessionEvents = new EventLog(this.agentsDir);
    const loader = new DefaultResourceLoader({
      cwd: sessionCwd,
      agentDir: getAgentDir(),
      systemPromptOverride: () => capabilitySet.systemPrompt,
      // Never the owner's global ~/.pi extensions: they are for interactive pi, and a
      // same-named tool (e.g. an ask_user popup) would shadow pibot's capability tools.
      noExtensions: true,
      // per-agent private plugins
      additionalExtensionPaths: listTsFiles(path.join(agent.dir, "extensions")),
      // per-agent evolved skills (+ staging during evolution)
      additionalSkillPaths: listSkillDirs(path.join(agent.dir, "skills")).map((s) => path.dirname(s.filePath)),
      // shared plugins bound to this agent + chat
        extensionFactories: [
          ...capabilitySet.extensions,
          // Per-task policy guard (if any) for this build only — e.g. the long-audio
          // transcription exec guard the host attaches to a background task's own run.
          ...extraExtensions,
          // Host-level, not a capability: every agent needs compaction, and the guard has to
          // exist for agents created before it did — without editing private manifests.
          autoCompactPlugin({
            dataDir: this.dataDir,
            log: (summary) => sessionEvents.log(agentId, "system", summary),
          }),
        ],
      });
      await loader.reload();

      // manifest model may be missing/renamed — degrade to pi's auto-pick rather than dying
      let model: ReturnType<AgentManager["resolveModel"]>;
      try {
        model = this.resolveModel(agent.manifest.model);
      } catch (e) {
        console.warn(`[${agentId}] model "${agent.manifest.model}" unavailable: ${errorMessage(e)} — auto-picking`);
        model = undefined;
      }
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: sessionCwd,
        agentDir: getAgentDir(),
        modelRuntime: this.modelRuntime,
        model,
        thinkingLevel: agent.manifest.thinking ?? "off",
        tools: [
          ...capabilitySet.sessionTools,
        ],
        customTools: capabilitySet.sessionTools.includes("bash")
          ? [scrubbedBashTool(sessionCwd, agent.manifest.envPassthrough) as unknown as ToolDefinition]
          : [],
        resourceLoader: loader,
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({}),
      });

    if (modelFallbackMessage) console.warn(`[${agentId}] model fallback:`, modelFallbackMessage);

    // persist session file path so restarts resume the same conversation
    if (session.sessionFile && !index[chatKey]) {
      index[chatKey] = session.sessionFile;
      writeJsonAtomic(indexPath, index);
    }

    this.sessions.set(key, session);
    // fingerprint the manifest NOW so later on-disk grant/manifest edits flag the session stale (bd: pibot-3w03)
    this.noteSessionBuilt(agentId, chatKey);
    // capture the ACTUAL authorised capability set this build produced, keyed to this exact
    // chat (bd pibot-4wq1) — the real host path, read back from the session object itself.
    this.captureSessionInventory(agentId, chatKey, session, capabilitySet);
    return session;
  }

  /** Start a fresh session for one agent+chat (the old file is kept on disk) */
  /** Re-read agent.json into the in-memory manifest — grants/caps reach session builds without a restart (bd: pibot-3w03). */
  private refreshAgentFromDisk(agentId: string): LoadedAgent | undefined {
    const agent = this.agents.get(agentId);
    if (!agent) return undefined;
    const file = path.join(agent.dir, "agent.json");
    if (fs.existsSync(file)) {
      try {
        const manifest = { ...defaultManifest(agentId), ...readJson<Partial<AgentManifest>>(file, {}) };
        manifest.name = manifest.name || agentId;
        agent.manifest = manifest;
      } catch {
        /* keep the in-memory manifest on parse trouble */
      }
    }
    return agent;
  }

  private manifestShaOnDisk(agentId: string): string | undefined {
    try {
      const dir = this.agents.get(agentId)?.dir;
      if (!dir) return undefined;
      return createHash("sha256").update(fs.readFileSync(path.join(dir, "agent.json"))).digest("hex");
    } catch {
      return undefined;
    }
  }

  /** Record the manifest fingerprint at session-build time (getOrCreateSession calls this; tests may too).
   *  Keyed PER SESSION — another chat of the same agent must never mask this session's staleness (bd: pibot-3w03). */
  noteSessionBuilt(agentId: string, chatKey: string): void {
    const sha = this.manifestShaOnDisk(agentId);
    if (sha) this.builtManifestShas.set(`${agentId}::${chatKey}`, sha);
  }

  /** True when the on-disk manifest differs from the one THIS session was built with — call resetSession so
   *  capability grants and manifest edits reach the running session without /new or a daemon restart (bd: pibot-3w03). */
  isSessionStale(agentId: string, chatKey: string): boolean {
    const built = this.builtManifestShas.get(`${agentId}::${chatKey}`);
    if (!built) return false;
    const disk = this.manifestShaOnDisk(agentId);
    return disk !== undefined && disk !== built;
  }

  /** Agent-level view for the dashboard inventory: ANY live session still built on an older manifest. */
  anySessionStale(agentId: string): boolean {
    const disk = this.manifestShaOnDisk(agentId);
    if (disk === undefined) return false;
    for (const [key, built] of this.builtManifestShas) {
      if (key.startsWith(`${agentId}::`) && built !== disk) return true;
    }
    return false;
  }

  /** sha256 of the manifest currently on disk (undefined when absent or unreadable). */
  manifestSha(agentId: string): string | undefined {
    return this.manifestShaOnDisk(agentId);
  }

  /**
   * Read the inventory of the session actually BUILT for one agent+chat (bd pibot-4wq1).
   *
   * Returns the snapshot captured when the session was built: the authorised capability ids
   * and the capability context the build produced, the unavailable ids the host had to skip,
   * and the ACTUAL active tool names read from the live session when it exposes them
   * (`evidence: "live-session"`; otherwise "unknown" — the active tools are then explicitly
   * unknown, never claimed as live). `currentManifestSha`/`stale` are recomputed against the
   * manifest on disk NOW, from the snapshot's OWN build-time hash, so a manifest patch keeps
   * THIS session stale until it is rebuilt and rebuilding one session never marks another
   * refreshed. Absent = no session has ever been built for this key.
   */
  sessionInventory(agentId: string, chatKey: string): SessionInventory | undefined {
    const snapshot = this.sessionInventories.get(`${agentId}::${chatKey}`);
    if (!snapshot) return undefined;
    const current = this.manifestShaOnDisk(agentId);
    return {
      ...snapshot,
      currentManifestSha: current,
      stale: current !== undefined && snapshot.builtManifestSha !== undefined && current !== snapshot.builtManifestSha,
    };
  }

  /** Snapshot what a just-built session actually holds — authorised ids/context plus the
   *  session's own active tools. Read-only: it never widens or restores a grant. */
  private captureSessionInventory(
    agentId: string,
    chatKey: string,
    session: AgentSession,
    built: { ids: string[]; unavailable: string[]; systemPrompt: string; sessionTools: string[] },
  ): void {
    const builtManifestSha = this.manifestShaOnDisk(agentId);
    const activeTools = readActiveToolNames(session);
    this.sessionInventories.set(`${agentId}::${chatKey}`, {
      agentId,
      sessionKey: `${agentId}::${chatKey}`,
      chatKey,
      capabilities: [...built.ids],
      unavailable: [...built.unavailable],
      capabilityContext: built.systemPrompt,
      authorisedTools: [...built.sessionTools],
      activeTools,
      evidence: activeTools ? "live-session" : "unknown",
      builtManifestSha,
      currentManifestSha: builtManifestSha,
      stale: false,
      builtAt: Date.now(),
    });
  }

  /**
   * Field-level, compare-and-swap manifest update (bd pibot-4wq1).
   *
   * Only the keys present in `patch` change; every other authorised field already
   * on disk is preserved verbatim. Removals from capability/tool/provider lists
   * must be named in `acknowledgeRemovals`, and a concurrent edit is refused via
   * `expectedSha` — so an "emergency replacement" can no longer drop a grant it
   * forgot to enumerate. Nothing is restored from history or widened on its own.
   *
   * The write deliberately does NOT refresh the session-build fingerprint:
   * isSessionStale() stays true so the host rebuilds against the new grants.
   */
  updateManifest(
    agentId: string,
    patch: ManifestPatch,
    opts: { expectedSha?: string; acknowledgeRemovals?: readonly string[] } = {},
  ): ManifestUpdateResult {
    const agent = this.agents.get(agentId);
    if (!agent) return { ok: false, error: `Unknown agent "${agentId}"` };
    const file = path.join(agent.dir, "agent.json");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { ok: false, error: `No manifest at ${file}` };
    }
    const currentSha = sha256Hex(raw);
    let current: AgentManifest;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      current = parsed as AgentManifest;
    } catch {
      return { ok: false, error: `manifest at ${file} is not a JSON object — refusing to overwrite it` };
    }
    current.name = current.name || agentId;
    const plan = planManifestPatch(current, patch, { ...opts, currentSha });
    if (!plan.ok || !plan.manifest) return { ok: false, error: plan.error, diff: plan.diff };
    writeJsonAtomic(file, plan.manifest);
    const fresh = this.refreshAgentFromDisk(agentId);
    return { ok: true, sha: sha256Hex(fs.readFileSync(file, "utf8")), manifest: fresh?.manifest ?? plan.manifest, diff: plan.diff };
  }

  /**
   * The capability inventory a session WOULD resolve for this agent's live
   * manifest right now (bd pibot-4wq1): the manifest is re-read from disk and run
   * through the real registry against the caller's real host context, so an
   * accept/delegate check reports what would be enabled — and what this host
   * cannot provide — instead of trusting the file.
   *
   * This is not an active-session read: `sessionBuilt`/`sessionStale`/
   * `sessionActive` (and the always-true `resolved` marker) let the caller tell a
   * would-resolve inventory from a live one, so it is never presented as proof
   * that a running session actually holds these capabilities.
   */
  resolveAgentInventory(
    agentId: string,
    ctx: Omit<CapabilityContext, "agent">,
    registry: readonly CapabilityDefinition[] = CAPABILITY_REGISTRY,
  ): SessionCapabilityInventory | undefined {
    const agent = this.refreshAgentFromDisk(agentId);
    if (!agent) return undefined;
    const set = resolveAgentCapabilitySet({ ...ctx, agent: { id: agent.id, dir: agent.dir, manifest: agent.manifest } }, registry);
    return {
      agentId,
      resolved: true,
      requested: agent.manifest.capabilities ?? null,
      capabilities: set.ids,
      tools: set.sessionTools,
      unavailable: set.unavailable,
      sessionBuilt: this.builtManifestShas.has(agentId) || [...this.builtManifestShas.keys()].some((k) => k.startsWith(`${agentId}::`)),
      sessionStale: this.anySessionStale(agentId),
      sessionActive: [...this.sessions.keys()].some((key) => key.startsWith(`${agentId}::`)),
    };
  }

  async resetSession(agentId: string, chatKey: string, chat: ChatRef, scheduler: Scheduler): Promise<void> {
    const key = `${agentId}::${chatKey}`;
    const old = this.sessions.get(key);
    if (old) {
      try {
        old.dispose();
      } catch {
        /* ignore */
      }
    }
    this.sessions.delete(key);
    // a rebuild/reset replaces this session's inventory: drop it so the next build re-captures
    this.sessionInventories.delete(key);
    // drop the index entry so the next getOrCreateSession creates a new file
    const sessionsDir = path.join(this.agentsDir, agentId, "sessions");
    const indexPath = path.join(sessionsDir, "index.json");
    const index = readJson<Record<string, string>>(indexPath, {});
    delete index[chatKey];
    writeJsonAtomic(indexPath, index);
    void scheduler;
  }

  resolveModel(modelSpec: string | undefined) {
    if (!modelSpec) return undefined;
    const r = resolveCliModel({ cliModel: modelSpec, modelRuntime: this.modelRuntime });
    if (r.error) throw new Error(`Model "${modelSpec}" not available: ${r.error}`);
    return r.model;
  }

  heartbeatModel(agent: LoadedAgent) {
    const spec = agent.manifest.heartbeat?.model;
    if (!spec || spec === "same") return undefined; // fall back to agent default
    return this.resolveModel(spec);
  }
}

/**
 * Read a session's ACTUAL active tool names through the SDK's own accessor
 * (`getActiveToolNames`). Returns null when the session object exposes no introspection or
 * throws — the caller must then report the active tools as "unknown", never fabricate a live
 * reading (bd pibot-4wq1).
 */
function readActiveToolNames(session: AgentSession): string[] | null {
  const fn = (session as { getActiveToolNames?: unknown }).getActiveToolNames;
  if (typeof fn !== "function") return null;
  try {
    const names = (session as { getActiveToolNames: () => unknown }).getActiveToolNames.call(session);
    if (!Array.isArray(names)) return null;
    return names.filter((name): name is string => typeof name === "string");
  } catch {
    return null;
  }
}

/** One-line, evidence-honest rendering of a built session's inventory for host diagnostics (bd pibot-4wq1). */
export function formatSessionInventory(inv: SessionInventory): string {
  const caps = inv.capabilities.length ? inv.capabilities.join(", ") : "(none)";
  const missing = inv.unavailable.length ? ` unavailable=${inv.unavailable.join(", ")}` : "";
  const tools = inv.activeTools ? `${inv.activeTools.length} active tools [${inv.activeTools.join(", ")}]` : "active tools unknown";
  return `[session-inventory ${inv.evidence}] ${inv.sessionKey} · caps=${caps}${missing} · ${tools}${inv.stale ? " · STALE (rebuild required)" : ""}`;
}

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.join(dir, e.name));
}

/** Discover per-agent skills: skills/<name>/SKILL.md (skips dot-dirs like .staging) */
export function listSkillDirs(skillsDir: string): Array<{ name: string; description: string; filePath: string; baseDir: string }> {
  if (!fs.existsSync(skillsDir)) return [];
  const skills: Array<{ name: string; description: string; filePath: string; baseDir: string }> = [];
  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const file = path.join(skillsDir, e.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    skills.push({
      name: raw.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? e.name,
      description: raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "",
      filePath: file,
      baseDir: path.dirname(file),
    });
  }
  return skills;
}

/** Common knowledge: the shared KNOWLEDGE.md every agent sees in its prompt */
export function commonKnowledge(vaultDir: string): string {
  const file = path.join(vaultDir, "pibot", "KNOWLEDGE.md");
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw ? `\n\n# Common knowledge (shared between agents)\n${truncate(raw, 2000)}` : "";
  } catch {
    return "";
  }
}

/** Resolve factories, allowed tools and prompt text together so they cannot drift. */
export function resolveAgentCapabilitySet(ctx: CapabilityContext, registry: readonly CapabilityDefinition[] = CAPABILITY_REGISTRY) {
  const resolved = resolveCapabilities(ctx, registry, ctx.agent.manifest.capabilities);
  const capabilityTools = new Set(registry.flatMap((entry) => [...entry.tools]));
  const sdkAndCustomTools = (ctx.agent.manifest.tools ?? DEFAULT_AGENT_TOOLS).filter((tool) => !capabilityTools.has(tool));
  return {
    ...resolved,
    sessionTools: [...new Set([...sdkAndCustomTools, ...resolved.tools])],
    systemPrompt: systemPromptFor(ctx.agent, ctx.vaultDir, resolved.prompt),
  };
}

export function systemPromptFor(agent: LoadedAgent, vaultDir: string, capabilityPrompt = ""): string {
  const hb = agent.manifest.heartbeat;
  const isDevAgent = agent.manifest.workspace === "repo";
  return [
    `You are "${agent.manifest.name}", a personal agent companion living inside pibot.`,
    `You are talking with your owner through a chat interface. Keep replies short and natural — you are a companion, not a report generator. Telegram-renderable markdown only — allowed: bold, italic, inline code, code blocks, links, blockquotes, plain-text bullet lines ('- '). Forbidden: tables (use 'Label: value' lines or short bold-label lists), headings (#), embedded media. Max 4096 chars per message.`,
    ``,
    `# Operating manual`,
    `- You have a heartbeat that wakes you periodically${hb?.enabled ? ` (every ${hb.interval})` : ""}. Between chats it is your chance to be proactive; the heartbeat decides whether anything is worth saying. Your HEARTBEAT.md checklist steers what to check.`,
    `- MEDIA: include a line "MEDIA: <url-or-absolute-file-path>" in your reply to send an image or file via Telegram (max 3 per reply).`,
    `- When a capability is listed below, use its tool instead of claiming it is unavailable. If it requires confirmation, call the confirmation tool; prose is not confirmation.`,
    `- Policy refusals are terminal: briefly explain what is blocked, then stop. Do not route around the policy with another tool.`,
    `- For factual claims taken from email, a thread, a file, or shared knowledge, name the source. If you are relying only on memory, say so.`,
    ...(capabilityPrompt ? [``, `# Available host capabilities`, capabilityPrompt] : []),
    `- The owner's Obsidian vault lives at ${vaultDir} — READ it freely (grep/find are your friends); it is the ground truth. Write only inside your own directory.`,
    ...(isDevAgent
      ? [
          `- You are the RESIDENT DEVELOPER of this bot: your workspace is the pibot source tree itself (repo root), not just your agent dir.`,
          `- Follow the loop from your persona: understand → implement → dev_test (typecheck + tests must pass) → dev_stage (lands a git checkpoint; refuses when red).`,
          `- Never touch .env, data/, node_modules, other agents' sessions/ or memory/, and never push/force git.`,
        ]
      : []),
  ].join("\n") + commonKnowledge(vaultDir);
}

/**
 * Replacement for the SDK's built-in `bash` tool whose child env is an allowlist
 * (see child-env.ts) rather than a copy of process.env, so decrypted secrets never
 * reach the agent's shell. A customTool named "bash" overrides the built-in entry
 * in the SDK's tool registry (Map.set by name), so there is no duplicate.
 */
export function scrubbedBashTool(cwd: string, passthrough?: string[]) {
  return createBashToolDefinition(cwd, {
    spawnHook: (ctx) => {
      const pi: Record<string, string> = {};
      for (const [k, v] of Object.entries(ctx.env)) if (k.startsWith("PI_") && v !== undefined) pi[k] = v;
      return { ...ctx, env: childEnv({ passthrough, extra: pi }) };
    },
  });
}
