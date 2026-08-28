import { describe, expect, it } from "vitest";
import { buildManifest, buildPersona, suggestedSubBotUsername, validateAgentName } from "./agent-factory.js";

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
