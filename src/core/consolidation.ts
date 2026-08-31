// ─── Events → durable memory consolidation (Skill Forge blueprint) ──────────
// Ouroboros-pattern pipeline: an advance-only cursor distills state/events.jsonl
// into block-based durable memory (blocks.json + regenerated CONSOLIDATED.md +
// journal). Lost/skipped events are never silently dropped — log rotation
// produces an explicit gap block. A cheap model consolidates unconsolidated
// events into summary blocks; older blocks compress into eras; durable lessons
// are promoted into memory/notes with an index. Triggered from evolution
// cycles, a heartbeat maintenance item, or the opt-in scheduled job —
// output feeds skill proposals.

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
  type CreateAgentSessionOptions,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import { redactEventSummary, type EventEntry } from "./events.js";
import { ensureDir, errorMessage, readJson, slug, truncate, uid, writeJsonAtomic } from "./util.js";

// ─── tunables ───────────────────────────────────────────────────────────────

/** Max events consumed per consolidation run (the rest stay queued). */
export const MAX_EVENTS_PER_RUN = 60;
/** Compress the oldest blocks into an era once the block count exceeds this. */
export const ERA_THRESHOLD = 24;
/** Recent blocks always kept as-is during era compression. */
export const ERA_KEEP = 12;

// ─── shapes ─────────────────────────────────────────────────────────────────

export type ConsolidatedBlockKind = "summary" | "gap" | "era";

export interface ConsolidatedBlock {
  id: string;
  kind: ConsolidatedBlockKind;
  createdAt: number;
  /** event-log line range covered: [from, to) */
  from: number;
  to: number;
  /** wall-clock span of the covered events */
  fromT: number;
  toT: number;
  /** distilled text; for gap blocks an honest description of the discontinuity */
  text: string;
}

export interface LessonRecord {
  t: number;
  title: string;
  /** path relative to the agent's memory/ dir */
  file: string;
  tags: string[];
}

export interface ConsolidationState {
  meta: {
    /** advance-only cursor: events.jsonl line index up to which everything is handled */
    offset: number;
    /** timestamp of the last consumed event (rotation reconciliation) */
    lastT: number;
    lastRunAt?: number;
    runs?: number;
    lessons?: LessonRecord[];
  };
  blocks: ConsolidatedBlock[];
}

export interface EventScanPlan {
  /** events to consolidate this run (capped at MAX_EVENTS_PER_RUN) */
  pending: EventEntry[];
  /** leftover lines recognized as already-consumed (rotation reconciliation) */
  skipped: number;
  /** events.jsonl line index where the unconsumed region begins */
  startLine: number;
  totalLines: number;
  /** the log shrank or its boundary went stale — a gap block must record the discontinuity */
  rotation: { skipped: number; pending: number; offsetBefore: number } | null;
  /** cursor after this run consumes `pending` */
  offsetAfter: number;
  lastTAfter: number;
  /** events beyond the cap that remain queued (not lost — later rounds) */
  deferred: number;
}

export interface DistillResult {
  summary: string;
  lessons: Array<{ title: string; content: string; tags?: string[] }>;
}

export interface DistillIO {
  distill(args: { agentId: string; events: EventEntry[] }): Promise<DistillResult>;
  compressEra(args: { agentId: string; blocks: ConsolidatedBlock[] }): Promise<string>;
}

export interface ConsolidateReport {
  agentId: string;
  ok: boolean;
  summary: string;
  consumed?: number;
  deferred?: number;
  gap?: boolean;
  lessonsWritten?: number;
  eraCompressed?: number;
  error?: string;
}

// ─── pure scan (unit-tested): cursor + rotation gap reconciliation ──────────

function tryParseEvent(line: string): EventEntry | null {
  try {
    const e = JSON.parse(line) as { t?: unknown; type?: unknown; summary?: unknown };
    if (typeof e.t !== "number" || typeof e.summary !== "string") return null;
    return { t: e.t, type: (typeof e.type === "string" ? e.type : "system") as EventEntry["type"], summary: e.summary };
  } catch {
    return null;
  }
}

export interface CursorMeta {
  offset: number;
  lastT: number;
}

