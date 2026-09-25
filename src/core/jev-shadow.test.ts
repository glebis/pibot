import { describe, expect, it, vi } from "vitest";
import {
  buildJevShadowInput,
  JEV_MAX_STATE_BYTES,
  JEV_RUBRIC_VERSION,
  jevShadowPermitted,
  JevShadowMemoryStore,
  JevShadowObserver,
  redactSensitive,
  type JevShadowPermission,
  type JevShadowRecord,
  type JevShadowSnapshot,
} from "./jev-shadow.js";
import type { evaluateJev } from "./jev-evaluator.js";

const OPEN: JevShadowPermission = { enabled: true, dataScope: "synthetic", providers: ["typesafe-ai"] };

function snapshot(over: Partial<JevShadowSnapshot> = {}): JevShadowSnapshot {
  return {
    runId: "run_1", probeId: "p1", agentId: "assistant", mode: "create",
    candidateHash: "cand_hash", rubricVersion: JEV_RUBRIC_VERSION,
    task: "Summarise the incident", criteria: "States the cause and the fix", candidateReply: "Cause: X. Fix: Y.",
    ...over,
  };
}

function choiceAnswer(choice: string, options: string[]) {
  const probabilities: Record<string, number> = {};
  for (const option of options) probabilities[option] = option === choice ? 1 : 0;
  return { type: "choice" as const, choice, probabilities };
}

describe("Jev shadow permission (flag AND scope AND provider AND key)", () => {
  it("is off by default — a missing policy is a refusal, not consent", () => {
    expect(jevShadowPermitted(undefined, { apiKey: "k" })).toEqual({ ok: false, reason: "flag_off" });
    expect(jevShadowPermitted({}, { apiKey: "k" })).toEqual({ ok: false, reason: "flag_off" });
    expect(jevShadowPermitted({ enabled: false, dataScope: "synthetic", providers: ["typesafe-ai"] }, { apiKey: "k" }))
      .toEqual({ ok: false, reason: "flag_off" });
  });

  it("requires an approved data scope — enabling the flag alone is not enough", () => {
    expect(jevShadowPermitted({ enabled: true, providers: ["typesafe-ai"] }, { apiKey: "k" }))
      .toEqual({ ok: false, reason: "scope_not_permitted" });
  });

  it("requires the provider to be in the agent's permitted scope", () => {
    expect(jevShadowPermitted({ enabled: true, dataScope: "synthetic", providers: ["openai"] }, { apiKey: "k" }))
      .toEqual({ ok: false, reason: "provider_not_permitted" });
  });

  it("requires a key last — scope without credentials is still a refusal", () => {
    const prev = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      expect(jevShadowPermitted(OPEN)).toEqual({ ok: false, reason: "missing_api_key" });
      expect(jevShadowPermitted(OPEN, { apiKey: "  " })).toEqual({ ok: false, reason: "missing_api_key" });
      expect(jevShadowPermitted(OPEN, { apiKey: "key" })).toEqual({ ok: true });
    } finally {
      if (prev === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = prev;
    }
  });
});

