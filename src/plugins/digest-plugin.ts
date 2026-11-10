import * as fs from "node:fs";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  describeLateDigestChange,
  digestVerdict,
  reconcileLateDigest,
  type DigestSubjectSearch,
  type DigestVerdictView,
} from "../core/digest-verdict.js";

/**
 * Shared plugin: canonical verdict for the daily proactive-research digest (bd pibot-jiqv).
 *
 * The wording of a digest used to be the model's choice, so "the researcher is still searching"
 * came out as "Thin wire — completed" (Nov 4 08:07 CET). THIN means searched-and-empty; it is
 * not a synonym for "no evidence yet". This plugin is the only place that decides, and it
 * refuses to accept a `thin` claim whose recorded searches were not all completed.
 *
 * Nothing here searches, schedules or sends: the caller records what actually happened for each
 * subject and the plugin returns the verdict, the owner-facing headline and the gap reasons.
 */

export interface DigestPluginDeps {
  agentId: string;
  /** agent root; the last verdict is persisted under <agentDir>/state/digest-verdict.json */
  agentDir: string;
  now?: () => number;
}

interface StoredVerdict {
  date: string;
  view: DigestVerdictView;
  subjects: DigestSubjectSearch[];
}

const SUBJECT_SCHEMA = Type.Object({
  subject: Type.String({ description: "Subject id/label exactly as it appears in the research registry" }),
  state: Type.Union([
    Type.Literal("completed"),
    Type.Literal("running"),
    Type.Literal("deferred"),
    Type.Literal("failed"),
  ], { description: "What actually happened to this subject's search: completed, still running, not searched (deferred), or failed" }),
  qualified: Type.Optional(Type.Number({ description: "How many results met the inclusion bar. Only meaningful when state=completed; omit it while a search is still running" })),
  note: Type.Optional(Type.String({ description: "Short honest reason kept with a missed window, e.g. 'researcher still scraping'" })),
});

type LateDetails =
  | { ok: false; reason: string }
  | { ok: true; changed: boolean; resubmitted: false; verdict: DigestVerdictView["verdict"] };

function normalizeSubjects(raw: Array<{ subject: string; state: DigestSubjectSearch["state"]; qualified?: number; note?: string }>): DigestSubjectSearch[] {
  return raw.map((s) => ({
    subject: s.subject,
    state: s.state,
    qualified: s.state === "completed" ? Math.max(0, Math.trunc(s.qualified ?? 0)) : 0,
    ...(s.note ? { note: s.note } : {}),
  }));
}

export function digestPlugin(deps: DigestPluginDeps): InlineExtension {
  const { agentId, agentDir } = deps;
  const stateDir = path.join(path.resolve(agentDir), "state");
  const storePath = path.join(stateDir, "digest-verdict.json");
  const date = () => new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);

  const read = (): StoredVerdict | undefined => {
    try {
      return JSON.parse(fs.readFileSync(storePath, "utf8")) as StoredVerdict;
    } catch { return undefined; }
  };
  const write = (stored: StoredVerdict) => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(stateDir, 0o700); } catch { /* best effort — the file still lands owner-only by default */ }
    fs.writeFileSync(storePath, JSON.stringify(stored, null, 2));
  };

  const render = (view: DigestVerdictView) => [
    view.headline,
    `verdict: ${view.verdict}`,
    ...view.gaps.map((gap) => `gap — ${gap}`),
    ...(view.covered.length ? [`covered: ${view.covered.join(", ")}`] : []),
    ...(view.lateCanUpgrade ? ["a late result can still change this verdict; do not call the day thin"] : []),
  ].join("\n");

  return {
    name: "digest",
    factory: (pi) => {
      pi.registerTool({
        name: "digest_verdict",
        label: "Digest verdict",
        description: [
          `Decide the daily research-digest verdict from what actually happened to each subject's search, and get the wording to report.`,
          `THIN is returned only when EVERY subject was searched and nothing qualified. A search that is still running, was deferred, or failed is PARTIAL/UNAVAILABLE, never thin — report that state honestly and do not pad or guess.`,
          `Call it right before reporting the digest, with one entry per active subject.`,
        ].join(" "),
        parameters: Type.Object({
          subjects: Type.Array(SUBJECT_SCHEMA, { minItems: 0, description: "One entry per active research subject" }),
        }),
        async execute(_toolCallId, params) {
          const subjects = normalizeSubjects(params.subjects);
          const view = digestVerdict(subjects);
          write({ date: date(), view, subjects });
          return {
            content: [{ type: "text", text: render(view) }],
            details: { ok: true, verdict: view.verdict, headline: view.headline, gaps: view.gaps, covered: view.covered },
          };
        },
      });

      pi.registerTool({
        name: "digest_late_result",
        label: "Late digest result",
        description: [
          `Fold a LATE digest result into the verdict you already reported, without searching anything again.`,
          `Pass the same subjects with the finished search now marked completed. The reply says what changed and is explicit that no subject was searched twice and that the earlier report stands as sent — never re-search or resend the earlier digest.`,
        ].join(" "),
        parameters: Type.Object({
          subjects: Type.Array(SUBJECT_SCHEMA, { minItems: 0, description: "The same subject list, with the late completion folded in" }),
        }),
        async execute(_toolCallId, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: LateDetails }> {
          const previous = read();
          if (!previous) {
            return {
              content: [{ type: "text" as const, text: "No earlier digest verdict recorded today, so there is nothing to reconcile. Report the late result directly with digest_verdict." }],
              details: { ok: false as const, reason: "no-previous-verdict" },
            };
          }
          const subjects = normalizeSubjects(params.subjects);
          const { view, changed } = reconcileLateDigest(previous.view, subjects);
          if (changed) write({ date: previous.date, view, subjects });
          const note = changed ? describeLateDigestChange(previous.view, view) : "Late digest result: no change — the recorded searches already produced this verdict. Nothing was searched again.";
          return {
            content: [{ type: "text" as const, text: `${note}\n${render(view)}` }],
            details: { ok: true as const, changed, resubmitted: false as const, verdict: view.verdict },
          };
        },
      });
    },
  };
}
