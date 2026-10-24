// Programmatic fact-check of numeric claims in a result text (bd pibot-wr9m).
// Verifies ONLY mechanical arithmetic: A×B=Z, A+B=Z, "X% of Y is Z", "X out of Y is Z%".
// It never judges prose certainty; labels (source claim / verified fact / hypothesis) stay
// with the synthesis itself — this module's job is that no arithmetic lie survives untouched.

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

/** true when the two sides agree within ±1 or 1% (rounding-friendly) */
function close(actual: number, expected: number): boolean {
  const tolerance = Math.max(1, Math.abs(expected) * 0.01);
  return Math.abs(actual - expected) <= tolerance;
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
    verdict(check, claim, close((num(pct) / 100) * num(base), num(z)));
  }

  // denominator share: "5 out of 8 is 62.5%"
  for (const m of text.matchAll(new RegExp(`(${NUM})\\s+out of\\s+(${NUM})\\s*(?:=|equals|is)\\s*(${NUMS})\\s*%`, "gi"))) {
    const [claim, part, whole, pct] = m;
    const wholeN = num(whole);
    verdict(check, claim, wholeN === 0 ? false : close((num(part) / wholeN) * 100, num(pct)));
  }

  return check;
}