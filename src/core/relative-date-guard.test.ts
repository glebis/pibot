import { describe, expect, it } from "vitest";
import { correctRelativeDateClaims } from "./relative-date-guard.js";

// 2026-10-26 08:32 Europe/Berlin (the documented incident window; CET = UTC+1, so 07:32 UTC).
const OCT26 = Date.UTC(2026, 9, 26, 7, 32);
const BERLIN = "Europe/Berlin";

describe("relative-date guard (bd pibot-wr9m)", () => {
  it("rewrites a Russian 'Сегодня' that contradicts the 2 Nov deadline", () => {
    const r = correctRelativeDateClaims("Дедлайн сегодня — 2 ноября. Успеть бы.", { now: OCT26, timeZone: BERLIN });
    expect(r.inconsistent).toBe(1);
    expect(r.corrected).toBe(true);
    expect(r.text).toContain("через 7 дней");
    expect(r.text).not.toContain("сегодня");
    expect(r.text).toContain("Успеть бы."); // the rest of the sentence is untouched
  });

  it("rewrites an English 'today' that contradicts the 2 Nov deadline", () => {
    const r = correctRelativeDateClaims("The deadline is today, November 2.", { now: OCT26, timeZone: BERLIN });
    expect(r.corrected).toBe(true);
    expect(r.text).toContain("in 7 days");
    expect(r.text).not.toMatch(/\btoday\b/);
  });

  it("rewrites a wrong 'in N days' / 'через N дней' too", () => {
    const en = correctRelativeDateClaims("Due in 2 days, November 2.", { now: OCT26, timeZone: BERLIN });
    expect(en.text).toContain("in 7 days");
    const ru = correctRelativeDateClaims("Срок через 2 дня — 2 ноября.", { now: OCT26, timeZone: BERLIN });
    expect(ru.text).toContain("через 7 дней");
  });

  it("leaves a claim that already agrees with the calendar untouched", () => {
    const r = correctRelativeDateClaims("Deadline in 7 days, November 2.", { now: OCT26, timeZone: BERLIN });
    expect(r.checked).toBe(1);
    expect(r.inconsistent).toBe(0);
    expect(r.corrected).toBe(false);
    expect(r.text).toBe("Deadline in 7 days, November 2.");
  });

  it("leaves relative-only prose (no explicit date) alone", () => {
    const r = correctRelativeDateClaims("The deadline is today and that is all we know.", { now: OCT26, timeZone: BERLIN });
    expect(r.checked).toBe(0);
    expect(r.corrected).toBe(false);
    expect(r.text).toBe("The deadline is today and that is all we know.");
  });

  it("leaves ambiguous prose that mixes several offsets alone", () => {
    const r = correctRelativeDateClaims("Today is fine and in 3 days is better, November 2.", { now: OCT26, timeZone: BERLIN });
    expect(r.corrected).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.text).toBe("Today is fine and in 3 days is better, November 2.");
  });

  it("leaves a clause with several explicit dates unjudged — never one relative word applied to many", () => {
    // The shared detector treats co-occurrence as prose, not an equation: two dates cannot be pinned
    // to one relative word, so no correction is produced (bd pibot-wr9m review).
    const text = "Today we ship, October 26 and November 2 both noted.";
    const r = correctRelativeDateClaims(text, { now: OCT26, timeZone: BERLIN });
    expect(r.checked).toBe(0);
    expect(r.corrected).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.text).toBe(text);
  });

  it("fails safe (blocked, unchanged) when a relative phrase cannot be attributed to the date", () => {
    // Two "today"s, one date: rewriting every phrase blind would touch a word the date does not own.
    const text = "today and today, November 2";
    const r = correctRelativeDateClaims(text, { now: OCT26, timeZone: BERLIN });
    expect(r.inconsistent).toBeGreaterThan(0);
    expect(r.corrected).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.text).toBe(text);
  });

  it("leaves mere co-occurrence alone — prose is not a date equation (bd pibot-wr9m review)", () => {
    const en = "Today I checked the page for the November 2 deadline.";
    expect(correctRelativeDateClaims(en, { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0, corrected: false, blocked: false, text: en });
    const ru = "Сегодня проверил страницу: дедлайн 2 ноября.";
    expect(correctRelativeDateClaims(ru, { now: OCT26, timeZone: BERLIN })).toMatchObject({ checked: 0, inconsistent: 0, corrected: false, blocked: false, text: ru });
  });

  it("still rewrites the observed apposition on Oct 26, and leaves 'сегодня' alone on the deadline day", () => {
    expect(correctRelativeDateClaims("Дедлайн сегодня — 2 ноября.", { now: OCT26, timeZone: BERLIN }).corrected).toBe(true);
    const onDeadline = "Дедлайн сегодня — 2 ноября.";
    const r = correctRelativeDateClaims(onDeadline, { now: Date.UTC(2026, 10, 2, 7, 32), timeZone: BERLIN });
    expect(r.corrected).toBe(false);
    expect(r.text).toBe(onDeadline); // the same source date on Nov 2 keeps "today"
  });

  it("counts from the named timezone, not the machine's", () => {
    // 2026-10-26T23:30Z is already 27 Oct in Berlin (CET, UTC+1) → 6 days to 2 Nov, not 7.
    const r = correctRelativeDateClaims("Deadline in 2 days, November 2.", { now: Date.UTC(2026, 9, 26, 23, 30), timeZone: BERLIN });
    expect(r.text).toContain("in 6 days");
  });

  it("returns the input unchanged for empty or date-free text", () => {
    expect(correctRelativeDateClaims("", { now: OCT26 })).toMatchObject({ checked: 0, corrected: false, text: "" });
    expect(correctRelativeDateClaims("no dates here at all.", { now: OCT26 }).corrected).toBe(false);
  });
});
