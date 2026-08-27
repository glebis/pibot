import * as fs from "node:fs";
import * as path from "node:path";
import type { ScheduleRepeat } from "./types.js";

// ─── ids / json io ──────────────────────────────────────────────────────────

export function uid(prefix = "", len = 8): string {
  const s = Math.random().toString(36).slice(2, 2 + len);
  return prefix ? `${prefix}_${s}` : s;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ─── durations & times ──────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3,
  m: 60e3, min: 60e3, mins: 60e3, minute: 60e3, minutes: 60e3,
  h: 3600e3, hr: 3600e3, hrs: 3600e3, hour: 3600e3, hours: 3600e3,
  d: 86400e3, day: 86400e3, days: 86400e3,
  w: 604800e3, week: 604800e3, weeks: 604800e3,
};

/** Parse "90s", "45m", "2h", "2h30m", "1d", "1.5h" → ms, or null */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|weeks?|w)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = parseFloat(m[1]);
    const unit = UNIT_MS[m[2]];
    if (!Number.isFinite(n) || !unit) return null;
    total += n * unit;
    matched = true;
  }
  return matched ? total : null;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

/** Parse "9am", "9:30pm", "18:00" → {hh, mm} or null */
function parseClock(s: string): { hh: number; mm: number } | null {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === "am") { if (hh === 12) hh = 0; }
  else if (m[3] === "pm") { if (hh !== 12) hh += 12; }
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

function nextAt(base: number, hh: number, mm: number, dayOffset = 0): number {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  if (dayOffset === 0 && d.getTime() <= base) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export interface ParsedWhen {
  dueAt: number;
  repeat?: ScheduleRepeat;
}

/**
 * Natural-language "when" parsing for scheduling.
 * Supports: "in 20m", "2h30m", "at 18:00", "9am", "tomorrow 9am",
 * "daily at 08:00", "every 2h", "hourly", "every day at 9am",
 * "friday 18:00", "mondays 10am", ISO timestamps.
 */
export function parseWhen(input: string, now = Date.now()): ParsedWhen | null {
  const s = input.trim().toLowerCase().replace(/[?.!]+$/, "");

  // "in <duration>" / bare duration
  const durMatch = s.match(/^(?:in\s+)?((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|weeks?|w)\s*)+)$/);
  if (durMatch) {
    const ms = parseDuration(durMatch[1]);
    if (ms && ms >= 1000) return { dueAt: now + ms };
  }

  // "hourly" / "daily" / "weekly" bare forms
  if (/^hourly$/.test(s)) return { dueAt: now + 3600e3, repeat: { everyMs: 3600e3 } };
  if (/^(daily|everyday)$/.test(s)) return { dueAt: nextAt(now, 9, 0), repeat: { dailyAt: "09:00" } };
  if (/^weekly$/.test(s)) return { dueAt: now + 604800e3, repeat: { everyMs: 604800e3 } };

  // "every X" family → recurring
  const every = s.match(/^(?:every|each)\s+(.+)$/);
  if (every) {
    const inner = every[1].trim();
    if (/^hour$/.test(inner)) return { dueAt: now + 3600e3, repeat: { everyMs: 3600e3 } };
    if (/^(day|24h)$/.test(inner)) {
      const c = { hh: 9, mm: 0 };
      return { dueAt: nextAt(now, c.hh, c.mm), repeat: { dailyAt: "09:00" } };
    }
    if (/^week$/.test(inner)) return { dueAt: now + 604800e3, repeat: { everyMs: 604800e3 } };
    // "every day at 9am"
    const daily = inner.match(/^(?:day|daily)\s*(?:at\s+|@\s*)?(.*)$/);
    if (daily !== null && /^(day|daily)/.test(inner)) {
      const c = parseClock(daily[1] || "09:00");
      if (c) return { dueAt: nextAt(now, c.hh, c.mm), repeat: { dailyAt: `${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}` } };
    }
    // "every 2h" / "every 30m"
    const ms = parseDuration(inner);
    if (ms && ms >= 60e3) return { dueAt: now + ms, repeat: { everyMs: ms } };
    // "every monday 10:00" / "every fridays 6pm"
    const wd = inner.match(/^(\w+)\s*(?:at\s+|on\s+)?(.*)$/);
    if (wd && WEEKDAYS[wd[1]] !== undefined) {
      const c = parseClock(wd[2] || "09:00");
      if (c) {
        return {
          dueAt: nextWeekday(now, WEEKDAYS[wd[1]], c.hh, c.mm),
          repeat: { weekdays: [WEEKDAYS[wd[1]]], dailyAt: `${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}` },
        };
      }
    }
  }

  // "daily at 08:00"
  const daily = s.match(/^daily\s*(?:at\s+|@\s*)?(.*)$/);
  if (daily) {
    const c = parseClock(daily[1] || "09:00");
    if (c) return { dueAt: nextAt(now, c.hh, c.mm), repeat: { dailyAt: `${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}` } };
  }

  // "tomorrow [at] [time]"
  const tmr = s.match(/^tomorrow\s*(?:at\s+|@\s*)?(.*)$/);
  if (tmr) {
    const c = parseClock(tmr[1] || "09:00");
    if (c) return { dueAt: nextAt(now, c.hh, c.mm, 1) };
  }

  // weekday: "friday 18:00", "mondays 10am", "sat"
  const wd = s.match(/^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|s|nesday|rsday|urday|day)?s?\s*(?:at\s+|on\s+)?(.*)$/);
  if (wd && WEEKDAYS[wd[1]] !== undefined) {
    const day = WEEKDAYS[wd[1]];
    const c = parseClock(wd[2] || "09:00");
    if (c) {
      return {
        dueAt: nextWeekday(now, day, c.hh, c.mm),
        repeat: { weekdays: [day], dailyAt: `${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}` },
      };
    }
    // bare weekday mentioned without a time but word matched — fall through
  }

  // "at 18:00" / "18:00" / "9am"
  const clock = s.match(/^(?:at\s+|@\s*)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/);
  if (clock) {
    const c = parseClock(clock[1]);
    if (c) return { dueAt: nextAt(now, c.hh, c.mm) };
  }

  // ISO / RFC fallback
  const t = Date.parse(input);
  if (!Number.isNaN(t) && t > now - 86400e3) return { dueAt: t };

  return null;
}

