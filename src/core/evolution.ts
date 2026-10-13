import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { closeBacklogItems, loadBacklogItems, topBacklogItem } from "./backlog.js";
import { readConsolidatedDigest, type ConsolidationEngine } from "./consolidation.js";
import type { EventLog } from "./events.js";
import { buildHeartbeatDigest } from "./heartbeat.js";
import { errorMessage, readJson, truncate, uid, writeJsonAtomic } from "./util.js";
import { JEV_RUBRIC_VERSION, type JevShadowObserver } from "./jev-shadow.js";

/** Stable content identity for shadow metadata — the content itself never leaves. */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

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

/** Structure gate: at least one line that is a heading ("# "), a bullet ("- ", "*", "•"),
 *  a numbered step ("1." / "1)"), or starts with "step" — anchored at line starts so
 *  structure in the FIRST line counts too (Sep 20: bodies opening with a heading or
 *  bullet were rejected because every alternative demanded a preceding newline, and
 *  markdown "*" bullets were never recognized). */
const SKILL_STRUCTURE_RE = /(?:^|\n)(?:#{1,3} |\s*[-*•] |\s*\d+[.)] |step)/;

/** Deterministic guardrails applied before anything reaches the live skills dir */
export function validateSkillFile(name: string, description: string, content: string): SkillGateResult {
  const errors: string[] = [];
  if (!validateSkillName(name)) errors.push(`invalid skill name "${name}"`);
  if (!description || description.length < 10) errors.push("description too short (need a trigger: 'Use when …')");
  if (Buffer.byteLength(content, "utf8") > 15_000) errors.push("skill exceeds 15KB budget");
  if (!SKILL_STRUCTURE_RE.test(content))
    errors.push('body has no structure (steps/list) — include a line starting with "# ", "- ", "*", or "1. "');
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

/** Refuse symlink components as well as lexical traversal for admin file operations. */
function safeSkillPath(agent: LoadedAgent, ...parts: string[]): string | undefined {
  const root = path.resolve(agent.dir);
  let current = root;
  try {
    for (const part of ["skills", ...parts]) {
      if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\")) return undefined;
      current = path.join(current, part);
      // lstat also identifies broken symlinks that existsSync would miss.
      try { if (fs.lstatSync(current).isSymbolicLink()) return undefined; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    }
    return current;
  } catch { return undefined; }
}

// ─── proposal shape ─────────────────────────────────────────────────────────

/** Staging sidecar: the backlog ids a staged candidate addresses (close-on-promote). */
const STAGING_BACKLOG_SIDECAR = ".backlog.json";

function readStagingBacklogIds(agent: LoadedAgent, skillName: string): string[] {
  const sidecar = safeSkillPath(agent, ".staging", skillName, STAGING_BACKLOG_SIDECAR);
  if (!sidecar) return [];
  try {
    const ids = readJson<{ ids?: unknown }>(sidecar, {}) as { ids?: unknown };
    return Array.isArray(ids.ids) ? ids.ids.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

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
  /** optional id of an open improvement-backlog item this proposal addresses (validated) */
  closesBacklog?: string;
}

export interface ProposalContext {
  agent: LoadedAgent;
  digest: string;
  existingSkills: Array<{ name: string; description: string; raw: string }>;
  goal?: string;
  /** skills already proposed recently — the proposer must not repeat them */
  recentProposals?: string[];
  /** distilled event history (consolidation output) — feeds pattern-mining proposals */
  consolidatedMemory?: string;
}

export interface EvolutionIO {
  propose(ctx: ProposalContext): Promise<EvolutionProposal>;
  /** run one eval probe in a session that has the candidate skill loaded; returns the agent reply */
  runProbe(probe: { task: string }, skillsDirs: string[], agent: LoadedAgent, model?: unknown): Promise<string>;
  /**
   * Judge a probe reply against its success criteria; returns 1..5.
   * May also report whether that number was parsed from the judge's answer or is
   * its error fallback (a 5 plus a fallback 3 still averages to 4 — observation
   * only, the score and the promotion rule are untouched by this metadata).
   */
  judge(args: { task: string; criteria: string; reply: string }): Promise<number | JudgeOutcome>;
}

/** A judge score plus its provenance. `parse` is absent when the IO cannot say. */
export type JudgeOutcome = { score: number; parse?: "parsed" | "fallback" };

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

// ─── staged review surface (admin view via chat cards) ─────────────────────

/** Parse `---\nname: …\ndescription: …\n---` frontmatter; body is everything after. */
export function parseSkillFrontmatter(raw: string): { name: string; description: string; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { name: "", description: "", body: raw };
  const fm = m[1];
  return {
    name: fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "",
    description: fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "",
    body: raw.slice(m[0].length),
  };
}

/** Probe scores from the most recent staging event for a skill, if any. */
export function lastProbeScores(entries: Array<{ summary: string }>, skillName: string): number[] | undefined {
  const re = new RegExp(`evolution: (?:create|patch) ["\u201c]?${skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["\u201d]? staged, probes \\[([^\\]]*)\\]`);
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].summary.match(re);
    if (!m) continue;
    const scores = m[1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    return scores;
  }
  return undefined;
}

export interface EvolutionHistoryEntry {
  t: number;
  summary: string;
}

export interface EvolutionReviewDetail extends StagedCandidate {
  currentContent?: string;
  /** Actual bounded event records, not reconstructed versions or causal claims. */
  history: EvolutionHistoryEntry[];
}

export interface StagedCandidate {
  name: string;
  /** "patch" when a live skill with this name exists, else "create" */
  mode: "create" | "patch";
  description: string;
  /** first ~500 chars of the candidate body */
  preview: string;
  /** full staged SKILL.md content (peek) */
  content: string;
  /** improvement-backlog ids this candidate will close on promote */
  closesBacklog: string[];
  /** probe scores from the last evolution cycle that staged this skill */
  scores?: number[];
  stagedAt: number;
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
      /** event-log consolidation (Skill Forge blueprint) — runs before each cycle;
       *  its output feeds the proposal context. Omit to disable. */
      consolidation?: Pick<ConsolidationEngine, "consolidate">;
      host: { announce(agentId: string, text: string): Promise<void> };
      io: EvolutionIO;
      /**
       * Advisory Jev shadow observer (bd pibot-n13). Default off: it only runs when
       * the agent's manifest grants flag + data scope + provider scope, and its
       * result is never read by this engine.
       */
      shadow?: JevShadowObserver;
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
    const agent = this.deps.agents.getAgent(agentId);
    const dir = agent && safeSkillPath(agent, ".staging");
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && validateSkillName(e.name)).map((e) => e.name);
  }

  /** Rich view of what's staged for an agent — what the admin actually reviews. */
  stagedDetail(agentId: string): StagedCandidate[] {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) return [];
    const out: StagedCandidate[] = [];
    const entries = this.deps.events.tail(agentId, 60);
    for (const name of this.staged(agentId)) {
      const file = safeSkillPath(agent, ".staging", name, "SKILL.md");
      if (!file) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(raw);
      let stagedAt = Date.now();
      try {
        stagedAt = fs.statSync(file).mtimeMs;
      } catch {
        /* racing deletion — fall back to now */
      }
      out.push({
        name,
        mode: this.currentContent(agentId, name) !== undefined ? "patch" : "create",
        description: parsed.description,
        preview: truncate(parsed.body.trim(), 500),
        content: raw,
        closesBacklog: readStagingBacklogIds(agent, name),
        scores: lastProbeScores(entries, name),
        stagedAt,
      });
    }
    return out.sort((a, b) => a.stagedAt - b.stagedAt);
  }

  /** Full staged SKILL.md content (peek action); undefined when nothing staged under that name. */
  stagedContent(agentId: string, skillName: string): string | undefined {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent || !validateSkillName(skillName)) return undefined;
    const file = safeSkillPath(agent, ".staging", skillName, "SKILL.md");
    if (!file) return undefined;
    try {
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    } catch {
      return undefined;
    }
  }

  /** Current installed content for comparison; absent for a newly created skill. */
  currentContent(agentId: string, skillName: string): string | undefined {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent || !validateSkillName(skillName)) return undefined;
    const file = safeSkillPath(agent, skillName, "SKILL.md");
    try { return file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined; }
    catch { return undefined; }
  }

  /** Load a complete queue in one staging pass, with a shared bounded history snapshot. */
  reviewDetails(agentId: string): EvolutionReviewDetail[] {
    const candidates = this.stagedDetail(agentId);
    const entries = this.deps.events.tail(agentId, 500);
    return candidates.map((candidate) => ({
      ...candidate,
      currentContent: this.currentContent(agentId, candidate.name),
      history: this.skillHistory(agentId, candidate.name, entries),
    }));
  }

  reviewDetail(agentId: string, skillName: string): EvolutionReviewDetail | undefined {
    if (!validateSkillName(skillName)) return undefined;
    return this.reviewDetails(agentId).find((c) => c.name === skillName);
  }

  private skillHistory(agentId: string, skillName: string, entries = this.deps.events.tail(agentId, 500)): EvolutionHistoryEntry[] {
    const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionsSkill = new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`);
    return entries
      .filter((e) => e.summary.startsWith("evolution:") && mentionsSkill.test(e.summary))
      .map(({ t, summary }) => ({ t, summary })).slice(-30);
  }

  /** Durable archive list for recovery after an Undo banner or process session ends. */
  archivedDetail(agentId: string): Array<EvolutionReviewDetail & { archiveId: string }> {
    const agent = this.deps.agents.getAgent(agentId);
    const root = agent && safeSkillPath(agent, ".archive");
    if (!agent || !root || !fs.existsSync(root)) return [];
    const out: Array<EvolutionReviewDetail & { archiveId: string }> = [];
    const entries = this.deps.events.tail(agentId, 500);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validateSkillName(entry.name)) continue;
      const skillRoot = safeSkillPath(agent, ".archive", entry.name);
      if (!skillRoot) continue;
      for (const receipt of fs.readdirSync(skillRoot, { withFileTypes: true })) {
        if (!receipt.isDirectory() || !/^[a-f0-9]{24}$/.test(receipt.name)) continue;
        const file = safeSkillPath(agent, ".archive", entry.name, receipt.name, "SKILL.md");
        const sidecar = safeSkillPath(agent, ".archive", entry.name, receipt.name, STAGING_BACKLOG_SIDECAR);
        const snapshot = safeSkillPath(agent, ".archive", entry.name, receipt.name, ".archive-review.json");
        if (!file || !sidecar || !snapshot) continue;
        try {
          const content = fs.readFileSync(file, "utf8");
          const parsed = parseSkillFrontmatter(content);
          const currentContent = this.currentContent(agentId, entry.name);
          const data = readJson<{ ids?: unknown }>(sidecar, {});
          const review = readJson<{ scores?: unknown }>(snapshot, {});
          out.push({
            name: entry.name, archiveId: receipt.name, content, currentContent,
            mode: currentContent === undefined ? "create" : "patch",
            description: parsed.description, preview: truncate(parsed.body.trim(), 500),
            closesBacklog: Array.isArray(data.ids) ? data.ids.map(String).filter(Boolean) : [],
            scores: Array.isArray(review.scores) && review.scores.every((n) => typeof n === "number" && Number.isFinite(n)) ? review.scores : undefined,
            stagedAt: fs.statSync(file).mtimeMs, history: this.skillHistory(agentId, entry.name, entries),
          });
        } catch { /* skip corrupt or concurrently restored archive */ }
      }
    }
    return out.sort((a, b) => b.stagedAt - a.stagedAt);
  }

  /** Archive the entire proposal, including sidecars; return an opaque Undo receipt. */
  archive(agentId: string, skillName: string): string | undefined {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent || !validateSkillName(skillName)) return undefined;
    const source = safeSkillPath(agent, ".staging", skillName);
    const archiveId = randomBytes(12).toString("hex");
    const destination = safeSkillPath(agent, ".archive", skillName, archiveId);
    const snapshot = safeSkillPath(agent, ".staging", skillName, ".archive-review.json");
    if (!source || !destination || !snapshot || this.stagedContent(agentId, skillName) === undefined) return undefined;
    try {
      // Capture scores now; later proposals with the same name must not rewrite archived evidence.
      writeJsonAtomic(snapshot, { scores: lastProbeScores(this.deps.events.tail(agentId, 60), skillName) }, 0o600);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.renameSync(source, destination);
      this.deps.events.log(agentId, "system", `evolution: archived staged skill ${skillName}`);
      this.dropReviewTokensFor(agentId, skillName);
      return archiveId;
    } catch { return undefined; }
  }

  /** Restore only when staging is empty; a newer candidate must never be overwritten. */
  restore(agentId: string, skillName: string, archiveId: string): boolean {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent || !validateSkillName(skillName) || !/^[a-f0-9]{24}$/.test(archiveId)) return false;
    const source = safeSkillPath(agent, ".archive", skillName, archiveId);
    const destination = safeSkillPath(agent, ".staging", skillName);
    if (!source || !destination || !fs.existsSync(source) || fs.existsSync(destination)) return false;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.renameSync(source, destination);
      this.deps.events.log(agentId, "system", `evolution: restored staged skill ${skillName}`);
      return true;
    } catch { return false; }
  }

  // ── review-card tokens (compact callback targets for chat buttons) ──────

  /** Telegram callback_data caps at 64 bytes — cards carry short tokens instead of agent+skill names. */
  private reviewTokens = new Map<string, { agentId: string; skillName: string; armedAt: number }>();
  private static readonly REVIEW_TOKEN_TTL_MS = 24 * 3600e3;

  /** Mint (or reuse) a short opaque token for a staged candidate's review card. */
  reviewToken(agentId: string, skillName: string): string {
    this.pruneReviewTokens();
    for (const [tok, v] of this.reviewTokens) {
      if (v.agentId === agentId && v.skillName === skillName) return tok;
    }
    const tok = uid("e", 6);
    this.reviewTokens.set(tok, { agentId, skillName, armedAt: Date.now() });
    return tok;
  }

  /** Resolve a review-card token back to its target; undefined when expired/unknown. */
  resolveReviewToken(token: string): { agentId: string; skillName: string } | undefined {
    this.pruneReviewTokens();
    const v = this.reviewTokens.get(token);
    return v ? { agentId: v.agentId, skillName: v.skillName } : undefined;
  }

  private dropReviewTokensFor(agentId: string, skillName: string): void {
    for (const [tok, v] of this.reviewTokens) {
      if (v.agentId === agentId && v.skillName === skillName) this.reviewTokens.delete(tok);
    }
  }

  private pruneReviewTokens(): void {
    const now = Date.now();
    for (const [tok, v] of this.reviewTokens) {
      if (now - v.armedAt > EvolutionEngine.REVIEW_TOKEN_TTL_MS) this.reviewTokens.delete(tok);
    }
  }

  /** Manually promote a staged candidate (skips probes, gates still apply) */
  promote(agentId: string, skillName: string): boolean {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent || !validateSkillName(skillName)) return false;
    const stagedFile = safeSkillPath(agent, ".staging", skillName, "SKILL.md");
    if (!stagedFile || !safeSkillPath(agent, skillName, "SKILL.md") || !fs.existsSync(stagedFile)) return false;
    // read the sidecar BEFORE promotion deletes the staging dir
    const backlogIds = readStagingBacklogIds(agent, skillName);
    if (!this.promoteCandidate(agent, skillName, fs.readFileSync(stagedFile, "utf8"), "manually promoted from staging")) return false;
    // close-on-commit: the sidecar records which backlog items the skill addresses
    this.closeBacklogIds(agent, backlogIds);
    this.dropReviewTokensFor(agentId, skillName); // decision made — stale buttons must not re-fire
    return true;
  }

  /** Compatibility entry point: rejection is now reversible archival. */
  reject(agentId: string, skillName: string): boolean {
    return this.archive(agentId, skillName) !== undefined;
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

    // consolidation first: distill new events into durable memory, then let the
    // proposal see the distilled view (Skill Forge pattern-mining input)
    let consolidatedMemory: string | undefined;
    if (this.deps.consolidation && agent.manifest.consolidation?.enabled !== false) {
      try {
        const report = await this.deps.consolidation.consolidate(agentId);
        if (report.ok) consolidatedMemory = readConsolidatedDigest(agent.dir) || undefined;
      } catch (e) {
        // consolidation never blocks an evolution cycle
        this.deps.events.log(agentId, "system", `evolution: consolidation skipped: ${errorMessage(e)}`);
      }
    }

    // goal-less cycles target the top-ranked open improvement-backlog item
    const sourcedBacklog = goal ? undefined : topBacklogItem(agent.dir);
    const effectiveGoal = goal ?? sourcedBacklog?.summary;
    if (sourcedBacklog) this.deps.events.log(agentId, "system", `evolution: goal sourced from backlog item ${sourcedBacklog.id} (priority=${sourcedBacklog.priority}, count=${sourcedBacklog.count})`);

    // 2. propose
    let proposal: EvolutionProposal;
    try {
      proposal = await this.deps.io.propose({ agent, digest, existingSkills, goal: effectiveGoal, recentProposals, consolidatedMemory });
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

    // 4. stage (+ sidecar of the backlog items this candidate addresses)
    const stagedDir = path.join(skillsDir, ".staging", proposal.skillName);
    fs.mkdirSync(stagedDir, { recursive: true });
    const candidateContent = this.candidateContent(agent, proposal);
    fs.writeFileSync(path.join(stagedDir, "SKILL.md"), candidateContent);
    const closesIds = this.validCloseIds(agent, [sourcedBacklog?.id, proposal.closesBacklog]);
    if (closesIds.length) writeJsonAtomic(path.join(stagedDir, STAGING_BACKLOG_SIDECAR), { ids: closesIds }, 0o600);

    // 5. eval probes (staging dir takes precedence over live skills dir)
    // The shadow observer sees a bounded snapshot only once a reply exists, and is
    // never awaited: no Jev outcome can reach scores, gates, promotion or closure.
    const scores: number[] = [];
    const shadowRunId = uid("run");
    const shadowProbeIds: string[] = [];
    for (const [index, probe] of proposal.probes.slice(0, 2).entries()) {
      const probeId = `${shadowRunId}:p${index + 1}`;
      shadowProbeIds.push(probeId);
      try {
        const reply = await this.deps.io.runProbe(probe, [path.join(skillsDir, ".staging"), skillsDir], agent);
        const judged = await this.deps.io.judge({ task: probe.task, criteria: probe.criteria, reply });
        const outcome: JudgeOutcome = typeof judged === "number" ? { score: judged } : judged;
        scores.push(outcome.score);
        this.observeShadow(agent, proposal, probe, reply, outcome, shadowRunId, probeId, candidateContent);
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
        // 6a. auto-promote with git checkpoint — close the backlog items the skill lands
        const promoted = this.promoteCandidate(agent, proposal.skillName, candidateContent, proposal.rationale);
        if (promoted) this.closeBacklogIds(agent, closesIds);
        this.noteShadowDecision(shadowRunId, shadowProbeIds, promoted ? "promoted" : "staged");
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
    this.noteShadowDecision(shadowRunId, shadowProbeIds, "staged");
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

  // ── internals ────────────────────────────────────────────────────────

  /**
   * Hand one probe to the shadow observer. Advisory only: nothing here can throw
   * into a cycle, and nothing it returns is ever read.
   *
   * A live cycle has no verified prior-version reply (running the baseline would
   * double probe cost, which the spec forbids), so it asks the criteria question
   * only and marks the baseline as missing. The pairwise question belongs to the
   * replay harness, where baseline and candidate are both run under matched
   * conditions.
   */
  private observeShadow(
    agent: LoadedAgent,
    proposal: EvolutionProposal,
    probe: { task: string; criteria: string },
    reply: string,
    outcome: JudgeOutcome,
    runId: string,
    probeId: string,
    candidateContent: string,
  ): void {
    const observer = this.deps.shadow;
    if (!observer) return;
    try {
      observer.observe(
        {
          runId,
          probeId,
          agentId: agent.id,
          mode: proposal.mode,
          candidateHash: contentHash(candidateContent),
          rubricVersion: JEV_RUBRIC_VERSION,
          task: probe.task,
          criteria: probe.criteria,
          candidateReply: reply,
          // a live cycle's probe text is real user-derived material, not a synthetic case
          dataClass: "live_probe",
          missingEvidence: ["baseline_reply"],
        },
        agent.manifest.evolution?.shadow,
        { score: outcome.score, parse: outcome.parse },
      );
    } catch {
      /* the shadow can never break a cycle */
    }
  }

  /** Record what the authoritative path did, as metadata only. */
  private noteShadowDecision(runId: string, probeIds: string[], decision: "promoted" | "staged"): void {
    const observer = this.deps.shadow;
    if (!observer) return;
    for (const probeId of probeIds) {
      try {
        observer.noteDecision(runId, probeId, decision);
      } catch {
        /* metadata only */
      }
    }
  }

  /** Filter backlog ids down to actually-open items, then mark them done. */
  private closeBacklogIds(agent: LoadedAgent, ids: string[]): void {
    const valid = this.validCloseIds(agent, ids);
    if (!valid.length) return;
    const closed = closeBacklogItems(agent.dir, valid);
    if (closed) this.deps.events.log(agent.id, "system", `evolution: closed ${closed} improvement-backlog item(s) [${valid.join(", ")}]`);
  }

  /** Keep only ids that are open backlog items of this agent. */
  private validCloseIds(agent: LoadedAgent, ids: Array<string | undefined>): string[] {
    const open = new Set(loadBacklogItems(agent.dir).filter((i) => i.status === "open").map((i) => i.id));
    return [...new Set(ids.map((i) => String(i ?? "").trim()).filter(Boolean))].filter((id) => open.has(id));
  }

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
    const skillsDir = path.join(agent.dir, "skills");
    const existingPath = path.join(skillsDir, p.skillName, "SKILL.md");
    const exists = fs.existsSync(existingPath);
    // Structure must hold on the RESULTING candidate, not the bare snippet: a
    // one-paragraph patch of an already-structured skill is still a structured
    // skill (Sep 20: five drafts were rejected because patch snippets were
    // judged alone and never contain steps/lists).
    const candidate = p.mode === "patch" && exists ? this.candidateContent(agent, p) : (p.content ?? "");
    const nameCheck = validateSkillFile(p.skillName, p.description, candidate);
    errors.push(...nameCheck.errors);
    if (p.mode === "patch") {
      if (!exists) errors.push(`cannot patch — skill "${p.skillName}" does not exist`);
      else if (p.find && !fs.readFileSync(existingPath, "utf8").includes(p.find)) errors.push("cannot patch — find-text not present");
    } else if (exists) {
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
      const target = validateSkillName(skillName) ? safeSkillPath(agent, skillName, "SKILL.md") : undefined;
      if (!target || !safeSkillPath(agent, skillName, "SKILL.md.bak") || !safeSkillPath(agent, ".staging", skillName)) return false;
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
          closesBacklog: Type.Optional(Type.String({ description: "Optional id of an open improvement-backlog item (from the backlog digest) that this proposal addresses and closes." })),
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
            ctx.consolidatedMemory ? `# Distilled memory (older, consolidated history)\n${ctx.consolidatedMemory}` : ``,
            ``,
            `# Existing skills\n${skills}`,
            ``,
            `Propose exactly one skill (create new, or patch existing).`,
            nudge ?? `Call the evolution_propose tool exactly once — text-only replies are discarded.`,
          ].filter(Boolean).join("\n");
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

    async judge(args: { task: string; criteria: string; reply: string }): Promise<number | JudgeOutcome> {
      const session = await ephemeral(agentStub(), {
        systemPrompt: `You are a strict eval judge. Score 1-5 whether the REPLY handles the TASK according to the CRITERIA. Reply with ONLY the digit.`,
      });
      try {
        await session.prompt(`TASK: ${args.task}\nCRITERIA: ${args.criteria}\nREPLY: ${truncate(args.reply, 4000)}`);
        const merr = sessionError(session);
        if (merr) return { score: 3, parse: "fallback" as const };
        const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
        const last = [...msgs].reverse().find((m) => m.role === "assistant");
        const text = (last?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join(" ");
        const m = text.match(/\b([1-5])\b/);
        return m ? { score: parseInt(m[1], 10), parse: "parsed" as const } : { score: 3, parse: "fallback" as const };
      } catch {
        return { score: 3, parse: "fallback" as const };
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
- If a "Distilled memory" section is present, mine it for durable patterns: repeated workflows, recurring frictions, and preferences are the best skill candidates.
- Skills are markdown files with steps: name, trigger-style description ("Use when …"), concise actionable body. Max 15KB.
- The body MUST be structured: at least one line starting with "# ", "- ", "*", or "1. " (heading, bullets, or numbered steps) — plain prose is rejected by the structure gate.
- Prefer small, sharp skills over encyclopedic ones. One skill = one workflow.
- For patch mode: find-text must EXACTLY match a snippet of the existing skill.
- Provide 1-2 eval probes: concrete tasks the skill should handle, each with judge criteria.
- If nothing is worth evolving, still propose the smallest useful improvement you can defend.`;