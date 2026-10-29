import { describe, expect, it } from "vitest";
import { scanNumericClaims, scanRelativeDateClaims } from "./fact-check.js";

const BERLIN = "Europe/Berlin";
const OCT26 = Date.UTC(2026, 9, 26, 7, 32); // 2026-10-26 08:32 Europe/Berlin (CET = UTC+1) — the observed moment

describe("scanNumericClaims (bd pibot-wr9m)", () => {
  it("rejects off-by-one arithmetic and large relative errors", () => {
    expect(scanNumericClaims("1 + 1 = 3").inconsistent).toBe(1);
    expect(scanNumericClaims("1000 * 1000 = 1005000").inconsistent).toBe(1);
    expect(scanNumericClaims("0.1 + 0.2 = 0.3").inconsistent).toBe(0);
  });

  it("verifies multiplication/addition claims", () => {
    const ok = scanNumericClaims("Each unit costs 120 * 3 = 360, and the parts 40 + 60 = 100 in total.");
    expect(ok).toMatchObject({ checked: 2, inconsistent: 0 });
    const bad = scanNumericClaims("120 * 3 = 340, and 40 + 60 = 110.");
    expect(bad).toMatchObject({ checked: 2, inconsistent: 2 });
    expect(bad.failures).toHaveLength(2);
  });

  it("verifies percentage-of claims with locale-commas", () => {
    expect(scanNumericClaims("15% of 2,000 is 300.")).toMatchObject({ checked: 1, inconsistent: 0 });
    const bad = scanNumericClaims("15% of 2,000 is 450.");
    expect(bad).toMatchObject({ checked: 1, inconsistent: 1 });
    expect(bad.failures[0]).toContain("15% of 2,000 is 450");
  });

  it("verifies out-of-percentage (denominator) claims and rejects zero denominators", () => {
    expect(scanNumericClaims("5 out of 8 is 62.5% of users.")).toMatchObject({ checked: 1, inconsistent: 0 });
    const bad = scanNumericClaims("5 out of 8 is 80%.");
    expect(bad).toMatchObject({ checked: 1, inconsistent: 1 });
    expect(scanNumericClaims("5 out of 0 is 50%.").inconsistent).toBe(1);
  });

  it("accepts rounding-friendly tolerance", () => {
    expect(scanNumericClaims("33% of 3 is 1.")).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanNumericClaims("120 * 3 ≈ 359.5 — call it 360.").checked).toBe(0); // ≈ is not a claim shape
  });

  it("ignores prose without arithmetic claims", () => {
    expect(scanNumericClaims("The task took 30 minutes and produced two files.")).toMatchObject({ checked: 0, inconsistent: 0 });
    expect(scanNumericClaims("")).toMatchObject({ checked: 0, inconsistent: 0 });
  });

  it("caps kept failures but counts them all", () => {
    const many = scanNumericClaims("1 + 1 = 30. 2 + 2 = 50. 3 + 3 = 70. 4 + 4 = 90. 5 + 5 = 110. 6 + 6 = 130.");
    expect(many).toMatchObject({ checked: 6, inconsistent: 6 });
    expect(many.failures).toHaveLength(5);
  });
});

