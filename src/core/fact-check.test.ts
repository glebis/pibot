import { describe, expect, it } from "vitest";
import { scanNumericClaims } from "./fact-check.js";

describe("scanNumericClaims (bd pibot-wr9m)", () => {
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