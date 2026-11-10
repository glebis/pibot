// Correlated delegate evidence for a background task that reaches its deadline
// (bd pibot-jiqv, Nov 3 Arjay: the child returned 4 s before the parent timed out).
//
// ONLY evidence RETURNED by an `agent_ask` THIS task made is recorded. We never scan the
// filesystem or another task's/chat's output: an unrelated artifact that happens to share a
// chat or a filename could be misattributed as this task's result. A fulfilled delegate call
// may return usable work OR a refusal/blocker prose; either is labelled as a returned reply,
// never as independently verified or completed work, and a refusal never turns a failed task
// into partial output.

import { truncate } from "./util.js";

export interface DelegateEvidenceItem {
  /** agent that returned the reply */
  toAgentId: string;
  /** reply text from the delegate call (stored bounded; formatted smaller) */
  text: string;
  /** false for refusal/blocker prose: kept as context, never used to claim usable output */
  usable: boolean;
}

export interface FormatOptions {
  /** what still has to happen, supplied by the caller that knows the outcome */
  remainingGate?: string;
}

const MAX_REPLY = 1200;
/** The stored reply is larger than the display body so a path named later still survives. */
const MAX_STORED = 8000;
const MAX_ITEMS = 8;
const MAX_REFS = 6;
const MAX_REF_CHARS = 300;

