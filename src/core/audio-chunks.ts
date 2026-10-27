/**
 * Real duration-aware Groq chunk execution (bd pibot-0xpf.4).
 *
 * The standing owner rule (quoted verbatim in `LONG_AUDIO_RULE`) is that >15 min
 * audio is transcribed in chunks of <=15 min through Groq and never swapped for
 * local WhisperKit. `planTranscription` decides that route; this module is the
 * executor that actually splits the file and runs the approved provider, one
 * chunk at a time, joining the transcripts in order.
 *
 * Everything that touches the outside world — the duration probe, ffmpeg
 * segmentation and the per-chunk provider call — is dependency-injected, so the
 * behaviour is exercised with mocks and temp fixtures only (no live audio, no
 * network, no ffmpeg install). The real ffprobe/ffmpeg helpers are exported here
 * for the host to bind at the call site.
 *
 * Failure is precise and terminal: a failed probe, a failed segment or a failed
 * chunk returns `ok:false` naming the step. There is NO local fallback — routing
 * around a blocked Groq is the exact failure this work exists to prevent.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "./util.js";
import {
  LONG_AUDIO_CHUNK_SEC,
  planTranscription,
  type TranscriptionDurationInput,
  type TranscriptionPlan,
  type TranscriptionRoute,
} from "./transcription-policy.js";

export const DEFAULT_CHUNK_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_CHUNK_SEGMENT_TIMEOUT_MS = 180_000;

/** Minimal shape of a provider result; avoids coupling this executor to SttService. */
export interface ChunkProviderResult {
  ok: boolean;
  text: string;
  provider: string;
  error?: string;
}

export interface ChunkedTranscriptionDeps {
  /** probe the media duration in seconds; null = could not determine */
  probeDurationSec: (filePath: string) => Promise<number | null>;
  /** split the file into ordered chunk paths of at most `chunkSeconds` each */
  segment: (filePath: string, chunkSeconds: number) => Promise<string[]>;
  /** transcribe ONE chunk with the approved (Groq-only) provider */
  transcribeChunk: (audioPath: string, index: number) => Promise<ChunkProviderResult>;
  /** best-effort removal of the produced chunk files (called even on failure) */
  cleanupParts?: (paths: string[]) => Promise<void>;
}

export interface ChunkedTranscriptionResult {
  ok: boolean;
  route: TranscriptionRoute;
  /** "groq" only when the transcripts came back; "none" on any block */
  provider: "groq" | "none";
  text: string;
  durationSec: number | null;
  chunks: number;
  transcripts: string[];
  /** precise, actionable reason when ok=false — never a silent substitution */
  error?: string;
}

function blocked(plan: TranscriptionPlan, error: string): ChunkedTranscriptionResult {
  return {
    ok: false,
    route: plan.route,
    provider: "none",
    text: "",
    durationSec: plan.durationSec,
    chunks: 0,
    transcripts: [],
    error,
  };
}

/**
 * Execute the long-audio Groq route. Probes the duration when the planner could
 * not (unknown duration), re-plans with the real value, then segments and
 * transcribes in order. Any failure returns `ok:false` with a precise blocker.
 */