describe("scanRelativeDateClaims — relative words must match the current date (bd pibot-wr9m)", () => {
  it("catches the observed 'today, November 2' on October 26", () => {
    const check = scanRelativeDateClaims("The deadline is today, November 2.", { now: OCT26, timeZone: BERLIN });
    expect(check).toMatchObject({ checked: 1, inconsistent: 1 });
    expect(check.failures[0]).toContain("November 2");
  });

  it("accepts the same wording when the date really is today", () => {
    const check = scanRelativeDateClaims("The deadline is today, November 2.", { now: Date.UTC(2026, 10, 2, 6, 32), timeZone: BERLIN });
    expect(check).toMatchObject({ checked: 1, inconsistent: 0 });
  });

  it("verifies and rejects explicit 'in N days' wording", () => {
    expect(scanRelativeDateClaims("Seven to go: in 7 days, November 2.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    const bad = scanRelativeDateClaims("in 2 days, November 2.", { now: OCT26, timeZone: BERLIN });
    expect(bad).toMatchObject({ checked: 1, inconsistent: 1 });
  });

  it("checks tomorrow/yesterday against the explicit date", () => {
    expect(scanRelativeDateClaims("Tomorrow is October 27.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanRelativeDateClaims("Tomorrow is November 3.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 1 });
    expect(scanRelativeDateClaims("Yesterday was October 25.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
  });

  it("resolves the reference date in the named timezone, not the machine's", () => {
    const instant = Date.UTC(2026, 10, 1, 23, 30); // 2026-11-02 00:30 Berlin, still 2026-11-01 UTC
    const text = "The deadline is today, November 2.";
    expect(scanRelativeDateClaims(text, { now: instant, timeZone: "UTC" }).inconsistent).toBe(1);
    expect(scanRelativeDateClaims(text, { now: instant, timeZone: BERLIN }).inconsistent).toBe(0);
  });

  it("leaves ambiguous or date-free prose alone", () => {
    expect(scanRelativeDateClaims("today I checked the page and in 7 days, November 2 is due.", { now: OCT26, timeZone: BERLIN }).checked).toBe(0);
    expect(scanRelativeDateClaims("The deadline is today.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0 });
    expect(scanRelativeDateClaims("", { now: OCT26 })).toMatchObject({ checked: 0, inconsistent: 0 });
  });

  it("leaves merely co-occurring relative/date prose unjudged (bd pibot-wr9m review)", () => {
    // A relative word in the same sentence as a date is NOT an equation unless written as an apposition.
    expect(scanRelativeDateClaims("Today I checked the page for the November 2 deadline.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0 });
    expect(scanRelativeDateClaims("Сегодня проверил страницу: дедлайн 2 ноября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0 });
    // the observed apposition is still caught on Oct 26 (7 days) and stays consistent on Nov 2
    expect(scanRelativeDateClaims("Дедлайн — сегодня, 2 ноября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 1 });
    expect(scanRelativeDateClaims("Дедлайн — сегодня, 2 ноября.", { now: Date.UTC(2026, 10, 2, 7, 32), timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
  });

  it("does not touch numeric arithmetic (separate concern)", () => {
    expect(scanRelativeDateClaims("1 + 1 = 3 today, October 26.", { now: OCT26, timeZone: BERLIN }).inconsistent).toBe(0);
  });
});

describe("scanRelativeDateClaims — the original wording was Russian (bd pibot-wr9m)", () => {
  it("catches the observed 'сегодня, 2 ноября' on 26 October", () => {
    const check = scanRelativeDateClaims("Дедлайн — сегодня, 2 ноября.", { now: OCT26, timeZone: BERLIN });
    expect(check).toMatchObject({ checked: 1, inconsistent: 1 });
    expect(check.failures[0]).toContain("2 ноября");
  });

  it("accepts 'через 7 дней, 2 ноября' and rejects the wrong count", () => {
    expect(scanRelativeDateClaims("Дедлайн — через 7 дней, 2 ноября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanRelativeDateClaims("Дедлайн — через 2 дня, 2 ноября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 1 });
  });

  it("checks завтра/послезавтра/вчера and 'N дней назад' against the explicit date", () => {
    expect(scanRelativeDateClaims("Завтра — 27 октября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanRelativeDateClaims("Послезавтра — 28 октября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanRelativeDateClaims("Вчера — 25 октября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanRelativeDateClaims("7 дней назад — 19 октября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanRelativeDateClaims("Вчера — 27 октября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 1 });
  });

  it("resolves the Russian reference date in the named timezone", () => {
    const instant = Date.UTC(2026, 10, 1, 23, 30); // 2026-11-02 00:30 Berlin, still 2026-11-01 UTC
    const text = "Дедлайн — сегодня, 2 ноября.";
    expect(scanRelativeDateClaims(text, { now: instant, timeZone: "UTC" }).inconsistent).toBe(1);
    expect(scanRelativeDateClaims(text, { now: instant, timeZone: BERLIN }).inconsistent).toBe(0);
  });

  it("leaves ambiguous Russian prose and date-free Russian wording alone", () => {
    expect(scanRelativeDateClaims("Сегодня проверил страницу и через 7 дней, 2 ноября дедлайн.", { now: OCT26, timeZone: BERLIN }).checked).toBe(0);
    expect(scanRelativeDateClaims("Дедлайн — сегодня.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0 });
  });

  it("does not mis-read afterзавтра as завтра", () => {
    // "послезавтра" is +2; if it were read as "завтра" the offset would be 1 and 28 October would mismatch
    expect(scanRelativeDateClaims("Послезавтра — 28 октября.", { now: OCT26, timeZone: BERLIN }).inconsistent).toBe(0);
    expect(scanRelativeDateClaims("Послезавтра — 27 октября.", { now: OCT26, timeZone: BERLIN }).inconsistent).toBe(1);
  });
});

describe("scanRelativeDateClaims — numeric dates survive clause splitting (bd pibot-wr9m review)", () => {
  it("sees the date in 'сегодня, 02.11.2026' instead of shredding it on the dots", () => {
    const check = scanRelativeDateClaims("Дедлайн — сегодня, 02.11.2026.", { now: OCT26, timeZone: BERLIN });
    expect(check).toMatchObject({ checked: 1, inconsistent: 1 });
    expect(check.failures[0]).toContain("02.11.2026");
  });

  it("still sees the date when no trailing sentence period is present", () => {
    expect(scanRelativeDateClaims("сегодня, 02.11.2026", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 1 });
  });

  it("accepts the matching numeric form", () => {
    expect(scanRelativeDateClaims("Дедлайн — через 7 дней, 02.11.2026.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanRelativeDateClaims("Today is 26.10.2026.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
  });

  it("catches an English numeric-date mismatch too", () => {
    expect(scanRelativeDateClaims("The deadline is today, 02.11.2026.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 1 });
  });
});

describe("scanRelativeDateClaims — ambiguous associations are left unjudged (bd pibot-wr9m review)", () => {
  it("does not apply one relative word to several unrelated dates", () => {
    expect(scanRelativeDateClaims("Tomorrow is October 27 and the review is November 2.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0 });
    expect(scanRelativeDateClaims("Завтра — 27 октября, а ревью — 2 ноября.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0 });
  });

  it("leaves a numeric date range alone", () => {
    expect(scanRelativeDateClaims("Today, 26.10.2026, opens the window that ends 02.11.2026.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0 });
  });

  it("still judges the unambiguous single-date case", () => {
    expect(scanRelativeDateClaims("Tomorrow is October 27.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 0 });
    expect(scanRelativeDateClaims("Tomorrow is November 3.", { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 1, inconsistent: 1 });
  });
});