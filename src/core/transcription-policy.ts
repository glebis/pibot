/**
 * Duration-aware transcription policy (bd pibot-0xpf.4).
 *
 * Standing owner instruction (2026-10-21): audio longer than 15 minutes must be
 * transcribed in chunks of at most 15 minutes through Groq. Local WhisperKit is
 * NOT an acceptable substitute at that duration. On 2026-10-26 a 27-minute talk
 * was routed to local WhisperKit after caption throttling — exactly the silent
 * substitution the owner had already ruled out.
 *
 * This module turns that rule into a decision the host can carry: the approved
 * route for a given duration, the chunk size, and a precise blocker when the
 * approved route is unavailable. It never returns a disallowed provider as a
 * quiet fallback — a caller that ignores the plan is the bug, and the plan says
 * so in words.
 */
import { DEFAULT_STT_PROVIDERS, sttProviderChain, sttProvidersFromEnv, type SttPolicy, type SttProviderId } from "./stt.js";

/** Owner rule: audio above this duration must be chunked. */
export const LONG_AUDIO_THRESHOLD_SEC = 15 * 60;
/** Chunk size used for long audio. */
export const LONG_AUDIO_CHUNK_SEC = 15 * 60;

/**
 * Canonical one-line owner rule. Kept here so the agent capability prompt, the
 * delegated-task contract and the handoff brief all quote the same sentence
 * instead of paraphrasing it into drift.
 */
export const LONG_AUDIO_RULE =
  "audio longer than 15 minutes must be transcribed in chunks of <=15 min through Groq; never substitute local WhisperKit at that duration — if Groq is unavailable, report the blocker instead of transcribing locally";

/**
 * Stable, machine-readable tag prefixed to a delegated task's instructions when it
 * declares transcription work (bd pibot-0xpf.4 review). It is prepended (see
 * tasks-plugin) so it survives the instructions length cap untruncated, and it is a
 * specific sentinel — never inferred from the bare word "audio".
 */
export const TRANSCRIPTION_POLICY_MARKER = "[pibot:transcription-policy]";

/** The durable marker line carrying the declared route, e.g. `[pibot:transcription-policy] route=chunked-external`. */
export function transcriptionPolicyMarker(route: TranscriptionRoute): string {
  return `${TRANSCRIPTION_POLICY_MARKER} route=${route}`;
}

/** Read the declared route back out of a task's durable instructions. Undefined when no marker is present. */
export function declaredTranscriptionRoute(instructions: string): TranscriptionRoute | undefined {
  const idx = (instructions ?? "").indexOf(TRANSCRIPTION_POLICY_MARKER);
  if (idx < 0) return undefined;
  const match = /^\s*route\s*=\s*([a-z-]+)/i.exec(instructions.slice(idx + TRANSCRIPTION_POLICY_MARKER.length));
  return match ? (match[1].toLowerCase() as TranscriptionRoute) : undefined;
}

export interface TranscriptionDurationInput {
  /**
   * Probed duration of the audio. `null`/`undefined` means unknown, which is
   * treated as long: we cannot prove it is short, and the reported failure mode
   * is precisely a long file slipping past a short-audio assumption.
   */
  durationSec: number | null | undefined;
  /** agent speech policy in effect (manifest.speech) */
  policy?: SttPolicy;
  /** host-enabled providers (the SttService provider set); defaults to STT_PROVIDERS/env defaults */
  hostProviders?: readonly string[];
  /**
   * Presence-only result of a Groq credential check (never the value). `false` is the
   * only value that proves the credential layer is missing; `undefined` means unknown.
   */
  groqCredentialPresent?: boolean;
  /**
   * Explicit, owner-recorded permission to transcribe >15-minute audio with the
   * local chain. Never inferred and never persisted — it must come from the owner.
   */
  localLongAudioPermission?: boolean;
}

export type TranscriptionRoute = "policy" | "chunked-external" | "local-exception" | "blocked" | "probe-required";

/**
 * Which layer actually lacks the approved Groq route. Declared agent policy, host
 * enablement and credentials are distinct layers; conflating them made the blocker
 * tell the owner to re-enable fields that were already true (bd pibot-hn90).
 */
export type TranscriptionBlockerLayer = "agent-policy" | "host-provider" | "credential" | "unknown";

