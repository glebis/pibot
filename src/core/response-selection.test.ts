import { describe, expect, it, vi } from "vitest";
import { createJevResponseJudge, DEFAULT_RESPONSE_SELECTION_POLICY, selectToolFreeResponse } from "./response-selection.js";

describe("tool-free response selection", () => {
  it("stops after the first draft that clears the threshold", async () => {
    const generate = vi.fn(async (model: string) => `answer from ${model}`);
    const result = await selectToolFreeResponse({ models: ["a", "b", "c"],
      policy: { ...DEFAULT_RESPONSE_SELECTION_POLICY, maxCandidates: 3 }, generate,
      assess: async c => ({ ok: true, meetsProbability: c.model === "b" ? 0.94 : 0.6 }) });
    expect(result).toMatchObject({ selected: { model: "b" }, reason: "threshold_met" });
    expect(generate.mock.calls.map(c => c[0])).toEqual(["a", "b"]);
  });

  it("uses pairwise judgment for best-of-N and bounds generation", async () => {
    const compare = vi.fn(async () => "b" as const);
    const result = await selectToolFreeResponse({ models: ["a", "b", "c", "d", "e"],
      policy: { ...DEFAULT_RESPONSE_SELECTION_POLICY, mode: "best_of_n", maxCandidates: 3 },
      generate: async model => `draft ${model}`, assess: async () => ({ ok: true, meetsProbability: 0.7 }), compare });
    expect(result).toMatchObject({ selected: { model: "c" }, reason: "best_of_n" });
    expect(result.candidates).toHaveLength(3);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it("keeps the primary draft when judging fails and never emits partial drafts", async () => {
    const result = await selectToolFreeResponse({ models: ["primary", "backup"],
      policy: DEFAULT_RESPONSE_SELECTION_POLICY, generate: async model => `draft ${model}`,
      assess: async () => ({ ok: false, reason: "timeout" }) });
    expect(result).toMatchObject({ selected: { model: "primary" }, reason: "primary_fallback" });
  });

  it("refuses live Jev calls without explicit data scope", async () => {
    const evaluate = vi.fn();
    const judge = createJevResponseJudge({ task: "Explain the result", criteria: "One sentence", dataClass: "live",
      permission: { enabled: true, dataScope: "synthetic", providers: ["typesafe-ai"] }, apiKey: "test", evaluate });
    expect(await judge.assess({ model: "a", text: "The result is 4." })).toMatchObject({ ok: false });
    expect(await judge.compare({ model: "a", text: "A" }, { model: "b", text: "B" })).toBe("unclear");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("sends bounded redacted state with a typed rubric", async () => {
    const evaluate = vi.fn(async () => ({ ok: true as const, elapsedMs: 1,
      answers: { meets: { type: "boolean" as const, probability: 0.92 } } }));
    const judge = createJevResponseJudge({ task: "Explain the result", criteria: "One sentence", dataClass: "synthetic",
      permission: { enabled: true, dataScope: "synthetic", providers: ["typesafe-ai"] }, apiKey: "test", evaluate });
    expect(await judge.assess({ model: "a", text: "token: sk-abcdefghijklmnopq" }))
      .toEqual({ ok: true, meetsProbability: 0.92 });
    const sent = JSON.stringify(evaluate.mock.calls[0]);
    expect(sent).not.toContain("sk-abcdefghijklmnopq");
    expect(sent).toContain("boolean");
  });
});
