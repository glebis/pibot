import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { CommsHooks } from "../plugins/agent-comms-plugin.js";
import { AvatarArtifactStore, createDefaultAvatarProviders } from "./avatar.js";
import { createDefaultSpeechProviders, SpeechArtifactStore, type SpeechKind } from "./speech.js";
import { CAPABILITY_REGISTRY, resolveCapabilities, type CapabilityContext, type CapabilityDefinition } from "./capabilities.js";
import type { Scheduler } from "./scheduler.js";
import { DEFAULT_AGENT_TOOLS, defaultManifest, type AgentManifest, type ChatRef } from "./types.js";
import { ensureDir, errorMessage, readJson, truncate, writeJsonAtomic } from "./util.js";

export interface LoadedAgent {
  id: string;
  dir: string;
  manifest: AgentManifest;
}

export class AgentManager {
  private agents = new Map<string, LoadedAgent>();
  private sessions = new Map<string, AgentSession>(); // `${agentId}::${chatKey}` → session
  private agentsDir: string;
  private vaultDir: string;
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
  ): Promise<AgentSession> {
    const key = `${agentId}::${chatKey}`;
    const cached = this.sessions.get(key);
    if (cached) return cached;

    const agent = this.agents.get(agentId);
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
      scheduler,
      chat,
      ask,
      comms,
      dictionary: { dataDir: this.dataDir },
      avatar: applyProfilePhoto && chat.transport.startsWith("telegram") && agent.manifest.capabilities?.includes("avatar") ? {
        providers: createDefaultAvatarProviders(),
        store: new AvatarArtifactStore(path.join(agent.dir, "runtime", "avatars")),
        applyProfilePhoto,
      } : undefined,
      speech: sendSpeech && chat.transport.startsWith("telegram") && agent.manifest.capabilities?.includes("speech") ? {
        providers: createDefaultSpeechProviders(),
        store: new SpeechArtifactStore(path.join(agent.dir, "runtime", "speech")),
        send: sendSpeech,
      } : undefined,
    });
    if (capabilitySet.unavailable.length) {
      console.warn(`[${agentId}] unavailable capabilities skipped: ${capabilitySet.unavailable.join(", ")}`);
    }

    const loader = new DefaultResourceLoader({
      cwd: sessionCwd,
      agentDir: getAgentDir(),
      systemPromptOverride: () => capabilitySet.systemPrompt,
      // per-agent private plugins
      additionalExtensionPaths: listTsFiles(path.join(agent.dir, "extensions")),
      // per-agent evolved skills (+ staging during evolution)
      additionalSkillPaths: listSkillDirs(path.join(agent.dir, "skills")).map((s) => path.dirname(s.filePath)),
      // shared plugins bound to this agent + chat
        extensionFactories: capabilitySet.extensions,
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
    return session;
  }

  /** Start a fresh session for one agent+chat (the old file is kept on disk) */
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
    `You are talking with your owner through a chat interface. Keep replies short and natural — you are a companion, not a report generator. Light markdown is fine.`,
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
