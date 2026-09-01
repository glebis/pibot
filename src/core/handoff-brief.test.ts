import { describe, expect, it } from "vitest";
import { buildHandoffEnvelope, extractBriefText } from "./handoff-brief.js";

describe("extractBriefText", () => {
  it("strips code fences and surrounding whitespace", () => {
    expect(extractBriefText("```\n- Task: do the thing\n```")).toBe("- Task: do the thing");
  });

  it("returns null for empty replies", () => {
    expect(extractBriefText("   \n``` \n```\n  ")).toBeNull();
  });
});

describe("buildHandoffEnvelope", () => {
  it("keeps the internal [handoff from prefix and carries the brief", () => {
    const env = buildHandoffEnvelope("coach", "- Task: file the report");
    expect(env.startsWith('[handoff from "coach"]')).toBe(true);
    expect(env).toContain("# Handoff brief");
    expect(env).toContain("- Task: file the report");
  });

  it("appends the sender's note when present", () => {
    const env = buildHandoffEnvelope("coach", "brief", "deadline is friday");
    expect(env).toContain("# Note from coach");
    expect(env).toContain("deadline is friday");
  });

  it("omits the note section when absent", () => {
    expect(buildHandoffEnvelope("coach", "brief")).not.toContain("# Note from");
  });
});