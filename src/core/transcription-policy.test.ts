import { describe, expect, it } from "vitest";
import type { SttPolicy } from "./stt.js";
import {
  LONG_AUDIO_CHUNK_SEC,
  LONG_AUDIO_THRESHOLD_SEC,
  TRANSCRIPTION_POLICY_MARKER,
  declaredTranscriptionRoute,
  formatTranscriptionPlan,
  planTranscription,
  transcriptionPolicyMarker,
  transcriptionTaskConstraint,
} from "./transcription-policy.js";

const HOST = ["whisperkit", "local_whisper", "groq"];
const AGENT_POLICY: SttPolicy = { providers: ["whisperkit", "groq"], allowExternal: true };

describe("planTranscription", () => {
  it("keeps the agent's configured chain for audio at or under 15 minutes", () => {
    const plan = planTranscription({ durationSec: 12 * 60, policy: AGENT_POLICY, hostProviders: HOST });
    expect(plan.longAudio).toBe(false);
    expect(plan.ok).toBe(true);
    expect(plan.route).toBe("policy");
    expect(plan.providers).toEqual(["whisperkit", "groq"]);
    expect(plan.chunkSeconds).toBeNull();
    expect(plan.chunks).toBe(1);
    expect(plan.constraint).toContain("<=15 min");
  });

  it("treats exactly 15 minutes as short and 15 minutes + 1s as long", () => {
    expect(planTranscription({ durationSec: LONG_AUDIO_THRESHOLD_SEC, policy: AGENT_POLICY, hostProviders: HOST }).longAudio).toBe(false);
    expect(planTranscription({ durationSec: LONG_AUDIO_THRESHOLD_SEC + 1, policy: AGENT_POLICY, hostProviders: HOST }).longAudio).toBe(true);
  });

  it("routes >15-minute audio to <=15-minute Groq chunks and never to a local provider", () => {
    const plan = planTranscription({ durationSec: 27 * 60, policy: AGENT_POLICY, hostProviders: HOST });
    expect(plan.longAudio).toBe(true);
    expect(plan.ok).toBe(true);
    expect(plan.route).toBe("chunked-external");
    expect(plan.providers).toEqual(["groq"]);
    expect(plan.chunkSeconds).toBe(LONG_AUDIO_CHUNK_SEC);
    expect(plan.chunks).toBe(2); // 27 min split into <=15 min pieces
    expect(plan.constraint).toMatch(/Groq/);
    expect(plan.constraint).toMatch(/<=15 min/i);
    expect(plan.constraint).toMatch(/do NOT fall back to WhisperKit/i);
  });

  it("blocks >15-minute audio when Groq is not in the agent's policy instead of quietly using WhisperKit", () => {
    const plan = planTranscription({
      durationSec: 27 * 60,
      policy: { providers: ["whisperkit", "local_whisper"] },
      hostProviders: HOST,
    });
    expect(plan.ok).toBe(false);
    expect(plan.route).toBe("blocked");
    expect(plan.providers).toEqual([]);
    expect(plan.blocker).toMatch(/15 min/i);
    expect(plan.blocker).toMatch(/Groq/);
    expect(plan.blocker).toMatch(/not a permitted substitute/i);
    expect(plan.providers).not.toContain("whisperkit");
  });

  it("blocks >15-minute audio when Groq is listed but external STT is not permitted", () => {
    const plan = planTranscription({
      durationSec: 20 * 60,
      policy: { providers: ["whisperkit", "groq"], allowExternal: false },
      hostProviders: HOST,
    });
    expect(plan.ok).toBe(false);
    expect(plan.route).toBe("blocked");
    expect(plan.providers).toEqual([]);
  });

  it("blocks >15-minute audio when the host does not enable Groq", () => {
    const plan = planTranscription({ durationSec: 20 * 60, policy: AGENT_POLICY, hostProviders: ["whisperkit"] });
    expect(plan.ok).toBe(false);
    expect(plan.route).toBe("blocked");
  });

  it("mandates a probe for an unknown duration instead of asserting it is >15 min", () => {
    const plan = planTranscription({ durationSec: null, policy: { providers: ["whisperkit"] }, hostProviders: HOST });
    // it must not claim the audio is long, nor silently route it locally
    expect(plan.longAudio).toBe(false);
    expect(plan.requiresProbe).toBe(true);
    expect(plan.ok).toBe(false);
    expect(plan.route).toBe("probe-required");
    expect(plan.durationKnown).toBe(false);
    expect(plan.providers).toEqual([]);
    expect(plan.blocker).toMatch(/probe it \(ffprobe\)/i);
    expect(plan.constraint).toMatch(/PROBE it \(ffprobe\) FIRST/i);
  });

  it("still honours an explicit owner local exception for unknown-duration audio", () => {
    const plan = planTranscription({
      durationSec: null,
      policy: { providers: ["whisperkit"] },
      hostProviders: HOST,
      localLongAudioPermission: true,
    });
    expect(plan.route).toBe("local-exception");
    expect(plan.requiresProbe).toBe(false);
  });

  it("records an explicit owner permission as a local exception for long audio", () => {
    const plan = planTranscription({
      durationSec: 27 * 60,
      policy: { providers: ["whisperkit"] },
      hostProviders: HOST,
      localLongAudioPermission: true,
    });
    expect(plan.ok).toBe(true);
    expect(plan.route).toBe("local-exception");
    expect(plan.providers).toEqual(["whisperkit"]);
    expect(plan.exception).toMatch(/owner-permitted/i);
  });

  it("does not invent a local exception when the local chain is empty", () => {
    const plan = planTranscription({
      durationSec: 27 * 60,
      policy: { providers: ["groq"], allowExternal: true },
      hostProviders: HOST,
      localLongAudioPermission: true,
    });
    expect(plan.route).toBe("chunked-external");
    expect(plan.providers).toEqual(["groq"]);
  });
});

