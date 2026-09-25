# Jev shadow evaluation for skill evolution

Date: 2026-09-25 · Status: proposed for review · bd: pibot-n13 · Implementation: not started

## Goal

Assess whether Jev's typed judgments improve PiBot's skill-evolution review decisions without changing the current promotion path during the evaluation. Jev classifies bounded probe evidence; deterministic PiBot policy stages, promotes, or requests human review.

## Current behavior and the gap

`src/core/evolution.ts` proposes one create/patch candidate with one or two model-authored tasks and success criteria. Deterministic gates check name, structure, patch target, probe presence, and repeated proposals. The engine stages the candidate, runs at most two probes with that candidate loaded, and asks an ephemeral LLM judge for a 1–5 score per reply. An average of at least 4 auto-promotes unless the resulting skill matches a risky pattern; otherwise it remains staged for human review. A judge error or unparseable response becomes 3. A 5 and a fallback 3 therefore still average to 4. Promotion can also close linked improvement-backlog items and announce the skill.

The current probes test the candidate against criteria written by the same proposer. They do not compare it with the prior skill or with no skill. A Jev judgment of those probes alone cannot establish improvement. Historical staging retains candidate files and prior score summaries, but not the original probe tasks, criteria, or replies.

## Scope

1. Build an independent, privacy-safe replay set from eligible staged or historical candidates, with owner-reviewed tasks and criteria.
2. Add a default-off, per-agent Jev shadow observer alongside the existing judge. Shadow outcomes cannot affect scores, staging, promotion, announcements, or backlog closure.
3. Produce an evidence report comparing Jev, the current judge, and blinded human review; return to the owner with a separate decision before any active gate is proposed.

Out of scope: replacing the current judge, changing the `avg >= 4` rule, automatic Jev veto or promotion, live daemon deployment, and changes to link triage.

## Decision contract

The shadow observer receives a snapshot for each probe after the candidate reply exists. It must not read a mutable staging path later. Its input contains only:

- opaque run and probe IDs, agent ID, create/patch mode, candidate and baseline content hashes, and rubric version;
- the task and explicit success criteria;
- the candidate reply and, only when a matched baseline is available, the baseline reply;
- flags indicating missing or truncated evidence.

No whole skill file, memory, event history, session transcript, credentials, or owner message is sent to Jev. Bound each field, redact known sensitive patterns, and reject an input that cannot fit the evaluator's 16 KiB UTF-8 state limit without hiding a required criterion. Treat task, criteria, and replies as untrusted data, not instructions. For live shadow use, an explicit per-agent flag **and** permitted provider/data scope are required; a configured gateway key alone is insufficient. Private probe text is not sent externally by default. Use synthetic or individually approved redacted cases until that scope is agreed.

Primary Jev question (`choice`, rubric versioned):

| Outcome | Meaning |
|---|---|
| `meets` | Reply satisfies every stated required criterion |
| `partial` | Some required criteria are met, but at least one is incomplete |
| `misses_required` | A required criterion is absent or contradicted |
| `unclear` | The available task, criteria, or reply cannot support a judgment |

When a verified baseline reply exists, ask a second `choice`: `candidate_better`, `baseline_better`, `equivalent`, or `unclear`, judged against the same criteria. A narrowly worded boolean question may flag a specific required omission for review. Do not map a continuous Jev score or choice probability to the existing 1–5 scale. The probabilities are routing evidence, not calibrated pass probabilities; category decisions and review thresholds must be validated on the replay set.

The observer returns a discriminated result: `evaluated` (categories and probability vectors), `unassessable` (missing/oversize/redacted evidence), `not_permitted`, or `failed` (typed evaluator reason). Every result carries rubric version, elapsed time, and content hashes. It has no mutation or promotion callback.

## Runtime placement and failure behavior

Add the observer at the evolution engine's probe/judge boundary, not as an agent tool. Preserve the current judge's score exactly. Capture a bounded in-memory snapshot while the candidate still exists, then run the shadow call through a small bounded queue that is not awaited by the promotion decision. Drop excess work rather than growing an unbounded queue or persisting private text. Handle promise rejection and process exit as missing shadow observations; neither changes the current decision. Cap calls per cycle to the existing two probes, set a short per-call timeout and a daily per-agent budget, and avoid retries beyond the evaluator's bound.

For the current judge, record whether `3` came from a parsed answer or its error fallback. This is observational metadata only in shadow mode; the numeric score and promotion rule stay intact.

Write metadata-only records keyed by run/probe ID: timestamp, agent, rubric version, candidate/baseline hashes, old score and parse status, Jev category or failure code, latency, and whether the old path promoted or staged. Do not log prompts, criteria, replies, or raw model responses. Keep detailed measurements in a private, bounded structured store; put only a terse status in `EventLog`, whose summaries feed future agent context. Align the structured trace with the existing `pibot-4ji` operational-trace work rather than creating a parallel user-facing log.

## Replay evaluation

1. Inventory eligible staged/historical candidates without copying private runtime files into Git. Stratify create vs patch, prior high vs low scores, and risky vs ordinary content. Exclude candidates whose baseline version cannot be reconstructed or whose material is outside the approved data scope.
2. Author independent tasks and criteria from the skill's stated trigger and intended behavior. Preserve a held-out set that the proposer did not write. Historical score summaries are context, not ground truth; original tasks and replies are generally unavailable from staging.
3. For each eligible case, snapshot hashes and run baseline and candidate in separate tool-free ephemeral sessions with matched model, prompt, and task. For create, baseline omits the new skill. For patch, baseline loads the verified prior version. Randomize and blind A/B order for human pairwise review. Repeat a small sample to measure run-to-run variance.
4. Compare human labels, old-judge score/parse status, Jev criteria category, and Jev pairwise result. Report severe misses that an automatic rule would pass, useful improvements it would hold for review, disagreement, unassessable share, latency, and cost. Split results by create/patch and data class. Do not select thresholds solely from overall agreement.

## Decision after the shadow period

Present the replay and live-shadow evidence to the owner. A possible later policy is **review-only escalation**: a clear `misses_required`, `baseline_better`, or material judge disagreement stages the candidate for human review. `unclear`, evaluator failure, missing permission, or missing baseline never grants promotion. Existing structural and risky-pattern gates remain mandatory. Any such policy change requires a separate spec decision and tests; Jev never promotes a skill by itself.

## Acceptance criteria for this spec's epic

- Replay fixtures and human labels are independent of model-authored probe criteria; baseline provenance is verified.
- Shadow mode is default off, per-agent and provider/data scoped, bounded in state, calls, time, queue size, and retained metadata.
- Tests prove Jev success, disagreement, timeout, invalid output, or provider denial cannot change the current score, promotion, staging, announcement, or backlog closure.
- A review report shows false-pass and false-review cases, missing-result rate, repeatability, latency, cost, and privacy exclusions, with limitations stated.
- No active Jev gate is enabled without a separate owner-reviewed decision.

## Likely implementation seams (future work)

- `src/core/evolution.ts`: snapshot and shadow observer integration; retain `EvolutionIO.judge` as the authority during shadow mode.
- `src/core/jev-evaluator.ts`: reuse the bounded typed client without domain-specific policy in the client.
- `src/core/types.ts` and config validation: per-agent shadow flag and external-data/provider permission.
- A dedicated private trace/replay module and focused boundary tests.
- `docs/evolution-pipeline.md`: update the diagram and text only when the runtime path changes.
