// ─── Jev replay evaluation harness ──────────────────────────────────────────
//
// Spec: docs/superpowers/specs/2026-09-25-jev-evolution-shadow-evaluation.md · bd pibot-n13
//
// Pure functions for the offline half of the evaluation: validate that a replay
// case is independent and its baseline provenanced, blind the A/B order, and
// aggregate human labels against the old judge and Jev. No I/O, no policy — the
// report it produces is evidence for the owner, never a gate.
//
// Privacy: fixtures live outside Git (or are synthetic). Nothing here writes
// probe text anywhere.

/** Where a case's material came from — only approved classes may be used. */
export type ReplayDataClass = "synthetic" | "redacted_approved";

export type ReplayLabel = {
  /** blinded human judgment of the candidate against the stated criteria */
  criteria: "meets" | "partial" | "misses_required" | "unclear";
  /** blinded human pairwise judgment; absent when no verified baseline existed */
  pairwise?: "candidate_better" | "baseline_better" | "equivalent" | "unclear";
};

export type JevReplayCase = {
  caseId: string;
  mode: "create" | "patch";
  skillName: string;
  dataClass: ReplayDataClass;
  /** content hashes snapshot at capture time */
  candidateHash: string;
  /** required for a patch case: the verified prior version's hash */
  baselineHash?: string;
  /** whether a baseline version was reconstructed and hash-verified */
  baselineProvenance: "verified" | "missing";
  /** owner-reviewed task and criteria — NOT written by the proposer */
  task: string;
  criteria: string;
  /** the proposer of the candidate (used to assert label independence) */
  taskAuthor: "owner" | "proposer";
  candidateReply: string;
  baselineReply?: string;
  /** what the authoritative path did with the candidate */
  oldScore: number;
  oldParse?: "parsed" | "fallback";
  /** Jev's observed outcome, when the shadow ran */
  jev?: { criteria?: string; pairwise?: string; result: "evaluated" | "unassessable" | "not_permitted" | "failed" };
  label?: ReplayLabel;
  /** repeat group id: cases from the same repeat sample must agree for run-to-run stability */
  repeatOf?: string;
};

export type ReplayExclusionReason =
  | "not_owner_authored"
  | "baseline_unverified"
  | "missing_required_material"
  | "disallowed_data_class";

export type ReplaySelection = {
  included: JevReplayCase[];
  excluded: Array<{ caseId: string; reason: ReplayExclusionReason }>;
};

/**
 * Only independently authored cases with verified baseline provenance and an
 * approved data class may enter the evaluation. Historical score summaries are
 * context, not ground truth, so they are never treated as a label.
 */
export function selectReplayCases(cases: readonly JevReplayCase[]): ReplaySelection {
  const included: JevReplayCase[] = [];
  const excluded: ReplaySelection["excluded"] = [];
  for (const c of cases) {
    if (c.taskAuthor !== "owner") {
      excluded.push({ caseId: c.caseId, reason: "not_owner_authored" });
      continue;
    }
    if (c.dataClass !== "synthetic" && c.dataClass !== "redacted_approved") {
      excluded.push({ caseId: c.caseId, reason: "disallowed_data_class" });
      continue;
    }
    if (c.mode === "patch" && (c.baselineProvenance !== "verified" || !c.baselineHash)) {
      excluded.push({ caseId: c.caseId, reason: "baseline_unverified" });
      continue;
    }
    if (!c.task.trim() || !c.criteria.trim() || !c.candidateReply.trim() || !c.candidateHash) {
      excluded.push({ caseId: c.caseId, reason: "missing_required_material" });
      continue;
    }
    included.push(c);
  }
  return { included, excluded };
}

/** Deterministic 0/1 from a case id and seed — blinding must be reproducible. */
function hashBit(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2;
}

/** A/B order for blinded human review; "AB" = candidate shown first. */
export function blindOrder(caseId: string, seed: string): "AB" | "BA" {
  return hashBit(`${seed}:${caseId}`) === 0 ? "AB" : "BA";
}

export type CaseVerdict =
  | "agree"
  | "disagree"
  /** the automatic rule would pass something a human calls a miss — the worst failure mode */
  | "false_pass"
  /** the rule holds for review something a human accepts */
  | "false_review"
  | "unassessable"
  | "unlabelled";

/** Compare one case's human label with the old judge and Jev. */
export function verdictFor(c: JevReplayCase, promoteThreshold = 4): CaseVerdict {
  if (!c.label) return "unlabelled";
  const wouldPromote = c.oldScore >= promoteThreshold;
  if (c.label.criteria === "misses_required" && wouldPromote) return "false_pass";
  if (c.label.criteria === "meets" && !wouldPromote) return "false_review";
  if (!c.jev || c.jev.result !== "evaluated" || !c.jev.criteria) return "unassessable";
  return c.jev.criteria === c.label.criteria ? "agree" : "disagree";
}

