import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COOLDOWN_MS, classifyModelError, ModelCascade, specProvider } from "./cascade.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already cleaned */ }
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-cascade-"));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

function cascade(globalTail: string[] = [], extraModels: Array<{ provider: string; id: string }> = []): ModelCascade {
  const statePath = path.join(makeTempDir(), "state.json");
  return new ModelCascade({
    statePath,
    globalTail,
    modelRuntime: {
      getModels: () => [{ provider: "ollama", id: "local" }, { provider: "anthropic", id: "claude" }, ...extraModels],
      hasConfiguredAuth: () => true,
    } as never,
  });
}

function makeInstance(statePath: string): ModelCascade {
  return new ModelCascade({ statePath, modelRuntime: { getModels: () => [{ provider: "ollama", id: "local" }], hasConfiguredAuth: () => true } as never });
}

describe("classifyModelError", () => {
  it.each([
    ["401 Unauthorized", "auth"],
    ["429 Rate limit", "rate-limit"],
    ["context window overflow", "context"],
    ["500 Internal server error", "transient"],
    ["timeout", "transient"],
    ["ECONNREFUSED", "transient"],
    ["unknown error type", "unknown"],
    ["", "unknown"],
    [null as unknown as string, "unknown"],
  ])("classifies '%s' as %s", (message, expected) => {
    expect(classifyModelError(message)).toBe(expected);
  });
});

describe("noteFailure cooldown + noteSuccess recovery", () => {
  it("opens breakers with class-specific cooldowns and recovers on success", () => {
    const c = cascade();
    const t = 1_700_000_000_000;
    const classes: Array<[string, keyof typeof COOLDOWN_MS]> = [
      ["401 Unauthorized", "auth"],
      ["429 Rate limit", "rate-limit"],
      ["500 Internal", "transient"],
      ["context window overflow", "context"],
    ];
    for (const [msg, cls] of classes) {
      c.noteFailure("ollama/local", msg, t);
      expect(c.entry("ollama/local")?.openUntil).toBe(t + COOLDOWN_MS[cls]);
      c.noteSuccess("ollama/local", t); // reset the streak: consecutive failures escalate the cooldown
    }
    c.noteSuccess("ollama/local", t + 1000);
    const e = c.entry("ollama/local");
    expect(e?.openUntil).toBe(0);
    expect(e?.lastSuccessAt).toBe(t + 1000);
    expect(c.isOpen("ollama/local", t + 1001)).toBe(false);
    expect(e?.failures).toBe(4);
  });
});

describe("persisted state reload", () => {
  it("reloads breaker and dead letter state across instances", () => {
    const statePath = path.join(makeTempDir(), "state.json");
    const t = 1_700_000_000_000;
    { const c = makeInstance(statePath); c.noteFailure("ollama/local", "401 Unauthorized", t); c.queueDead({ agentId: "a", transport: "t", chatId: "1", text: "dl1", createdAt: t, attempts: [] }); c.queueDead({ agentId: "b", transport: "t", chatId: "2", text: "dl2", createdAt: t, attempts: [], automaticReplayBlocked: true, lastError: "dup" }); }
    { const c = makeInstance(statePath); expect(c.entry("ollama/local")?.openUntil).toBe(t + COOLDOWN_MS["auth"]); expect(c.entry("ollama/local")?.lastErrorClass).toBe("auth"); expect(c.deadLetters()).toHaveLength(2); const dl2 = c.deadLetters().find(d => d.text === "dl2"); expect(dl2?.automaticReplayBlocked).toBe(true); expect(dl2?.lastError).toBe("dup"); }
  });
});

