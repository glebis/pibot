import { describe, expect, it, vi } from "vitest";
import { evaluateJev, type JevQuestion, type JevTrace } from "./jev-evaluator.js";

const questions: Record<string, JevQuestion> = {
  relevant: { type: "boolean", instructions: "Is this relevant?" },
  destination: { type: "choice", instructions: "Choose a destination.", criteria: { current: "Current agent", review: "Owner review" } },
  depth: { type: "score", instructions: "How much processing?", criteria: ["none", "light", "deep"] },
};
const answers = {
  relevant: { type: "boolean", probability: 0.9 },
  destination: { type: "choice", choice: "current", probabilities: { current: 0.8, review: 0.2 } },
  depth: { type: "score", score: 1.4, probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 } },
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("evaluateJev", () => {
  it("posts typed questions and validates all answer types without tracing content", async () => {
    const fetchFn = vi.fn(async () => response({ model: "typesafe-ai/jev", answers }));
    const traces: JevTrace[] = [];
    const result = await evaluateJev({ state: { title: "Example" }, questions, apiKey: "test-key", fetchFn, trace: (event) => traces.push(event) });
    expect(result).toMatchObject({ ok: true, answers });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, options] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(JSON.parse(options.body as string)).toMatchObject({
      model: "typesafe-ai/jev", state: { title: "Example" }, questions,
      providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
    });
    expect(traces[0]).toMatchObject({ outcome: "success", attempts: 1, questionCount: 3 });
    expect(JSON.stringify(traces)).not.toContain("Example");
    expect(JSON.stringify(traces)).not.toContain("test-key");
  });

  it("rejects an out-of-criteria choice instead of making a decision", async () => {
    const fetchFn = vi.fn(async () => response({ answers: { ...answers, destination: { ...answers.destination, choice: "other" } } }));
    expect(await evaluateJev({ state: "example", questions, apiKey: "test-key", fetchFn })).toMatchObject({ ok: false, reason: "invalid_response" });
  });

  it("rejects malformed probability distributions and a choice that is not the top option", async () => {
    const malformed = vi.fn(async () => response({ answers: { ...answers, destination: { type: "choice", choice: "current", probabilities: { current: 0.3, review: 0.3 } } } }));
    expect(await evaluateJev({ state: "example", questions, apiKey: "test-key", fetchFn: malformed })).toMatchObject({ ok: false, reason: "invalid_response" });
    const mismatch = vi.fn(async () => response({ answers: { ...answers, destination: { type: "choice", choice: "current", probabilities: { current: 0.1, review: 0.9 } } } }));
    expect(await evaluateJev({ state: "example", questions, apiKey: "test-key", fetchFn: mismatch })).toMatchObject({ ok: false, reason: "invalid_response" });
  });

  it("retries a transient status once, then returns a safe failure", async () => {
    const fetchFn = vi.fn(async () => response({}, 429));
    const result = await evaluateJev({ state: "example", questions, apiKey: "test-key", fetchFn });
    expect(result).toMatchObject({ ok: false, reason: "http_error" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("times out even if a fetch implementation ignores abort", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const result = await evaluateJev({ state: "example", questions, apiKey: "test-key", fetchFn, timeoutMs: 250 });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not call the gateway without a key", async () => {
    const fetchFn = vi.fn(async () => response({ answers }));
    expect(await evaluateJev({ state: "example", questions, apiKey: "", fetchFn })).toMatchObject({ ok: false, reason: "missing_api_key" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("bounds state and rejects invalid question definitions before a request", async () => {
    const fetchFn = vi.fn(async () => response({ answers }));
    expect(await evaluateJev({ state: 42, questions, apiKey: "test-key", fetchFn })).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(await evaluateJev({ state: "x".repeat(17_000), questions, apiKey: "test-key", fetchFn })).toMatchObject({ ok: false, reason: "state_too_large" });
    expect(await evaluateJev({ state: "example", questions: { destination: { type: "choice", instructions: "Pick", criteria: { only: "One" } } }, apiKey: "test-key", fetchFn })).toMatchObject({ ok: false, reason: "invalid_questions" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