export type ReplayReport = {
  counts: {
    total: number;
    labelled: number;
    evaluatedByJev: number;
    unassessable: number;
    agreement: number;
    disagreement: number;
    falsePass: number;
    falseReview: number;
  };
  shares: { unassessable: number; agreementOfEvaluated: number };
  /** false passes / false reviews split by mode and data class */
  bySlice: Record<string, { total: number; falsePass: number; falseReview: number }>;
  /** judge parse provenance: a fallback 3 is not an observation of quality */
  judgeParse: { parsed: number; fallback: number; unknown: number };
  /** mean absolute difference between the old score and a 1-5 proxy of the label */
  latencyMs: number[];
};

const LABEL_SCORE: Record<ReplayLabel["criteria"], number> = { meets: 5, partial: 3, misses_required: 1, unclear: 3 };

export function summarizeReplay(cases: readonly JevReplayCase[], latencies: readonly number[] = []): ReplayReport {
  const counts = { total: cases.length, labelled: 0, evaluatedByJev: 0, unassessable: 0, agreement: 0, disagreement: 0, falsePass: 0, falseReview: 0 };
  const bySlice: ReplayReport["bySlice"] = {};
  const judgeParse = { parsed: 0, fallback: 0, unknown: 0 };
  for (const c of cases) {
    if (c.oldParse === "parsed") judgeParse.parsed += 1;
    else if (c.oldParse === "fallback") judgeParse.fallback += 1;
    else judgeParse.unknown += 1;
    if (c.label) counts.labelled += 1;
    if (c.jev?.result === "evaluated") counts.evaluatedByJev += 1;
    const verdict = verdictFor(c);
    if (verdict === "unassessable") counts.unassessable += 1;
    if (verdict === "agree") counts.agreement += 1;
    if (verdict === "disagree") counts.disagreement += 1;
    if (verdict === "false_pass") counts.falsePass += 1;
    if (verdict === "false_review") counts.falseReview += 1;
    const key = `${c.mode}/${c.dataClass}`;
    bySlice[key] ??= { total: 0, falsePass: 0, falseReview: 0 };
    bySlice[key].total += 1;
    if (verdict === "false_pass") bySlice[key].falsePass += 1;
    if (verdict === "false_review") bySlice[key].falseReview += 1;
  }
  const judged = counts.agreement + counts.disagreement;
  return {
    counts,
    shares: {
      unassessable: counts.total ? counts.unassessable / counts.total : 0,
      agreementOfEvaluated: judged ? counts.agreement / judged : 0,
    },
    bySlice,
    judgeParse,
    latencyMs: [...latencies],
  };
}

/**
 * Run-to-run stability: repeated samples of the same case must produce the same
 * human label and the same Jev category, otherwise the comparison is noise.
 */
export function repeatability(cases: readonly JevReplayCase[]): { groups: number; unstable: string[] } {
  const groups = new Map<string, JevReplayCase[]>();
  for (const c of cases) {
    if (!c.repeatOf) continue;
    groups.set(c.repeatOf, [...(groups.get(c.repeatOf) ?? []), c]);
  }
  const unstable: string[] = [];
  for (const [id, group] of groups) {
    const labels = new Set(group.map((c) => c.label?.criteria ?? "unlabelled"));
    const jev = new Set(group.map((c) => c.jev?.criteria ?? (c.jev?.result ?? "none")));
    if (labels.size > 1 || jev.size > 1) unstable.push(id);
  }
  return { groups: groups.size, unstable };
}

/** A terse markdown report for owner review. Evidence and limitations, no gate. */
export function renderReplayReport(report: ReplayReport, repeats: { groups: number; unstable: string[] }, excluded: ReplaySelection["excluded"]): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    "# Jev replay evaluation",
    "",
    `Cases: ${report.counts.total} (labelled ${report.counts.labelled}, Jev-evaluated ${report.counts.evaluatedByJev})`,
    `Agreement ${report.counts.agreement} · disagreement ${report.counts.disagreement} · unassessable ${pct(report.shares.unassessable)}`,
    `False passes ${report.counts.falsePass} · false reviews ${report.counts.falseReview}`,
    `Judge parse status: parsed ${report.judgeParse.parsed}, error-fallback ${report.judgeParse.fallback}, unknown ${report.judgeParse.unknown}`,
    `Repeat samples: ${repeats.groups}${repeats.unstable.length ? ` — UNSTABLE: ${repeats.unstable.join(", ")}` : " (stable)"}`,
    "",
    "## By slice",
    ...Object.entries(report.bySlice).map(([slice, s]) => `- ${slice}: ${s.total} cases, ${s.falsePass} false pass, ${s.falseReview} false review`),
    "",
    "## Excluded",
    excluded.length ? excluded.map((e) => `- ${e.caseId}: ${e.reason}`).join("\n") : "- none",
    "",
    "## Limitations",
    "- Agreement is not calibration; category decisions and any review threshold still need validation on this set.",
    "- Historical scores are context, not ground truth; only blinded human labels are treated as labels.",
    "- No threshold is proposed here, and no promotion path changes on the basis of this report.",
  ];
  return lines.join("\n");
}
