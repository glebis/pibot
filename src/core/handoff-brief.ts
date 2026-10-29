/**
 * Handoff context packaging. A handoff must carry "just enough" context: not a
 * raw transcript dump, but a task-oriented brief the target agent can execute
 * without re-asking the user. The brief is distilled by an ephemeral
 * cheap-model session; when no model runtime is available the raw transcript
 * excerpt is used as-is (graceful degradation).
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { trackActivity } from "./activity.js";
import { declaredTranscriptionRoute, LONG_AUDIO_RULE } from "./transcription-policy.js";

const BRIEF_SYSTEM = `You package a conversation for handoff to another AI agent. Given the recent transcript, write a brief that lets the target agent continue — and execute the task — without asking the user to repeat anything.

If the work involves transcribing audio longer than 15 minutes, record this owner rule verbatim in the Context section so it survives the handoff: "${LONG_AUDIO_RULE}".

Use exactly these sections, each a short line or two; omit a section only if it truly has no content:
- Task: what the user wants done, in one or two sentences
- Context: decisions, constraints, preferences and facts from the conversation that affect execution
- Artifacts: concrete identifiers mentioned (file paths, links, ids, names) — verbatim
- Done: what has already been completed or tried
- Next: the immediate next action for the target agent

Rules: keep the whole brief under 1200 characters; never invent anything not in the transcript; if there is no task at all, reply exactly "No active task — small talk only."`;

export interface HandoffBriefResult {
  brief: string;
  /** "model" = distilled brief, "fallback" = raw excerpt (no model available or model failed) */
  via: "model" | "fallback";
}

/** Pure: clean a model reply into a usable brief (strip code fences and whitespace). */
export function extractBriefText(raw: string): string | null {
  const text = raw
    .replace(/```[a-z]*\n?/gi, "")
    .trim();
  return text || null;
}

/** Pure: the prompt envelope delivered to the target agent (keeps the `[handoff from` internal-prompt prefix). */
export function buildHandoffEnvelope(
  fromAgent: string,
  brief: string,
  note?: string,
  opts: { includeLongAudioRule?: boolean } = {},
): string {
  return [
    `[handoff from "${fromAgent}"] The user is moving this conversation to you. Continue where this left off — acknowledge in one short line, then pick up the thread.`,
    ``,
    `# Handoff brief`,
    brief,
    // Deterministic carry (bd pibot-0xpf.4 review): when the handoff involves long-audio
    // transcription, the canonical owner rule is attached by THIS envelope, not left to
    // the model to reproduce from the brief.
    ...(opts.includeLongAudioRule ? [``, `# Owner policy (verbatim)`, LONG_AUDIO_RULE] : []),
    ...(note ? [``, `# Note from ${fromAgent}`, note] : []),
  ].join("\n");
}

/**
 * Whether a handoff source already carries the long-audio policy — either the durable
 * task policy marker prepended to instructions, or the canonical rule wording. The host
 * uses this to decide `includeLongAudioRule`, so the carry is deterministic rather than
 * a hope that the model repeated the rule in its brief.
 */
export function handoffNeedsLongAudioRule(source: string): boolean {
  const text = source ?? "";
  if (declaredTranscriptionRoute(text) !== undefined) return true;
  return text.includes("WhisperKit") && /15\s*min/i.test(text);
}

/** Distill a transcript excerpt into a handoff brief via an ephemeral cheap-model session. */
export async function composeHandoffBrief(
  excerpt: string,
  opts: { modelRuntime?: ModelRuntime; model?: ReturnType<ModelRuntime["getModel"]>; cwd?: string }
): Promise<HandoffBriefResult> {
  if (!opts.modelRuntime) return { brief: excerpt, via: "fallback" };
  const cwd = opts.cwd ?? process.cwd();
  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: BRIEF_SYSTEM,
    });
    await loader.reload();
    const session = (
      await createAgentSession({
        cwd,
        agentDir: getAgentDir(),
        modelRuntime: opts.modelRuntime,
        model: opts.model,
        thinkingLevel: "off",
        tools: [],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      })
    ).session;
    try {
      await trackActivity({ kind: "handoff-brief", label: "package handoff brief", session }, () => session.prompt(`Transcript to package:\n\n${excerpt}`));
      const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      const raw = (last?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join(" ");
      const brief = extractBriefText(raw);
      if (brief) return { brief, via: "model" };
    } finally {
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* model unavailable or failed → fall through to the raw excerpt */
  }
  return { brief: excerpt, via: "fallback" };
}