# Jev-guided response selection

Status: isolated prototype; no live PiBot routing. Beads: `pibot-39f`.

## Product decision

PiBot already has an error-failover cascade (`ModelCascade` and `turnWithCascade`): it moves to another model when the current model cannot answer, while retaining session history and dead-letter recovery. Response selection solves a different problem. It prepares tool-free drafts and chooses one before delivery. Repeating a normal `AgentSession.prompt` across models would repeat tool actions, mutate the same session, and can stream partial replies to Telegram. It must not be used as the candidate generator.

Jev returns a probability for a *written criterion*, such as “this answer visibly satisfies all requested requirements.” It does not return a universal probability that a response is correct. A sequential route stops at the first draft over a calibrated acceptance threshold. To claim the highest-quality draft among N, generate all N and compare them pairwise; this costs more and cannot guarantee the global optimum when judgments are inconsistent. Both routes retain a deterministic primary-draft fallback when Jev is unavailable.

## Prototype contract

`src/core/response-selection.ts` provides:

- `selectToolFreeResponse`: lazy sequential generation or bounded best-of-N comparison, at most four distinct models and a size cap per draft; no model calls, tools, or delivery inside the coordinator itself.
- `createJevResponseJudge`: one bounded `Noul` question for task completion and one `Choice` question for pairwise comparison. It sends only task, criteria, and candidate text after known-secret redaction. Live text requires explicit per-agent permission for TypeSafe and `redacted_approved` scope. A configured key alone is insufficient.
- Typed selection reasons: `threshold_met`, `best_of_n`, `primary_fallback`, or `no_draft`. An assessor failure never becomes a high score.

The generation adapter should call `ModelRuntime.complete` with a fixed system prompt, a snapshot of the user request, a limited read-only context, and no tools. It must honor the agent's provider allowlist and the cascade's open breakers, but must not alter the canonical session. Generate drafts with a shared deadline and token cap; publish only the selected answer. Store only model IDs, rubric version, latency, hashes, and outcome in telemetry. Do not record private drafts in ordinary event logs.

## Suitable pilot

Start with a bounded, low-risk, tool-free response type such as a short explanation or participant recommendation that is already generated via `ModelRuntime.complete`. Exclude owner voice (latency), tool-using turns (side effects), commands, urgent calls, and anything whose correctness depends on external evidence not included in the judge state. For factual answers, verify claims against sources or tool receipts separately; a high rubric score cannot supply missing evidence.

Run three modes on a labelled synthetic set: primary-only baseline, sequential threshold, and best-of-N. Track criterion satisfaction, severe factual misses, judge disagreement, latency to first and final answer, token/API cost, evaluator failures, and fallback share. Blind human comparison determines whether the extra calls improve outcomes. Shadow the chosen response type before enabling alternate delivery. Thresholds and model order are per agent and response type, with explicit daily cost and concurrency caps.

The score-to-policy separation follows [TypeSafe's guardrail approach](https://docs.typesafe.ai/cookbooks/llm_guardrails). The existing Jev evaluator remains the common typed, bounded API client.

Initial synthetic check on 2026-10-15 used three fixed drafts for a sum task. Sequential mode assessed two drafts and selected the correct backup in 629 ms (primary 0.03, backup 0.96). Best-of-N assessed three drafts, made pairwise comparisons, and selected the same backup in 1,317 ms (primary 0.03, backup 0.95, incorrect third 0.05). This verifies wiring and illustrates the latency trade-off. No second or third LLM generated those drafts; a real multi-model benefit is still unmeasured.
