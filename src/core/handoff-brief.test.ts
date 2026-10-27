import { describe, expect, it } from "vitest";
import { buildHandoffEnvelope, extractBriefText, handoffNeedsLongAudioRule } from "./handoff-brief.js";
import { LONG_AUDIO_RULE, transcriptionPolicyMarker } from "./transcription-policy.js";

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

  it("carries the canonical owner rule deterministically when asked — not via the model", () => {
    const off = buildHandoffEnvelope("coach", "brief");
    expect(off).not.toContain(LONG_AUDIO_RULE);
    const on = buildHandoffEnvelope("coach", "brief", undefined, { includeLongAudioRule: true });
    // the exact rule sentence is present regardless of what the brief contains
    expect(on).toContain("# Owner policy (verbatim)");
    expect(on).toContain(LONG_AUDIO_RULE);
  });
});

describe("handoffNeedsLongAudioRule", () => {
  it("detects the durable task policy marker or the canonical rule wording", () => {
    expect(handoffNeedsLongAudioRule(`${transcriptionPolicyMarker("chunked-external")} …`)).toBe(true);
    expect(handoffNeedsLongAudioRule(`Reminder: never substitute local WhisperKit; >15 min uses Groq.`)).toBe(true);
    expect(handoffNeedsLongAudioRule("draft the weekly note")).toBe(false);
  });
});