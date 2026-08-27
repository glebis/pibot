import { describe, expect, it } from "vitest";
import { fmtWhen, inQuietHours, nextRepeatAt, parseDuration, parseWhen } from "./util.js";

// fixed reference: a Thursday, 2026-08-27 18:20 local
const NOW = new Date(2026, 7, 27, 18, 20, 0).getTime();

describe("parseDuration", () => {
  it("parses single and compound units", () => {
    expect(parseDuration("45m")).toBe(45 * 60e3);
    expect(parseDuration("2h30m")).toBe(2.5 * 3600e3);
    expect(parseDuration("1.5h")).toBe(1.5 * 3600e3);
    expect(parseDuration("90s")).toBe(90e3);
    expect(parseDuration("1d")).toBe(86400e3);
    expect(parseDuration("2 days")).toBe(2 * 86400e3);
  });

  it("rejects garbage", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("tomorrow")).toBeNull();
  });
});

describe("parseWhen", () => {
  it("parses relative durations", () => {
    expect(parseWhen("in 20m", NOW)?.dueAt).toBe(NOW + 20 * 60e3);
    expect(parseWhen("2h30m", NOW)?.dueAt).toBe(NOW + 2.5 * 3600e3);
    expect(parseWhen("in 1.5h", NOW)?.repeat).toBeUndefined();
  });

  it("parses clock times into the future", () => {
    // 18:20 now → 19:00 today
    expect(parseWhen("19:00", NOW)?.dueAt).toBe(new Date(2026, 7, 27, 19, 0).getTime());
    // 09:00 already past → tomorrow
    expect(parseWhen("9am", NOW)?.dueAt).toBe(new Date(2026, 7, 28, 9, 0).getTime());
    expect(parseWhen("at 23:30", NOW)?.dueAt).toBe(new Date(2026, 7, 27, 23, 30).getTime());
  });

  it("parses tomorrow with default or explicit time", () => {
    expect(parseWhen("tomorrow", NOW)?.dueAt).toBe(new Date(2026, 7, 28, 9, 0).getTime());
    expect(parseWhen("tomorrow 9am", NOW)?.dueAt).toBe(new Date(2026, 7, 28, 9, 0).getTime());
    expect(parseWhen("tomorrow 18:00", NOW)?.dueAt).toBe(new Date(2026, 7, 28, 18, 0).getTime());
  });

  it("parses daily recurrence", () => {
    const r = parseWhen("daily at 08:00", NOW);
    expect(r?.dueAt).toBe(new Date(2026, 7, 28, 8, 0).getTime());
    expect(r?.repeat).toEqual({ dailyAt: "08:00" });

    expect(parseWhen("every day at 9am", NOW)?.repeat).toEqual({ dailyAt: "09:00" });
    expect(parseWhen("daily", NOW)?.repeat).toEqual({ dailyAt: "09:00" });
  });

  it("parses interval recurrence", () => {
    expect(parseWhen("every 2h", NOW)).toEqual({ dueAt: NOW + 7200e3, repeat: { everyMs: 7200e3 } });
    expect(parseWhen("every 30m", NOW)?.repeat).toEqual({ everyMs: 1800e3 });
    expect(parseWhen("hourly", NOW)?.repeat).toEqual({ everyMs: 3600e3 });
    expect(parseWhen("weekly", NOW)?.repeat).toEqual({ everyMs: 604800e3 });
  });

  it("parses weekday recurrence", () => {
    // Thursday 2026-08-27 → friday 18:00 = tomorrow
    const fri = parseWhen("friday 18:00", NOW);
    expect(fri?.dueAt).toBe(new Date(2026, 7, 28, 18, 0).getTime());
    expect(fri?.repeat).toEqual({ weekdays: [5], dailyAt: "18:00" });

    // mondays 10am = next monday 2026-08-31
    expect(parseWhen("mondays 10am", NOW)?.dueAt).toBe(new Date(2026, 7, 31, 10, 0).getTime());
    expect(parseWhen("every monday 10:00", NOW)?.dueAt).toBe(new Date(2026, 7, 31, 10, 0).getTime());
  });

  it("falls back to ISO timestamps and rejects garbage", () => {
    const future = new Date(NOW + 3600e3).toISOString();
    expect(parseWhen(future, NOW)?.dueAt).toBe(Date.parse(future));
    expect(parseWhen("snooze nothing garbage", NOW)).toBeNull();
    expect(parseWhen("hourly nonsense", NOW)).toBeNull();
  });
});

describe("nextRepeatAt", () => {
  it("advances everyMs from fire time", () => {
    expect(nextRepeatAt({ everyMs: 3600e3 }, NOW)).toBe(NOW + 3600e3);
  });

  it("computes next dailyAt occurrence", () => {
    expect(nextRepeatAt({ dailyAt: "09:00" }, NOW)).toBe(new Date(2026, 7, 28, 9, 0).getTime());
  });

  it("computes next matching weekday (nearest of several)", () => {
    // from Thursday → mon (31st) and sat (29th): nearest is saturday
    expect(nextRepeatAt({ weekdays: [1, 6], dailyAt: "10:00" }, NOW)).toBe(new Date(2026, 7, 29, 10, 0).getTime());
  });

  it("returns null without repeat info", () => {
    expect(nextRepeatAt({}, NOW)).toBeNull();
  });
});

describe("fmtWhen", () => {
  it("formats relative times", () => {
    expect(fmtWhen(NOW, NOW)).toBe("now");
    expect(fmtWhen(NOW + 40e3, NOW)).toBe("in 40s");
    expect(fmtWhen(NOW + 20 * 60e3, NOW)).toBe("in 20 min");
    expect(fmtWhen(NOW + 4500e3, NOW)).toBe("in 1h 15m");
  });

  it("formats absolute times beyond a day", () => {
    const s = fmtWhen(NOW + 3 * 86400e3, NOW);
    expect(s).toMatch(/^on /);
    expect(s).toContain("Aug 30");
  });
});

describe("inQuietHours", () => {
  it("detects inside a same-day window", () => {
    expect(inQuietHours({ from: "23:00", to: "08:00" }, new Date(2026, 7, 27, 23, 30).getTime())).toBe(true);
    expect(inQuietHours({ from: "23:00", to: "08:00" }, new Date(2026, 7, 27, 2, 0).getTime())).toBe(true);
    expect(inQuietHours({ from: "23:00", to: "08:00" }, NOW)).toBe(false);
  });

  it("supports daytime windows and wraparound", () => {
    expect(inQuietHours({ from: "12:00", to: "14:00" }, new Date(2026, 7, 27, 13, 0).getTime())).toBe(true);
    expect(inQuietHours({ from: "14:00", to: "13:00" }, new Date(2026, 7, 27, 2, 0).getTime())).toBe(true);
    expect(inQuietHours(undefined, NOW)).toBe(false);
  });
});