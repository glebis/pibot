/**
 * Policy guard for raw exec inside a task that declared long / unknown-duration audio
 * transcription (bd pibot-0xpf.4 review).
 *
 * The durable task contract carries the transcription rule, and the `tasks` capability
 * prompt quotes it — but a delegated background run that holds the `exec` capability
 * could still invoke WhisperKit directly through `exec_run`, bypassing the contract
 * (the incident: a 27-minute talk routed to local WhisperKit after caption throttling).
 * This extension closes that specific vector: when the host attaches it to the task's
 * own session and the task DECLARED the policy via the durable marker (never an
 * inference from the bare word "audio"), a known disallowed local Whisper/WhisperKit
 * executable call is blocked BEFORE execution.
 *
 * Honest scope (no comprehensive-sandbox claim): this blocks the named local
 * transcriber binaries in the `exec_run` (and `bash`) tool input — absolute paths
 * included. It is not a general sandbox and does not cover `delegate_cli` or arbitrary
 * binaries. Short-audio and non-transcription exec behaviour is untouched.
 */
import type { ExtensionAPI, InlineExtension, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { declaredTranscriptionRoute, type TranscriptionRoute } from "../core/transcription-policy.js";

/** Tool names this guard inspects. `exec_run` is the exec capability's raw runner. */
export const GUARDED_TOOL_NAMES: readonly string[] = ["exec_run", "bash"];

/** Routes for which a local Whisper/WhisperKit substitution is forbidden. */
export const ENFORCED_ROUTES: readonly TranscriptionRoute[] = ["chunked-external", "probe-required"];

/** Known local Whisper / WhisperKit executable basenames, matched case-insensitively (absolute paths included). */
export const DISALLOWED_LOCAL_TRANSCRIBERS: readonly string[] = [
  "whisperkit-cli",
  "whisperkit",
  "whisper",
  "whisper-cli",
  "whisper-cpp",
  "whisper.cpp",
  "whisper-server",
  "faster-whisper",
  "faster_whisper",
];

function basename(command: string): string {
  const trimmed = command.trim();
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** The disallowed local transcriber a single command token names, or undefined. */
export function namedDisallowedTranscriber(command: string): string | undefined {
  if (!command || command.startsWith("-")) return undefined;
  const base = basename(command);
  return DISALLOWED_LOCAL_TRANSCRIBERS.find((name) => name === base);
}

/** True when a command token names a Python interpreter (basename form: python, python3, python3.11, py). */
function isPythonExecutable(command: string): boolean {
  const base = basename(command);
  return base === "py" || /^python(\d+(\.\d+)*)?$/.test(base);
}

/**
 * Candidate command segments from a tool input: exec_run argv, a bin/args pair, or a
 * shell command split at separators so each segment's leading word is a command
 * position (never a plain argument word: `echo whisper` is not a call).
 */
function candidateSegments(input: unknown): string[][] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.argv)) {
    const argv = record.argv.filter((a): a is string => typeof a === "string");
    return argv.length ? [argv] : [];
  }
  if (typeof record.bin === "string") {
    const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === "string") : [];
    return [[record.bin, ...args]];
  }
  if (typeof record.command === "string") {
    return record.command
      .split(/(?:&&|\|\||;|\|)/)
      .map((part) => part.trim().split(/\s+/).filter(Boolean))
      .filter((segment) => segment.length > 0);
  }
  return [];
}

/** The disallowed transcriber one command segment names, if any. */
function segmentOffender(tokens: string[]): string | undefined {
  if (namedDisallowedTranscriber(tokens[0])) return tokens[0];
  // python -m whisper / python3.11 -m faster_whisper — a real local-Whisper invocation. Only when the
  // command really IS a Python interpreter: `echo -m whisper` names no transcriber and must stay allowed.
  if (isPythonExecutable(tokens[0])) {
    for (let i = 1; i < tokens.length - 1; i++) {
      if (tokens[i] === "-m" && /^(whisper|faster[-_]whisper|whisperkit)$/i.test(tokens[i + 1])) return tokens[i + 1];
    }
  }
  return undefined;
}

/** The offending command when a tool input invokes a disallowed local transcriber, else undefined. Pure. */
export function disallowedLocalTranscriber(input: unknown): string | undefined {
  for (const tokens of candidateSegments(input)) {
    const hit = segmentOffender(tokens);
    if (hit) return hit;
  }
  return undefined;
}

export interface TranscriptionExecGuardOptions {
  /** The route the task's durable contract declared, or undefined for a task with no audio work. */
  route?: TranscriptionRoute;
  /** Explicit owner permission to transcribe long audio locally — never block then. */
  allowLocalLongAudio?: boolean;
}

/** Whether the guard enforces for a declared route. */
export function guardEnforces(route: TranscriptionRoute | undefined, allowLocalLongAudio = false): boolean {
  if (allowLocalLongAudio) return false;
  return route !== undefined && ENFORCED_ROUTES.includes(route);
}

/** The `tool_call` decision: a block result for a disallowed local transcriber, otherwise undefined. Pure. */
export function guardToolCall(
  event: { toolName: string; input?: unknown },
  route: TranscriptionRoute | undefined,
  allowLocalLongAudio = false,
): ToolCallEventResult | undefined {
  if (!guardEnforces(route, allowLocalLongAudio)) return undefined;
  if (!GUARDED_TOOL_NAMES.includes(event.toolName)) return undefined;
  const hit = disallowedLocalTranscriber(event.input);
  if (!hit) return undefined;
  return {
    block: true,
    reason: `blocked: "${hit}" is a local WhisperKit/Whisper transcriber. This task declared long or unknown-duration audio; the owner rule requires chunks of <=15 min through Groq and forbids substituting a local provider. Report the blocker instead of transcribing locally (bd pibot-0xpf.4).`,
  };
}

/** Build the guard plugin for a task's declared route. The host attaches it to that task's own session. */
export function transcriptionExecGuardPlugin(opts: TranscriptionExecGuardOptions): InlineExtension {
  return {
    name: "transcription-exec-guard",
    factory: (pi: ExtensionAPI) => {
      pi.on("tool_call", (event) =>
        guardToolCall(event as { toolName: string; input?: unknown }, opts.route, opts.allowLocalLongAudio),
      );
    },
  };
}

/**
 * Build the guard from a task's DURABLE instructions (the prepended policy marker), or
 * undefined when the task declares no long/unknown-duration audio. This is the exact
 * helper the host uses in `runLedgerTask`.
 */
export function transcriptionGuardForInstructions(instructions: string): InlineExtension | undefined {
  const route = declaredTranscriptionRoute(instructions);
  if (!guardEnforces(route)) return undefined;
  return transcriptionExecGuardPlugin({ route });
}
