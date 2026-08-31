import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { ConsolidationEngine, consolidationPaths, MAX_EVENTS_PER_RUN, planEventScan, readConsolidatedDigest, renderConsolidatedMarkdown, type ConsolidatedBlock, type ConsolidationState, type DistillIO, type EventScanPlan, type CursorMeta } from "./consolidation.js";
import { EventLog } from "./events.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-consol-"));
}

// ─── planEventScan (pure cursor + rotation) ─────────────────────────────────

describe("planEventScan", () => {
  function lines(n: number, t0 = 1000): string[] {
    return Array.from({ length: n }, (_, i) => JSON.stringify({ t: t0 + i * 1000, type: "system", summary: `event ${i}` }));
  }

  it("consumes everything from scratch on the first run", () => {
    const plan = planEventScan(lines(5), { offset: 0, lastT: 0 });
    expect(plan.pending.length).toBe(5);
    expect(plan.rotation).toBeNull();
    expect(plan.offsetAfter).toBe(5);
    expect(plan.lastTAfter).toBe(5000);
  });

  it("advances positionally when the log only grows", () => {
    const plan = planEventScan(lines(10), { offset: 3, lastT: 3000 });
    expect(plan.pending.length).toBe(7);
    expect(plan.pending[0].summary).toBe("event 3");
    expect(plan.offsetAfter).toBe(10);
    expect(plan.rotation).toBeNull();
  });

  it("caps the batch and defers the rest", () => {
    const plan = planEventScan(lines(10), { offset: 0, lastT: 0 }, { maxEvents: 4 });
    expect(plan.pending.length).toBe(4);
    expect(plan.deferred).toBe(6);
    expect(plan.offsetAfter).toBe(4);
  });

  it("returns an empty plan when nothing is new", () => {
    const plan = planEventScan(lines(5), { offset: 5, lastT: 5000 });
    expect(plan.pending.length).toBe(0);
    expect(plan.rotation).toBeNull();
    expect(plan.offsetAfter).toBe(5);
    expect(plan.lastTAfter).toBe(5000);
  });

  it("detects rotation when the file shrank and reconciles by timestamp", () => {
    // consumed 10 lines; the log was rotated down to 5 leftovers + 2 new
    const raw = [...lines(5, 1000), ...lines(2, 10_000)];
    const plan = planEventScan(raw, { offset: 10, lastT: 5000 });
    expect(plan.rotation).not.toBeNull();
    expect(plan.rotation!.skipped).toBe(5);
    expect(plan.rotation!.pending).toBe(2);
    expect(plan.pending.length).toBe(2);
    expect(plan.pending[0].t).toBe(10_000);
    expect(plan.offsetAfter).toBe(7);
    expect(plan.lastTAfter).toBe(11_000);
  });

  it("records a rotation even when nothing fresh remains", () => {
    const raw = lines(4, 1000); // all already consumed
    const plan = planEventScan(raw, { offset: 10, lastT: 5000 });
    expect(plan.rotation).not.toBeNull();
    expect(plan.pending.length).toBe(0);
    expect(plan.offsetAfter).toBe(4);
    expect(plan.lastTAfter).toBe(5000);
  });

  it("skips unparsable lines without corrupting the cursor", () => {
    const raw = [lines(2)[0], "not json", lines(3, 9000)[0]];
    const plan = planEventScan(raw, { offset: 0, lastT: 0 });
    expect(plan.pending.length).toBe(2);
    expect(plan.offsetAfter).toBe(3);
  });

  it("detects head-trim when leftovers re-grow past the old offset (positional cursor lies)", () => {
    // the file was rotated down to a short tail and then grew again — line 0 is
    // an already-consumed leftover, lines 1–3 are genuinely new but sit BEFORE
    // the recorded offset: only the timestamp filter can rescue them
    const raw = [...lines(1, 1000), ...lines(3, 30_000)];
    const plan = planEventScan(raw, { offset: 3, lastT: 5000 });
    expect(plan.rotation).not.toBeNull();
    expect(plan.rotation!.skipped).toBe(1);
    expect(plan.pending.map((e) => e.t)).toEqual([30_000, 31_000, 32_000]);
  });

  it("detects a stale boundary line when the byte position lands mid-old-tail", () => {
    const raw = [...lines(6, 5000), ...lines(2, 35_000)];
    const plan = planEventScan(raw, { offset: 3, lastT: 20_000 });
    expect(plan.rotation).not.toBeNull();
    expect(plan.pending.map((e) => e.t)).toEqual([35_000, 36_000]);
    expect(plan.offsetAfter).toBe(8);
  });

  it("consumes positionally when the log stayed consistent (no false rotation)", () => {
    const raw = [...lines(10, 500), ...lines(3, 20_000)];
    const plan = planEventScan(raw, { offset: 10, lastT: 10_000 });
    expect(plan.rotation).toBeNull();
    expect(plan.pending.map((e) => e.t)).toEqual([20_000, 21_000, 22_000]);
  });
});

