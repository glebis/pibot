// ─── Research-intake primitives: typed questions over the QuestionBus ─────────
// Thin, reusable building blocks for intake flows. Every helper:
//   - preserves the one-pending-question constraint (QuestionBus enforces it),
//   - keeps the free-text fallback (any typed message answers; voice arrives as
//     transcribed text through the same interception path),
//   - returns a normalized IntakeAnswer with modality + skipped flags so
//     analytics can distinguish modality and skip rates.

import type { ChatRef } from "./types.js";
import type { QuestionAnswer, QuestionSpec } from "./questions.js";

export type AskFn = (
  chat: { transport: string; chatId: string },
  spec: QuestionSpec
) => Promise<QuestionAnswer>;

export type IntakeModality = "button" | "poll" | "text" | "voice" | "none";

export interface IntakeAnswer<T = string | number | boolean | undefined> {
  /** the parsed answer; undefined when timed out / replaced / invalid */
  value?: T;
  /** answer modality as recorded by the question surface */
  modality: IntakeModality;
  /** true when the question expired, was replaced, or was answered emptily */
  skipped: boolean;
  /** the raw QuestionAnswer, for drill-down */
  raw: QuestionAnswer;
}

function modalityOf(raw: QuestionAnswer, source?: "text" | "voice"): IntakeModality {
  if (source === "voice" && raw.via === "text") return "voice";
  if (raw.via === "button") return "button";
  if (raw.via === "poll") return "poll";
  if (raw.via === "text") return "text";
  return "none";
}

function wrap<T>(raw: QuestionAnswer, parse: (r: QuestionAnswer) => T, source?: "text" | "voice"): IntakeAnswer<T> {
  const skipped = Boolean(raw.timedOut || raw.replaced) || (raw.index === -1 && raw.via !== "text");
  return {
    value: skipped ? undefined : parse(raw),
    modality: modalityOf(raw, source),
    skipped,
    raw,
  };
}

/** Choice question: ≤6 options → inline buttons; >6 → native poll (automatic). */
export async function askChoice(
  ask: AskFn,
  chat: { transport: string; chatId: string },
  text: string,
  options: string[],
  opts: { timeoutMs?: number; poll?: boolean; source?: "text" | "voice" } = {}
): Promise<IntakeAnswer<string>> {
  const raw = await ask(chat, { text, options, timeoutMs: opts.timeoutMs, poll: opts.poll });
  return wrap(raw, (r) => r.choice, opts.source);
}

/** Yes/No question → boolean (Yes = index 0). */
export async function askConfirm(
  ask: AskFn,
  chat: { transport: string; chatId: string },
  text: string,
  opts: { timeoutMs?: number; yes?: string; no?: string; source?: "text" | "voice" } = {}
): Promise<IntakeAnswer<boolean>> {
  const yes = opts.yes ?? "Yes";
  const no = opts.no ?? "No";
  const raw = await ask(chat, { text, options: [yes, no], timeoutMs: opts.timeoutMs });
  return wrap(
    raw,
    (r) => r.choice.toLowerCase().startsWith(yes.toLowerCase()[0]) || r.index === 0,
    opts.source
  );
}

/** Scale question: numbered buttons 1..N (N ≤ 6 → buttons; more → poll). */
export async function askScale(
  ask: AskFn,
  chat: { transport: string; chatId: string },
  text: string,
  max = 5,
  opts: { timeoutMs?: number; source?: "text" | "voice" } = {}
): Promise<IntakeAnswer<number>> {
  const options = Array.from({ length: Math.max(2, Math.min(max, 10)) }, (_, i) => String(i + 1));
  const raw = await ask(chat, { text, options, timeoutMs: opts.timeoutMs });
  return wrap(raw, (r) => (Number.isInteger(r.index) && r.index >= 0 ? r.index + 1 : Number(r.choice) || 0), opts.source);
}

/** Open question: cardless message; the next typed (or voice) message is the answer. */
export async function askText(
  ask: AskFn,
  chat: { transport: string; chatId: string },
  text: string,
  opts: { timeoutMs?: number; source?: "text" | "voice" } = {}
): Promise<IntakeAnswer<string>> {
  const raw = await ask(chat, { text, options: [], timeoutMs: opts.timeoutMs });
  return wrap(raw, (r) => r.choice, opts.source);
}