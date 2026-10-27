import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { transcriptionPolicyMarker } from "../core/transcription-policy.js";
import {
  disallowedLocalTranscriber,
  guardEnforces,
  guardToolCall,
  namedDisallowedTranscriber,
  transcriptionExecGuardPlugin,
  transcriptionGuardForInstructions,
} from "./transcription-exec-guard-plugin.js";

/** Capture the `tool_call` handlers a plugin registers. */
function guardHandlers(ext: InlineExtension): Array<(event: unknown) => { block?: boolean; reason?: string } | void> {
  const handlers: Array<(event: unknown) => { block?: boolean; reason?: string } | void> = [];
  const pi = {
    on: (name: string, handler: (event: unknown) => { block?: boolean; reason?: string } | void) => {
      if (name === "tool_call") handlers.push(handler);
    },
    registerTool: vi.fn(),
  } as unknown as ExtensionAPI;
  (typeof ext === "function" ? ext : ext.factory)(pi);
  return handlers;
}

/**
 * Mimic pi's tool-call gate: every handler runs; a `block` result stops the call
 * before the tool's `execute` would run.
 */
function callTool(
  handlers: Array<(event: unknown) => { block?: boolean; reason?: string } | void>,
  toolName: string,
  input: unknown,
  executed: string[],
): { blocked: boolean; reason?: string } {
  for (const handler of handlers) {
    const result = handler({ type: "tool_call", toolCallId: "c1", toolName, input });
    if (result?.block) return { blocked: true, reason: result.reason };
  }
  executed.push(toolName);
  return { blocked: false };
}

const LONG = transcriptionPolicyMarker("chunked-external"); // the durable declared-long marker

describe("disallowedLocalTranscriber (pure)", () => {
  it("names local Whisper/WhisperKit binaries, absolute paths included", () => {
    expect(namedDisallowedTranscriber("whisperkit-cli")).toBe("whisperkit-cli");
    expect(namedDisallowedTranscriber("/usr/local/bin/whisperkit-cli")).toBe("whisperkit-cli");
    expect(namedDisallowedTranscriber("/opt/whisper/whisper")).toBe("whisper");
    expect(namedDisallowedTranscriber("WHISPER")).toBe("whisper");
    expect(namedDisallowedTranscriber("yt-dlp")).toBeUndefined();
  });

  it("reads exec_run argv, bin/args, and shell command positions — never argument words", () => {
    expect(disallowedLocalTranscriber({ argv: ["whisperkit-cli", "--model", "base", "x.wav"] })).toBe("whisperkit-cli");
    expect(disallowedLocalTranscriber({ bin: "/opt/bin/faster-whisper", args: ["x.wav"] })).toBe("/opt/bin/faster-whisper");
    expect(disallowedLocalTranscriber({ command: "whisperkit-cli x.wav" })).toBe("whisperkit-cli");
    expect(disallowedLocalTranscriber({ command: "echo whisper is not a call" })).toBeUndefined();
    expect(disallowedLocalTranscriber({ argv: ["python3", "-m", "whisper", "x.wav"] })).toBe("whisper");
    expect(disallowedLocalTranscriber({ argv: ["yt-dlp", "-x", "https://x"] })).toBeUndefined();
    expect(disallowedLocalTranscriber({ argv: [] })).toBeUndefined();
    expect(disallowedLocalTranscriber(undefined)).toBeUndefined();
  });

  it("applies the `-m whisper` check only to a real Python executable (review false-positive fix)", () => {
    // `echo -m whisper` names no transcriber: the module flag is only meaningful after a Python interpreter.
    expect(disallowedLocalTranscriber({ argv: ["echo", "-m", "whisper"] })).toBeUndefined();
    expect(disallowedLocalTranscriber({ command: "echo -m whisper" })).toBeUndefined();
    expect(disallowedLocalTranscriber({ command: "printf -m whisperkit" })).toBeUndefined();
    // a real interpreter form (any common spelling) is still caught
    expect(disallowedLocalTranscriber({ argv: ["/usr/bin/python3.11", "-m", "faster_whisper", "x.wav"] })).toBe("faster_whisper");
    expect(disallowedLocalTranscriber({ argv: ["py", "-m", "whisperkit", "x.wav"] })).toBe("whisperkit");
  });
});

