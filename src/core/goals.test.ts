import { describe, expect, it } from "vitest";
import {
  advanceGoal, buildJudgePrompt, GOAL_MAX_PARSE_FAILURES, GOAL_MAX_TURNS_DEFAULT, goalCard, hasContract, newGoal,
  parseGoalVerdict, renderGoalBlock, renderGoalStatus, shouldContinue, withMethodBlocker,
} from "./goals.js";
import { validateGoalMethods, type GoalMethodBlocker, type MethodProbe } from "./method-resolution.js";

const state = (over = {}) => ({ ...newGoal("research three agent memory systems", { now: 1_000 }), ...over });
const verdict = (v: "done" | "continue" | "wait", reason = "because") => ({ verdict: v, reason });

const probe = (over: Partial<MethodProbe> = {}): MethodProbe => ({ which: () => null, docs: () => [], ...over });
const blockerFor = (objective: string, over: Partial<MethodProbe> = {}): GoalMethodBlocker => {
  const resolution = validateGoalMethods(objective, undefined, probe(over));
  if (resolution.status !== "blocked") throw new Error("expected a blocked method");
  return resolution.blocker;
};

describe("goal state", () => {
  it("starts active, unspent, contracts empty", () => {
    const g = newGoal("do the thing", { now: 5 });
    expect(g).toMatchObject({ status: "active", turnsUsed: 0, maxTurns: GOAL_MAX_TURNS_DEFAULT, parseFailures: 0, subgoals: [], createdAt: 5 });
    expect(GOAL_MAX_TURNS_DEFAULT).toBe(8);
    expect(hasContract(g)).toBe(false);
  });

  it("clamps an absurd turn budget instead of trusting it", () => {
    expect(newGoal("x", { maxTurns: 999 }).maxTurns).toBe(50);
    expect(newGoal("x", { maxTurns: 0 }).maxTurns).toBe(1);
  });
});

describe("prompt blocks", () => {
  it("carries the objective, contract, criteria and progress", () => {
    const g = state({
      contract: { outcome: "a written comparison", verification: "three sources named", constraints: "no new deps" },
      subgoals: ["include pricing"],
    });
    const block = renderGoalBlock(g);
    expect(block).toMatch(/^\[goal\] research three/);
    expect(block).toContain("turn 1 of 8");
    expect(block).toContain("outcome: a written comparison");
    expect(block).toContain("include pricing");
    expect(block).toMatch(/say so explicitly/i);
  });

  it("status is readable when set, and instructive when not", () => {
    expect(renderGoalStatus(undefined)).toMatch(/No goal set/);
    expect(renderGoalStatus(state({ status: "active" }))).toMatch(/🎯 \*\*active\*\* — research three/);
  });

  it("the judge prompt states the verdicts and demands one JSON line", () => {
    const p = buildJudgePrompt(state({ contract: { outcome: "three sources" } }), "I finished everything.");
    expect(p).toContain("three sources");
    expect(p).toContain("THE AGENT'S LAST REPLY:");
    expect(p).toMatch(/continue — /);
    expect(p).toMatch(/ONE line of JSON only/);
  });
});

describe("verdict parsing tolerates a mumbling judge", () => {
  it("reads a clean verdict", () => {
    expect(parseGoalVerdict('{"verdict":"done","reason":"all three compared"}')).toEqual({ verdict: "done", reason: "all three compared" });
  });

  it("reads one wrapped in prose or a code fence", () => {
    expect(parseGoalVerdict('Sure!\n```json\n{"verdict":"continue","reason":"next: pricing"}\n```')).toEqual({ verdict: "continue", reason: "next: pricing" });
  });

  it("returns null for junk, an unknown verdict, or no JSON", () => {
    expect(parseGoalVerdict("I think it's probably done?")).toBeNull();
    expect(parseGoalVerdict('{"verdict":"maybe","reason":"hm"}')).toBeNull();
    expect(parseGoalVerdict("")).toBeNull();
  });
});