export interface TranscriptionPlan {
  longAudio: boolean;
  durationKnown: boolean;
  durationSec: number | null;
  /** the caller must probe the media duration (ffprobe) before a route exists */
  requiresProbe: boolean;
  ok: boolean;
  route: TranscriptionRoute;
  providers: SttProviderId[];
  chunkSeconds: number | null;
  chunks: number | null;
  /** canonical constraint text to carry into a delegated task spec / instructions */
  constraint: string;
  /** precise, actionable reason when ok=false */
  blocker?: string;
  /** the layer named by `blocker` when the long-audio route is unavailable */
  blockerLayer?: TranscriptionBlockerLayer;
  /** set only for route "local-exception" */
  exception?: string;
}

function minutes(sec: number): string {
  return (sec / 60).toFixed(1);
}

function durationLabel(durationSec: number | null): string {
  return durationSec == null ? "of unknown length" : `is ${minutes(durationSec)} min`;
}

/** The approved-route sentence appended to a delegated task's instructions. */
function longAudioConstraint(durationSec: number | null, chunks: number | null): string {
  const chunkText = chunks && chunks > 1 ? `${chunks} chunks of <=15 min` : "chunks of <=15 min";
  return `TRANSCRIPTION POLICY (owner instruction): this audio ${durationLabel(durationSec)} (>15 min) — transcribe it ONLY in ${chunkText} through Groq; do NOT fall back to WhisperKit or any local provider for any chunk. If Groq is unavailable, stop and report the blocker instead of substituting another provider.`;
}

/**
 * Name the layer that is actually missing the Groq route. Only a layer this function
 * can prove missing is reported as such; when the caller did not supply the host
 * provider set, it says so instead of guessing and blaming the agent manifest.
 */
function groqBlockerLayer(input: TranscriptionDurationInput, policy: SttPolicy): { layer: TranscriptionBlockerLayer; detail: string } {
  const requested = policy.providers ?? [...DEFAULT_STT_PROVIDERS];
  const declaresGroq = requested.includes("groq");
  if (!declaresGroq) {
    return { layer: "agent-policy", detail: `the agent's speech.sttProviders does not list "groq".` };
  }
  if (policy.allowExternal !== true) {
    return { layer: "agent-policy", detail: `the agent's speech.sttProviders lists "groq" but speech.allowExternalStt is not true, so external STT is disabled.` };
  }
  if (input.hostProviders === undefined) {
    return {
      layer: "unknown",
      detail: `the agent manifest already requests groq with external STT allowed; the planner was not given the host provider set, so the remaining layers are host enablement (STT_PROVIDERS) or the Groq credential — NOT the agent manifest.`,
    };
  }
  if (!input.hostProviders.includes("groq")) {
    return { layer: "host-provider", detail: `the host STT provider set (STT_PROVIDERS) does not enable "groq"; the agent manifest is already correct.` };
  }
  if (input.groqCredentialPresent === false) {
    return { layer: "credential", detail: `the host enables "groq" and the agent permits it, but no Groq credential (GROQ_API_KEY) is present.` };
  }
  return { layer: "unknown", detail: `groq is declared, host-enabled and permitted; the route is blocked for a reason this planner cannot see.` };
}

/**
 * Decide the transcription route for one audio file. Pure — no IO, no network.
 * Returns `ok:false` with a precise blocker when the approved long-audio route
 * is unavailable, never a disallowed provider.
 */
