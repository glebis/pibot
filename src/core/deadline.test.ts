import { describe, expect, it } from "vitest";
import {
  dayNumber, describeDeadline, findExplicitDates, localDateParts, parseAbsoluteDate, relativeDeadline, toDayString,
} from "./deadline.js";

const BERLIN = "Europe/Berlin";
// 2026-10-26 08:32 Europe/Berlin (CET = UTC+1) — the exact observed moment pibusiness called Nov 2 "today".
const OCT26_0832 = Date.UTC(2026, 9, 26, 7, 32);

describe("relativeDeadline — the observed Oct 26 vs Nov 2 case (bd pibot-wr9m)", () => {
  it("computes seven days and never forms a 'today' warning", () => {
    const u = relativeDeadline("2026-11-02", { now: OCT26_0832, timeZone: BERLIN });
    expect(u).toMatchObject({ days: 7, isToday: false, isPast: false, phrase: "in 7 days", today: "2026-10-26", deadlineDay: "2026-11-02" });
  });

  it("still computes seven days when only the deadline's day is known", () => {
    const u = relativeDeadline("November 2", { now: OCT26_0832, timeZone: BERLIN });
    expect(u).toMatchObject({ days: 7, phrase: "in 7 days" });
  });

  it("derives the relative word from the date instead of copying it", () => {
    // the same absolute deadline, three different 'now's → three different words
    expect(relativeDeadline("2026-11-02", { now: Date.UTC(2026, 10, 2, 12), timeZone: BERLIN })?.phrase).toBe("today");
    expect(relativeDeadline("2026-11-02", { now: Date.UTC(2026, 10, 1, 12), timeZone: BERLIN })?.phrase).toBe("tomorrow");
    expect(relativeDeadline("2026-11-02", { now: Date.UTC(2026, 10, 3, 12), timeZone: BERLIN })?.phrase).toBe("yesterday");
  });

  it("returns null only for an unparseable string deadline", () => {
    expect(relativeDeadline("sometime soon", { now: OCT26_0832 })).toBeNull();
    expect(relativeDeadline(Date.UTC(2026, 10, 2), { now: OCT26_0832, timeZone: BERLIN })?.days).toBe(7);
  });
});

describe("relativeDeadline — timezone boundary", () => {
  // one instant: 2026-10-26 23:30 UTC
  const instant = Date.UTC(2026, 9, 26, 23, 30);

  it("counts from the local date in the named timezone, not the machine's", () => {
    expect(relativeDeadline("2026-11-02", { now: instant, timeZone: "UTC" })).toMatchObject({ today: "2026-10-26", days: 7 });
    expect(relativeDeadline("2026-11-02", { now: instant, timeZone: BERLIN })).toMatchObject({ today: "2026-10-27", days: 6 });
    expect(relativeDeadline("2026-11-02", { now: instant, timeZone: "Pacific/Kiritimati" })).toMatchObject({ today: "2026-10-27", days: 6 });
    expect(relativeDeadline("2026-11-02", { now: instant, timeZone: "America/Los_Angeles" })).toMatchObject({ today: "2026-10-26", days: 7 });
  });

  it("respects the local midnight rollover to the minute", () => {
    // Berlin is CET (UTC+1) after the 2026-10-25 clock change: 22:30 UTC = 23:30 Oct 26, 23:30 UTC = 00:30 Oct 27
    expect(relativeDeadline("2026-11-02", { now: Date.UTC(2026, 9, 26, 22, 30), timeZone: BERLIN })?.today).toBe("2026-10-26");
    expect(relativeDeadline("2026-11-02", { now: Date.UTC(2026, 9, 26, 23, 30), timeZone: BERLIN })?.today).toBe("2026-10-27");
  });
});

describe("relativeDeadline — DST transitions do not shift the count", () => {
  it("stays exact across the Europe/Berlin autumn clock change (2026-10-25)", () => {
    const d1 = relativeDeadline("2026-11-02", { now: Date.UTC(2026, 9, 24, 12), timeZone: BERLIN });
    const d2 = relativeDeadline("2026-11-02", { now: Date.UTC(2026, 9, 25, 12), timeZone: BERLIN });
    expect(d1?.days).toBe(9);
    expect(d2?.days).toBe(8); // one calendar day later — a 25-hour span must not read as 0 or 2
  });

  it("stays exact across the Europe/Berlin spring clock change (2026-03-29)", () => {
    const d1 = relativeDeadline("2026-04-05", { now: Date.UTC(2026, 2, 28, 12), timeZone: BERLIN });
    const d2 = relativeDeadline("2026-04-05", { now: Date.UTC(2026, 2, 29, 12), timeZone: BERLIN });
    expect(d1?.days).toBe(8);
    expect(d2?.days).toBe(7);
  });
});

describe("calendar helpers", () => {
  it("formats and numbers a local calendar date", () => {
    expect(toDayString({ year: 2026, month: 11, day: 2 })).toBe("2026-11-02");
    expect(localDateParts(Date.UTC(2026, 10, 1, 23, 30), BERLIN)).toEqual({ year: 2026, month: 11, day: 2 });
    expect(dayNumber({ year: 2026, month: 10, day: 26 }) - dayNumber({ year: 2026, month: 10, day: 25 })).toBe(1);
  });

  it("falls back to the machine zone for an unknown timezone instead of throwing", () => {
    expect(() => relativeDeadline("2026-11-02", { now: OCT26_0832, timeZone: "Not/AZone" })).not.toThrow();
  });
});

