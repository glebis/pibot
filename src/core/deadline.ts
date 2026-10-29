// ─── Deadline urgency: relative wording is computed, never copied (bd pibot-wr9m) ───
//
// Observed 2026-10-26: a reminder called the November 2 deadline "today". The
// absolute deadline was correct; the RELATIVE word was wrong because it was
// inferred/echoed instead of computed against the current date. This module makes
// that computation explicit and timezone-aware:
//
//   • the reference "today" is the current instant rendered in a NAMED timezone
//     (never the machine's implicit offset, and never a value carried in prose);
//   • the distance is counted in CALENDAR days from the local date parts, so a
//     DST transition inside the span cannot shift the count by an hour;
//   • the absolute deadline stays a separate input — this module only derives the
//     relative wording from it.

const DAY_MS = 86_400_000;

export interface LocalDateParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
}

export interface DeadlineUrgency {
  /** signed calendar days from today to the deadline: 0 = today, 7 = a week out, -1 = yesterday */
  days: number;
  isToday: boolean;
  isTomorrow: boolean;
  /** the calendar day is already behind us (days < 0) */
  isPast: boolean;
  /** relative wording computed from `now` — the only thing a nudge should quote */
  phrase: string;
  /** local calendar date of `now`, YYYY-MM-DD */
  today: string;
  /** local calendar date of the deadline, YYYY-MM-DD */
  deadlineDay: string;
}

