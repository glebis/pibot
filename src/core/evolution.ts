import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
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
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import type { EventLog } from "./events.js";
import { buildHeartbeatDigest } from "./heartbeat.js";
import { errorMessage, readJson, truncate, writeJsonAtomic } from "./util.js";

const run = promisify(execFile);

// ─── pure helpers (unit-tested) ─────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

export function validateSkillName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("--");
}

export interface SkillGateResult {
  ok: boolean;
  errors: string[];
}

/** Deterministic guardrails applied before anything reaches the live skills dir */
export function validateSkillFile(name: string, description: string, content: string): SkillGateResult {
  const errors: string[] = [];
  if (!validateSkillName(name)) errors.push(`invalid skill name "${name}"`);
  if (!description || description.length < 10) errors.push("description too short (need a trigger: 'Use when …')");
  if (Buffer.byteLength(content, "utf8") > 15_000) errors.push("skill exceeds 15KB budget");
  if (!/\n#{1,3} |^step|\n- |\n\d+\./m.test(content)) errors.push("body has no structure (steps/list) — skills need actionable structure");
  return { ok: errors.length === 0, errors };
}

// ─── risky pattern gate (prompt-injection guard) ────────────────────────────

export const RISKY_PATTERNS: RegExp[] = [
  /\bexec\b/i,
  /\bfetch\b/i,
  /\bPOST\b/i,
  /\beval\b/i,
  /child_process/i,
  /\bsops\b/i,
  /rm\s+-rf/i,
  /require\s*\(/i,
  /import\s*\(/i,
  /process\.env/i,
  /ignore[\s\S]*previous[\s\S]*instructions/i,
];

export function containsRiskyPattern(content: string): boolean {
  return RISKY_PATTERNS.some((re) => re.test(content));
}

/** Exact find/replace patching, reported honestly */
export function applyPatch(raw: string, find: string, replace: string): { ok: boolean; result?: string; error?: string } {
  const idx = raw.indexOf(find);
  if (idx === -1) return { ok: false, error: "find-text not found" };
  if (raw.indexOf(find, idx + 1) !== -1) return { ok: false, error: "find-text is ambiguous (matches multiple times)" };
  return { ok: true, result: raw.slice(0, idx) + replace + raw.slice(idx + find.length) };
}

// ─── proposal shape ─────────────────────────────────────────────────────────

export interface EvolutionProposal {
  mode: "create" | "patch";
  skillName: string;
  description: string;
  /** full markdown body (create mode) */
  content?: string;
  /** patch mode */
  find?: string;
  replace?: string;
  rationale: string;
  probes: Array<{ task: string; criteria: string }>;
}

export interface ProposalContext {
  agent: LoadedAgent;
  digest: string;
  existingSkills: Array<{ name: string; description: string; raw: string }>;
  goal?: string;
  /** skills already proposed recently — the proposer must not repeat them */
  recentProposals?: string[];
}

export interface EvolutionIO {
  propose(ctx: ProposalContext): Promise<EvolutionProposal>;
  /** run one eval probe in a session that has the candidate skill loaded; returns the agent reply */
  runProbe(probe: { task: string }, skillsDirs: string[], agent: LoadedAgent, model?: unknown): Promise<string>;
  /** judge a probe reply against its success criteria; returns 1..5 */
  judge(args: { task: string; criteria: string; reply: string }): Promise<number>;
}

export interface EvolutionReport {
  agentId: string;
  ok: boolean;
  summary: string;
  skill?: string;
  staged?: boolean;
  promoted?: boolean;
  scores?: number[];
  errors?: string[];
  rationale?: string;
}

/** Mine the event log for recently proposed skill titles (dedup signal) */
export function extractRecentProposals(entries: Array<{ type: string; summary: string }>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const m = e.summary.match(/evolution: (?:create|patch) ["\u201c]?([^"\u201c,]+)/);
    if (m) out.push(m[1].trim());
  }
  return [...new Set(out)];
}

export class EvolutionEngine {
  private stateFile: string;

  constructor(
    private deps: {
      agents: AgentManager;
      modelRuntime: ModelRuntime;
      events: EventLog;
      dataDir: string;
      host: { announce(agentId: string, text: string): Promise<void> };
      io: EvolutionIO;
    }
  ) {
    this.stateFile = path.join(deps.dataDir, "evolution.json");
  }

  // ── daily budget ──────────────────────────────────────────────────────────

  private runsToday(agentId: string): number {
    const state = readJson<{ runs?: Record<string, { day: string; count: number }> }>(this.stateFile, {});
    const entry = state.runs?.[agentId];
    const today = new Date().toISOString().slice(0, 10);
    return entry?.day === today ? entry.count : 0;
  }

  private countRun(agentId: string): void {
    const state = readJson<{ runs?: Record<string, { day: string; count: number }> }>(this.stateFile, {});
    const today = new Date().toISOString().slice(0, 10);
    state.runs = state.runs ?? {};
    const prev = state.runs[agentId];
    state.runs[agentId] = { day: today, count: (prev?.day === today ? prev.count : 0) + 1 };
    writeJsonAtomic(this.stateFile, state);
  }

  // ── staging surface ───────────────────────────────────────────────────────

  staged(agentId: string): string[] {
    const dir = path.join(this.deps.agents.getAgent(agentId)?.dir ?? "", "skills", ".staging");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /** Manually promote a staged candidate (skips probes, gates still apply) */
  promote(agentId: string, skillName: string): boolean {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) return false;
    const stagedFile = path.join(agent.dir, "skills", ".staging", skillName, "SKILL.md");
    if (!fs.existsSync(stagedFile)) return false;
    return this.promoteCandidate(agent, skillName, fs.readFileSync(stagedFile, "utf8"), "manually promoted from staging");
  }

  reject(agentId: string, skillName: string): boolean {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) return false;
    const stagedDir = path.join(agent.dir, "skills", ".staging", skillName);
    if (!fs.existsSync(stagedDir)) return false;
    fs.rmSync(stagedDir, { recursive: true, force: true });
    this.deps.events.log(agentId, "system", `evolution: rejected staged skill ${skillName}`);
    return true;
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  async evolve(agentId: string, goal?: string, opts: { force?: boolean } = {}): Promise<EvolutionReport> {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) return { agentId, ok: false, summary: `unknown agent "${agentId}"`, errors: ["unknown agent"] };

    const maxPerDay = 4;
    if (!opts.force && this.runsToday(agentId) >= maxPerDay) {
      return { agentId, ok: false, summary: `evolution budget reached for today (${maxPerDay} runs)`, errors: ["budget"] };
    }
    this.countRun(agentId); // every cycle costs a propose call — count it

    // 1. collect
    const skillsDir = path.join(agent.dir, "skills");
    const existingSkills = this.readExistingSkills(skillsDir);
    const digest = buildHeartbeatDigest(agent, { list: () => [] }, this.deps.events);
    const recentProposals = extractRecentProposals(this.deps.events.tail(agentId, 40));

    // 2. propose
    let proposal: EvolutionProposal;
    try {
      proposal = await this.deps.io.propose({ agent, digest, existingSkills, goal, recentProposals });
    } catch (e) {
      this.deps.events.log(agentId, "system", `evolution propose failed: ${errorMessage(e)}`);
      return { agentId, ok: false, summary: `propose failed: ${errorMessage(e)}`, errors: [errorMessage(e)] };
    }

    // 3. guardrails
    const gates = this.gate(agent, proposal, this.deps.events.tail(agentId, 40));
    if (!gates.ok) {
      this.deps.events.log(agentId, "system", `evolution gates rejected "${proposal.skillName}": ${gates.errors.join("; ")}`);
      return {
        agentId,
        ok: false,
        summary: `Rejected by guardrails: ${gates.errors.join("; ")}`,
        errors: gates.errors,
        skill: proposal.skillName,
        rationale: proposal.rationale,
      };
    }

    // 4. stage
    const stagedDir = path.join(skillsDir, ".staging", proposal.skillName);
    fs.mkdirSync(stagedDir, { recursive: true });
    const candidateContent = this.candidateContent(agent, proposal);
    fs.writeFileSync(path.join(stagedDir, "SKILL.md"), candidateContent);

    // 5. eval probes (staging dir takes precedence over live skills dir)
    const scores: number[] = [];
    for (const probe of proposal.probes.slice(0, 2)) {
      try {
        const reply = await this.deps.io.runProbe(probe, [path.join(skillsDir, ".staging"), skillsDir], agent);
        const score = await this.deps.io.judge({ task: probe.task, criteria: probe.criteria, reply });
        scores.push(score);
      } catch (e) {
        scores.push(1);
        this.deps.events.log(agentId, "system", `evolution probe error: ${errorMessage(e)}`);
      }
    }
    const avg = scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);

    this.deps.events.log(agentId, "system", `evolution: ${proposal.mode} "${proposal.skillName}" staged, probes [${scores.join(", ")}]`);

    if (scores.length > 0 && avg >= 4) {
      if (containsRiskyPattern(candidateContent)) {
        this.deps.events.log(agentId, "system", `evolution: risky pattern detected in "${proposal.skillName}", requires manual promote`);
      } else {
        // 6a. auto-promote with git checkpoint
      const promoted = this.promoteCandidate(agent, proposal.skillName, candidateContent, proposal.rationale);
      return {
        agentId,
        ok: true,
        summary: `${proposal.mode === "create" ? "Created" : "Patched"} skill "${proposal.skillName}" (probes ${scores.join(", ")}) — ${proposal.rationale}`,
        skill: proposal.skillName,
        staged: false,
        promoted,
        scores,
        rationale: proposal.rationale,
      };
      }
    }

    // 6b. stays staged for human review
    return {
      agentId,
      ok: true,
      summary: `Staged "${proposal.skillName}" for review (probe scores ${scores.join(", ") || "n/a"}; needs ≥4 avg to auto-promote).`,
      skill: proposal.skillName,
      staged: true,
      scores,
      rationale: proposal.rationale,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private readExistingSkills(skillsDir: string): Array<{ name: string; description: string; raw: string }> {
    if (!fs.existsSync(skillsDir)) return [];
    const out: Array<{ name: string; description: string; raw: string }> = [];
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const file = path.join(skillsDir, e.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8");
      out.push({
        name: raw.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? e.name,
        description: raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "",
        raw,
      });
    }
    return out;
  }

  private gate(agent: LoadedAgent, p: EvolutionProposal, recentEvents: Array<{ type: string; summary: string }> = []): SkillGateResult {
    const errors: string[] = [];
    const nameCheck = validateSkillFile(p.skillName, p.description, p.content ?? p.replace ?? "");
    errors.push(...nameCheck.errors);
    if (p.mode === "patch") {
      const file = path.join(agent.dir, "skills", p.skillName, "SKILL.md");
      if (!fs.existsSync(file)) errors.push(`cannot patch — skill "${p.skillName}" does not exist`);
      else if (p.find && !fs.readFileSync(file, "utf8").includes(p.find)) errors.push("cannot patch — find-text not present");
    } else if (fs.existsSync(path.join(agent.dir, "skills", p.skillName, "SKILL.md"))) {
      errors.push(`skill "${p.skillName}" already exists — use mode "patch"`);
    }
    if (!p.probes?.length) errors.push("no eval probes provided");
    // stagnation guard (Ouroboros): same target proposed 3+ times recently = spinning
    let spins = 0;
    for (const e of recentEvents) {
      const m = e.summary.match(/evolution: (?:create|patch) ["\u201c]?([^"\u201c,]+)/);
      if (m && m[1].trim() === p.skillName) spins++;
    }
    if (spins >= 3) errors.push(`stagnation: "${p.skillName}" was proposed ${spins} times recently — try a different improvement`);
    return { ok: errors.length === 0, errors };
  }

  /** Full candidate file content (create: new frontmatter+body; patch: patched live file) */
  private candidateContent(agent: LoadedAgent, p: EvolutionProposal): string {
    const fm = `---\nname: ${p.skillName}\ndescription: ${p.description}\n---\n\n`;
    if (p.mode === "create") return fm + (p.content ?? "");
    const file = path.join(agent.dir, "skills", p.skillName, "SKILL.md");
    const raw = fs.readFileSync(file, "utf8");
    const patched = applyPatch(raw, p.find ?? "", p.replace ?? "");
    return patched.ok ? (patched.result as string) : raw;
  }

  /** Move a candidate from staging to live; git-checkpoint; announce. */
  private promoteCandidate(agent: LoadedAgent, skillName: string, content: string, rationale: string): boolean {
    try {
      const skillsDir = path.join(agent.dir, "skills");
      const target = path.join(skillsDir, skillName, "SKILL.md");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`); // belt & suspenders on top of git
      fs.writeFileSync(target, content);
      fs.rmSync(path.join(skillsDir, ".staging", skillName), { recursive: true, force: true });

      void this.gitCheckpoint(agent, skillName, rationale).catch(() => {});
      this.deps.events.log(agent.id, "system", `evolution: promoted skill ${skillName}`);
      void this.deps.host
        .announce(agent.id, `🧬 Evolved my own skill **${skillName}** — ${truncate(rationale, 200)}\n(previous version kept as SKILL.md.bak; git has the history)`)
        .catch(() => {});
      return true;
    } catch (e) {
      console.error("[evolution] promote failed:", e);
      return false;
    }
  }

  private async gitCheckpoint(agent: LoadedAgent, skillName: string, rationale: string): Promise<void> {
    try {
      await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: agent.dir });
      await run("git", ["add", path.join("agents", agent.id, "skills")], { cwd: process.cwd() });
      await run("git", ["commit", "-m", `evolve(${agent.id}): ${skillName} — ${truncate(rationale, 72)}`], { cwd: process.cwd() });
    } catch {
      /* not a repo, or nothing to commit — fine */
    }
  }
}

// ─── default LLM-backed IO (cheap-model ephemeral sessions) ─────────────────

export function createLlmEvolutionIO(deps: { agents: AgentManager; modelRuntime: ModelRuntime; modelFor: (agent: LoadedAgent) => unknown }): EvolutionIO {
  /** Extract model errors from a finished session and surface them loudly */
  function sessionError(session: AgentSession): string | null {
    const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; errorMessage?: string }>;
    return [...msgs].reverse().find((m) => m.role === "assistant" && m.errorMessage)?.errorMessage ?? null;
  }
  const ephemeral = async (agent: LoadedAgent, opts: { systemPrompt: string; skillsDirs?: string[]; tools?: ReturnType<typeof defineTool>[] }): Promise<AgentSession> => {
    const loader = new DefaultResourceLoader({
      cwd: agent.dir,
      agentDir: getAgentDir(),
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: opts.systemPrompt,
      additionalSkillPaths: opts.skillsDirs ?? [],
    });
    await loader.reload();
    const session = (
      await createAgentSession({
        cwd: agent.dir,
        agentDir: getAgentDir(),
        modelRuntime: deps.modelRuntime,
        model: deps.modelFor(agent) as never,
        thinkingLevel: "off",
        tools: opts.tools ? opts.tools.map((t) => t.name) : [],
        customTools: opts.tools ?? [],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(agent.dir),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      })
    ).session;
    return session;
  };

  return {
    async propose(ctx: ProposalContext): Promise<EvolutionProposal> {
      let proposal: EvolutionProposal | null = null;
      const proposeTool = defineTool({
        name: "evolution_propose",
        label: "Evolution proposal",
        description: "Submit exactly one skill proposal (create or patch) with eval probes. Call exactly once.",
        parameters: Type.Object({
          mode: Type.Union([Type.Literal("create"), Type.Literal("patch")]),
          skillName: Type.String({ description: "kebab-case, 2-48 chars" }),
          description: Type.String({ description: "Trigger-style: 'Use when …'. Max one line." }),
          content: Type.Optional(Type.String({ description: "Full markdown body (create mode). Structured, ≤15KB." })),
          find: Type.Optional(Type.String({ description: "Exact text to replace (patch mode)" })),
          replace: Type.Optional(Type.String({ description: "Replacement (patch mode)" })),
          rationale: Type.String({ description: "Why this makes the agent better w.r.t. the goal/events" }),
          probes: Type.Array(
            Type.Object({
              task: Type.String({ description: "A concrete task the skill should handle" }),
              criteria: Type.String({ description: "What a good response does for this task (for the judge)" }),
            }),
            { minItems: 1, maxItems: 2 }
          ),
        }),
        execute: async (_id, params) => {
          proposal = params as unknown as EvolutionProposal;
          return { content: [{ type: "text", text: "logged" }], details: {} };
        },
      });

      const session = await ephemeral(ctx.agent, { systemPrompt: PROPOSE_SYSTEM, tools: [proposeTool] });
      try {
        const skills = ctx.existingSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n") || "(none yet)";
        const ask = (nudge?: string) =>
          [
            `EVOLUTION CYCLE for agent "${ctx.agent.id}".`,
            ctx.goal ? `Goal: ${ctx.goal}` : `Goal: (none given — derive the highest-value improvement from recent activity)`,
            ``,
            `# State digest\n${ctx.digest}`,
            ``,
            `# Existing skills\n${skills}`,
            ``,
            `Propose exactly one skill (create new, or patch existing).`,
            nudge ?? `Call the evolution_propose tool exactly once — text-only replies are discarded.`,
          ].join("\n");
        await session.prompt(ask());
        const merr = sessionError(session);
        if (merr) throw new Error(merr);
        if (!proposal) {
          // some models reply in text first — one explicit retry
          await session.prompt(`You did not call the tool. Call evolution_propose exactly once now.`);
        }
      } finally {
        try {
          session.dispose();
        } catch {
          /* ignore */
        }
      }
      if (!proposal) {
        const modelId = (deps.modelFor(ctx.agent) as { id?: string } | undefined)?.id ?? "configured model";
        throw new Error(`model made no proposal (no tool call) — consider a different evolution.model than "${modelId}"`);
      }
      return proposal;
    },

    async runProbe(probe: { task: string }, skillsDirs: string[], agent: LoadedAgent): Promise<string> {
      const session = await ephemeral(agent, {
        systemPrompt: `You are testing a newly evolved skill. Follow your skills when relevant. Be concise.`,
        skillsDirs,
      });
      try {
        await session.prompt(probe.task);
        const merr = sessionError(session);
        if (merr) throw new Error(merr);
        const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.role !== "assistant") continue;
          const text = (msgs[i].content ?? []).filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n").trim();
          if (text) return text;
        }
        return "(no reply)";
      } finally {
        try {
          session.dispose();
        } catch {
          /* ignore */
        }
      }
    },

    async judge(args: { task: string; criteria: string; reply: string }): Promise<number> {
      const session = await ephemeral(agentStub(), {
        systemPrompt: `You are a strict eval judge. Score 1-5 whether the REPLY handles the TASK according to the CRITERIA. Reply with ONLY the digit.`,
      });
      try {
        await session.prompt(`TASK: ${args.task}\nCRITERIA: ${args.criteria}\nREPLY: ${truncate(args.reply, 4000)}`);
        const merr = sessionError(session);
        if (merr) return 3;
        const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
        const last = [...msgs].reverse().find((m) => m.role === "assistant");
        const text = (last?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join(" ");
        const m = text.match(/\b([1-5])\b/);
        return m ? parseInt(m[1], 10) : 3;
      } catch {
        return 3;
      } finally {
        try {
          session.dispose();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// tiny shim so judge sessions can build without a real agent ref
function agentStub(): LoadedAgent {
  return { id: "eval", dir: process.cwd(), manifest: { name: "eval" } };
}

function listSkillDirsFor(dirs: string[]): string[] {
  return dirs.filter((d) => fs.existsSync(d));
}

const PROPOSE_SYSTEM = `You are the evolution engine of a personal agent companion. Your job: propose exactly ONE skill improvement that makes the agent measurably better.

Rules:
- Derive the proposal from the goal (if given) and from friction visible in recent events (snoozes, missed fires, repeated asks, corrections).
- Skills are markdown files with steps: name, trigger-style description ("Use when …"), concise actionable body. Max 15KB.
- Prefer small, sharp skills over encyclopedic ones. One skill = one workflow.
- For patch mode: find-text must EXACTLY match a snippet of the existing skill.
- Provide 1-2 eval probes: concrete tasks the skill should handle, each with judge criteria.
- If nothing is worth evolving, still propose the smallest useful improvement you can defend.`;