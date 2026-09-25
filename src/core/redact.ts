// ─── Secret redaction, one implementation ───────────────────────────────────
//
// The event log already scrubbed its summaries; the daemon's console (which IS
// data/daemon.log) did not — so grammy/node-fetch error objects wrote live bot
// tokens straight to disk on every network flap (bd pibot-vuu: 7 occurrences,
// two sub-bot tokens leaked).
//
// One scrubber, used by both boundaries, so a new pattern lands everywhere.

const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string]> = [
  // PEM blocks (sops/age keys, private keys) — greedy across lines, first.
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[REDACTED_PRIVATE_KEY]"],
  // Telegram bot tokens, bare or inside api.telegram.org/bot<id>:<token>/ URLs.
  // The bot id is kept: it is not a credential, and it says WHICH bot failed.
  [/(?<!\d)(\d{5,12}):[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, "$1:[TELEGRAM_BOT_TOKEN_REDACTED]"],
  // Provider / platform key shapes that are unambiguous by prefix.
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
  [/\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED]"],
  // "token": "…" / token=… / api_key: … and friends.
  [
    /("(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|private[_-]?key|signing[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|credentials?|password|passwd|passphrase|secret|token)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|null|true|false|-?\d+(?:\.\d+)?)/gi,
    `$1"${REDACTED}"`,
  ],
  [
    /(\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|private[_-]?key|signing[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|credentials?|password|passwd|passphrase|secret|token)\b\s*(?:=|:)\s*)(?:Bearer\s+[^\s,;}\]]+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
    `$1${REDACTED}`,
  ],
  [/\bBearer\s+[^\s,;}\]]+/gi, `Bearer ${REDACTED}`],
];

export { REDACTED };

/** Scrub known credential forms from any string. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [rx, replacement] of PATTERNS) out = out.replace(rx, replacement);
  return out;
}