export interface ExplicitDate {
  /** the date exactly as it appeared in the text */
  raw: string;
  /** index of `raw` within the source text */
  index: number;
  /** resolved calendar date, YYYY-MM-DD */
  day: string;
  /** signed calendar days from "today" (same tz) to this date */
  daysFromNow: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_ALT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

// The observed failure was a RUSSIAN reminder ("сегодня, 2 ноября"): month names
// and relative words must be read in the language they were actually written in.
const RU_MONTHS: Record<string, number> = {
  "январь": 1, "января": 1, "февраль": 2, "февраля": 2, "март": 3, "марта": 3,
  "апрель": 4, "апреля": 4, "май": 5, "мая": 5, "июнь": 6, "июня": 6, "июль": 7, "июля": 7,
  "август": 8, "августа": 8, "сентябрь": 9, "сентября": 9, "октябрь": 10, "октября": 10,
  "ноябрь": 11, "ноября": 11, "декабрь": 12, "декабря": 12,
};
const RU_MONTH_ALT =
  "январ[ья]|феврал[ья]|март[а]?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|август[а]?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья]";
/** "2 ноября" / "2 ноября 2026" — day-first, genitive month (Cyrillic has no ASCII word boundary, so use look-arounds). */
const RU_DATE = new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})\\s+(${RU_MONTH_ALT})(?:\\s+(\\d{4}))?(?![\\p{L}\\p{N}])`, "gu");
/** "26.10.2026" — the Russian numeric day-first form. */
const RU_NUMERIC_DATE = /(?<![\p{L}\d])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/gu;

export type DeadlineLanguage = "en" | "ru";

function numberOr(value: number | Date, fallback: number): number {
  return typeof value === "number" ? value : value.getTime();
}

/** Calendar date of `ms` in `timeZone` (IANA name; undefined = system zone). */
export function localDateParts(ms: number, timeZone?: string): LocalDateParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  } catch {
    // an unknown tz name must not crash a reminder — fall back to the machine zone
    parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  }
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function toDayString(p: LocalDateParts): string {
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Days since the epoch for a calendar date — DST-immune because the hour is pinned to UTC midnight. */
export function dayNumber(p: LocalDateParts): number {
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
}

function validParts(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Year for a date written without one: nearest to `now` (±183 days) so "Nov 2" on Oct 26 stays this year. */
function inferYear(month: number, day: number, today: LocalDateParts): number {
  // try the current year first, then the neighbours, and keep whichever lands closest to today
  let best = today.year;
  let bestDistance = Infinity;
  for (const year of [today.year - 1, today.year, today.year + 1]) {
    if (!validParts(year, month, day)) continue;
    const distance = Math.abs(dayNumber({ year, month, day }) - dayNumber(today));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = year;
    }
  }
  return best;
}

/** Every explicit calendar date in `text` (ISO or month-name form), resolved against a tz-aware "today". */
export function findExplicitDates(text: string, opts: { now?: number | Date; timeZone?: string } = {}): ExplicitDate[] {
  const nowMs = numberOr(opts.now ?? Date.now(), Date.now());
  const today = localDateParts(nowMs, opts.timeZone);
  const todayDay = dayNumber(today);
  const found: ExplicitDate[] = [];
  const seen = new Set<string>();

  const push = (raw: string, index: number, y: number | undefined, m: number, d: number): void => {
    const year = y ?? inferYear(m, d, today);
    if (!validParts(year, m, d)) return;
    const key = `${index}:${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    const parts: LocalDateParts = { year, month: m, day: d };
    found.push({ raw, index, day: toDayString(parts), daysFromNow: dayNumber(parts) - todayDay });
  };

  // ISO: 2026-11-02 (also 2026/11/02)
  for (const m of text.matchAll(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g)) {
    push(m[0], m.index ?? 0, Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // "November 2" / "Nov. 2, 2026"
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"))) {
    const month = MONTHS[m[1].toLowerCase().replace(/\.$/, "")];
    if (month) push(m[0], m.index ?? 0, m[3] ? Number(m[3]) : undefined, month, Number(m[2]));
  }
  // "2 November" / "2. November 2026"
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?\\b`, "gi"))) {
    const month = MONTHS[m[2].toLowerCase().replace(/\.$/, "")];
    if (month) push(m[0], m.index ?? 0, m[3] ? Number(m[3]) : undefined, month, Number(m[1]));
  }
  // Russian: "2 ноября" / "2 ноября 2026"
  for (const m of text.matchAll(RU_DATE)) {
    const month = RU_MONTHS[m[2]];
    if (month) push(m[0], m.index ?? 0, m[3] ? Number(m[3]) : undefined, month, Number(m[1]));
  }
  // Russian numeric: "26.10.2026" (day.month.year)
  for (const m of text.matchAll(RU_NUMERIC_DATE)) {
    push(m[0], m.index ?? 0, Number(m[3]), Number(m[2]), Number(m[1]));
  }

  return found.sort((a, b) => a.index - b.index);
}

/** Parse a single absolute deadline written as a date string ("2026-11-02", "November 2"). */
export function parseAbsoluteDate(text: string, opts: { now?: number | Date; timeZone?: string } = {}): ExplicitDate | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [first] = findExplicitDates(trimmed, opts);
  // only accept when the date really is the whole input (a substring means it is prose, not a value)
  if (!first || first.raw.trim().length !== trimmed.length) return null;
  return first;
}

/** Russian plural for "день" — 1 день, 2–4 дня, 5+ дней. */
function ruDays(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

function phraseFor(days: number, language: DeadlineLanguage = "en"): string {
  if (language === "ru") {
    if (days === 0) return "сегодня";
    if (days === 1) return "завтра";
    if (days === 2) return "послезавтра";
    if (days === -1) return "вчера";
    if (days === -2) return "позавчера";
    return days > 0 ? `через ${days} ${ruDays(days)}` : `${-days} ${ruDays(-days)} назад`;
  }
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 1 ? `in ${days} days` : `${-days} days ago`;
}

function partsFromInput(input: number | Date | string, now: LocalDateParts, timeZone?: string): LocalDateParts | null {
  if (typeof input === "string") {
    const parsed = parseAbsoluteDate(input, { now: Date.UTC(now.year, now.month - 1, now.day), timeZone });
    if (!parsed) return null;
    return { year: Number(parsed.day.slice(0, 4)), month: Number(parsed.day.slice(5, 7)), day: Number(parsed.day.slice(8, 10)) };
  }
  return localDateParts(typeof input === "number" ? input : input.getTime(), timeZone);
}

/**
 * Compute urgency for an absolute deadline against the CURRENT local date.
 * Returns null only when a string deadline cannot be parsed as a date.
 */
export function relativeDeadline(
  deadline: number | Date | string,
  opts: { now?: number | Date; timeZone?: string; language?: DeadlineLanguage } = {},
): DeadlineUrgency | null {
  const nowMs = numberOr(opts.now ?? Date.now(), Date.now());
  const today = localDateParts(nowMs, opts.timeZone);
  const target = partsFromInput(deadline, today, opts.timeZone);
  if (!target) return null;
  const days = dayNumber(target) - dayNumber(today);
  return {
    days,
    isToday: days === 0,
    isTomorrow: days === 1,
    isPast: days < 0,
    phrase: phraseFor(days, opts.language),
    today: toDayString(today),
    deadlineDay: toDayString(target),
  };
}

/** "2026-11-02 (in 7 days)" — the absolute date kept distinct from the computed relative wording. */
export function describeDeadline(
  deadline: number | Date | string,
  opts: { now?: number | Date; timeZone?: string; language?: DeadlineLanguage } = {},
): string | null {
  const urgency = relativeDeadline(deadline, opts);
  return urgency ? `${urgency.deadlineDay} (${urgency.phrase})` : null;
}

/** Local wall-clock HH:mm in `timeZone` (undefined = machine zone); falls back to the machine zone for an unknown tz. */
export function localClock(ms: number, timeZone?: string): string {
  const format = (tz?: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  try {
    return format(timeZone);
  } catch {
    return format(undefined);
  }
}

/**
 * "2026-11-02 09:00 (in 7 days)" — the absolute date + the exact local due clock, kept
 * alongside the computed relative wording. `describeDeadline` alone drops the clock, so a
 * same-day reminder reads as actionable only in the digest that has both.
 */
export function describeDeadlineAt(
  deadline: number | Date | string,
  opts: { now?: number | Date; timeZone?: string; language?: DeadlineLanguage } = {},
): string | null {
  const urgency = relativeDeadline(deadline, opts);
  if (!urgency) return null;
  const ms = typeof deadline === "number" ? deadline : deadline instanceof Date ? deadline.getTime() : null;
  const clock = ms != null ? localClock(ms, opts.timeZone) : null;
  const datePart = clock ? `${urgency.deadlineDay} ${clock}` : urgency.deadlineDay;
  return `${datePart} (${urgency.phrase})`;
}