// ─── renderConsolidatedMarkdown ─────────────────────────────────────────────

describe("renderConsolidatedMarkdown", () => {
  const base = 1_700_000_000_000;
  const block = (over: Partial<ConsolidationState["blocks"][number]> = {}) => ({
    id: "b_1",
    kind: "summary" as const,
    createdAt: base,
    from: 0,
    to: 10,
    fromT: base,
    toT: base + 3600e3,
    text: "did things",
    ...over,
  });

  it("renders eras, blocks and the lessons index oldest-first", () => {
    const state: ConsolidationState = {
      meta: { offset: 40, lastT: base + 7200e3, lessons: [{ t: base, title: "Anna prefers voice notes", file: "notes/x.md", tags: ["consolidated", "people"] }] },
      blocks: [
        block({ kind: "era", from: 0, to: 30, text: "the early era" }),
        block({ kind: "gap", from: 30, to: 31, text: "rotation lost some" }),
        block({ from: 31, to: 40, text: "recent summary" }),
      ],
    };
    const md = renderConsolidatedMarkdown(state);
    expect(md).toContain("# Consolidated memory");
    expect(md.indexOf("## Eras")).toBeLessThan(md.indexOf("## Blocks"));
    expect(md).toContain("the early era");
    expect(md).toContain("⚠︎ gap (events 30–31");
    expect(md).toContain("recent summary");
    expect(md).toContain("[Anna prefers voice notes](../notes/x.md)");
    expect(md).toContain("#consolidated");
  });

  it("renders an empty state without crashing", () => {
    const md = renderConsolidatedMarkdown({ meta: { offset: 0, lastT: 0 }, blocks: [] });
    expect(md).toContain("nothing consolidated yet");
  });
});

// ─── ConsolidationEngine ────────────────────────────────────────────────────