describe("advancing the state", () => {
  it("a done verdict finishes the goal", () => {
    const next = advanceGoal(state(), verdict("done", "compared all three"), 2_000);
    expect(next).toMatchObject({ status: "done", turnsUsed: 1, lastVerdict: "done", parseFailures: 0, lastTurnAt: 2_000 });
  });

  it("continue and wait keep it active", () => {
    expect(advanceGoal(state(), verdict("continue"), 2_000).status).toBe("active");
    expect(advanceGoal(state(), verdict("wait", "needs the owner"), 2_000).status).toBe("active");
  });

  it("auto-pauses after repeated unreadable verdicts instead of burning the budget", () => {
    let g = state();
    for (let i = 0; i < GOAL_MAX_PARSE_FAILURES; i++) g = advanceGoal(g, null, 2_000);
    expect(g.status).toBe("paused");
    expect(g.parseFailures).toBe(GOAL_MAX_PARSE_FAILURES);
    expect(g.lastReason).toMatch(/auto-paused/);
    expect(g.turnsUsed).toBe(GOAL_MAX_PARSE_FAILURES);
  });

  it("a readable verdict clears the failure streak", () => {
    const recovered = advanceGoal(advanceGoal(state(), null, 2_000), verdict("continue"), 3_000);
    expect(recovered.parseFailures).toBe(0);
    expect(recovered.status).toBe("active");
  });
});

describe("when NOT to continue — the bounds are the design", () => {
  it("stops when there is no active goal", () => {
    expect(shouldContinue(undefined)).toEqual({ continue: false, reason: "not_active" });
    expect(shouldContinue(state({ status: "paused" }))).toEqual({ continue: false, reason: "not_active" });
    expect(shouldContinue(state({ status: "done" }))).toEqual({ continue: false, reason: "not_active" });
  });

  it("stops at the turn budget", () => {
    expect(shouldContinue(state({ turnsUsed: 8, maxTurns: 8 }))).toEqual({ continue: false, reason: "budget_exhausted" });
    expect(shouldContinue(state({ turnsUsed: 7, maxTurns: 8 }))).toEqual({ continue: true });
  });

  it("does NOT stop on a newer owner message — steering is ordering, not a veto", () => {
    const g = state({ lastTurnAt: 1_000 });
    expect(shouldContinue(g, { lastOwnerMessageAt: 1_500 })).toEqual({ continue: true });
  });

  it("a fresh goal is not vetoed by the very message that set it", () => {
    const fresh = newGoal("do it", { now: 10_000 });
    expect(shouldContinue(fresh, { lastOwnerMessageAt: 10_000 })).toEqual({ continue: true });
  });

  it("defers while snoozed rather than dying", () => {
    expect(shouldContinue(state(), { snoozed: true })).toEqual({ continue: false, reason: "snoozed" });
  });

  it("does not stack a second auto-turn on the same moment", () => {
    expect(shouldContinue(state(), { lastAutoTurnAt: 10_000, now: 10_500 })).toEqual({ continue: false, reason: "no_new_work" });
  });
});

describe("goalCard — contextual pause/resume buttons", () => {
  it("active goal renders a Pause button", () => {
    const card = goalCard(state({ status: "active" }));
    expect(card?.buttons.map((b) => [b.label, b.action])).toEqual([["⏸ Pause", "goal:pause"]]);
  });

  it("paused goal renders Continue (nudge) + Resume (unpause) buttons", () => {
    const card = goalCard(state({ status: "paused" }));
    expect(card?.buttons.map((b) => [b.label, b.action])).toEqual([
      ["▶️ Continue", "continue"],
      ["▶️ Resume", "goal:resume"],
    ]);
  });

  it("done or absent goals render no card", () => {
    expect(goalCard(state({ status: "done" }))).toBeUndefined();
    expect(goalCard(undefined)).toBeUndefined();
  });
});