describe("findExplicitDates", () => {
  it("reads ISO and month-name dates and resolves the signed distance", () => {
    const [iso] = findExplicitDates("due 2026-11-02", { now: OCT26_0832, timeZone: BERLIN });
    expect(iso).toMatchObject({ day: "2026-11-02", daysFromNow: 7 });
    const [named] = findExplicitDates("due November 2", { now: OCT26_0832, timeZone: BERLIN });
    expect(named).toMatchObject({ day: "2026-11-02", daysFromNow: 7 });
    const [euro] = findExplicitDates("due 2 November", { now: OCT26_0832, timeZone: BERLIN });
    expect(euro).toMatchObject({ day: "2026-11-02", daysFromNow: 7 });
  });

  it("infers the nearest year when one is omitted", () => {
    const [jan] = findExplicitDates("January 5", { now: Date.UTC(2026, 11, 20), timeZone: BERLIN });
    expect(jan).toMatchObject({ day: "2027-01-05", daysFromNow: 16 });
  });

  it("honours an explicit year and rejects impossible dates", () => {
    expect(findExplicitDates("Nov. 2, 2027", { now: OCT26_0832, timeZone: BERLIN })[0]).toMatchObject({ day: "2027-11-02" });
    expect(findExplicitDates("2026-02-30", { now: OCT26_0832 })).toHaveLength(0);
    expect(findExplicitDates("February 30", { now: OCT26_0832 })).toHaveLength(0);
  });

  it("finds every date in order", () => {
    const all = findExplicitDates("from October 26 to November 2", { now: OCT26_0832, timeZone: BERLIN });
    expect(all.map((d) => d.day)).toEqual(["2026-10-26", "2026-11-02"]);
  });
});

describe("parseAbsoluteDate", () => {
  it("parses a bare date and refuses prose", () => {
    expect(parseAbsoluteDate("November 2", { now: OCT26_0832, timeZone: BERLIN })?.day).toBe("2026-11-02");
    expect(parseAbsoluteDate("2026-11-02", { now: OCT26_0832, timeZone: BERLIN })?.day).toBe("2026-11-02");
    expect(parseAbsoluteDate("the deadline is November 2", { now: OCT26_0832, timeZone: BERLIN })).toBeNull();
    expect(parseAbsoluteDate("", { now: OCT26_0832 })).toBeNull();
  });
});

describe("describeDeadline", () => {
  it("keeps the absolute date separate from the computed relative wording", () => {
    expect(describeDeadline("2026-11-02", { now: OCT26_0832, timeZone: BERLIN })).toBe("2026-11-02 (in 7 days)");
    expect(describeDeadline("nonsense", { now: OCT26_0832 })).toBeNull();
  });
});

describe("Russian wording — the original failure was in Russian (bd pibot-wr9m)", () => {
  it("reads Russian month names in the day-first form", () => {
    expect(findExplicitDates("срок 2 ноября", { now: OCT26_0832, timeZone: BERLIN })[0]).toMatchObject({ day: "2026-11-02", daysFromNow: 7 });
    expect(findExplicitDates("26 октября", { now: OCT26_0832, timeZone: BERLIN })[0]).toMatchObject({ day: "2026-10-26", daysFromNow: 0 });
    expect(findExplicitDates("2 ноября 2026", { now: OCT26_0832, timeZone: BERLIN })[0]).toMatchObject({ day: "2026-11-02" });
  });

  it("reads the Russian numeric day-first form", () => {
    const [d] = findExplicitDates("дедлайн 02.11.2026", { now: OCT26_0832, timeZone: BERLIN });
    expect(d).toMatchObject({ day: "2026-11-02", daysFromNow: 7 });
    expect(findExplicitDates("26.10.2026", { now: OCT26_0832, timeZone: BERLIN })[0]).toMatchObject({ day: "2026-10-26" });
  });

  it("computes the Russian relative phrase instead of copying 'сегодня'", () => {
    const u = relativeDeadline("2 ноября", { now: OCT26_0832, timeZone: BERLIN, language: "ru" });
    expect(u).toMatchObject({ days: 7, isToday: false, phrase: "через 7 дней", today: "2026-10-26", deadlineDay: "2026-11-02" });
    expect(describeDeadline("2026-11-02", { now: OCT26_0832, timeZone: BERLIN, language: "ru" })).toBe("2026-11-02 (через 7 дней)");
  });

  it("uses the correct Russian singular/plural form", () => {
    const at = (iso: string, now: number) => relativeDeadline(iso, { now, timeZone: BERLIN, language: "ru" })?.phrase;
    expect(at("2026-11-02", Date.UTC(2026, 10, 2, 12))).toBe("сегодня");
    expect(at("2026-11-02", Date.UTC(2026, 10, 1, 12))).toBe("завтра");
    expect(at("2026-11-02", Date.UTC(2026, 9, 31, 12))).toBe("послезавтра");
    expect(at("2026-11-02", Date.UTC(2026, 10, 3, 12))).toBe("вчера");
    expect(at("2026-11-02", Date.UTC(2026, 9, 25, 12))).toBe("через 8 дней");
    expect(at("2026-11-02", Date.UTC(2026, 9, 30, 12))).toBe("через 3 дня");
  });

  it("stays seven calendar days across the 2026-10-25 Berlin DST change in Russian too", () => {
    expect(relativeDeadline("2 ноября", { now: Date.UTC(2026, 9, 26, 6, 32), timeZone: BERLIN, language: "ru" })?.days).toBe(7);
    // one Berlin calendar day earlier, i.e. before the observed date, is still +8 not +7 or +9
    expect(relativeDeadline("2 ноября", { now: Date.UTC(2026, 9, 25, 6, 32), timeZone: BERLIN, language: "ru" })?.days).toBe(8);
  });

  it("keeps English as the default phrase language", () => {
    expect(relativeDeadline("2 ноября", { now: OCT26_0832, timeZone: BERLIN })?.phrase).toBe("in 7 days");
  });
});