describe("transcription constraint text", () => {
  it("carries the duration and provider rule into a delegated task spec", () => {
    const line = transcriptionTaskConstraint({ durationSec: 27 * 60, policy: AGENT_POLICY, hostProviders: HOST });
    expect(line).toContain("27.0 min");
    expect(line).toContain("Groq");
    expect(line).toMatch(/do NOT fall back to WhisperKit/i);
  });

  it("tells a blocked caller to report the blocker instead of substituting", () => {
    const line = transcriptionTaskConstraint({ durationSec: 27 * 60, policy: { providers: ["whisperkit"] }, hostProviders: HOST });
    expect(line).toMatch(/do NOT transcribe it locally/i);
  });

  it("formats the actual route for a task record", () => {
    const plan = planTranscription({ durationSec: 27 * 60, policy: AGENT_POLICY, hostProviders: HOST });
    expect(formatTranscriptionPlan(plan)).toContain("chunked-external (2 x <=15 min via groq)");
  });

  it("records the probe requirement for a task record when the duration is unknown", () => {
    const plan = planTranscription({ durationSec: null, policy: AGENT_POLICY, hostProviders: HOST });
    const line = formatTranscriptionPlan(plan);
    expect(line).toContain("probe-required");
    expect(line).toContain("duration unknown");
  });
});

describe("durable policy marker", () => {
  it("round-trips the declared route out of a task's instructions", () => {
    const marker = transcriptionPolicyMarker("chunked-external");
    expect(declaredTranscriptionRoute(`${marker}\nTRANSCRIPTION POLICY (owner instruction): …`)).toBe("chunked-external");
    expect(declaredTranscriptionRoute(transcriptionPolicyMarker("probe-required"))).toBe("probe-required");
    expect(declaredTranscriptionRoute("plain instructions with no marker")).toBeUndefined();
  });

  it("uses a specific sentinel, never the bare word audio", () => {
    expect(TRANSCRIPTION_POLICY_MARKER).toContain("transcription-policy");
    expect(declaredTranscriptionRoute("this task touches audio but declares no policy")).toBeUndefined();
  });
});
