# Direct Jev pilot and PiBot opportunity map

**Date:** 2026-10-15  
**Status:** local evaluation; no new live decision gate enabled  
**Provider:** TypeSafe direct API (`jev-latest`), using the separate SOPS-stored `TYPESAFE_API_KEY`

## What was tested

`scripts/jev-smoke.mts` calls PiBot's own `evaluateJev` client, not a separate SDK. It sends only synthetic text, one case at a time. Before seeing the answers, each Choice case has a written expected label. The script reads the direct key from `data/settings.enc.json` in memory and prints labels, selected probabilities, latency and input-token counts; it never prints the key.

| Probe | Expected | Observed |
| --- | --- | --- |
| Goal result present / only promised / receipt missing | `done` / `continue` / `continue` | 3/3 matched |
| Retrieved passage relevant / unrelated / keyword trap | `relevant` / `irrelevant` / `irrelevant` | 3/3 matched |
| Heartbeat update changed / repeated / paraphrased repeat | `new` / `repeat` / `repeat` | 3/3 matched |
| Quote supports / contradicts / does not establish / contains an injected instruction | `supported` / `contradicted` / `unsupported` / `unsupported` | 4/4 matched |
| One mixed Noul + Score call | cancellation probability high; urgency level at least 1 | Noul `0.99`; Score `2` |

The 13 Choice calls had **13/13 matches and zero API failures**. Observed client elapsed times were **210–333 ms** per call, with **379–407 input tokens** for each Choice case. TypeSafe's authenticated model listing and the direct endpoint both returned HTTP 200. These are easy, authored examples, not blinded owner labels or an accuracy estimate; the selected probabilities do not establish calibration or a safe threshold. The underlying model alias may change over time. No private PiBot session, memory, skill, or owner message was sent.

## Existing PiBot Jev seams

| Seam | Current state | Next evidence needed |
| --- | --- | --- |
| Skill evolution | `src/core/jev-shadow.ts` observes probes in dry-run mode by default; shadow results cannot promote a skill. The current assistant grant allows synthetic data. | Owner-reviewed replay cases, verified baselines, blind labels, scope decision. Keep the old judge authoritative. |
| Goal completion | `src/core/goal-jev.ts` offers a per-agent Jev judge and local fallback; daemon mode defaults off. | Independent goal/reply/contract cases, especially false `done` and missing verification. Start with shadow comparison. |
| Saved-source triage | `src/plugins/link-triage-plugin.ts` can suggest relevance, destination, and reading depth; its shadow flag defaults off. | Review saved-source fixtures and owner focus; compare recommendations with owner labels before routing anything. |

The direct key changes which endpoint the evaluator prefers after PiBot loads the new settings. It does **not** grant a new agent data scope, turn `PIBOT_JEV_SHADOW` on, or enable `/goal` or link-triage flags. No service restart or deployment was performed for this pilot.

## Where to try Jev next

| Priority | Candidate | PiBot seam | Pilot decision and limit |
| --- | --- | --- | --- |
| 1 | **Claim-to-source check** | Research intake and saved-source outputs | For each proposed claim, compare a bounded claim and source excerpt with `supported` / `contradicted` / `unsupported` / `unclear`. Show a review marker and source link; never invent a citation or publish from the model label alone. The synthetic quote cases passed, including an injected instruction. |
| 1 | **Saved-link review** | Existing `link_triage_shadow` | Run the existing advisory tool over approved synthetic or redacted saved sources, then compare relevance and destination with owner labels. Do not auto-route, save, discard, or message. Lowest implementation effort because the seam exists. |
| 2 | **Memory/search rerank** | `memory_recall` currently counts keyword hits | Retrieve locally first, then ask Jev to score only a small shortlist of bounded excerpts for relevance, usable evidence, conflict, and instruction attempts. Preserve lexical results when Jev is unavailable. The keyword-trap case is encouraging but too small to set a filter. |
| 2 | **Heartbeat novelty** | Exact fingerprint and narrow filler checks in `heartbeat.ts` | Compare the draft speak with recent delivered messages and fresh evidence. In shadow mode, measure semantic repeats and false silences. Do not suppress a due item or important change on a single Jev judgment. |
| 3 | **Agent setup clarity** | `ambiguity.ts` uses an LLM to score persona dimensions and generate questions | Jev can score goal, constraints and success clarity as separate typed questions. Keep the LLM or human for writing follow-up questions, since Jev does not generate prose. |
| 3 | **Turn intent / model routing** | `cascade.ts` and agent/tool dispatch | Classify narrow intents to suggest a cheaper handler or specialist, then compare cost, latency, and wrong-route rate with the current path. Keep user-facing choices and tool authority in deterministic code. |

**Out of scope for Jev authority:** identity resolution, calendar or payment writes, phone-call consent and urgent-call triggering, secret access, external publication, and skill promotion. Jev may flag a case for review, but verified source records, explicit permissions, and deterministic policy decide these actions.

## Decision and measurement before activation

1. Pick one low-risk seam. Save a diverse, owner-reviewed set of positive, negative, borderline and adversarial cases **before** tuning questions or thresholds. Keep a held-out portion and record source/data permission.
2. Run Jev beside the current behavior. Record category, full probability vector, provider-reported confidence where available, error/missing result, latency, input tokens and current decision. Do not retain private prompt text in operational logs.
3. Compare with owner labels: false passes, false reviews, missed important information, run-to-run stability, cost and coverage. Choose thresholds per decision and harm, rather than from the 13 synthetic matches.
4. Review the results before allowing Jev to affect routing or suppression. Existing permission gates and deterministic safety checks remain mandatory.

**Implementation caveat:** `jev-evaluator.ts` currently retains Choice/Score probability vectors but discards TypeSafe's separate `confidence` field. `goal-jev.ts` calls the selected option's probability “confidence.” The [TypeSafe confidence guide](https://docs.typesafe.ai/confidence) distinguishes these measures. Preserve and name both before using confidence-based policies; do not silently reinterpret the current goal threshold.

## References

- [TypeSafe direct API and typed response](https://docs.typesafe.ai/introduction/quickstart)
- [TypeSafe passage classification pattern](https://docs.typesafe.ai/cookbooks/classifying_rag_passages)
- [TypeSafe citation check pattern](https://docs.typesafe.ai/cookbooks/citation_check)
- [TypeSafe confidence guidance](https://docs.typesafe.ai/confidence)