/**
 * Pure advance-only cursor over an append-only JSONL event log.
 * No cursor yet → consume from line 0. Otherwise the positional offset is
 * authoritative; a shorter file or a stale boundary timestamp means the log
 * was rotated/truncated — reconcile by timestamp (consumed leftovers have
 * t <= lastT) and report a rotation so the caller writes a durable gap block.
 * Same-millisecond events at the boundary count as consumed.
 */
export function planEventScan(rawLines: string[], meta: CursorMeta, opts: { maxEvents?: number } = {}): EventScanPlan {
  const maxEvents = Math.max(1, opts.maxEvents ?? MAX_EVENTS_PER_RUN);
  const totalLines = rawLines.length;
  const parsed = rawLines
    .map((line, lineNo) => (line.trim() ? { lineNo, event: tryParseEvent(line) } : { lineNo, event: null }))
    .filter((p): p is { lineNo: number; event: EventEntry } => p.event !== null);

  const hasCursor = meta.offset > 0 || meta.lastT > 0;
  let rotation: EventScanPlan["rotation"] = null;
  let startLine = 0;
  let skipped = 0;

  if (hasCursor) {
    const posStart = Math.min(meta.offset, totalLines);
    const shrank = totalLines < meta.offset;
    const boundary = parsed.find((p) => p.lineNo === posStart);
    const stale = Boolean(boundary && meta.lastT > 0 && boundary.event.t < meta.lastT);
    // lines before the cursor that look unconsumed (t > lastT) mean the head was
    // trimmed and the file re-grew past the old offset — the positional cursor lied
    const misplaced = Boolean(!shrank && !stale && parsed.some((p) => p.lineNo < posStart && p.event.t > meta.lastT));
    if (shrank || stale || misplaced) {
      // rotation: walk past leftovers by timestamp (t <= lastT = consumed)
      const first = parsed.find((p) => p.event.t > meta.lastT);
      startLine = first ? first.lineNo : totalLines;
      skipped = parsed.filter((p) => p.lineNo < startLine).length;
      rotation = { skipped, pending: parsed.filter((p) => p.lineNo >= startLine).length, offsetBefore: meta.offset };
    } else {
      startLine = posStart;
    }
  }

  const fresh = parsed.filter((p) => p.lineNo >= startLine);
  const capped = fresh.slice(0, maxEvents);
  const pending = capped.map((p) => p.event);
  const deferred = fresh.length - capped.length;
  const offsetAfter = pending.length
    ? capped[capped.length - 1].lineNo + 1
    : rotation !== null
      ? totalLines // reconcile the cursor to the current file
      : hasCursor
        ? Math.min(meta.offset, totalLines)
        : totalLines;
  const lastTAfter = pending.length ? pending[pending.length - 1].t : meta.lastT;

  return { pending, skipped, startLine, totalLines, rotation, offsetAfter, lastTAfter, deferred };
}

// ─── file layout ────────────────────────────────────────────────────────────

export const CONSOLIDATED_DIR = path.join("memory", "consolidated");
export const BLOCKS_FILE = path.join(CONSOLIDATED_DIR, "blocks.json");
export const MARKDOWN_FILE = path.join(CONSOLIDATED_DIR, "CONSOLIDATED.md");
export const JOURNAL_FILE = path.join(CONSOLIDATED_DIR, "journal.jsonl");

export function consolidationPaths(agentDir: string) {
  return {
    dir: path.join(agentDir, CONSOLIDATED_DIR),
    blocks: path.join(agentDir, BLOCKS_FILE),
    markdown: path.join(agentDir, MARKDOWN_FILE),
    journal: path.join(agentDir, JOURNAL_FILE),
    events: path.join(agentDir, "state", "events.jsonl"),
  };
}

function emptyState(): ConsolidationState {
  return { meta: { offset: 0, lastT: 0 }, blocks: [] };
}

function loadState(agentDir: string): ConsolidationState {
  const st = readJson<ConsolidationState>(consolidationPaths(agentDir).blocks, emptyState());
  if (!st || !Array.isArray(st.blocks)) return emptyState();
  if (!st.meta || typeof st.meta.offset !== "number") st.meta = { offset: 0, lastT: 0 };
  return st;
}

