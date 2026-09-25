import { describe, expect, it, vi } from "vitest";
import { buildGoalJudgeState, createCompositeGoalJudge, goalQuestions, jevGoalPermitted, judgeGoalWithJev, JEV_GOAL_MIN_CONFIDENCE } from "./goal-jev.js";
import { newGoal } from "./goals.js";
import type { evaluateJev } from "./jev-evaluator.js";

const goal = (over = {}) => ({
  ...newGoal("compare three memory systems", { now: 1, contract: { outcome: "a comparison", verification: "three sources named" } }),
  ...over,
});
const choice = (c: string, p = 0.9) => ({ type: "choice" as const, choice: c, probabilities: { done: c === "done" ? p : (1 - p) / 3, continue: c === "continue" ? p : (1 - p) / 3, wait: c === "wait" ? p : (1 - p) / 3, unclear: c === "unclear" ? p : (1 - p) / 3 } });
const bool = (p: number) => ({ type: "boolean" as const, probability: p });
const ok = (answers: Record<string, unknown>) =>
  vi.fn(async () => ({ ok: true as const, elapsedMs: 9, answers })) as unknown as typeof evaluateJev;
const evalFail = (reason: string) =>
  vi.fn(async () => ({ ok: false as const, reason: reason as never, elapsedMs: 5 })) as unknown as typeof evaluateJev;

