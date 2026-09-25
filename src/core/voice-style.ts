// ─── Minimal voice communication ────────────────────────────────────────────
//
// "No technical details" is two mechanisms, not one:
//
//   1. VOICE_STYLE_DIRECTIVE — a prompt-side line that changes what the model
//      SAYS. Only the model knows that "the redirect bug in the auth middleware"
//      is the listenable form of "fixed src/auth/mw.ts:42", or that a full path
//      was asked for rather than leaked.
//   2. applyVoiceStyle() — a deterministic filter that changes what LEAVES, and
//      is therefore the guarantee. It cannot understand meaning, so it only
//      removes what is unambiguously unlistenable: URLs, code fences, markdown,
//      commit hashes, emoji, and the directory part of a path.
//
// Pure and dependency-free so both callers (the reply path and the speech path)
// can use it and tests can pin the contract.

/** One line appended to a turn when the mode is on. Suffix, so internal-prompt detection is unaffected. */
export const VOICE_STYLE_DIRECTIVE =
  "Replying for listening (voice): at most 4 short sentences, plain spoken language. " +
  "No URLs, no code, no markdown, no hashes or model names. Name a file by its file name, not its path — " +
  "give a full path only when the request explicitly asks for one.";

export type VoiceStyleOptions = {
  /** cap spoken output at N sentences (omit for no cap) */
  maxSentences?: number;
  /** hard character ceiling, applied at a sentence boundary (omit for no cap) */
  maxChars?: number;
};

/**
 * Operational notices the bot sends about itself (failures, queueing, pairing).
 * A minimal mode that hid "your message was queued" would recreate exactly the
 * silence this project spent a night eliminating, so callers must skip filtering
 * for these — and the prefix set is the contract, not a suggestion.
 */
const NOTICE_PREFIXES = ["⚠️", "⚠︎", "🪫", "🔑", "⛔️", "⛔"];

export function isOperationalNotice(text: string): boolean {
  const t = text.trimStart();
  return NOTICE_PREFIXES.some((p) => t.startsWith(p));
}

/** Provider names precise enough to drop a `provider/model` spec without guessing. */
const PROVIDER_RX = /\b(?:ollama|openai|openai-codex|openrouter|anthropic|google|deepinfra|groq|mistral|lyceum|moonshotai)\/[\w.:-]{3,}\b/gi;
/** Fenced code, inline code, markdown links, emphasis, headings, quotes, list markers. */
const FENCE_RX = /```[\w-]*\n?([\s\S]*?)```/g;
const INLINE_CODE_RX = /`([^`\n]+)`/g;
const MD_LINK_RX = /\[([^\]\n]+)\]\([^)\s]+\)/g;
const URL_RX = /\bhttps?:\/\/[^\s<>()"']+/gi;
const HEADING_RX = /^\s{0,3}#{1,6}\s+/gm;
const QUOTE_RX = /^\s{0,3}>\s?/gm;
const BULLET_RX = /^\s{0,3}(?:[-*+]|\d{1,2}[.)])\s+/gm;
const EMPHASIS_RX = /(\*\*|__|\*|_)(?=\S)([\s\S]*?\S)\1/g;
/** At least one hex letter, so plain numbers and long digit runs survive. */
const COMMIT_RX = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
/** Path tokens: leading / or ~ or 2+ slashes, ending in a file-ish name. */
const PATH_RX = /(?<![\w/~.-])(?:~\/|\/|(?:[\w.-]+\/){2,})(?:[\w.-]+\/)*([\w.-]+)/g;
const EMOJI_RX = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

function shortenPaths(text: string): string {
  return text.replace(PATH_RX, (_m, base: string) => base);
}

function cap(text: string, opts: VoiceStyleOptions): string {
  const maxSentences = opts.maxSentences ?? 0;
  const maxChars = opts.maxChars ?? 0;
  if (!maxSentences && !maxChars) return text;
  const sentences = text.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  let kept = maxSentences ? sentences.slice(0, maxSentences) : [...sentences];
  let out = kept.join(" ");
  if (maxChars && out.length > maxChars) {
    const within = kept.filter((_, i) => kept.slice(0, i + 1).join(" ").length <= maxChars);
    const trimmed = within.join(" ");
    if (trimmed) out = trimmed;
  }
  return out || text; // never silence: the cap gives way, not the reply
}

/**
 * Turn a written reply into something that can be listened to. Idempotent, and
 * never returns empty for non-empty input (the "never send nothing" rule).
 */
export function applyVoiceStyle(text: string, opts: VoiceStyleOptions = {}): string {
  if (!text?.trim()) return text ?? "";
  let out = text;
  out = out.replace(FENCE_RX, (_m, inner: string) => ` ${String(inner).replace(/\n+/g, " ")} `);
  out = out.replace(INLINE_CODE_RX, "$1");
  out = out.replace(MD_LINK_RX, "$1");
  out = out.replace(URL_RX, "");
  out = out.replace(PROVIDER_RX, "");
  out = out.replace(COMMIT_RX, "");
  out = shortenPaths(out);
  out = out.replace(HEADING_RX, "").replace(QUOTE_RX, "").replace(BULLET_RX, "");
  out = out.replace(EMPHASIS_RX, "$2");
  out = out.replace(EMOJI_RX, "");
  out = out
    // Speech has no line breaks: a bullet list or a fenced block must read as one
    // flowing sentence, otherwise the filter leaves orphaned newlines behind.
    .replace(/\n+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();
  const capped = cap(out, opts);
  return capped.trim() || out.trim() || text.trim();
}