describe("guardEnforces", () => {
  it("enforces only the long/unknown routes and never a local exception", () => {
    expect(guardEnforces("chunked-external")).toBe(true);
    expect(guardEnforces("probe-required")).toBe(true);
    expect(guardEnforces("policy")).toBe(false);
    expect(guardEnforces(undefined)).toBe(false);
    expect(guardEnforces("local-exception")).toBe(false);
    expect(guardEnforces("chunked-external", true)).toBe(false); // explicit owner permission
  });
});

describe("transcription exec guard plugin", () => {
  it("blocks a disallowed local transcriber before execution, in both exec_run and bash", () => {
    const executed: string[] = [];
    const handlers = guardHandlers(transcriptionExecGuardPlugin({ route: "chunked-external" }));

    const blocked = callTool(handlers, "exec_run", { argv: ["whisperkit-cli", "transcribe", "/a.wav"] }, executed);
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("WhisperKit");
    expect(callTool(handlers, "exec_run", { argv: ["/usr/local/bin/whisperkit-cli", "--model", "base"] }, executed).blocked).toBe(true);
    expect(callTool(handlers, "bash", { command: "python3 -m whisper /a.wav" }, executed).blocked).toBe(true);
    expect(executed).toEqual([]); // the blocked CLI never executed
  });

  it("leaves allowed, non-transcription exec untouched", () => {
    const executed: string[] = [];
    const handlers = guardHandlers(transcriptionExecGuardPlugin({ route: "probe-required" }));
    expect(callTool(handlers, "exec_run", { argv: ["yt-dlp", "--skip-download", "--list-subs", "https://x"] }, executed).blocked).toBe(false);
    expect(callTool(handlers, "read", { path: "/tmp/x" }, executed).blocked).toBe(false);
    expect(executed).toEqual(["exec_run", "read"]);
  });

  it("does not block WhisperKit for a short-audio (policy) task or an explicit local exception", () => {
    const executed: string[] = [];
    expect(guardToolCall({ toolName: "exec_run", input: { argv: ["whisperkit-cli"] } }, "policy")).toBeUndefined();
    expect(guardToolCall({ toolName: "exec_run", input: { argv: ["whisperkit-cli"] } }, "local-exception")).toBeUndefined();
    expect(guardToolCall({ toolName: "exec_run", input: { argv: ["whisperkit-cli"] } }, "chunked-external", true)).toBeUndefined();
    expect(executed).toEqual([]);
  });

  it("blocks a disallowed transcriber at every bash command position; echo -m whisper stays allowed", () => {
    const executed: string[] = [];
    const handlers = guardHandlers(transcriptionExecGuardPlugin({ route: "chunked-external" }));
    expect(callTool(handlers, "bash", { command: "echo ok; whisperkit-cli /a.wav" }, executed).blocked).toBe(true);
    expect(callTool(handlers, "bash", { command: "true && whisper /a.wav" }, executed).blocked).toBe(true);
    expect(callTool(handlers, "bash", { command: "echo whisper is fine" }, executed).blocked).toBe(false);
    expect(callTool(handlers, "bash", { command: "echo -m whisper" }, executed).blocked).toBe(false);
    expect(executed).toEqual(["bash", "bash"]); // only the two allowed calls reached execution
  });

  it("builds a guard from the durable policy marker, and nothing without one", () => {
    const withMarker = transcriptionGuardForInstructions(`${LONG}\nTRANSCRIPTION POLICY (owner instruction): ...`);
    expect(withMarker).toBeDefined();
    const executed: string[] = [];
    const handlers = guardHandlers(withMarker!);
    expect(callTool(handlers, "exec_run", { argv: ["whisperkit-cli", "x"] }, executed).blocked).toBe(true);

    expect(transcriptionGuardForInstructions("just write it, no audio here")).toBeUndefined();
    expect(transcriptionGuardForInstructions(transcriptionPolicyMarker("policy"))).toBeUndefined();
  });
});