describe("ConsolidationEngine", () => {
  let dir: string;
  let agents: AgentManager;
  let events: EventLog;
  let io: DistillIO;
  let engine: import("./consolidation.js").ConsolidationEngine;

  let distillSummary: string;
  let distillLessons: Array<{ title: string; content: string; tags?: string[] }>;
  let eraText: string;
  let distillError: Error | null;
  let eraError: Error | null;

  beforeEach(() => {
    dir = tmpDir();
    agents = new AgentManager(dir, { getModels: () => [] } as never);
    agents.createAgent("assistant");
    events = new EventLog(dir);
    distillSummary = "The user set up beads and is building pibot incrementally.";
    distillLessons = [{ title: "prefers terse replies", content: "The user prefers terse replies with bullet points.", tags: ["style"] }];
    eraText = "Early era: setup and early development.";
    distillError = null;
    eraError = null;
    io = {
      distill: vi.fn(async () => {
        if (distillError) throw distillError;
        return { summary: distillSummary, lessons: distillLessons };
      }),
      compressEra: vi.fn(async () => {
        if (eraError) throw eraError;
        return eraText;
      }),
    };
    engine = new ConsolidationEngine({ agents: agents as never, events, io });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function eventsFile(): string {
    return consolidationPaths(path.join(dir, "assistant")).events;
  }

  /** Write a synthetic events file (ensures the state/ dir exists). */
  function writeEventsFile(lines: string[]): void {
    fs.mkdirSync(path.dirname(eventsFile()), { recursive: true });
    fs.writeFileSync(eventsFile(), lines.join("\n") + "\n");
  }

  function readState(): ConsolidationState {
    const file = consolidationPaths(path.join(dir, "assistant")).blocks;
    if (!fs.existsSync(file)) return { meta: { offset: 0, lastT: 0 }, blocks: [] };
    return JSON.parse(fs.readFileSync(file, "utf8")) as ConsolidationState;
  }

  it("consumes events into a summary block, advances the cursor, and writes md + journal", async () => {
    events.log("assistant", "message", "first event");
    events.log("assistant", "system", "second event");
    const report = await engine.consolidate("assistant");
    expect(report.ok).toBe(true);
    expect(report.consumed).toBe(2);

    const state = readState();
    expect(state.meta.offset).toBe(2);
    expect(state.blocks.length).toBe(1);
    expect(state.blocks[0].kind).toBe("summary");
    expect(state.blocks[0].text).toContain("beads");
    expect(fs.existsSync(consolidationPaths(path.join(dir, "assistant")).markdown)).toBe(true);
    const journal = fs.readFileSync(consolidationPaths(path.join(dir, "assistant")).journal, "utf8").trim().split("\n");
    expect(journal.length).toBe(1);
    expect(JSON.parse(journal[0]).consumed).toBe(2);
    // consolidation must not write itself back into the event log (pending loop)
    expect(events.tail("assistant").some((e) => e.summary.includes("consolidation:"))).toBe(false);
  });

  it("scales to a single event without pluralization lies", async () => {
    events.log("assistant", "system", "one only");
    const report = await engine.consolidate("assistant");
    expect(report.summary).toContain("1 event →");
    expect(report.summary).not.toContain("events →");
  });

  it("promotes lessons into memory notes with an index", async () => {
    events.log("assistant", "system", "make a lesson");
    await engine.consolidate("assistant");
    const state = readState();
    expect(state.meta.lessons?.length).toBe(1);
    const lesson = state.meta.lessons![0];
    const lessonFile = path.join(dir, "assistant", "memory", lesson.file);
    expect(fs.existsSync(lessonFile)).toBe(true);
    const raw = fs.readFileSync(lessonFile, "utf8");
    expect(raw).toContain("title: prefers terse replies");
    expect(raw).toContain("tags: [consolidated, style]");
    expect(fs.readFileSync(consolidationPaths(path.join(dir, "assistant")).markdown, "utf8")).toContain("prefers terse replies");
  });

  it("is a no-op when there is nothing new", async () => {
    const report = await engine.consolidate("assistant");
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("no new events");
    expect(io.distill).not.toHaveBeenCalled();
    expect(fs.existsSync(consolidationPaths(path.join(dir, "assistant")).blocks)).toBe(false);

    events.log("assistant", "system", "something");
    await engine.consolidate("assistant");
    const again = await engine.consolidate("assistant");
    expect(again.summary).toContain("no new events");
    expect((io.distill as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(readState().blocks.length).toBe(1);
  });

  it("does not advance the cursor when the model fails", async () => {
    events.log("assistant", "system", "event one");
    events.log("assistant", "system", "event two");
    distillError = new Error("model down");
    const report = await engine.consolidate("assistant");
    expect(report.ok).toBe(false);
    const state = readState();
    expect(state.meta.offset).toBe(0);
    expect(state.blocks.length).toBe(0);
    // and it retries successfully later — consuming the 2 original events plus
    // the failure notice the engine logged (failures are part of the record)
    distillError = null;
    const retry = await engine.consolidate("assistant");
    expect(retry.ok).toBe(true);
    expect(retry.consumed).toBe(3);
    expect(readState().blocks.filter((b) => b.kind === "summary").length).toBe(1);
  });

  it("defers events beyond the batch cap and consumes them next run", async () => {
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 3; i++) events.log("assistant", "system", `evt ${i}`);
    const first = await engine.consolidate("assistant");
    expect(first.consumed).toBe(MAX_EVENTS_PER_RUN);
    expect(first.deferred).toBe(3);
    const second = await engine.consolidate("assistant");
    expect(second.consumed).toBe(3);
    expect(readState().blocks.filter((b) => b.kind === "summary").length).toBe(2);
  });

  it("respects manifest gating: enabled=false skips without consuming", async () => {
    fs.writeFileSync(path.join(dir, "assistant", "agent.json"), JSON.stringify({ name: "assistant", consolidation: { enabled: false } }));
    await agents.discover(); // reload manifests from disk
    events.log("assistant", "system", "ignored");
    const report = await engine.consolidate("assistant");
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("disabled");
    expect(io.distill).not.toHaveBeenCalled();
    expect(fs.existsSync(consolidationPaths(path.join(dir, "assistant")).blocks)).toBe(false);
  });

  it("records a durable gap block when the event log rotated", async () => {
    events.log("assistant", "system", "old event");
    await engine.consolidate("assistant"); // offset → 1
    expect(readState().meta.offset).toBe(1);

    // simulate rotation: head trimmed, only fresh lines remain
    const t = Date.now() + 5000;
    writeEventsFile([JSON.stringify({ t, type: "system", summary: "brand new" })]);
    const report = await engine.consolidate("assistant");
    expect(report.gap).toBe(true);

    const state = readState();
    const gap = state.blocks.find((b) => b.kind === "gap")!;
    expect(gap).toBeTruthy();
    expect(gap.text).toContain("rotation");
    expect(gap.text).toContain("recorded, not silent");
    expect(state.blocks.some((b) => b.kind === "summary")).toBe(true);
    expect(state.meta.offset).toBe(1);

    // next run is clean — rotation must not replay
    const again = await engine.consolidate("assistant");
    expect(again.summary).toContain("no new events");
    const kinds = readState().blocks.map((b) => b.kind);
    expect(kinds).toEqual(["summary", "gap", "summary"]);
  });

  it("compresses old blocks into an era once the threshold is exceeded", async () => {
    // pre-seed 24 blocks
    const blocksFile = consolidationPaths(path.join(dir, "assistant")).blocks;
    fs.mkdirSync(path.dirname(blocksFile), { recursive: true });
    const state = readState();
    state.blocks = Array.from({ length: 24 }, (_, i) => ({
      id: `b_${i}`,
      kind: "summary" as const,
      createdAt: Date.now(),
      from: i,
      to: i + 1,
      fromT: Date.now() - (24 - i) * 60_000,
      toT: Date.now(),
      text: `block ${i} says something durable`,
    }));
    fs.writeFileSync(blocksFile, JSON.stringify(state));
    writeEventsFile([JSON.stringify({ t: Date.now(), type: "system", summary: "fresh" })]);

    const report = await engine.consolidate("assistant");
    expect(report.eraCompressed).toBe(13); // 25 blocks → oldest 13 merged (keep 12)
    const after = readState();
    expect(after.blocks.length).toBe(13); // 12 kept + 1 era
    expect(after.blocks[0].kind).toBe("era");
    expect(after.blocks[0].text).toBe("Early era: setup and early development.");
  });

  it("falls back to deterministic era text when the model fails", async () => {
    const blocksFile = consolidationPaths(path.join(dir, "assistant")).blocks;
    fs.mkdirSync(path.dirname(blocksFile), { recursive: true });
    const state = readState();
    state.blocks = Array.from({ length: 24 }, (_, i) => ({
      id: `b_${i}`,
      kind: "summary" as const,
      createdAt: Date.now(),
      from: i,
      to: i + 1,
      fromT: Date.now(),
      toT: Date.now(),
      text: `block ${i} content`,
    }));
    fs.writeFileSync(blocksFile, JSON.stringify(state));
    writeEventsFile([JSON.stringify({ t: Date.now(), type: "system", summary: "evt" })]);
    eraError = new Error("no model");
    const report = await engine.consolidate("assistant");
    expect(report.ok).toBe(true);
    const era = readState().blocks[0];
    expect(era.kind).toBe("era");
    expect(era.text).toContain("fallback era");
    expect(era.text).toContain("block 0 content"); // nothing lost
  });

  it("redacts credential-looking text the model echoes back", async () => {
    distillSummary = 'User configured api_key = "sk-super-secret-123" in settings';
    events.log("assistant", "system", "config work");
    await engine.consolidate("assistant");
    expect(readState().blocks.some((b) => b.text.includes("sk-super-secret-123"))).toBe(false);
    // the same for lesson bodies
    distillLessons = [{ title: "tokens", content: "use access_token = sk-leaky-token for tests" }];
    writeEventsFile([JSON.stringify({ t: Date.now() + 5000, type: "system", summary: "more" })]);
    await engine.consolidate("assistant");
    const lesson = readState().meta.lessons!.find((l) => l.title === "tokens")!;
    expect(fs.readFileSync(path.join(dir, "assistant", "memory", lesson.file), "utf8")).not.toContain("sk-leaky-token");
  });

  it("statusText reports blocks, lessons, and pending events", async () => {
    expect(engine.statusText("assistant")).toContain("0 block(s)");
    events.log("assistant", "system", "pending event");
    await engine.consolidate("assistant");
    const status = engine.statusText("assistant");
    expect(status).toContain("1 block(s)");
    expect(status).toContain("1 lesson");
    expect(status).toContain("0 events pending");
    expect(engine.statusText("nope")).toContain("unknown agent");
  });

  it("guards against concurrent runs for the same agent", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    (io.distill as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await gate;
      return { summary: "s", lessons: [] };
    });
    events.log("assistant", "system", "x");
    const p1 = engine.consolidate("assistant");
    const p2 = await engine.consolidate("assistant");
    expect(p2.summary).toContain("already running");
    release();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
  });
});

// ─── EventScanPlan type sanity (structural) ─────────────────────────────────

describe("EventScanPlan structural sanity", () => {
  it("empty lines produce an empty plan", () => {
    const plan: EventScanPlan = planEventScan([], { offset: 0, lastT: 0 } satisfies CursorMeta);
    expect(plan.pending).toEqual([]);
    expect(plan.rotation).toBeNull();
    expect(plan.deferred).toBe(0);
  });
});