describe("Jev shadow snapshot → bounded evaluator input", () => {
  it("carries only the contract fields, framed as untrusted data", () => {
    const built = buildJevShadowInput(snapshot());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const state = built.state as Record<string, unknown>;
    expect(state.kind).toBe("untrusted_probe_data");
    expect(Object.keys(state).sort()).toEqual(["candidate_reply", "flags", "kind", "required_criteria", "run", "task"]);
    expect((state.run as Record<string, unknown>).candidate_hash).toBe("cand_hash");
    expect(built.questions.criteria.type).toBe("choice");
    expect(String((built.questions.criteria as { instructions: string }).instructions)).toMatch(/untrusted DATA/i);
    // no pairwise question without a verified baseline
    expect(built.questions.pairwise).toBeUndefined();
    expect((state.flags as Record<string, unknown>).baseline_reply_unavailable).toBe(true);
  });

  it("asks the pairwise question only when a baseline reply exists", () => {
    const built = buildJevShadowInput(snapshot({ baselineReply: "Cause: X.", baselineHash: "base_hash" }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.questions.pairwise?.type).toBe("choice");
    expect(Object.keys((built.questions.pairwise as { criteria: Record<string, string> }).criteria))
      .toEqual(["candidate_better", "baseline_better", "equivalent", "unclear"]);
    expect((built.state as { baseline_reply?: string }).baseline_reply).toBe("Cause: X.");
    expect((built.state as { run: { baseline_hash?: string } }).run.baseline_hash).toBe("base_hash");
  });

  it("offers the four rubric categories and never a 1-5 mapping", () => {
    const built = buildJevShadowInput(snapshot());
    if (!built.ok) throw new Error("expected input");
    const criteria = (built.questions.criteria as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria).sort()).toEqual(["meets", "misses_required", "partial", "unclear"]);
    expect(JSON.stringify(built.questions)).not.toMatch(/score|1-5/i);
  });

  it("redacts known credential shapes before anything leaves", () => {
    const built = buildJevShadowInput(snapshot({
      candidateReply: "used sk-abcdefghijklmnopqrstuvwx and 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw then eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcde",
    }));
    if (!built.ok) throw new Error("expected input");
    const serialized = JSON.stringify(built.state);
    expect(built.redacted).toBe(true);
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(serialized).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(serialized).toContain("[redacted]");
  });

  it("redacts without inventing matches on ordinary text", () => {
    expect(redactSensitive("Cause: X. Fix: Y.")).toEqual({ text: "Cause: X. Fix: Y.", redacted: false });
  });

  it("sheds the optional baseline reply before declaring a case unassessable", () => {
    const built = buildJevShadowInput(snapshot({
      criteria: "c".repeat(8_000),
      task: "t".repeat(2_000),
      candidateReply: "r".repeat(4_000),
      baselineReply: "b".repeat(4_000),
    }));
    if (!built.ok) throw new Error("expected input after shedding the baseline");
    expect(built.questions.pairwise).toBeUndefined();
    expect((built.state as { flags: Record<string, unknown> }).flags.baseline_reply_unavailable).toBe(true);
  });

  it("refuses an input that cannot fit the evaluator's state limit without hiding a criterion", () => {
    const built = buildJevShadowInput(snapshot({ task: "t".repeat(20_000), criteria: "c".repeat(20_000) }));
    expect(built).toMatchObject({ ok: false, reason: "state_too_large" });
    expect(JEV_MAX_STATE_BYTES).toBe(16_384);
  });

  it("treats a snapshot with no task, criteria or reply as invalid rather than sending it", () => {
    expect(buildJevShadowInput(snapshot({ candidateReply: "   " }))).toMatchObject({ ok: false, reason: "invalid_snapshot" });
  });
});