describe("what we send Jev", () => {
  it("frames the goal and reply as untrusted data and bounds them", () => {
    const state = buildGoalJudgeState(goal(), "I did the thing");
    expect(state.kind).toBe("untrusted_goal_data");
    expect(state.untrustedLastReply).toBe("I did the thing");
    expect((state.contract as Record<string, string>).verification).toBe("three sources named");
    expect(JSON.stringify(state).length).toBeLessThan(16_384);
  });

  it("redacts credentials before anything leaves", () => {
    const state = buildGoalJudgeState(goal({ objective: "use sk-abcdefghijklmnopqrstuvwx to connect" }), "ok");
    expect(JSON.stringify(state)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("asks a typed verdict plus the two booleans that make the contract load-bearing", () => {
    const q = goalQuestions(goal());
    expect(Object.keys(q)).toEqual(["verdict", "verification_met", "blocked_external"]);
    expect((q.verdict as { criteria: Record<string, string> }).criteria).toMatchObject({ done: expect.any(String), wait: expect.any(String) });
    expect(q.verification_met.type).toBe("boolean");
  });
});

describe("the optional, configurable switch", () => {
  const ask = { enabled: true, apiKey: "k" };
  it("is off unless the agent asked for it — local stays the default", () => {
    expect(jevGoalPermitted(undefined, ask)).toEqual({ ok: false, reason: "not_configured" });
    expect(jevGoalPermitted({ judge: "local" }, ask)).toEqual({ ok: false, reason: "not_configured" });
  });
  it("needs the daemon switch, a scope, the provider and a key", () => {
    expect(jevGoalPermitted({ judge: "jev" }, { enabled: false, apiKey: "k" })).toEqual({ ok: false, reason: "flag_off" });
    expect(jevGoalPermitted({ judge: "jev", providers: ["typesafe-ai"] }, ask)).toEqual({ ok: false, reason: "scope_not_permitted" });
    expect(jevGoalPermitted({ judge: "jev", dataScope: "synthetic", providers: ["openai"] }, ask)).toEqual({ ok: false, reason: "provider_not_permitted" });
    expect(jevGoalPermitted({ judge: "jev", dataScope: "synthetic", providers: ["typesafe-ai"] }, { enabled: true })).toEqual({ ok: false, reason: "missing_key" });
    expect(jevGoalPermitted({ judge: "jev", dataScope: "synthetic", providers: ["typesafe-ai"] }, ask)).toEqual({ ok: true });
  });
});

describe("evidence over assertion", () => {
  it("takes a confident done", async () => {
    const r = await judgeGoalWithJev(goal(), "three sources compared", { evaluate: ok({ verdict: choice("done", 0.95), verification_met: bool(0.9), blocked_external: bool(0.1) }) });
    expect(r).toMatchObject({ ok: true, verdict: "done" });
  });

  it("downgrades a done whose verification is NOT visible in the reply", async () => {
    const r = await judgeGoalWithJev(goal(), "I'll compare them next", { evaluate: ok({ verdict: choice("done", 0.95), verification_met: bool(0.2), blocked_external: bool(0.1) }) });
    expect(r).toMatchObject({ ok: true, verdict: "continue" });
    if (r.ok) expect(r.reason).toMatch(/verification not visible/i);
  });

  it("refuses to finish a goal on a coin flip (low confidence is not a verdict)", async () => {
    const r = await judgeGoalWithJev(goal(), "maybe done?", { evaluate: ok({ verdict: choice("done", JEV_GOAL_MIN_CONFIDENCE - 0.2), verification_met: bool(0.9), blocked_external: bool(0.1) }) });
    expect(r).toEqual({ ok: false, reason: "low_confidence" });
  });

  it("turns a strong external block into wait, even when Jev said continue", async () => {
    const r = await judgeGoalWithJev(goal(), "waiting for you to approve", { evaluate: ok({ verdict: choice("continue", 0.8), verification_met: bool(0.2), blocked_external: bool(0.9) }) });
    expect(r).toMatchObject({ ok: true, verdict: "wait" });
  });

  it("reports typed failures so the caller can choose a policy per cause", async () => {
    for (const reason of ["timeout", "invalid_response", "http_error", "network_error"]) {
      expect(await judgeGoalWithJev(goal(), "x", { evaluate: evalFail(reason) })).toEqual({ ok: false, reason });
    }
    const unclear = await judgeGoalWithJev(goal(), "x", { evaluate: ok({ verdict: choice("unclear", 0.9), verification_met: bool(0.5), blocked_external: bool(0.5) }) });
    expect(unclear).toEqual({ ok: false, reason: "unclear" });
  });

  it("bounds every field, so even hostile input still fits the evaluator's state limit", async () => {
    const huge = goal({ contract: { outcome: "x".repeat(4_000), verification: "y".repeat(4_000) }, subgoals: Array.from({ length: 20 }, () => "z".repeat(200)) });
    const sentStates: Array<{ state: unknown }> = [];
    const evaluate = (async (input: { state: unknown }) => {
      sentStates.push(input);
      return { ok: true as const, elapsedMs: 1, answers: { verdict: choice("continue", 0.9), verification_met: bool(0.2), blocked_external: bool(0.1) } };
    }) as unknown as typeof evaluateJev;
    const r = await judgeGoalWithJev(huge, "r".repeat(20_000), { evaluate });
    expect(r.ok).toBe(true);
    const sent = sentStates[0]!.state;
    expect(Buffer.byteLength(JSON.stringify(sent), "utf8")).toBeLessThan(16_384);
    // the reply is bounded, not dropped
    expect(String((sent as { untrustedLastReply: string }).untrustedLastReply).length).toBeLessThanOrEqual(1_500);
  });

  it("propagates the client's own typed oversize failure rather than inventing one", async () => {
    const r = await judgeGoalWithJev(goal(), "x", { evaluate: evalFail("state_too_large") });
    expect(r).toEqual({ ok: false, reason: "state_too_large" });
  });
});

describe("the composite: optional, configurable, and never silently unjudged", () => {
  const local = vi.fn(async () => ({ verdict: "continue" as const, reason: "local says so" }));
  const jevOk = vi.fn(async () => ({ ok: true as const, verdict: "done" as const, reason: "jev reason", confidence: 0.9 }));
  const grant = { judge: "jev" as const, dataScope: "redacted_approved" as const, providers: ["typesafe-ai"] };
  const build = (over = {}) => createCompositeGoalJudge({ local, enabled: true, apiKey: "k", judgeJev: jevOk as never, ...over });

  it("uses the local judge when the agent has not opted in — no external call at all", async () => {
    jevOk.mockClear();
    local.mockClear();
    const composite = build();
    const r = await composite.judge(goal(), "x", { permission: { judge: "local" } });
    expect(r).toMatchObject({ verdict: "continue" });
    expect(jevOk).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalled();
  });

  it("uses the local judge when the agent opted in but the daemon switch is off", async () => {
    const logs: string[] = [];
    const composite = build({ enabled: false });
    await composite.judge(goal(), "x", { permission: grant, log: (s: string) => logs.push(s) });
    expect(jevOk).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/flag_off/);
  });

  it("uses Jev when both switches agree, and says so in one line", async () => {
    const logs: string[] = [];
    const composite = build();
    const r = await composite.judge(goal(), "x", { permission: grant, log: (s: string) => logs.push(s) });
    expect(r).toEqual({ verdict: "done", reason: "jev: jev reason" });
    expect(logs.join(" ")).toMatch(/jev done \(0\.90\)/);
  });

  it("falls back to local on every typed Jev failure, naming the cause", async () => {
    for (const reason of ["timeout", "http_error", "state_too_large", "unclear", "low_confidence"]) {
      const logs: string[] = [];
      const composite = build({ judgeJev: (async () => ({ ok: false, reason })) as never });
      const r = await composite.judge(goal(), "x", { permission: grant, log: (s: string) => logs.push(s) });
      expect(r, reason).toMatchObject({ verdict: "continue" });
      expect(logs.join(" "), reason).toContain(reason);
    }
  });

  it("falls back rather than throwing when the judge itself explodes", async () => {
    const logs: string[] = [];
    const composite = build({ judgeJev: (async () => { throw new Error("boom"); }) as never });
    const r = await composite.judge(goal(), "x", { permission: grant, log: (s: string) => logs.push(s) });
    expect(r).toMatchObject({ verdict: "continue" });
    expect(logs.join(" ")).toMatch(/network_error/);
  });
});