function saveState(agentDir: string, state: ConsolidationState): void {
  writeJsonAtomic(consolidationPaths(agentDir).blocks, state, 0o600);
}

/** Append one run's record to the consolidation journal (best-effort). */
function appendJournal(agentDir: string, record: Record<string, unknown>): void {
  try {
    ensureDir(path.join(agentDir, CONSOLIDATED_DIR));
    fs.appendFileSync(path.join(agentDir, JOURNAL_FILE), JSON.stringify({ t: Date.now(), ...record }) + "\n", { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

function saveMarkdown(agentDir: string, state: ConsolidationState): void {
  const file = consolidationPaths(agentDir).markdown;
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, renderConsolidatedMarkdown(state), { mode: 0o600 });
  } catch {
    /* markdown is regenerated next run — never fatal */
  }
}

// ─── pure render (unit-tested) ──────────────────────────────────────────────

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Regenerate the human-facing markdown view from the JSON source of truth. */
export function renderConsolidatedMarkdown(state: ConsolidationState): string {
  const parts: string[] = [
    "# Consolidated memory",
    "",
    "_Distilled automatically from the event log. Oldest first. Source of truth: `memory/consolidated/blocks.json`._",
    "",
  ];
  const eras = state.blocks.filter((b) => b.kind === "era");
  const rest = state.blocks.filter((b) => b.kind !== "era");
  if (eras.length) {
    parts.push("## Eras");
    for (const b of eras) parts.push(`\n### ${day(b.fromT)} → ${day(b.toT)} (events ${b.from}–${b.to})\n\n${b.text}\n`);
  }
  if (rest.length) {
    parts.push("## Blocks");
    for (const b of rest) {
      const range = `events ${b.from}–${b.to}`;
      if (b.kind === "gap") parts.push(`\n### ⚠︎ gap (${range}, around ${day(b.fromT)})\n\n${b.text}\n`);
      else parts.push(`\n### ${day(b.fromT)} — ${range}\n\n${b.text}\n`);
    }
  }
  if (!state.blocks.length) parts.push("_(nothing consolidated yet)_\n");
  const lessons = state.meta.lessons ?? [];
  if (lessons.length) {
    parts.push("## Lessons index");
    parts.push(
      lessons
        .map((l) => `- [${l.title}](../${l.file}) — ${day(l.t)}${l.tags.length ? ` · ${l.tags.map((tg) => `#${tg}`).join(" ")}` : ""}`)
        .join("\n") + "\n"
    );
  }
  return parts.join("\n");
}

/** Distilled memory for prompt injection (evolution proposals). Truncated. */
export function readConsolidatedDigest(agentDir: string, max = 1600): string {
  try {
    const raw = fs.readFileSync(consolidationPaths(agentDir).markdown, "utf8");
    return truncate(raw, max);
  } catch {
    return "";
  }
}

function ageAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * One maintenance-panel line about event consolidation (read-only, fs-safe).
 * Returns null when the agent explicitly disabled consolidation.
 */
export function consolidationPanelLine(agentDir: string, now = Date.now()): string | null {
  const manifest = readJson<{ consolidation?: { enabled?: boolean } }>(path.join(agentDir, "agent.json"), {});
  if (manifest.consolidation?.enabled === false) return null;
  const paths = consolidationPaths(agentDir);
  const state = loadState(agentDir);

  let pending = 0;
  try {
    const lines = fs.readFileSync(paths.events, "utf8").trimEnd().split("\n").filter(Boolean);
    const plan = planEventScan(lines, state.meta);
    pending = plan.rotation ? plan.rotation.pending : plan.pending.length + plan.deferred;
  } catch {
    /* no event log — nothing pending */
  }

  const lastRun = state.meta.lastRunAt ? `last run ${ageAgo(state.meta.lastRunAt, now)}` : "never run";
  const st = pending > 0 ? `${lastRun} · ${pending} event${pending === 1 ? "" : "s"} pending` : `${lastRun} · up to date`;
  return `- events consolidation (memory/consolidated): ${st} — distill the event log into durable memory with maintain: "consolidate events"`;
}

// ─── engine ─────────────────────────────────────────────────────────────────

const LESSONS_MAX_PER_RUN = 4;
const SUMMARY_MAX = 2000;
const ERA_TEXT_MAX = 3000;

export class ConsolidationEngine {
  private inflight = new Set<string>();
  private maxEvents: number;
  private eraThreshold: number;
  private eraKeep: number;

  constructor(
    private deps: {
      agents: Pick<AgentManager, "getAgent">;
      events: Pick<import("./events.js").EventLog, "log">;
      io: DistillIO;
    },
    opts: { maxEvents?: number; eraThreshold?: number; eraKeep?: number } = {}
  ) {
    this.maxEvents = opts.maxEvents ?? MAX_EVENTS_PER_RUN;
    this.eraThreshold = opts.eraThreshold ?? ERA_THRESHOLD;
    this.eraKeep = opts.eraKeep ?? ERA_KEEP;
  }

  /** Run one consolidation pass for this agent. Never throws. */
  async consolidate(agentId: string): Promise<ConsolidateReport> {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) return { agentId, ok: false, summary: `unknown agent "${agentId}"`, error: "unknown agent" };
    if (agent.manifest.consolidation?.enabled === false) {
      return { agentId, ok: true, summary: "consolidation disabled for this agent" };
    }
    if (this.inflight.has(agentId)) return { agentId, ok: true, summary: "consolidation already running" };
    this.inflight.add(agentId);
    try {
      return await this.consolidateInner(agent);
    } catch (e) {
      const err = errorMessage(e);
      try {
        this.deps.events.log(agentId, "system", `consolidation failed: ${err}`);
      } catch {
        /* ignore */
      }
      return { agentId, ok: false, summary: `consolidation failed: ${err}`, error: err };
    } finally {
      this.inflight.delete(agentId);
    }
  }

  private async consolidateInner(agent: LoadedAgent): Promise<ConsolidateReport> {
    const dir = agent.dir;
    const paths = consolidationPaths(dir);
    const state = loadState(dir);

    // 1. scan (pure)
    let rawLines: string[] = [];
    try {
      rawLines = fs.readFileSync(paths.events, "utf8").trimEnd().split("\n").filter(Boolean);
    } catch {
      /* no log yet */
    }
    const plan = planEventScan(rawLines, state.meta, { maxEvents: this.maxEvents });

    if (!plan.pending.length && !plan.rotation) {
      return { agentId: agent.id, ok: true, summary: "no new events to consolidate" };
    }

    const meta: ConsolidationState["meta"] = { ...state.meta, offset: plan.offsetAfter, lastT: plan.lastTAfter };
    const blocks = [...state.blocks];

    // 2. durable gap block for rotation — lost events are never silent
    if (plan.rotation) {
      blocks.push({
        id: uid("b_"),
        kind: "gap",
        createdAt: Date.now(),
        from: plan.rotation.offsetBefore,
        to: plan.offsetAfter,
        fromT: state.meta.lastT,
        toT: Date.now(),
        text: redactEventSummary(
          `Event-log rotation: the cursor was at line ${plan.rotation.offsetBefore}; ` +
            `${plan.rotation.skipped} already-consolidated line(s) were skipped, ${plan.rotation.pending} fresh remain. ` +
            `Lines trimmed from the head of the log before being distilled are covered by this gap — the loss is recorded, not silent.`
        ),
      });
    }

    // gap-only pass (rotation detected, nothing fresh to distill)
    if (!plan.pending.length) {
      const done: ConsolidationState = {
        meta: { ...meta, lastRunAt: Date.now(), runs: (state.meta.runs ?? 0) + 1 },
        blocks,
      };
      saveState(dir, done);
      saveMarkdown(dir, done);
      appendJournal(dir, { agent: agent.id, rotation: true, consumed: 0 });
      return { agentId: agent.id, ok: true, summary: "recorded an event-log rotation gap", gap: true };
    }

    // 3. distill via the cheap model (on failure the cursor never advances)
    let distilled: DistillResult;
    try {
      distilled = await this.deps.io.distill({ agentId: agent.id, events: plan.pending });
    } catch (e) {
      const err = errorMessage(e);
      this.deps.events.log(agent.id, "system", `consolidation: distill failed, cursor left at ${state.meta.offset} (${err})`);
      appendJournal(dir, { agent: agent.id, error: err, pending: plan.pending.length });
      return { agentId: agent.id, ok: false, summary: `distill failed: ${err}`, error: err };
    }

    // 4. summary block
    const fromT = plan.pending[0].t;
    const toT = plan.pending[plan.pending.length - 1].t;
    const summaryBlock: ConsolidatedBlock = {
      id: uid("b_"),
      kind: "summary",
      createdAt: Date.now(),
      from: plan.startLine,
      to: plan.offsetAfter,
      fromT,
      toT,
      text: truncate(redactEventSummary(distilled.summary.trim() || "(empty summary)"), SUMMARY_MAX),
    };
    blocks.push(summaryBlock);

    // 5. lessons → memory notes + index
    const lessonsWritten = this.writeLessons(dir, distilled.lessons ?? []);

    // 6. era compression (deterministic fallback keeps every record)
    const eraCompressed = await this.maybeCompressEra(agent, blocks);

    // 7. persist: JSON is the source of truth, markdown is regenerated, journal appended
    const done: ConsolidationState = {
      meta: {
        offset: plan.offsetAfter,
        lastT: plan.lastTAfter,
        lastRunAt: Date.now(),
        runs: (state.meta.runs ?? 0) + 1,
        lessons: [...(state.meta.lessons ?? []), ...lessonsWritten],
      },
      blocks,
    };
    saveState(dir, done);
    saveMarkdown(dir, done);
    appendJournal(dir, {
      agent: agent.id,
      consumed: plan.pending.length,
      deferred: plan.deferred,
      gap: Boolean(plan.rotation),
      block: summaryBlock.id,
      lessons: lessonsWritten.length,
      era: eraCompressed || undefined,
    });

    const parts = [
      `consolidation: ${plan.pending.length} event${plan.pending.length === 1 ? "" : "s"} → summary block (events ${summaryBlock.from}–${summaryBlock.to})`,
    ];
    if (plan.rotation) parts.unshift("rotation gap recorded;");
    if (plan.deferred) parts.push(`${plan.deferred} still queued`);
    if (lessonsWritten.length) parts.push(`${lessonsWritten.length} lesson${lessonsWritten.length === 1 ? "" : "s"}`);
    if (eraCompressed) parts.push(`era merged ${eraCompressed} old blocks`);
    // NOTE: consolidation never writes back into events.jsonl — its records live
    // in the journal + blocks; a run that logged itself would be consumed by the
    // next run forever (self-sustaining pending loop).

    return {
      agentId: agent.id,
      ok: true,
      summary: parts.join(" · "),
      consumed: plan.pending.length,
      deferred: plan.deferred,
      gap: Boolean(plan.rotation),
      lessonsWritten: lessonsWritten.length,
      eraCompressed: eraCompressed || undefined,
    };
  }

  /** Write distilled lessons as memory notes (memory-plugin compatible) + index records. */
  private writeLessons(agentDir: string, lessons: Array<{ title: string; content: string; tags?: string[] }>): LessonRecord[] {
    const notesDir = path.join(agentDir, "memory", "notes");
    const written: LessonRecord[] = [];
    let existingNotes: Set<string> | null = null;
    for (const lesson of lessons.slice(0, LESSONS_MAX_PER_RUN)) {
      const title = truncate(String(lesson.title ?? "").trim(), 80);
      const content = truncate(String(lesson.content ?? "").trim(), 600);
      if (!title || !content) continue;
      if (!existingNotes) {
        existingNotes = new Set();
        try {
          for (const f of fs.readdirSync(notesDir)) if (f.endsWith(".md")) existingNotes.add(f);
        } catch {
          /* no notes yet */
        }
      }
      const date = new Date().toISOString().slice(0, 10);
      const file = `${date}-${slug(title)}-${uid("", 4)}.md`;
      const tags = ["consolidated", ...(lesson.tags ?? []).map((t) => String(t).trim()).filter(Boolean)].slice(0, 8);
      const body = [
        "---",
        `title: ${title}`,
        `tags: [${tags.join(", ")}]`,
        `created: ${new Date().toISOString()}`,
        "---",
        "",
        redactEventSummary(content),
        "",
      ].join("\n");
      try {
        ensureDir(notesDir);
        fs.writeFileSync(path.join(notesDir, file), body, { mode: 0o600 });
      } catch {
        continue; // never let lesson promotion break the run
      }
      existingNotes.add(file);
      written.push({ t: Date.now(), title, file: path.join("notes", file), tags });
    }
    return written;
  }

  /** Compress the oldest blocks into one era block when the count grows. */
  private async maybeCompressEra(agent: LoadedAgent, blocks: ConsolidatedBlock[]): Promise<number> {
    if (blocks.length <= this.eraThreshold) return 0;
    const candidates = blocks.slice(0, blocks.length - this.eraKeep);
    const span = `${day(candidates[0].fromT)} → ${day(candidates[candidates.length - 1].toT)}`;
    let text: string;
    try {
      text = truncate(redactEventSummary(await this.deps.io.compressEra({ agentId: agent.id, blocks: candidates })), ERA_TEXT_MAX);
    } catch {
      // deterministic fallback — the record is never lost, only less compressed
      text = truncate(
        redactEventSummary(`(fallback era, model unavailable) ${span}\n` + candidates.map((b) => `- [${b.kind}] ${b.text}`).join("\n")),
        ERA_TEXT_MAX
      );
    }
    const era: ConsolidatedBlock = {
      id: uid("b_"),
      kind: "era",
      createdAt: Date.now(),
      from: candidates[0].from,
      to: candidates[candidates.length - 1].to,
      fromT: candidates[0].fromT,
      toT: candidates[candidates.length - 1].toT,
      text,
    };
    blocks.splice(0, candidates.length, era);
    return candidates.length;
  }

  /** Human-readable status for /consolidate status + the dashboard. */
  statusText(agentId: string): string {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) return `unknown agent "${agentId}"`;
    if (agent.manifest.consolidation?.enabled === false) return "consolidation: disabled";
    const dir = agent.dir;
    const state = loadState(dir);
    let pending = 0;
    try {
      const lines = fs.readFileSync(consolidationPaths(dir).events, "utf8").trimEnd().split("\n").filter(Boolean);
      const plan = planEventScan(lines, state.meta);
      pending = plan.pending.length + plan.deferred;
    } catch {
      /* no log */
    }
    const blocks = state.blocks;
    const eras = blocks.filter((b) => b.kind === "era").length;
    const summaries = blocks.filter((b) => b.kind === "summary").length;
    const gaps = blocks.filter((b) => b.kind === "gap").length;
    const lastRun = state.meta.lastRunAt ? ageAgo(state.meta.lastRunAt, Date.now()) : "never";
    return [
      `consolidation: ${blocks.length} block(s) (${eras} eras, ${summaries} summaries, ${gaps} gaps) · ${state.meta.lessons?.length ?? 0} lessons`,
      `cursor at line ${state.meta.offset} · ${pending} events pending · runs: ${state.meta.runs ?? 0} · last: ${lastRun}`,
    ].join("\n");
  }
}