describe("Jev shadow observer (bounded, silent, non-authoritative)", () => {
  function observer(over: Partial<ConstructorParameters<typeof JevShadowObserver>[0]> = {}) {
    const records: JevShadowRecord[] = [];
    const evaluate = vi.fn(async () => ({
      ok: true as const,
      elapsedMs: 12,
      answers: {
        criteria: choiceAnswer("meets", ["meets", "partial", "misses_required", "unclear"]),
      },
    })) as unknown as typeof evaluateJev & ReturnType<typeof vi.fn>;
    const obs = new JevShadowObserver({ evaluate, apiKey: "test-key", onRecord: (r) => records.push(r), store: new JevShadowMemoryStore(), ...over });
    return { obs, evaluate, records };
  }

  it("does not call the evaluator at all when the agent's flag is off", async () => {
    const { obs, evaluate, records } = observer();
    obs.observe(snapshot(), { enabled: false, dataScope: "synthetic", providers: ["typesafe-ai"] });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(evaluate).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ jevResult: "not_permitted", jevReason: "flag_off" });
  });

  it("records the current judge's score and parse status without touching either", async () => {
    const { obs, evaluate, records } = observer();
    obs.observe(snapshot(), OPEN, { score: 3, parse: "fallback" });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ oldScore: 3, oldParse: "fallback", jevResult: "evaluated", jevCriteria: "meets", rubricVersion: JEV_RUBRIC_VERSION });
    // the score it was told about is reported back unchanged
    expect(records[0]!.oldScore).toBe(3);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("keeps prompts, criteria and replies out of the metadata record", async () => {
    const { obs, records } = observer();
    obs.observe(snapshot({ criteria: "SECRET-CRITERIA", candidateReply: "SECRET-REPLY" }), OPEN);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("SECRET-CRITERIA");
    expect(serialized).not.toContain("SECRET-REPLY");
    expect(Object.keys(records[0]!).sort()).toEqual([
      "agentId", "baselineHash", "candidateHash", "elapsedMs", "jevCriteria", "jevPairwise", "jevResult", "oldParse", "oldScore", "probeId", "rubricVersion", "runId", "ts",
    ].filter((k) => k in records[0]!).sort());
  });

  it("asks the pairwise question when a baseline reply is present", async () => {
    const evaluate = vi.fn(async () => ({
      ok: true as const,
      elapsedMs: 20,
      answers: {
        criteria: choiceAnswer("partial", ["meets", "partial", "misses_required", "unclear"]),
        pairwise: choiceAnswer("candidate_better", ["candidate_better", "baseline_better", "equivalent", "unclear"]),
      },
    })) as unknown as typeof evaluateJev & ReturnType<typeof vi.fn>;
    const records: JevShadowRecord[] = [];
    const obs = new JevShadowObserver({ evaluate, apiKey: "k", onRecord: (r) => records.push(r) });
    obs.observe(snapshot({ baselineReply: "Cause: X.", baselineHash: "h" }), OPEN);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ jevCriteria: "partial", jevPairwise: "candidate_better" });
    const sent = (evaluate.mock.calls[0]![0] as { questions: Record<string, unknown>; timeoutMs?: number });
    expect(Object.keys(sent.questions)).toEqual(["criteria", "pairwise"]);
    expect(sent.timeoutMs).toBe(4_000);
  });

  it("turns an evaluator failure into a typed record, never a throw", async () => {
    const evaluate = vi.fn(async () => ({ ok: false as const, reason: "timeout" as const, elapsedMs: 4_000 }));
    const records: JevShadowRecord[] = [];
    const obs = new JevShadowObserver({ evaluate: evaluate as unknown as typeof evaluateJev, apiKey: "k", onRecord: (r) => records.push(r) });
    obs.observe(snapshot(), OPEN);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ jevResult: "failed", jevReason: "timeout" });
  });

  it("swallows a thrown evaluator (rejection is a missing observation, not an incident)", async () => {
    const evaluate = vi.fn(async () => {
      throw new Error("provider denial");
    });
    const records: JevShadowRecord[] = [];
    const obs = new JevShadowObserver({ evaluate: evaluate as unknown as typeof evaluateJev, apiKey: "k", onRecord: (r) => records.push(r) });
    expect(() => obs.observe(snapshot(), OPEN)).not.toThrow();
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ jevResult: "failed" });
  });

  it("records an unassessable case instead of sending an oversize snapshot", async () => {
    const { obs, evaluate, records } = observer();
    obs.observe(snapshot({ task: "t".repeat(20_000), criteria: "c".repeat(20_000) }), OPEN);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ jevResult: "unassessable", jevReason: "state_too_large" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("drops excess work instead of growing the queue, and says so", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const evaluate = vi.fn(async () => {
      await gate;
      return { ok: true as const, elapsedMs: 1, answers: { criteria: choiceAnswer("meets", ["meets", "partial", "misses_required", "unclear"]) } };
    });
    const records: JevShadowRecord[] = [];
    const obs = new JevShadowObserver({ evaluate: evaluate as unknown as typeof evaluateJev, apiKey: "k", maxQueue: 1, onRecord: (r) => records.push(r) });
    obs.observe(snapshot({ probeId: "p1" }), OPEN);
    obs.observe(snapshot({ probeId: "p2" }), OPEN);
    obs.observe(snapshot({ probeId: "p3" }), OPEN);
    expect(obs.droppedCount()).toBe(1); // one running + one waiting is the bound
    expect(obs.pending()).toBeLessThanOrEqual(1);
    release?.();
    await vi.waitFor(() => expect(records.some((r) => r.jevReason === "queue_full")).toBe(true));
  });

  it("enforces the per-agent daily budget", async () => {
    const { obs, evaluate, records } = observer({ maxPerDay: 1 });
    obs.observe(snapshot({ probeId: "p1" }), OPEN);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    obs.observe(snapshot({ probeId: "p2" }), OPEN);
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(records[1]).toMatchObject({ jevResult: "not_permitted", jevReason: "budget_exhausted" });
  });

  it("records what the authoritative path did, without being able to change it", async () => {
    const { obs, records } = observer();
    obs.observe(snapshot(), OPEN, { score: 5, parse: "parsed" });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    obs.noteDecision("run_1", "p1", "promoted");
    expect(records[0]!.decision).toBe("promoted");
    expect(records[0]!.oldScore).toBe(5);
  });
});
