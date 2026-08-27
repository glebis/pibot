import { describe, expect, it } from "vitest";
import { buildManifest, buildPersona, validateAgentName } from "./agent-factory.js";

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