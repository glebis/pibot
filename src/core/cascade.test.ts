import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { COOLDOWN_MS, classifyModelError, ModelCascade, specProvider } from "./cascade.js";

function cascade(globalTail: string[] = []) {
  return new ModelCascade({
    statePath: path.join(os.tmpdir(), `pibot-cascade-${Math.random()}.json`),
    globalTail,
    modelRuntime: {
      getModels: () => [
        { provider: "ollama", id: "local" },
        { provider: "anthropic", id: "claude" },
      ],
      hasConfiguredAuth: () => true,
    } as never,
  });
}

describe("per-agent provider routing", () => {
  it("does not append global or authenticated providers when no policy opts into them", () => {
    expect(cascade(["anthropic/global"]).chainFor({ model: "ollama/primary" })).toEqual(["ollama/primary"]);
  });

  it("only routes through providers explicitly allowed by the agent", () => {
    expect(cascade(["anthropic/global", "ollama/global"]).chainFor({
      model: "ollama/primary",
      providers: ["anthropic"],
    })).toEqual(["anthropic/global", "anthropic/claude"]);
  });
});

describe("credit-exhaustion classification", () => {
  it("classifies provider billing/credit failures as credits", () => {
    const samples = [
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade your plan.",
      '402 {"error":{"message":"Insufficient Balance"}}',
      "You exceeded your current quota, please check your plan and billing details.",
      "Insufficient credits for this request. Increase your credits or reduce the request size.",
      "429 insufficient_quota: You exceeded your current quota",
      "Your spending limit has been reached for this workspace",
      "payment required",
    ];
    for (const s of samples) expect(classifyModelError(s), s).toBe("credits");
  });

  it("keeps genuine rate limits, auth errors, and context errors out of the credits class", () => {
    expect(classifyModelError("Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 29999, Requested 200. Please try again in 20s.")).toBe("rate-limit");
    expect(classifyModelError("429 RESOURCE_EXHAUSTED: quota of requests per minute exceeded")).toBe("rate-limit");
    expect(classifyModelError("invalid api key")).toBe("auth");
    expect(classifyModelError("401 unauthorized")).toBe("auth");
    expect(classifyModelError("prompt is too long: 250000 tokens > 200000 maximum context length")).toBe("context");
  });

  it("gives credits a long breaker cooldown (between rate-limit and auth)", () => {
    expect(COOLDOWN_MS.credits).toBeGreaterThan(COOLDOWN_MS["rate-limit"]);
    expect(COOLDOWN_MS.credits).toBeLessThan(COOLDOWN_MS.auth);
  });

  it("extracts providers from specs", () => {
    expect(specProvider("anthropic/claude")).toBe("anthropic");
    expect(specProvider("ollama/llama:cloud")).toBe("ollama");
    expect(specProvider("bare-model")).toBe("");
  });
});

describe("provider credit holds", () => {
  function creditCascade() {
    return new ModelCascade({
      statePath: path.join(os.tmpdir(), `pibot-cascade-${Math.random()}.json`),
      modelRuntime: {
        getModels: () => [
          { provider: "anthropic", id: "claude" },
          { provider: "anthropic", id: "opus" },
          { provider: "ollama", id: "local" },
        ],
        hasConfiguredAuth: () => true,
      } as never,
    });
  }

  it("a credits failure blocks sibling models of the same provider but not other providers", () => {
    const c = creditCascade();
    expect(c.noteFailure("anthropic/claude", "Your credit balance is too low to access the Anthropic API.")).toBe("credits");
    expect(c.isOpen("anthropic/claude")).toBe(true);
    expect(c.firstHealthy(["anthropic/claude", "anthropic/opus", "ollama/local"])).toBe("ollama/local");
  });

  it("a success (or probe) lifts the hold again", () => {
    const c = creditCascade();
    c.noteFailure("anthropic/claude", "Your credit balance is too low");
    expect(c.creditBlockedProviders()).toEqual(["anthropic"]);
    c.noteSuccess("anthropic/claude");
    expect(c.creditBlockedProviders()).toEqual([]);
    expect(c.firstHealthy(["anthropic/claude", "ollama/local"])).toBe("anthropic/claude");
  });

  it("clearBreakers lifts credit holds too", () => {
    const c = creditCascade();
    c.noteFailure("anthropic/claude", "Insufficient Balance");
    c.clearBreakers();
    expect(c.creditBlockedProviders()).toEqual([]);
    expect(c.firstHealthy(["anthropic/claude", "ollama/local"])).toBe("anthropic/claude");
  });

  it("credit holds expire with the credits cooldown", () => {
    const c = creditCascade();
    c.noteFailure("anthropic/claude", "Insufficient Balance", 1_000);
    expect(c.creditBlockedProviders(1_000 + COOLDOWN_MS.credits + 1)).toEqual([]);
    expect(c.isOpen("anthropic/claude", 1_000 + COOLDOWN_MS.credits + 1)).toBe(false);
    expect(c.firstHealthy(["anthropic/claude", "ollama/local"], 1_000 + COOLDOWN_MS.credits + 1)).toBe("anthropic/claude");
  });

  it("non-credit failures never set a provider hold", () => {
    const c = creditCascade();
    c.noteFailure("anthropic/claude", "Rate limit reached: tokens per min");
    expect(c.creditBlockedProviders()).toEqual([]);
  });

  it("statusLines marks provider credit holds on every sibling", () => {
    const c = creditCascade();
    c.noteFailure("anthropic/claude", "Your credit balance is too low");
    const lines = c.statusLines(["anthropic/claude", "anthropic/opus"]);
    expect(lines[0]).toContain("(credits)"); // the model that failed
    expect(lines[1]).toContain("out of credits (provider hold"); // untouched sibling, blocked via the hold
  });
});