const ABS_PATH = /(?:^|[\s("'`\[])((?:\/[^\s"'`()<>\[\],;]+)+)/g;
const NO_REPLY = /^\(no reply\)$/i;
/** Replies that carry no result at all (acknowledgements) — not evidence of output. */
const NO_RESULT = /^(?:no result|nothing to report|no output|nothing yet|нет результата|результата нет|нечего|пока ничего)/i;
/** Conservative refusal/blocker meta-statement at the START of a reply (EN + RU bots). */
const REFUSAL = /^(?:error:|ask failed:|delivery failed:|refused\b|blocked\b|blocker:|cannot\b|can't\b|unable to\b|i (?:cannot|can't|am unable|don't have access)|не могу|не удалось|невозможно|заблокирован|блокер|отказано|нет доступа|пока не готово|не готово)/i;
const ACK = /^(?:i (?:have )?(?:started|received|begun|am working|will|can start)|working on|started|received|in progress|acknowledged|принял|получил|начал|начала|начинаю|работаю|сделаю|приступил|в процессе)/i;
const PENDING = /(?:no (?:output|result|transcript|summary|answer)(?:\s+(?:is\s+)?available|\s+yet)?|nothing (?:to report|yet)|not (?:ready|finished|done) yet|пока (?:нет|не готов)|результат(?:а)? (?:пока )?нет|ещё не готов)/i;
const FUTURE_WORK = /(?:\b(?:will|going to|plan to|expect to|should be)\b.{0,50}\b(?:save|saved|write|written|create|created|generate|generated|finish|finished|complete|completed|deliver|delivered)\b|(?:будет|планирую|собираюсь).{0,50}(?:сохран|запиш|созда|готов|пришл))/i;
const NEGATED_WORK = /(?:\b(?:have not|has not|haven't|hasn't|did not|didn't|not yet|never)\b.{0,45}\b(?:saved?|written|wrote|created?|generated?|finished|completed?|transcribed)|(?:не|пока не).{0,45}(?:сохран|запис|созда|подготов|готов|расшифров))/i;
const RESULT_LABEL = /^(?:result|answer|summary|transcript|output|translation|draft|итог|ответ|результат|сводка|расшифровка|перевод|черновик)\s*[:—-]\s*/i;
const WORK_PRODUCT = /\b(?:wrote|saved|created|generated|transcribed|translated|summarized|produced|drafted|completed)\b|(?:записал|сохранил|создал|создала|подготовил|подготовила|расшифровал|перевёл|перевела|готов(?:о|а)?)/i;
const READY_PRODUCT = /\b(?:transcript|summary|draft|report|file|translation)\s+(?:is\s+)?ready\b/i;
const PRODUCT_OBJECT = /(?:\/[^\s]+|\b(?:file|transcript|summary|draft|report|document|translation|result)\b|(?:файл|транскрипт|расшифровк|сводк|черновик|отчёт|документ|результат))/i;

export type DelegateReplyKind = "skip" | "refusal" | "usable";

function stripReplyMarkdown(text: string): string {
  return text.trim().replace(/^(?:>\s*|[-*+]\s*|#{1,6}\s*|\*\*|__)+/, "").trim();
}

export function classifyDelegateReply(text: string): DelegateReplyKind {
  const clean = stripReplyMarkdown(text);
  if (!clean || NO_REPLY.test(clean) || NO_RESULT.test(clean)) return "skip";
  const label = clean.match(RESULT_LABEL);
  const body = label ? stripReplyMarkdown(clean.slice(label[0].length)) : clean;
  if (!body || NO_RESULT.test(body) || REFUSAL.test(body) || ACK.test(body) || PENDING.test(body) || FUTURE_WORK.test(body) || NEGATED_WORK.test(body)) return "refusal";
  if (label || READY_PRODUCT.test(clean) || (WORK_PRODUCT.test(clean) && PRODUCT_OBJECT.test(clean))) return "usable";
  // An unconstrained affirmative sentence is context, not a work product.
  return "refusal";
}

/** Absolute paths explicitly named in the delegate's returned text (never verified on disk). */
export function extractArtifactRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(ABS_PATH)) {
    const ref = match[1];
    if (!ref || ref.length < 2 || ref.length > MAX_REF_CHARS || refs.includes(ref)) continue;
    refs.push(ref);
    if (refs.length >= MAX_REFS) break;
  }
  return refs;
}

/**
 * Render correlated USABLE delegate evidence as a PARTIAL task result. Returns undefined when
 * no usable reply exists, so the caller keeps the honest failure.
 */
export function formatDelegateEvidence(items: DelegateEvidenceItem[], opts: FormatOptions = {}): string | undefined {
  const usable = items.filter((item) => item.usable && item.text.trim());
  if (!usable.length) return undefined;
  const latest = usable[usable.length - 1];
  // Refs come from the full stored text, so a path after the display cut is preserved.
  const refs = extractArtifactRefs(usable.map((item) => item.text).join("\n"));
  const head = `Delegate ${latest.toAgentId} returned a reply (correlated; delegate-returned, not independently verified).`;
  // The gate stays on line 2 so the owner-report cap (4 lines) never drops the next-step decision.
  const gate = `Remaining gate: ${opts.remainingGate ?? "confirm the returned work and any filing/delivery still required."}`;
  const body = truncate(latest.text.trim(), MAX_REPLY);
  const refsLine = refs.length
    ? `\nPaths reported by the delegate (existence not verified): ${refs.join(", ")}`
    : "";
  return `${head}\n${gate}\n${body}${refsLine}`;
}

/** Render a refusal, acknowledgement, or ambiguous reply as context. */
export function formatRefusalEvidence(item: DelegateEvidenceItem): string {
  const body = truncate(item.text.trim(), MAX_REPLY);
  return `Delegate ${item.toAgentId} returned context/refusal/blocker (correlated; not independently verified).\n${body}`;
}

/**
 * Collect replies for one task run. `report()` is the deadline path (usable replies only);
 * `finish()` marks the run over so a later reply is appended silently instead of being
 * mistaken for a fresh completion or triggering a second notification.
 */
export class DelegateEvidenceCollector {
  private items: DelegateEvidenceItem[] = [];
  /** Exact full-text keys for RETAINED items only — bounded by MAX_ITEMS, no intro-char collisions. */
  private seen = new Set<string>();

  private reported = false;

  /** onLate(note, usable): a reply that arrived after report()/finish(). */
  constructor(private readonly onLate: (note: string, usable: boolean) => void) {}

  record(toAgentId: string, text: string): void {
    const clean = text.trim();
    const kind = classifyDelegateReply(clean);
    if (kind === "skip") return;
    const item: DelegateEvidenceItem = { toAgentId, text: clean.slice(0, MAX_STORED), usable: kind === "usable" };
    // Dedupe by the full stored text (bounded), not a shared intro.
    const key = `${item.toAgentId}\u0000${item.text}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(item);
    while (this.items.length > MAX_ITEMS) {
      // Keep a usable work product through a burst of acknowledgements/refusals before
      // report() can persist it. Evict the oldest context first; memory stays bounded.
      const contextIndex = this.items.findIndex((candidate) => !candidate.usable);
      const removed = this.items.splice(contextIndex >= 0 ? contextIndex : 0, 1)[0];
      this.seen.delete(`${removed.toAgentId}\u0000${removed.text}`);
    }
    if (this.reported) {
      this.onLate(item.usable ? formatDelegateEvidence([item])! : formatRefusalEvidence(item), item.usable);
    }
  }

  /** The deadline result; sets the run as reported so later evidence is treated as late. */
  report(opts: FormatOptions = {}): string | undefined {
    const out = formatDelegateEvidence(this.items, opts);
    if (out) this.reported = true;
    return out;
  }

  /** No more result will be read from this run; later delegate replies are late evidence. */
  finish(): void {
    this.reported = true;
  }
}