describe("unresolved execution method — one blocker, not repeated turns (bd pibot-0xpf.1)", () => {
  it("attaches the blocker and stamps the turn it arrived on", () => {
    const g = withMethodBlocker(state({ turnsUsed: 2 }), blockerFor("implement using cmd acp"));
    expect(g.methodBlocker).toMatchObject({ id: "method:cmd:unknown_method", reason: "unknown_method" });
    expect(g.methodBlockedAt).toBe(2);
  });

  it("treats an identical blocker as a no-op — it must not become a fresh turn", () => {
    const g = withMethodBlocker(state({ turnsUsed: 3 }), blockerFor("implement using cmd acp"));
    expect(withMethodBlocker(g, blockerFor("use cmd acp"))).toBe(g);
    expect(withMethodBlocker(g, blockerFor("implement using cmd acp"))).toBe(g);
  });

  it("replaces a different blocker and re-stamps it", () => {
    const first = withMethodBlocker(state({ turnsUsed: 1 }), blockerFor("implement using cmd acp"));
    const next = withMethodBlocker(first, blockerFor("run pytest"));
    expect(next.methodBlocker?.id).toBe("method:pytest:unknown_method");
    expect(next.methodBlockedAt).toBe(1);
  });

  it("clears the blocker when the owner resolves the method (clarification)", () => {
    const g = withMethodBlocker(state(), blockerFor("implement using cmd acp"));
    expect(withMethodBlocker(g, undefined).methodBlocker).toBeUndefined();
    expect(withMethodBlocker(g, undefined).methodBlockedAt).toBeUndefined();
    const clean = state();
    expect(withMethodBlocker(clean, undefined)).toBe(clean);
  });

  it("stops the loop at the blocker, and resumes once it is cleared", () => {
    const g = withMethodBlocker(state({ turnsUsed: 1, maxTurns: 8 }), blockerFor("implement using cmd acp"));
    expect(shouldContinue(g)).toEqual({ continue: false, reason: "method_blocked" });
    expect(shouldContinue(withMethodBlocker(g, undefined))).toEqual({ continue: true });
  });

  it("preserves independent work: attaching a blocker spends no turn and changes no goal content", () => {
    const base = state({ turnsUsed: 3, contract: { outcome: "a written comparison" }, subgoals: ["include pricing"] });
    const g = withMethodBlocker(base, blockerFor("implement using cmd acp"));
    expect(g.status).toBe("active");
    expect(g.turnsUsed).toBe(3);
    expect(g.objective).toBe(base.objective);
    expect(g.contract).toEqual(base.contract);
    expect(g.subgoals).toEqual(base.subgoals);
  });

  it("carries the blocker into the turn block and the status render", () => {
    const g = withMethodBlocker(state(), blockerFor("implement using cmd acp", {}));
    expect(renderGoalBlock(g)).toContain("blocked method:");
    expect(renderGoalBlock(g)).toMatch(/Do NOT retry/);
    expect(renderGoalBlock(g)).toMatch(/ONE precise question/);
    expect(renderGoalStatus(g)).toContain("method blocked (unknown_method)");
  });

  it("distinguishes a documented-but-missing method from an unknown one", () => {
    const documented = blockerFor("implement using cmd acp", { docs: () => ["/skills/herdr/SKILL.md"] });
    expect(documented.reason).toBe("not_on_path");
    expect(renderGoalStatus(withMethodBlocker(state(), documented))).toContain("method blocked (not_on_path)");
  });

  it("a required-all goal blocks on the missing method even when another tool is installed", () => {
    // "use cmd acp and run pytest" — pytest resolves, cmd does not: one blocker on cmd, not a pass
    const resolution = validateGoalMethods("use cmd acp and run pytest", undefined, probe({
      which: (c) => (c === "pytest" ? "/usr/bin/pytest" : null),
    }));
    expect(resolution.status).toBe("blocked");
    if (resolution.status !== "blocked") return;
    expect(resolution.blocker.method.command).toBe("cmd");
    const g = withMethodBlocker(state({ turnsUsed: 1 }), resolution.blocker);
    expect(shouldContinue(g)).toEqual({ continue: false, reason: "method_blocked" });
  });

  it("attaches no blocker and the loop continues once the method resolves", () => {
    const resolution = validateGoalMethods("implement using cmd acp", undefined, probe({
      which: () => "/Users/me/.hermes/node/bin/cmd",
    }));
    expect(resolution.status).toBe("resolved");
    const g = state({ turnsUsed: 1 });
    const attached = resolution.status === "blocked" ? withMethodBlocker(g, resolution.blocker) : g;
    expect(attached.methodBlocker).toBeUndefined();
    expect(shouldContinue(attached)).toEqual({ continue: true });
  });

  it("an explicit alternative goal only blocks when every branch is missing", () => {
    const resolved = validateGoalMethods("use cmd acp or run pytest", undefined, probe({
      which: (c) => (c === "pytest" ? "/usr/bin/pytest" : null),
    }));
    expect(resolved.status).toBe("resolved");
    const blocked = validateGoalMethods("use cmd acp or run kubectl", undefined, probe());
    expect(blocked.status).toBe("blocked");
  });
});