export function planTranscription(input: TranscriptionDurationInput): TranscriptionPlan {
  const durationKnown = typeof input.durationSec === "number" && Number.isFinite(input.durationSec);
  const durationSec = durationKnown ? Math.max(0, input.durationSec as number) : null;
  const chain = sttProviderChain(input.hostProviders ?? sttProvidersFromEnv(), input.policy ?? {});
  const localChain = chain.filter((provider) => provider !== "groq");
  // A route with no credential is not usable: only `false` disproves it, `undefined` means unchecked.
  const groqPermitted = chain.includes("groq") && input.groqCredentialPresent !== false;

  // An explicit, owner-recorded permission overrides the duration rule — it is
  // recorded intent, never inferred from a missing/unknown duration.
  if (input.localLongAudioPermission && localChain.length) {
    return {
      longAudio: true,
      durationKnown,
      durationSec,
      requiresProbe: false,
      ok: true,
      route: "local-exception",
      providers: localChain,
      chunkSeconds: null,
      chunks: 1,
      exception: "owner-permitted local transcription of >15-minute audio",
      constraint: `TRANSCRIPTION POLICY (explicit owner exception): this audio ${durationLabel(durationSec)} may run on the local chain (${localChain.join(" -> ")}) because the owner recorded a specific permission for it.`,
    };
  }

  // Unknown duration is NOT asserted to be long. Marking unknown audio ">15 min"
  // is the same class of guess as the incident this guards against (a long file
  // slipping past a short-audio assumption), just pointed the other way. Require a
  // probe; the executor probes first and re-plans with the real duration.
  if (durationSec == null) {
    return {
      longAudio: false,
      durationKnown: false,
      durationSec: null,
      requiresProbe: true,
      ok: false,
      route: "probe-required",
      providers: [],
      chunkSeconds: null,
      chunks: null,
      blocker: "audio duration is unknown — probe it (ffprobe) before choosing a transcription route; this planner will not assume the file is short or >15 minutes.",
      constraint: `TRANSCRIPTION POLICY (owner instruction): this audio's duration is unknown — PROBE it (ffprobe) FIRST, then route by the result: <=15 min may use the agent's local chain, >15 min must use chunks of <=15 min through Groq and NEVER local WhisperKit. If the probe fails, stop and report the blocker instead of guessing.`,
    };
  }

  const longAudio = durationSec > LONG_AUDIO_THRESHOLD_SEC;
  if (!longAudio) {
    const ok = chain.length > 0;
    return {
      longAudio: false,
      durationKnown,
      durationSec,
      requiresProbe: false,
      ok,
      route: ok ? "policy" : "blocked",
      providers: chain,
      chunkSeconds: null,
      chunks: 1,
      constraint: `TRANSCRIPTION POLICY: this audio ${durationLabel(durationSec)} (<=15 min) — the agent's configured STT chain applies (${chain.join(" -> ") || "none"}).`,
      ...(ok ? {} : { blocker: "no STT provider permitted by this agent's speech policy" }),
    };
  }

  const chunks = Math.max(1, Math.ceil(durationSec / LONG_AUDIO_CHUNK_SEC));

  if (groqPermitted) {
    return {
      longAudio: true,
      durationKnown,
      durationSec,
      requiresProbe: false,
      ok: true,
      route: "chunked-external",
      providers: ["groq"],
      chunkSeconds: LONG_AUDIO_CHUNK_SEC,
      chunks,
      constraint: longAudioConstraint(durationSec, chunks),
    };
  }

  const { layer, detail } = groqBlockerLayer(input, input.policy ?? {});
  const blocker = `audio ${durationLabel(durationSec)} is longer than 15 minutes: the standing owner policy requires chunks of <=15 min through Groq, but the Groq route is unusable. Missing layer: ${layer}. ${detail} Local WhisperKit is not a permitted substitute at this duration.`;
  return {
    longAudio: true,
    durationKnown,
    durationSec,
    requiresProbe: false,
    ok: false,
    route: "blocked",
    providers: [],
    chunkSeconds: LONG_AUDIO_CHUNK_SEC,
    chunks,
    blocker,
    blockerLayer: layer,
    constraint: `TRANSCRIPTION POLICY (owner instruction): this audio ${durationLabel(durationSec)} (>15 min) and the approved route (chunks of <=15 min via Groq) is unavailable — do NOT transcribe it locally; return this blocker to the owner instead: ${blocker}`,
  };
}

/** Constraint line for a delegated task spec, without the caller holding a plan. */
export function transcriptionTaskConstraint(input: TranscriptionDurationInput): string {
  return planTranscription(input).constraint;
}

/** Compact, evidence-shaped record of the route actually chosen (for task records / logs). */
export function formatTranscriptionPlan(plan: TranscriptionPlan): string {
  const dur = plan.durationSec != null ? `${minutes(plan.durationSec)} min` : "duration unknown";
  const route =
    plan.route === "chunked-external"
      ? `chunked-external (${plan.chunks ?? "?"} x <=${plan.chunkSeconds ? plan.chunkSeconds / 60 : 15} min via ${plan.providers.join(",")})`
      : plan.route === "local-exception"
        ? `local-exception (${plan.providers.join(",") || "none"}) - ${plan.exception ?? ""}`
        : plan.route === "policy"
          ? `policy (${plan.providers.join(" -> ") || "none"})`
          : plan.route === "probe-required"
            ? "probe-required (duration unknown — ffprobe first)"
            : `blocked (missing layer: ${plan.blockerLayer ?? "unknown"})`;
  return `[transcription] ${dur} - ${route}${plan.blocker ? ` - blocker: ${plan.blocker}` : ""}`;
}
