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
import { calendarPlugin } from "../plugins/calendar-plugin.js";
import { gmailPlugin } from "../plugins/gmail-plugin.js";
import { linearPlugin } from "../plugins/linear-plugin.js";
import { memoryPlugin } from "../plugins/memory-plugin.js";
import { questionPlugin } from "../plugins/question-plugin.js";
import { schedulerPlugin } from "../plugins/scheduler-plugin.js";
import { skillManagePlugin } from "../plugins/skill-manage-plugin.js";
import { tgResponderPlugin } from "../plugins/tg-responder-plugin.js";
import { knowledgePlugin } from "../plugins/knowledge-plugin.js";
import { agentCommsPlugin, type CommsHooks } from "../plugins/agent-comms-plugin.js";
import { attendPlugin } from "../plugins/attend-plugin.js";
import type { Scheduler } from "./scheduler.js";
import { DEFAULT_AGENT_TOOLS, defaultManifest, type AgentManifest, type ChatRef } from "./types.js";
import { ensureDir, readJson, truncate, writeJsonAtomic } from "./util.js";

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
  private modelRuntime: ModelRuntime;

  constructor(agentsDir: string, modelRuntime: ModelRuntime, vaultDir?: string) {
    this.agentsDir = path.resolve(agentsDir);
    this.vaultDir = vaultDir ?? path.join(os.homedir(), "Brains", "brain");
    this.modelRuntime = modelRuntime;
  }

  get vault(): string {
    return this.vaultDir;
  }

  // ── discovery & scaffolding ───────────────────────────────────────────────

  async discover(): Promise<void> {
    this.agents.clear();
    ensureDir(this.agentsDir);
    for (const e of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const dir = path.join(this.agentsDir, e.name);
      if (!fs.existsSync(path.join(dir, "agent.json"))) continue;
      const manifest = { ...defaultManifest(e.name), ...readJson<Partial<AgentManifest>>(path.join(dir, "agent.json"), {}) };
      manifest.name = manifest.name || e.name;
      this.agents.set(e.name, { id: e.name, dir, manifest });
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
    this.agents.set(name, { id: name, dir, manifest });
    return undefined;
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
    comms?: CommsHooks
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

    const loader = new DefaultResourceLoader({
      cwd: agent.dir,
      agentDir: getAgentDir(),
      systemPromptOverride: () => systemPromptFor(agent, this.vaultDir),
      // per-agent private plugins
      additionalExtensionPaths: listTsFiles(path.join(agent.dir, "extensions")),
      // per-agent evolved skills (+ staging during evolution)
      additionalSkillPaths: listSkillDirs(path.join(agent.dir, "skills")).map((s) => path.dirname(s.filePath)),
      // shared plugins bound to this agent + chat
        extensionFactories: [
          schedulerPlugin({ scheduler, agentId, chat, getQuietHours: () => agent.manifest.heartbeat?.quietHours }),
          memoryPlugin({ agentDir: agent.dir }),
          calendarPlugin(),
          gmailPlugin(),
          linearPlugin(),
          skillManagePlugin({ agentDir: agent.dir, agentId }),
          ...(ask ? [questionPlugin({ chat, ask })] : []),
        ],
      });
      await loader.reload();

      const model = this.resolveModel(agent.manifest.model);
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: agent.dir,
        agentDir: getAgentDir(),
        modelRuntime: this.modelRuntime,
        model,
        thinkingLevel: agent.manifest.thinking ?? "off",
        tools: [
          ...(agent.manifest.tools ?? DEFAULT_AGENT_TOOLS),
          "schedule_create", "schedule_list", "schedule_cancel", "snooze",
          "promise_make", "promise_keep", "calendar_today", "calendar_create_event", "calendar_delete_event", "calendar_move_event",
          "gmail_list", "gmail_read",
          "linear_list", "linear_create", "linear_update",
          "memory_save", "memory_recall",
          "skill_save", "skill_patch", "skill_list",
          ...(ask ? ["ask_user"] : []),
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

function systemPromptFor(agent: LoadedAgent, vaultDir: string): string {
  const hb = agent.manifest.heartbeat;
  return [
    `You are "${agent.manifest.name}", a personal agent companion living inside pibot.`,
    `You are talking with your owner through a chat interface. Keep replies short and natural — you are a companion, not a report generator. Light markdown is fine.`,
    ``,
    `# Operating manual`,
    `- Time-sensitive requests: use the schedule_create tool. It is instant — no confirmation ritual needed. Confirm briefly in your reply.`,
    `- Things worth remembering: memory_save (or write files directly into memory/ — that directory is yours).`,
    `- The user may say "snooze" — use the snooze tool. Important items still fire through snooze.`,
    `- Decisions with clear options: use the ask_user tool — it renders tappable buttons (2–6 options) or a poll (7–10) in the chat and returns the user's choice. Always include an "unsure" option when the user might not know.`,
    `- You have a heartbeat that wakes you periodically${hb?.enabled ? ` (every ${hb.interval})` : ""}. Between chats it is your chance to be proactive; the heartbeat decides whether anything is worth saying.`,
    `- The owner's Obsidian vault lives at ${vaultDir} — READ it freely (grep/find are your friends); it is the ground truth. Write only inside your own directory.`,
    ``,
    `# Schedule tool semantics`,
    `- "when" strings: "in 20m", "tomorrow 9am", "daily at 08:00", "every 2h", "friday 18:00", "every day at 9am".`,
    `- kind: reminder | task | note | subject | custom.`,
    `- delivery "direct" sends a quick formatted ping when due; "agent" wakes you to compose the message yourself (more personal, more tokens).`,
    `- wake "important" — reserve it for hard commitments (deadlines, meds).`,
  ].join("\n") + commonKnowledge(vaultDir);
}