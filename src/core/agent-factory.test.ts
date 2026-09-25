import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { buildManifest, buildPersona, createAgentFromSpec, suggestedSubBotUsername, validateAgentName } from "./agent-factory.js";

describe("agent factory", () => {
  it("builds a manifest per proactivity preset", () => {
    const quiet = buildManifest({ name: "a", job: "watches things", vibe: "warm & casual", proactivity: "quiet" });
    expect(quiet.heartbeat).toMatchObject({ enabled: true, interval: "90m" });

    const off = buildManifest({ name: "b", job: "reacts", vibe: "dry & efficient", proactivity: "off" });
    expect(off.heartbeat?.enabled).toBe(false);

    const chatty = buildManifest({ name: "c", job: "chats", vibe: "warm & casual", proactivity: "chatty" });
    expect(chatty.heartbeat?.interval).toBe("20m");
  });

  it("persona carries job, vibe, and the operating defaults", () => {
    const p = buildPersona({
      name: "coach",
      job: "Keeps me training daily.",
      vibe: "coach-like: encouraging but demanding",
      proactivity: "balanced",
    });
    expect(p).toContain("You are coach. Keeps me training daily.");
    expect(p).toContain("encouraging but demanding");
    expect(p).toContain("err toward silence");
  });

  it("custom vibes are used verbatim", () => {
    const p = buildPersona({ name: "x", job: "Test job.", vibe: "speaks in haiku", proactivity: "off" });
    expect(p).toContain("speaks in haiku");
    expect(p).not.toContain("warm, brief");
  });

  it("validates names", () => {
    expect(validateAgentName("good-name")).toBeNull();
    expect(validateAgentName("Bad!", ["a"])).toContain("lowercase");
    expect(validateAgentName("coach", ["coach"])).toContain("already exists");
  });
});
describe("suggestedSubBotUsername", () => {
  it("namespaces under the parent bot", () => {
    expect(suggestedSubBotUsername("tax", "pimother_bot")).toBe("pimother_tax_bot");
    expect(suggestedSubBotUsername("focuscoach", "pimother_bot")).toBe("pimother_focuscoach_bot");
  });

  it("handles dashes and truncates to Telegram's 32-char limit", () => {
    expect(suggestedSubBotUsername("research-assistant-2", "pimother_bot")).toBe("pimother_research_assistant_bot");
    const long = suggestedSubBotUsername("a-very-long-agent-name-that-keeps-going", "pimother_bot");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith("_bot")).toBe(true);
  });

  it("defaults to pimother_bot when the manager is unknown", () => {
    expect(suggestedSubBotUsername("tax")).toBe("pimother_tax_bot");
  });
});

describe("computeAmbiguity", () => {
  it("weights goal/constraints/success per the Ouroboros formula", async () => {
    const { computeAmbiguity } = await import("../core/ambiguity.js");
    expect(computeAmbiguity({ goal: 1, constraints: 1, success: 1 })).toBeCloseTo(0);
    expect(computeAmbiguity({ goal: 0, constraints: 0, success: 0 })).toBeCloseTo(1);
    // 0.9*0.4 + 0.8*0.3 + 0.7*0.3 = 0.81 → 0.19 (the Ouroboros example)
    expect(computeAmbiguity({ goal: 0.9, constraints: 0.8, success: 0.7 })).toBeCloseTo(0.19);
  });
});

// ─── programmatic creation ──────────────────────────────────────────────────

describe("createAgentFromSpec", () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-factory-"));
    const agents = new AgentManager(dir, { getModels: () => [] } as never);
    const ensure = vi.fn();
    return { agents, ensure, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it("creates with quiet defaults, persona from the description, rhythm armed", async () => {
    const { agents, ensure, dir, cleanup } = setup();
    const r = await createAgentFromSpec({ agents, scheduler: { ensure } }, { id: "helper", description: "Runs errands for Gleb" });
    expect(r.ok).toBe(true);
    const m = (r as { ok: true; manifest: { heartbeat: { interval: string }; capabilities?: string[] }; dir: string }).manifest;
    expect(m.heartbeat).toMatchObject({ enabled: true, interval: "90m" });
    expect(m.capabilities).toBeUndefined(); // conservative defaults, not an explicit list
    const persona = fs.readFileSync(path.join((r as { ok: true; dir: string }).dir, "AGENTS.md"), "utf8");
    expect(persona).toContain("Runs errands for Gleb");
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ id: "hb:helper" }));
    cleanup();
  });

  it("rejects collisions, bad ids, empty descriptions", async () => {
    const { agents, cleanup } = setup();
    agents.createAgent("taken", "seed");
    expect((await createAgentFromSpec({ agents }, { id: "taken", description: "x" })).ok).toBe(false);
    expect((await createAgentFromSpec({ agents }, { id: "Bad_ID", description: "x" })).ok).toBe(false);
    expect((await createAgentFromSpec({ agents }, { id: "fresh", description: "  " })).ok).toBe(false);
    cleanup();
  });

  it("validates proactivity and capabilities strictly", async () => {
    const { agents, cleanup } = setup();
    const badP = await createAgentFromSpec({ agents }, { id: "alpha", description: "x", proactivity: "hyperactive" });
    expect(badP).toMatchObject({ ok: false, error: expect.stringContaining("quiet|balanced|chatty|off") });
    const badC = await createAgentFromSpec({ agents }, { id: "alpha", description: "x", capabilities: ["telepathy"] });
    expect(badC).toMatchObject({ ok: false, error: expect.stringContaining("telepathy") });
    cleanup();
  });

  it("honours an explicit capability list and model/providers overrides", async () => {
    const { agents, ensure, cleanup } = setup();
    const r = await createAgentFromSpec({ agents, scheduler: { ensure } }, {
      id: "researcher2", description: "Researches things", proactivity: "off",
      capabilities: ["scheduler", "telegram-send"], model: "ollama/glm-5.3-flash:cloud", providers: "ollama,openrouter",
    });
    expect(r.ok).toBe(true);
    const m = (r as { ok: true; manifest: { capabilities?: string[]; model?: string; providers?: string[]; heartbeat: { enabled: boolean } } }).manifest;
    expect(m.capabilities).toEqual(["scheduler", "telegram-send"]);
    expect(m.model).toBe("ollama/glm-5.3-flash:cloud");
    expect(m.providers).toEqual(["ollama", "openrouter"]);
    expect(m.heartbeat.enabled).toBe(false); // proactivity off
    expect(ensure).not.toHaveBeenCalled(); // nothing to arm
    cleanup();
  });
});
