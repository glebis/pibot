// Digest verdict for the daily proactive-research pass (bd pibot-jiqv).
//
// Nov 4 08:07 CET: the researcher was still searching (its own reply said the scrape was
// running, no candidates yet); seconds later the knower reported "Thin wire — completed".
// THIN means "every subject was searched and nothing qualified" — an empty corpus. It was
// used for "the search had not finished", which tells the owner the day is quiet when the
// evidence is actually missing. The two states must never share a word.
//
// This module is the single deterministic place that decides:
//   drop         — searches completed and produced qualified links
//   thin         — searches COMPLETED with zero qualified results (a genuinely quiet day)
//   partial      — at least one search window missed (running/deferred), some evidence exists
//   unavailable  — no search completed at all (retrieval failed; nothing can be judged)
//
// THIN is reserved for completed searches only. A missed window is PARTIAL/UNAVAILABLE, and
// when the late result finally lands the verdict is recomputed from the SAME recorded searches
// — no resubmission, and never a duplicate search for a subject that already ran.

export type DigestSearchState = "completed" | "running" | "deferred" | "failed";

export interface DigestSubjectSearch {
  /** subject id/label as recorded in the registry */
  subject: string;
  state: DigestSearchState;
  /** how many results met the inclusion bar (only meaningful once `state` is completed) */
  qualified: number;
  /** free-form note kept with a missed window (e.g. "researcher still scraping") */
  note?: string;
}

export type DigestVerdict = "drop" | "thin" | "partial" | "unavailable" | "skipped";

export interface DigestVerdictView {
  verdict: DigestVerdict;
  /** owner-facing one-liner; THIN and PARTIAL never share wording */
  headline: string;
  /** subjects whose search window was missed, with the reason — never presented as "thin" */
  gaps: string[];
  /** subjects that completed and qualify for the drop */
  covered: string[];
  /** true when a late result could still change the verdict without a new search */
  lateCanUpgrade: boolean;
}

const isSettled = (s: DigestSearchState) => s === "completed";

/**
 * Turn the recorded search states into the digest verdict. Pure: the caller supplies what
 * actually happened, including late completions, and nothing is inferred from wall-clock.
 */
export function digestVerdict(subjects: DigestSubjectSearch[]): DigestVerdictView {
  const active = subjects.filter((s) => s.subject.trim());
  if (!active.length) {
    return { verdict: "skipped", headline: "No active research subjects — nothing searched.", gaps: [], covered: [], lateCanUpgrade: false };
  }
  const completed = active.filter((s) => isSettled(s.state));
  const missed = active.filter((s) => !isSettled(s.state));
  const covered = completed.filter((s) => s.qualified > 0).map((s) => s.subject);
  const qualifiedTotal = completed.reduce((n, s) => n + Math.max(0, Math.trunc(s.qualified)), 0);
  const gaps = missed.map((s) => {
    const reason = s.state === "running" ? "search still running"
      : s.state === "deferred" ? "not searched (deferred)"
      : "search failed";
    return `${s.subject}: ${reason}${s.note ? ` — ${s.note}` : ""}`;
  });

  // A missed window is never "thin": the absence of results is unproven, not observed.
  if (missed.length && !completed.length) {
    return {
      verdict: "unavailable",
      headline: `Digest unavailable — no search completed (${gaps.slice(0, 2).join("; ")}). This is NOT a thin day.`,
      gaps, covered, lateCanUpgrade: true,
    };
  }
  if (missed.length) {
    return {
      verdict: "partial",
      headline: `Digest partial — ${covered.length ? `${qualifiedTotal} qualified from ${completed.length} of ${active.length} subject(s)` : `${completed.length} of ${active.length} subject(s) searched, none qualified`}; ${gaps.length} window(s) missed, so the day cannot be called thin yet.`,
      gaps, covered, lateCanUpgrade: true,
    };
  }
  if (!qualifiedTotal) {
    return {
      verdict: "thin",
      headline: `Thin wire — all ${active.length} subject(s) searched, nothing met the inclusion bar.`,
      gaps: [], covered: [], lateCanUpgrade: false,
    };
  }
  return {
    verdict: "drop",
    headline: `${qualifiedTotal} qualified link(s) across ${covered.length} of ${active.length} subject(s).`,
    gaps: [], covered, lateCanUpgrade: false,
  };
}

/**
 * Fold a LATE result into an earlier view without re-running anything (bd pibot-jiqv).
 *
 * The caller passes the same subject list with the finished search now marked completed. The
 * verdict is recomputed, and the returned `resubmitted` flag is always false: a late reply is
 * evidence arriving, not a second search. Subjects that already ran are never re-queried, so
 * an upgraded digest can never double-cover a subject.
 */
export function reconcileLateDigest(
  previous: DigestVerdictView,
  subjects: DigestSubjectSearch[],
): { view: DigestVerdictView; changed: boolean; resubmitted: false } {
  const view = digestVerdict(subjects);
  const changed = view.verdict !== previous.verdict || view.headline !== previous.headline;
  return { view, changed, resubmitted: false };
}

/** One-line owner/ledger annotation for a late completion: what changed, and that nothing re-ran. */
export function describeLateDigestChange(previous: DigestVerdictView, next: DigestVerdictView): string {
  const from = previous.verdict, to = next.verdict;
  const why = to === "thin" ? "the searches finished with nothing qualified"
    : to === "drop" ? "the late searches finished with qualified results"
    : `the verdict is now ${to}`;
  return `Late digest result: ${from} → ${to} — ${why}. No subject was searched twice; the earlier report stands as sent.`;
}