describe("state safety for missing/corrupt/primitive JSON", () => {
  it.each([
    ["missing-file", undefined],
    ["empty", ""],
    ["corrupt", "{ not json }"],
    ["truncated", '{"entries":{"test":{'],
    ["wrong-root-string", '"just a string"'],
    ["wrong-root-array", "[]"],
    ["primitive-number", "42"],
    ["primitive-null", "null"],
    ["entries-array", '{"entries":[],"deadLetters":[]}'],
    ["deadLetters-object", '{"entries":{},"deadLetters":{}}'],
    ["partial-missing-keys", '{"entries":{"test":{}},"deadLetters":null}'],
  ])("uses fallback empty state for %s", (label, raw) => {
    const dir = makeTempDir();
    const statePath = path.join(dir, "state.json");
    if (raw !== undefined) fs.writeFileSync(statePath, raw, "utf8");
    const c = new ModelCascade({
      statePath,
      modelRuntime: { getModels: () => [], hasConfiguredAuth: () => true } as never,
    });
    expect(c.entry("any/model")).toBeUndefined();
    expect(c.deadLetterCount()).toBe(0);
  });

  it("salvages valid entries when key matches model, discards mismatched entries", () => {
    const statePath = path.join(makeTempDir(), "state.json");
    fs.writeFileSync(statePath, '{"entries":{"ollama/local":{"model":"ollama/local","openUntil":1000,"failures":1},"mismatched":{"model":"ollama/local","openUntil":2000,"failures":2},"bad":null,"also-bad":"not-an-object"},"deadLetters":[]}', "utf8");
    const c = new ModelCascade({ statePath, modelRuntime: { getModels: () => [{ provider: "ollama", id: "local" }], hasConfiguredAuth: () => true } as never });
    expect(c.entry("ollama/local")?.openUntil).toBe(1000);
    expect(c.entry("ollama/local")?.failures).toBe(1);
    expect(c.deadLetterCount()).toBe(0);
  });

  it("salvages valid deadLetters and discards null/malformed entries", () => {
    const statePath = path.join(makeTempDir(), "state.json");
    const validDl = { id: "dl1", agentId: "a", transport: "t", chatId: "1", text: "valid", createdAt: 1, attempts: [], lastError: "err", automaticReplayBlocked: false };
    fs.writeFileSync(statePath, `{"entries":{},"deadLetters":[${JSON.stringify(validDl)},null,"not-an-object",${JSON.stringify({ ...validDl, id: "dl2" })}]}`, "utf8");
    const c = new ModelCascade({ statePath, modelRuntime: { getModels: () => [], hasConfiguredAuth: () => true } as never });
    expect(c.deadLetterCount()).toBe(2);
    expect(c.deadLetters().map((d) => d.id).sort()).toEqual(["dl1", "dl2"]);
  });

  it("preserves valid breaker when deadLetters container is malformed", () => {
    const statePath = path.join(makeTempDir(), "state.json");
    fs.writeFileSync(statePath, '{"entries":{"ollama/local":{"model":"ollama/local","openUntil":2000,"failures":2}},"deadLetters":"not-an-array"}', "utf8");
    const c = new ModelCascade({ statePath, modelRuntime: { getModels: () => [{ provider: "ollama", id: "local" }], hasConfiguredAuth: () => true } as never });
    expect(c.entry("ollama/local")?.openUntil).toBe(2000);
    expect(c.entry("ollama/local")?.failures).toBe(2);
    expect(c.deadLetterCount()).toBe(0);
  });

  it("preserves valid deadLetters when entries container is malformed", () => {
    const statePath = path.join(makeTempDir(), "state.json");
    const validDl = { id: "dl1", agentId: "a", transport: "t", chatId: "1", text: "valid", createdAt: 1, attempts: [] };
    fs.writeFileSync(statePath, `{"entries":null,"deadLetters":[${JSON.stringify(validDl)}]}`, "utf8");
    const c = new ModelCascade({ statePath, modelRuntime: { getModels: () => [], hasConfiguredAuth: () => true } as never });
    expect(c.entry("any/model")).toBeUndefined();
    expect(c.deadLetterCount()).toBe(1);
    expect(c.deadLetters()[0].text).toBe("valid");
  });
});

describe("probeAlive breaker interaction", () => {
  it("probe success clears an already-open breaker and failed probe persists entry with error class", async () => {
    const c = new ModelCascade({
      statePath: path.join(makeTempDir(), "state.json"),
      modelRuntime: {
        getModels: () => [{ provider: "ollama", id: "local" }],
        hasConfiguredAuth: () => true,
        complete: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
      } as never,
    });
    const t = 1_700_000_000_000;
    c.noteFailure("ollama/local", "500 Internal", t);
    expect(c.entry("ollama/local")?.openUntil).toBeGreaterThan(t);

    const results = await c.probeAlive(["ollama/local"]);
    expect(results).toEqual([{ spec: "ollama/local", ok: true }]);
    expect(c.entry("ollama/local")?.openUntil).toBe(0);

    const complete = vi.fn().mockResolvedValue({ stopReason: "error", errorMessage: "service unavailable" });
    const c2 = new ModelCascade({
      statePath: path.join(makeTempDir(), "state.json"),
      modelRuntime: {
        getModels: () => [{ provider: "anthropic", id: "claude" }],
        hasConfiguredAuth: () => true,
        complete,
      } as never,
    });
    await c2.probeAlive(["anthropic/claude"]);
    const e = c2.entry("anthropic/claude");
    expect(e).toBeDefined();
    expect(e?.openUntil).toBeGreaterThan(Date.now());
    expect(e?.lastErrorClass).toBe("transient");
    expect(e?.lastError).toContain("service unavailable");
  });
});

