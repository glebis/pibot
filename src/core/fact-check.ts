// Programmatic fact-check of numeric claims in a result text (bd pibot-wr9m).
// Verifies ONLY mechanical arithmetic: A×B=Z, A+B=Z, "X% of Y is Z", "X out of Y is Z%",
// and — separately — relative date words paired with an explicit calendar date.
// It never judges prose certainty; labels (source claim / verified fact / hypothesis) stay
// with the synthesis itself — this module's job is that no arithmetic lie survives untouched.

import { findExplicitDates, type ExplicitDate } from "./deadline.js";

export interface FactCheck {
  /** number of machine-checkable claims found */
  checked: number;
  /** number that failed their own arithmetic */
  inconsistent: number;
  /** the exact claim substrings that failed (example evidence) */
  failures: string[];
}

const NUM = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
const NUMS = String.raw`[+-]?[\d,]*\d(?:\.\d+)?`;

/** parse a numeric token ("2,000", "45%") → number */
function num(token: string): number {
  return Number(token.replace(/[,%€$]/g, "").trim());
}

/** Arithmetic must agree apart from floating-point representation noise. */
function close(actual: number, expected: number): boolean {
  const tolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(actual), Math.abs(expected));
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

/** Percentage prose may round to the precision of the stated result, not an arbitrary 1%. */
function rounded(actual: number, stated: string): boolean {
  const expected = num(stated);
  const decimals = stated.replace(/,/g, "").split(".")[1]?.length ?? 0;
  return close(actual, expected) || (Number.isFinite(actual) && Math.abs(actual - expected) < 0.5 * 10 ** -decimals);
}

function makeCheck(): FactCheck {
  return { checked: 0, inconsistent: 0, failures: [] };
}

function verdict(check: FactCheck, claim: string, ok: boolean): void {
  check.checked++;
  if (!ok) {
    check.inconsistent++;
    if (check.failures.length < 5) check.failures.push(claim);
  }
}

/** Verify every mechanical arithmetic claim in `text`. Pure and crash-bounded: any regex
 *  that parses to a checkable shape is verified; malformed fragments are ignored. */
export function scanNumericClaims(text: string): FactCheck {
  const check = makeCheck();
  if (!text) return check;

  // multiplication: "120 * 3 = 360" (also × or x between digits)
  for (const m of text.matchAll(new RegExp(`(${NUM})\\s*[×x*]\\s*(${NUM})\\s*(?:=|equals|is)\\s*(${NUMS})`, "gi"))) {
    const [claim, a, b, z] = m;
    verdict(check, claim, close(num(a) * num(b), num(z)));
  }

  // addition: "40 + 60 = 100" or "40 plus 60 is 100"
  for (const m of text.matchAll(new RegExp(`(${NUM})\\s*(?:\\+|plus)\\s*(${NUM})\\s*(?:=|equals|is)\\s*(${NUMS})`, "gi"))) {
    const [claim, a, b, z] = m;
    verdict(check, claim, close(num(a) + num(b), num(z)));
  }

  // percentage of: "15% of 2,000 is 300" / "15% of 2,000 = 300"
  for (const m of text.matchAll(new RegExp(`(${NUM})\\s*%\\s*of\\s*(${NUM})\\s*(?:=|equals|is)\\s*(${NUMS})`, "gi"))) {
    const [claim, pct, base, z] = m;
    verdict(check, claim, rounded((num(pct) / 100) * num(base), z));
  }

  // denominator share: "5 out of 8 is 62.5%"
  for (const m of text.matchAll(new RegExp(`(${NUM})\\s+out of\\s+(${NUM})\\s*(?:=|equals|is)\\s*(${NUMS})\\s*%`, "gi"))) {
    const [claim, part, whole, pct] = m;
    const wholeN = num(whole);
    verdict(check, claim, wholeN === 0 ? false : rounded((num(part) / wholeN) * 100, pct));
  }

  return check;
}

/** Relative words carry an implied calendar offset; "in N days" / "через N дней" states one outright. */
const RELATIVE_WORDS: Record<string, number> = {
  today: 0, tomorrow: 1, yesterday: -1,
  "сегодня": 0, "завтра": 1, "послезавтра": 2, "вчера": -1, "позавчера": -2,
};
// Cyrillic has no ASCII \b, so look-arounds gate the words. Longest alternative first
// so "послезавтра" is not read as "завтра", and "позавчера" not as "вчера". Fresh regexes
// per use: `replace`/`matchAll` on a shared global regex is stateful.
const relativeWordRe = () => /(?<![\p{L}])(today|tomorrow|yesterday|послезавтра|позавчера|сегодня|завтра|вчера)(?![\p{L}])/giu;
const inDaysRe = () => /(?<![\p{L}])(?:in\s+(\d{1,4})\s+days?|через\s+(\d{1,4})\s+(?:день|дня|дней))(?![\p{L}])/giu;
const agoDaysRe = () => /(?<![\p{L}])(\d{1,4})\s+(?:день|дня|дней)\s+назад(?![\p{L}])/giu;

/**
 * A relative word must be LINKED to the date, not merely share a sentence with it: only a
 * copula/apposition ("today, November 2" — comma, dash; "Tomorrow IS October 27") makes the
 * claim "the relative word = this date". Without it, "Today I checked the page for the
 * November 2 deadline." is prose, not an equation, and must not be rewritten or suppressed.
 */