// ─── default LLM-backed IO (cheap-model ephemeral sessions) ─────────────────

const DISTILL_SYSTEM = `You distill a personal agent's raw event log into durable long-term memory.
Given EVENTS, produce one summary block and optionally durable lessons. Call the consolidation_submit tool exactly once.

- The summary block: dense and factual. Recurring topics, preferences, decisions, frictions, outcomes, trajectory. NOT a play-by-play. Third person ("the user …"). Max ~200 words.
- Lessons are single durable facts worth keeping for months: preferences (about the user, their tools, their people), decisions and their reasons, recurring failure patterns and fixes. Concrete and self-contained. Max 4, or zero if nothing is durable. Titles are short note titles; content is 1-2 full sentences.
- Never invent events. Omit trivia and anything credential-like.`;

const ERA_SYSTEM = `You compress old memory blocks of a personal agent into ONE era block. Keep durable facts, decisions, preferences, and patterns; drop process noise and repetition. Write third person, max ~150 words, and mention the time span covered.`;

export function createLlmConsolidationIO(deps: {
  agents: AgentManager;
  modelRuntime: ModelRuntime;
  modelFor: (agent: LoadedAgent) => unknown;
}): DistillIO {
  function sessionError(session: AgentSession): string | null {
    const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; errorMessage?: string }>;
    return [...msgs].reverse().find((m) => m.role === "assistant" && m.errorMessage)?.errorMessage ?? null;
  }

  const ephemeral = async (agent: LoadedAgent, opts: { systemPrompt: string; tools?: ReturnType<typeof defineTool>[] }): Promise<AgentSession> => {
    const loader = new DefaultResourceLoader({
      cwd: agent.dir,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: opts.systemPrompt,
    });
    await loader.reload();
    const session = (
      await createAgentSession({
        cwd: agent.dir,
        agentDir: getAgentDir(),
        modelRuntime: deps.modelRuntime,
        model: deps.modelFor(agent) as unknown as CreateAgentSessionOptions["model"],
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
    async distill({ agentId, events }): Promise<DistillResult> {
      const agent = deps.agents.getAgent(agentId);
      if (!agent) throw new Error(`unknown agent "${agentId}"`);
      let result: DistillResult | null = null;
      const submitTool = defineTool({
        name: "consolidation_submit",
        label: "Consolidation submit",
        description: "Submit the summary block and durable lessons. Call exactly once.",
        parameters: Type.Object({
          summary: Type.String({ description: "Dense factual summary block (third person, ≤200 words)" }),
          lessons: Type.Optional(
            Type.Array(
              Type.Object({
                title: Type.String({ description: "Short note title" }),
                content: Type.String({ description: "1-2 self-contained sentences" }),
                tags: Type.Optional(Type.Array(Type.String(), { description: "Topic tags" })),
              }),
              { maxItems: 4, description: "Durable facts worth keeping for months (may be empty)" }
            )
          ),
        }),
        execute: async (_id, params) => {
          const p = params as { summary: string; lessons?: DistillResult["lessons"] };
          result = { summary: String(p.summary ?? ""), lessons: p.lessons ?? [] };
          return { content: [{ type: "text", text: "logged" }], details: {} };
        },
      });

      const session = await ephemeral(agent, { systemPrompt: DISTILL_SYSTEM, tools: [submitTool] });
      try {
        const body = events
          .map((e) => `- [${new Date(e.t).toISOString().slice(0, 16)} ${e.type}] ${e.summary}`)
          .join("\n");
        const ask = [
          `DISTILL ${events.length} event(s) from the event log of agent "${agentId}".`,
          "",
          "# Events",
          body,
          "",
          "Call consolidation_submit exactly once.",
        ].join("\n");
        await session.prompt(ask);
        const merr = sessionError(session);
        if (merr) throw new Error(merr);
      } finally {
        try {
          session.dispose();
        } catch {
          /* ignore */
        }
      }
      if (!result) throw new Error("model made no consolidation submission (no tool call)");
      const out = result as DistillResult;
      if (!out.summary.trim()) throw new Error("model submitted an empty summary");
      return out;
    },

    async compressEra({ agentId, blocks }): Promise<string> {
      const agent = deps.agents.getAgent(agentId);
      if (!agent) throw new Error(`unknown agent "${agentId}"`);
      const session = await ephemeral(agent, { systemPrompt: ERA_SYSTEM });
      try {
        const body = blocks
          .map((b) => `#### ${b.kind} (${day(b.fromT)} – ${day(b.toT)})\n${b.text}`)
          .join("\n\n");
        await session.prompt([`COMPRESS ${blocks.length} old memory block(s) into one era block.`, "", "# Blocks", body].join("\n"));
        const merr = sessionError(session);
        if (merr) throw new Error(merr);
        const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.role !== "assistant") continue;
          const text = (msgs[i].content ?? []).filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n").trim();
          if (text) return text;
        }
        throw new Error("empty era reply");
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