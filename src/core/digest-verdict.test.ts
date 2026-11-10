import { describe, expect, it } from "vitest";
import { digestVerdict, describeLateDigestChange, reconcileLateDigest, type DigestSubjectSearch } from "./digest-verdict.js";

const s = (subject: string, state: DigestSubjectSearch["state"], qualified = 0, note?: string): DigestSubjectSearch =>
  ({ subject, state, qualified, ...(note ? { note } : {}) });

describe("digest verdict (bd pibot-jiqv)", () => {
  it("calls a completed, empty search THIN", () => {
    const v = digestVerdict([s("ai-agents", "completed", 0), s("local-llms", "completed", 0)]);
    expect(v.verdict).toBe("thin");
    expect(v.headline).toContain("Thin wire");
    expect(v.headline).toContain("nothing met the inclusion bar");
    expect(v.gaps).toEqual([]);
  });

  it("never calls a still-running search THIN — it is unavailable", () => {
    // The Nov 4 case: researcher reported the scrape still running, digest said "Thin wire — completed".
    const v = digestVerdict([s("ai-agents", "running", 0, "researcher still scraping")]);
    expect(v.verdict).toBe("unavailable");
    expect(v.headline).toContain("NOT a thin day");
    expect(v.headline).not.toContain("Thin wire");
    expect(v.gaps[0]).toContain("search still running");
    expect(v.gaps[0]).toContain("researcher still scraping");
  });

  it("separates a missed window from an empty one when other subjects completed", () => {
    const v = digestVerdict([s("ai-agents", "completed", 2), s("local-llms", "running")]);
    expect(v.verdict).toBe("partial");
    expect(v.covered).toEqual(["ai-agents"]);
    expect(v.gaps).toHaveLength(1);
    expect(v.headline).toContain("cannot be called thin yet");
  });

  it("distinguishes a deferred subject from a failed one in the gap wording", () => {
    const v = digestVerdict([s("a", "completed", 0), s("b", "deferred"), s("c", "failed")]);
    expect(v.gaps).toEqual(["b: not searched (deferred)", "c: search failed"]);
    expect(v.verdict).toBe("partial");
  });

  it("reports a normal drop when searches completed with results", () => {
    const v = digestVerdict([s("ai-agents", "completed", 3), s("local-llms", "completed", 1)]);
    expect(v.verdict).toBe("drop");
    expect(v.covered).toEqual(["ai-agents", "local-llms"]);
    expect(v.lateCanUpgrade).toBe(false);
  });

  it("skips when there are no active subjects", () => {
    expect(digestVerdict([]).verdict).toBe("skipped");
    expect(digestVerdict([s("   ", "completed", 1)]).verdict).toBe("skipped");
  });

  it("upgrades unavailable to drop on a late result WITHOUT searching again", () => {
    const before = digestVerdict([s("ai-agents", "running")]);
    expect(before.verdict).toBe("unavailable");
    const after = reconcileLateDigest(before, [s("ai-agents", "completed", 2)]);
    expect(after.view.verdict).toBe("drop");
    expect(after.changed).toBe(true);
    expect(after.resubmitted).toBe(false);
    expect(describeLateDigestChange(before, after.view)).toContain("no subject was searched twice".replace("no", "No"));
  });

  it("lets a late result settle an inconclusive day into a genuinely thin one", () => {
    const before = digestVerdict([s("a", "completed", 0), s("b", "running")]);
    expect(before.verdict).toBe("partial");
    const after = reconcileLateDigest(before, [s("a", "completed", 0), s("b", "completed", 0)]);
    expect(after.view.verdict).toBe("thin");
    expect(describeLateDigestChange(before, after.view)).toContain("nothing qualified");
  });

  it("reports no change when a late reply adds nothing", () => {
    const before = digestVerdict([s("a", "completed", 1)]);
    const after = reconcileLateDigest(before, [s("a", "completed", 1)]);
    expect(after.changed).toBe(false);
    expect(after.view.verdict).toBe("drop");
  });

  it("ignores a negative/garbage qualified count instead of reporting results", () => {
    const v = digestVerdict([s("a", "completed", -4)]);
    expect(v.verdict).toBe("thin");
  });
});