function nextWeekday(now: number, weekday: number, hh: number, mm: number): number {
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  let add = (weekday - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= now) add = 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}

/** Next due time for a repeating schedule, from a fire time */
export function nextRepeatAt(repeat: ScheduleRepeat, from: number): number | null {
  if (repeat.everyMs) return from + repeat.everyMs;
  // weekday + dailyAt together = weekly on those days at that time — checked before plain daily
  if (repeat.weekdays?.length) {
    const [hh, mm] = (repeat.dailyAt ?? "09:00").split(":").map(Number);
    let best = Infinity;
    for (const wd of repeat.weekdays) {
      const t = nextWeekday(from, wd, hh, mm);
      if (t < best) best = t;
    }
    return best === Infinity ? null : best;
  }
  if (repeat.dailyAt) {
    const [hh, mm] = repeat.dailyAt.split(":").map(Number);
    return nextAt(from, hh, mm);
  }
  return null;
}

/** Human-friendly relative/absolute time */
export function fmtWhen(ms: number, now = Date.now()): string {
  const diff = ms - now;
  if (diff <= 30e3) return "now";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diff < 60e3) return `in ${Math.round(diff / 1e3)}s`;
  if (diff < 3600e3) return `in ${Math.round(diff / 60e3)} min`;
  if (diff < 86400e3) {
    const h = Math.floor(diff / 3600e3);
    const m = Math.round((diff % 3600e3) / 60e3);
    return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `on ${d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })} at ${time}`;
}

/** Next occurrence of a daily HH:MM time (for daily jobs) */
export function nextDailyAt(hhmm: string, now = Date.now()): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Timestamp of the NEXT quiet-hours end (morning wake time) after `now` */
export function nextQuietEnd(qh: { from: string; to: string } | undefined, now = Date.now()): number | null {
  if (!qh) return null;
  const [toH, toM] = qh.to.split(":").map(Number);
  const d = new Date(now);
  d.setHours(toH || 0, toM || 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function inQuietHours(qh: { from: string; to: string } | undefined, now = Date.now()): boolean {
  if (!qh) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const from = toMin(qh.from);
  const to = toMin(qh.to);
  return from <= to ? nowMin >= from && nowMin < to : nowMin >= from || nowMin < to;
}

// ─── misc ───────────────────────────────────────────────────────────────────

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}