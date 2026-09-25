import { describe, expect, it } from "vitest";
import {
  blindOrder, renderReplayReport, repeatability, selectReplayCases, summarizeReplay, verdictFor,
  type JevReplayCase,
} from "./jev-replay.js";

function replayCase(over: Partial<JevReplayCase> = {}): JevReplayCase {
  return {
    caseId: "c1", mode: "create", skillName: "morning-brief", dataClass: "synthetic",
    candidateHash: "cand", baselineHash: "base", baselineProvenance: "verified",
    task: "owner task", criteria: "owner criteria", taskAuthor: "owner",
    candidateReply: "candidate answer", oldScore: 5, oldParse: "parsed",
    jev: { result: "evaluated", criteria: "meets" }, label: { criteria: "meets" },
    ...over,
  };
}

describe("replay selection (independent + provenanced)", () => {
  it("keeps owner-authored, provenanced, approved cases", () => {
    const sel = selectReplayCases([replayCase()]);
    expect(sel.included).toHaveLength(1);
    expect(sel.excluded).toHaveLength(0);
  });

  it("excludes proposer-authored criteria — the independence requirement", () => {
    const sel = selectReplayCases([replayCase({ taskAuthor: "proposer" })]);
    expect(sel.included).toHaveLength(0);
    expect(sel.excluded[0]).toEqual({ caseId: "c1", reason: "not_owner_authored" });
  });

  it("excludes a patch whose baseline was never reconstructed", () => {
    const sel = selectReplayCases([replayCase({ mode: "patch", baselineProvenance: "missing", baselineHash: undefined })]);
    expect(sel.excluded[0]!.reason).toBe("baseline_unverified");
  });

  it("excludes material outside the approved data class and incomplete cases", () => {
    const sel = selectReplayCases([
      replayCase({ caseId: "c1", dataClass: "unapproved" as never }),
      replayCase({ caseId: "c2", candidateReply: "  " }),
    ]);
    expect(sel.excluded.map((e) => e.reason).sort()).toEqual(["disallowed_data_class", "missing_required_material"]);
  });
});

describe("blinded A/B ordering", () => {
  it("is deterministic for a seed and splits roughly evenly", () => {
    expect(blindOrder("case-a", "seed")).toBe(blindOrder("case-a", "seed"));
    const orders = Array.from({ length: 200 }, (_, i) => blindOrder(`case-${i}`, "seed"));
    const ab = orders.filter((o) => o === "AB").length;
    expect(ab).toBeGreaterThan(60);
    expect(ab).toBeLessThan(140);
  });

  it("changes the order for a different seed (blinding is not fixed per case)", () => {
    const differs = Array.from({ length: 50 }, (_, i) => blindOrder(`c${i}`, "s1") !== blindOrder(`c${i}`, "s2")).some(Boolean);
    expect(differs).toBe(true);
  });
});

describe("verdicts: the failure modes the report exists to surface", () => {
  it("flags a false pass — the automatic rule would ship what a human calls a miss", () => {
    expect(verdictFor(replayCase({ label: { criteria: "misses_required" }, oldScore: 5 }))).toBe("false_pass");
  });

  it("flags a false review — the rule holds something a human accepts", () => {
    expect(verdictFor(replayCase({ label: { criteria: "meets" }, oldScore: 2 }))).toBe("false_review");
  });

  it("counts agreement, disagreement and unassessable separately", () => {
    expect(verdictFor(replayCase({ jev: { result: "evaluated", criteria: "partial" }, label: { criteria: "meets" } }))).toBe("disagree");
    expect(verdictFor(replayCase({ jev: { result: "failed" }, label: { criteria: "meets" } }))).toBe("unassessable");
    expect(verdictFor(replayCase({ label: undefined }))).toBe("unlabelled");
  });

  it("never treats an old score as the label", () => {
    // old score says perfect; the human label is the only thing that decides
    expect(verdictFor(replayCase({ oldScore: 5, label: { criteria: "misses_required" } }))).toBe("false_pass");
  });
});

describe("report aggregation", () => {
  it("aggregates by slice and keeps judge parse provenance visible", () => {
    const report = summarizeReplay([
      replayCase({ caseId: "a", mode: "create" }),
      replayCase({ caseId: "b", mode: "patch", baselineProvenance: "verified", oldScore: 5, label: { criteria: "misses_required" }, oldParse: "fallback" }),
      replayCase({ caseId: "c", mode: "patch", oldParse: undefined, jev: { result: "unassessable" }, label: { criteria: "partial" } }),
    ], [120, 300]);
    expect(report.counts).toMatchObject({ total: 3, labelled: 3, falsePass: 1, agreement: 1, unassessable: 1 });
    expect(report.judgeParse).toEqual({ parsed: 1, fallback: 1, unknown: 1 });
    expect(report.bySlice["patch/synthetic"]).toMatchObject({ total: 2, falsePass: 1 });
    expect(report.latencyMs).toEqual([120, 300]);
  });

  it("reports repeat stability and names unstable groups", () => {
    const { groups, unstable } = repeatability([
      replayCase({ caseId: "r1", repeatOf: "g1" }),
      replayCase({ caseId: "r2", repeatOf: "g1" }),
      replayCase({ caseId: "r3", repeatOf: "g2", jev: { result: "evaluated", criteria: "partial" } }),
      replayCase({ caseId: "r4", repeatOf: "g2", jev: { result: "evaluated", criteria: "meets" } }),
    ]);
    expect(groups).toBe(2);
    expect(unstable).toEqual(["g2"]);
  });

  it("renders a report that states evidence, exclusions and limitations — and proposes no gate", () => {
    const md = renderReplayReport(
      summarizeReplay([replayCase()]),
      repeatability([replayCase()]),
      [{ caseId: "x", reason: "not_owner_authored" }],
    );
    expect(md).toContain("False passes 0");
    expect(md).toContain("not_owner_authored");
    expect(md).toContain("## Limitations");
    expect(md).toMatch(/no promotion path changes/i);
  });
});