export async function runChunkedTranscription(
  filePath: string,
  planInput: TranscriptionDurationInput,
  deps: ChunkedTranscriptionDeps,
): Promise<ChunkedTranscriptionResult> {
  let plan = planTranscription(planInput);

  // Unknown duration: probe first (never assume long, never assume short).
  if (plan.requiresProbe) {
    const probed = await deps.probeDurationSec(filePath).catch(() => null);
    if (probed == null || !Number.isFinite(probed) || probed <= 0) {
      return blocked(plan, `${plan.blocker ?? "audio duration is unknown"} The probe returned no usable duration, so no chunk plan exists — refusing to transcribe.`);
    }
    plan = planTranscription({ ...planInput, durationSec: probed });
  }

  // A blocked route must never reach the provider — report, never substitute.
  if (!plan.ok || plan.route === "blocked") {
    return blocked(plan, plan.blocker ?? "the approved transcription route is unavailable");
  }
  // This executor only owns the chunked-external route; other routes belong to the
  // normal path and must not be silently serviced here.
  if (plan.route !== "chunked-external") {
    return blocked(plan, `the chunked executor only runs the long-audio Groq route (got "${plan.route}") — route this audio through the normal transcription path`);
  }

  const chunkSeconds = plan.chunkSeconds ?? LONG_AUDIO_CHUNK_SEC;
  const durationSec = plan.durationSec;

  let parts: string[];
  try {
    parts = await deps.segment(filePath, chunkSeconds);
  } catch (error) {
    return {
      ok: false,
      route: "chunked-external",
      provider: "none",
      text: "",
      durationSec,
      chunks: 0,
      transcripts: [],
      error: `chunk segmentation failed: ${errorMessage(error)} — no local fallback attempted`,
    };
  }
  if (!parts.length) {
    return {
      ok: false,
      route: "chunked-external",
      provider: "none",
      text: "",
      durationSec,
      chunks: 0,
      transcripts: [],
      error: "chunk segmentation produced no chunks — refusing to transcribe the whole file uncut",
    };
  }

  const transcripts: string[] = [];
  try {
    for (let i = 0; i < parts.length; i++) {
      const result = await deps
        .transcribeChunk(parts[i], i)
        .catch((error): ChunkProviderResult => ({ ok: false, text: "", provider: "none", error: errorMessage(error) }));
      if (!result.ok) {
        return {
          ok: false,
          route: "chunked-external",
          provider: "none",
          text: "",
          durationSec,
          chunks: parts.length,
          transcripts,
          error: `chunk ${i + 1}/${parts.length} failed: ${result.error ?? "unknown error"} — Groq chunks are the only permitted route at this duration; no local fallback attempted`,
        };
      }
      transcripts.push(result.text.trim());
    }
  } finally {
    if (deps.cleanupParts) await deps.cleanupParts(parts).catch(() => {});
  }

  return {
    ok: true,
    route: "chunked-external",
    provider: "groq",
    text: transcripts.filter(Boolean).join("\n\n").trim(),
    durationSec,
    chunks: parts.length,
    transcripts,
  };
}

// ── real (host) IO helpers — bound at the call site via dependency injection ──

function runExecCapture(execFn: typeof execFile, bin: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFn(bin, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`${path.basename(bin)} failed: ${errorMessage(error)}`));
      else resolve(stdout.toString());
    });
  });
}

/** Best-effort `command -v <name>`: the resolved binary path, or null. */
export function resolveExecutable(execFn: typeof execFile, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFn("sh", ["-c", `command -v ${name}`], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

/**
 * Probe a media file's duration with ffprobe. Returns null when ffprobe is
 * absent or the output is not a usable positive number — the caller turns that
 * into a precise blocker instead of guessing a duration.
 */
export async function probeDurationSecWithFfprobe(
  execFn: typeof execFile,
  filePath: string,
  binOverride?: string | null,
  timeoutMs: number = DEFAULT_CHUNK_PROBE_TIMEOUT_MS,
): Promise<number | null> {
  const bin = binOverride !== undefined ? binOverride : await resolveExecutable(execFn, "ffprobe");
  if (!bin) return null;
  try {
    const stdout = await runExecCapture(execFn, bin, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path.resolve(filePath)], timeoutMs);
    const value = Number(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Split a media file into <= chunkSeconds PCM chunks with ffmpeg's segment muxer
 * and return their paths in playback order. Re-encoding to 16 kHz mono WAV keeps
 * chunk boundaries exact and decode-safe for the provider.
 */
export async function segmentAudioWithFfmpeg(
  execFn: typeof execFile,
  filePath: string,
  chunkSeconds: number,
  outDir: string,
  binOverride?: string | null,
  timeoutMs: number = DEFAULT_CHUNK_SEGMENT_TIMEOUT_MS,
): Promise<string[]> {
  const bin = binOverride !== undefined ? binOverride : await resolveExecutable(execFn, "ffmpeg");
  if (!bin) throw new Error("ffmpeg is not installed");
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  await runExecCapture(
    execFn,
    bin,
    [
      "-nostdin", "-v", "error", "-i", path.resolve(filePath),
      "-ac", "1", "-ar", "16000",
      "-f", "segment", "-segment_time", String(chunkSeconds),
      "-y", path.join(outDir, "chunk-%03d.wav"),
    ],
    timeoutMs,
  );
  return fs
    .readdirSync(outDir)
    .filter((name) => name.startsWith("chunk-") && name.endsWith(".wav"))
    .sort()
    .map((name) => path.join(outDir, name));
}