const APPOSITION_WORDS = new Set(["is", "was", "are", "were", "be", "equals", "="]);

/** One relative-offset phrase found in a clause: its text, span and implied calendar offset. */
interface OffsetHit {
  phrase: string;
  start: number;
  end: number;
  offset: number;
}

function offsetHits(segment: string): OffsetHit[] {
  const hits: OffsetHit[] = [];
  const add = (re: RegExp, offsetOf: (m: RegExpExecArray) => number): void => {
    for (const m of segment.matchAll(re)) {
      const start = m.index ?? 0;
      hits.push({ phrase: m[0], start, end: start + m[0].length, offset: offsetOf(m) });
    }
  };
  add(relativeWordRe(), (m) => RELATIVE_WORDS[m[1].toLowerCase()]);
  add(inDaysRe(), (m) => Number(m[1] ?? m[2]));
  add(agoDaysRe(), (m) => -Number(m[1]));
  return hits.sort((a, b) => a.start - b.start);
}

/** True when two spans are written as an apposition (only punctuation/space or a copula between). */
function isApposition(segment: string, a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  const [left, right] = a.start <= b.start ? [a, b] : [b, a];
  if (right.start < left.end) return false;
  const words = segment
    .slice(left.end, right.start)
    .replace(/[^\p{L}\p{N}_=]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length === 0 || (words.length === 1 && APPOSITION_WORDS.has(words[0].toLowerCase()));
}

/** A relative offset an explicit date is unambiguously associated with (apposition, single date). */
export interface RelativeDateAssociation {
  phrase: string;
  start: number;
  end: number;
  offset: number;
  date: ExplicitDate;
}

/**
 * The relative-word / explicit-date associations a clause actually STATES: exactly one distinct
 * relative offset paired, in apposition, with exactly one explicit date. A clause with no relative
 * word, an ambiguous mix of offsets, or several unrelated dates yields nothing — a false accusation
 * (or a false correction) is worse than a miss.
 */
export function relativeDateAssociations(
  segment: string,
  opts: { now?: number | Date; timeZone?: string } = {},
): RelativeDateAssociation[] {
  const hits = offsetHits(segment);
  if (new Set(hits.map((h) => h.offset)).size !== 1) return [];
  const dates = findExplicitDates(segment, opts);
  if (dates.length !== 1) return [];
  const date = dates[0];
  const span = { start: date.index, end: date.index + date.raw.length };
  return hits.filter((h) => isApposition(segment, h, span)).map((h) => ({ ...h, date }));
}

/** How many relative-offset phrases appear in a clause (any offset) — used to detect a blind rewrite. */
export function relativePhraseCount(segment: string): number {
  return offsetHits(segment).length;
}

/** Replace every relative phrase in a clause with the computed wording (the correction step). */
export function replaceRelativePhrases(segment: string, phrase: string): string {
  return segment.replace(relativeWordRe(), phrase).replace(inDaysRe(), phrase).replace(agoDaysRe(), phrase);
}

/**
 * Split a text into claim-sized clauses at sentence terminators, WITHOUT shredding a
 * numeric date. The review caught the original splitter cutting on EVERY dot, so
 * "сегодня, 02.11.2026" became "сегодня, 02" | "11" | "2026" and the guard never saw
 * the date. Dots strictly between digits belong to the date, so they are masked out
 * before splitting and restored afterwards; the final period of the sentence is not
 * between digits and still terminates the clause.
 */
function splitClauses(text: string): string[] {
  const MASK = "\u0000";
  const masked = text.replace(/(?<=\d)\.(?=\d)/g, MASK);
  return masked.split(/[.!?\n;]+/).map((s) => s.split(MASK).join("."));
}

/**
 * Verify relative date words against explicit calendar dates in the same claim.
 *
 * This is the mechanical half of bd pibot-wr9m: on 2026-10-26 a reminder called the
 * November 2 deadline "today". Whether "today" is right is decided by the CURRENT
 * date (timezone-aware), not by the sender's prose. The original wording was Russian,
 * so "сегодня/завтра/вчера", "через N дней" and "N дней назад" are read the same way.
 *
 * Only a relative word LINKED to the date (an apposition — "сегодня, 2 ноября",
 * "Tomorrow is October 27") is a claim: mere co-occurrence in a sentence is prose and
 * is left unjudged, so "Сегодня проверил страницу: дедлайн 2 ноября." is never a false
 * accusation. A clause mixing several offsets, or naming several unrelated dates, is
 * ambiguous and is left alone (see `relativeDateAssociations`).
 */
export function scanRelativeDateClaims(
  text: string,
  opts: { now?: number | Date; timeZone?: string } = {},
): FactCheck {
  const check = makeCheck();
  if (!text) return check;

  for (const segment of splitClauses(text)) {
    const [assoc] = relativeDateAssociations(segment, opts);
    if (!assoc) continue;
    const claim = segment.trim().slice(0, 140);
    verdict(check, `${claim} → ${assoc.date.raw}`, assoc.date.daysFromNow === assoc.offset);
  }

  return check;
}