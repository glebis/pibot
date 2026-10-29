// ─── Date-backed correction of relative wording (bd pibot-wr9m) ─────────────
//
// Observed 2026-10-26 (Russian): pibusiness sent "дедлайн сегодня — 2 ноября" — the
// deadline is November 2, but the RELATIVE word "today" was wrong (the sender's
// date was 26 October). The absolute date was correct; only the relative word
// was stale/copied. Appending a warning to a confidently-false reminder leaves
// the false word the user actually reads intact, so this module REWRITES the
// relative wording from the absolute date it sits beside — deterministically and
// timezone-aware — instead of merely annotating it.
//
// Detection is delegated to `relativeDateAssociations` / `scanRelativeDateClaims`
// (fact-check.ts): only a relative word LINKED to the date (an apposition —
// "сегодня, 2 ноября", "Tomorrow is October 27") is a claim. Mere co-occurrence in
// one sentence ("Today I checked the page for the November 2 deadline." /
// "Сегодня проверил страницу: дедлайн 2 ноября.") is prose and is left untouched.
// A clause naming several unrelated dates, or mixing several offsets, is ambiguous
// and is left alone too.
//
// The reference "today" is the current instant in a NAMED timezone (shared with the
// heartbeat digest / ledger through `time-zone.ts`), never the machine's implicit
// offset and never a value carried in prose.

import { relativeDeadline } from "./deadline.js";
import { relativeDateAssociations, relativePhraseCount, replaceRelativePhrases, scanRelativeDateClaims } from "./fact-check.js";
import { DISPLAY_TIME_ZONE } from "./time-zone.js";

/** The owner's timezone, shared with the digest render and the ledger date check. */
export const OWNER_TIMEZONE = DISPLAY_TIME_ZONE;

export interface RelativeDateGuardOptions {
  now?: number | Date;
  timeZone?: string;
}

export interface RelativeDateGuardResult {
  /** explicit dates judged against a relative offset */
  checked: number;
  /** claims whose relative wording contradicted the current date */
  inconsistent: number;
  /** true when `text` was rewritten with a date-backed phrase */
  corrected: boolean;
  /** true when an inconsistency existed that could not be safely rewritten (fail safe) */
  blocked: boolean;
  /** the corrected text (identical to the input when nothing changed) */
  text: string;
  /** the offending claim substrings, for the record */
  failures: string[];
}

function timeZoneOf(opts: RelativeDateGuardOptions): string {
  return opts.timeZone || process.env.PIBOT_TIMEZONE || DISPLAY_TIME_ZONE;
}

function nowMsOf(opts: RelativeDateGuardOptions): number {
  return typeof opts.now === "number" ? opts.now : opts.now ? opts.now.getTime() : Date.now();
}

function hasCyrillic(s: string): boolean {
  return /[\u0400-\u04FF]/.test(s);
}

/**
 * Split into clause + terminator parts, keeping the terminators so the text rejoins
 * unchanged. Dots strictly between digits belong to a numeric date ("02.11.2026"), so
 * they are masked out before splitting and restored afterwards (the same fix as
 * `fact-check.splitClauses`); the final period is not between digits and still splits.
 */
function splitClausesKeepingTerminators(text: string): string[] {
  const MASK = "\u0000";
  const masked = text.replace(/(?<=\d)\.(?=\d)/g, MASK);
  return masked.split(/([.!?\n;]+)/).map((s) => s.split(MASK).join("."));
}

/**
 * Rewrite relative date wording that contradicts the absolute date beside it.
 *
 * Detection is delegated to `scanRelativeDateClaims` (fact-check.ts) so the correction
 * shares the ledger's fact-check path; the rewrite is deterministic and only touches a
 * clause whose relative word is written in apposition to exactly one explicit date.
 * A clause where the offset could not be safely attributed is reported as `blocked` so
 * the caller can fail safe instead of emitting the false wording.
 */
export function correctRelativeDateClaims(
  text: string,
  opts: RelativeDateGuardOptions = {},
): RelativeDateGuardResult {
  const timeZone = timeZoneOf(opts);
  const now = nowMsOf(opts);
  const verdict = scanRelativeDateClaims(text, { now, timeZone });
  const result: RelativeDateGuardResult = {
    checked: verdict.checked,
    inconsistent: verdict.inconsistent,
    corrected: false,
    blocked: false,
    text,
    failures: [...verdict.failures],
  };
  if (!text || verdict.inconsistent === 0) return result;

  const segments = splitClausesKeepingTerminators(text);
  for (let i = 0; i < segments.length; i += 2) {
    const segment = segments[i];
    if (!segment) continue;
    const associations = relativeDateAssociations(segment, { now, timeZone });
    if (!associations.length) continue; // no linked relative/date claim here
    const assoc = associations[0];
    if (assoc.date.daysFromNow === assoc.offset) continue; // already agrees with the calendar

    // A clause carrying another relative phrase we cannot attribute would be rewritten
    // blind by the phrase replacement — do not guess; fail safe for the whole result.
    if (relativePhraseCount(segment) !== associations.length) {
      result.blocked = true;
      continue;
    }
    const urgency = relativeDeadline(assoc.date.day, { now, timeZone, language: hasCyrillic(segment) ? "ru" : "en" });
    if (!urgency) {
      result.blocked = true;
      continue;
    }
    const rewritten = replaceRelativePhrases(segment, urgency.phrase);
    if (rewritten === segment) {
      result.blocked = true; // could not locate the token to replace — do not guess
      continue;
    }
    segments[i] = rewritten;
    result.corrected = true;
  }

  if (result.corrected) result.text = segments.join("");
  return result;
}