describe("chain / nextCandidate provider exhaustion", () => {
  it("firstHealthy skips circuit-open and resolves chain", () => {
    const c = cascade();
    const t = 1_700_000_000_000;
    c.noteFailure("ollama/local", "500 Internal", t);
    expect(c.firstHealthy(["ollama/local", "anthropic/claude"], t + 1)).toBe("anthropic/claude");
  });

  it("nextCandidate returns undefined when failedSpec is the only chain entry", () => {
    const c = cascade();
    const t = 1_700_000_000_000;
    c.noteFailure("ollama/local", "500 Internal", t);
    expect(c.nextCandidate(["ollama/local"], "ollama/local", t + 1)).toBeUndefined();
  });

  it("nextCandidate returns undefined when all specs are circuit-open", () => {
    const c = cascade();
    const t = 1_700_000_000_000;
    c.noteFailure("ollama/local", "500 Internal", t);
    c.noteFailure("anthropic/claude", "401 Unauthorized", t);
    expect(c.nextCandidate(["ollama/local", "anthropic/claude"], undefined, t + 1)).toBeUndefined();
  });

  it("nextCandidate skips unresolvable specs", () => {
    const c = cascade([], [{ provider: "openai", id: "gpt-4" }]);
    expect(c.nextCandidate(["ollama/local", "openai/gpt-4", "anthropic/claude"])).toBe("ollama/local");
    expect(c.firstHealthy(["unknown/model"])).toBeUndefined();
  });

it("skips unknown candidate and later uses anthropic/claude when it becomes resolvable", () => {
    const c = cascade([], [{ provider: "anthropic", id: "claude" }]);
    expect(c.nextCandidate(["unknown/model", "anthropic/claude"])).toBe("anthropic/claude");
    expect(c.firstHealthy(["unknown/model", "anthropic/claude"])).toBe("anthropic/claude");
  });
});

describe("dead-letter bounded retention + take/unshift", () => {
  it("queues, bounds to 100, takes oldest, and unshifts back", () => {
    const c = cascade();
    for (let i = 0; i < 120; i++) {
      c.queueDead({ agentId: `a${i}`, transport: "t", chatId: `${i}`, text: `msg${i}`, createdAt: i, attempts: [] });
    }
    expect(c.deadLetterCount()).toBe(100);
    expect(c.deadLetters()[0].text).toBe("msg20");
    expect(c.deadLetters()[99].text).toBe("msg119");

    const taken = c.takeOneDead();
    expect(taken?.text).toBe("msg20");
    expect(c.deadLetterCount()).toBe(99);

    c.unshiftDead(taken!);
    expect(c.deadLetters()[0].text).toBe("msg20");
  });

  it("preserves automaticReplayBlocked, lastError, and survives across instances", () => {
    const statePath = path.join(makeTempDir(), "state.json");
    {
      const c = makeInstance(statePath);
      c.queueDead({ agentId: "a", transport: "t", chatId: "1", text: "first", createdAt: 1, attempts: [], automaticReplayBlocked: true, lastError: "dup" });
      c.queueDead({ agentId: "b", transport: "t", chatId: "2", text: "second", createdAt: 2, attempts: [] });
    }
    {
      const c = makeInstance(statePath);
      expect(c.deadLetterCount()).toBe(2);
      const taken = c.takeOneDead();
      expect(taken?.text).toBe("first");
      expect(taken?.automaticReplayBlocked).toBe(true);
      expect(taken?.lastError).toBe("dup");
    }
  });
});

describe("probeAlive deterministic success/failure", () => {
  it("probeAlive records failure on aborted stopReason and thrown error, and does not call model runtime for unknown model", async () => {
    const complete = vi.fn();

    const c = new ModelCascade({
      statePath: path.join(makeTempDir(), "state.json"),
      modelRuntime: {
        getModels: () => [{ provider: "anthropic", id: "claude" }, { provider: "ollama", id: "local" }, { provider: "ollama", id: "other" }],
        hasConfiguredAuth: () => true,
        complete,
      } as never,
    });

    complete.mockResolvedValueOnce({ stopReason: "aborted" });
    const r1 = await c.probeAlive(["anthropic/claude"]);
    expect(r1).toEqual([{ spec: "anthropic/claude", ok: false, error: "stopReason=aborted" }]);
    expect(c.entry("anthropic/claude")).toBeDefined();
    expect(c.entry("anthropic/claude")?.lastErrorClass).toBe("unknown");
    expect(c.entry("anthropic/claude")?.lastError).toContain("stopReason=aborted");

    complete.mockRejectedValueOnce(new Error("network unreachable"));
    const r2 = await c.probeAlive(["ollama/other"]);
    expect(r2).toEqual([{ spec: "ollama/other", ok: false, error: "network unreachable" }]);
    expect(c.entry("ollama/other")).toBeDefined();
    expect(c.entry("ollama/other")?.openUntil).toBeGreaterThan(Date.now());
    expect(c.entry("ollama/other")?.lastErrorClass).toBe("transient");
    expect(c.entry("ollama/other")?.lastError).toContain("network unreachable");

    const r3 = await c.probeAlive(["unknown/model"]);
    expect(r3).toEqual([{ spec: "unknown/model", ok: false, error: "not in catalog" }]);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe("per-agent provider routing", () => {
  it("does not append global or authenticated providers when no policy opts into them", () => {
    expect(cascade().chainFor({ model: "ollama/primary" })).toEqual(["ollama/primary"]);
  });

  it("only routes through providers explicitly allowed by the agent", () => {
    expect(cascade().chainFor({
      model: "ollama/primary",
      providers: ["anthropic"],
    })).toEqual(["anthropic/claude"]);
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
