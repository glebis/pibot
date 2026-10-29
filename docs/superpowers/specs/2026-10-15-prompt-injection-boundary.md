# PiBot prompt injection boundary

Status: implementation foundation; live routing is not enabled. Beads: `pibot-r4n`.

## Goal

Detect attempts to promote lower-trust text into instructions, then route each affected turn through a deterministic policy. Treat detection as a signal. Tool permissions, identity checks, and approval for consequential actions remain enforced by code.

## Boundaries

| Source | Current entry point | Identity and trust | Initial route |
| --- | --- | --- | --- |
| Owner Telegram text | `TelegramTransport.onMessage` → `PiBot.routeUserTurn` | Authenticated chat, direct owner request | Observe after explicit live-data scope |
| Owner voice | `PiBot.voiceTurn` → `promptAgentUnlocked` | Bound owner chat, STT can mishear | Observe; never account ban |
| Participant Telegram text | `answerLabParticipant` and public request flow | DM actor can be verified; group callback currently loses `from.id` | Observe, then block after calibration |
| Participant media/voice | `handleMedia` → transcription → `routeUserTurn` | Preserve original actor through media metadata before enforcement | Observe, then block after calibration |
| Retrieved pages, documents, email, skill content | Each fetch/parse adapter before model context | Source data, never user authority | Screen bounded extracted text; enforce tool boundary regardless of score |
| Tool responses and persisted summaries | Tool-result/session adapter before reuse | Lower-trust data, including previously model-generated text | Screen at reuse and validate proposed action separately |

The Telegram text callback currently carries `chatId` and message ID but not `from.id`. In a group, a chat ID is not a person. Add verified actor provenance to the transport contract before building any sanction workflow. Direct owner requests such as “explain this prompt injection” or quoted attack examples may contain attack phrases without being an attempt to redirect PiBot.

## Assessment hook

`src/core/injection-guard.ts` exposes a side-effect-free hook. Callers supply source, data class, raw text, and a per-source policy. The hook returns `pass`, `review`, `block`, `unassessable`, or `not_assessed`, plus metadata. It sends one bounded TypeSafe Jev question on instruction takeover. It does not send actor identity, session history, system prompt, tool credentials, or agent memory. Recognized credential shapes are redacted before sending, but this is not a guarantee that arbitrary private data is removed; real content still requires explicit approval for `redacted_approved` scope.

Policy defaults to off. `observe` returns a pass and a proposed route. `enforce` returns the threshold route. Size policy is in UTF-8 bytes: `minBytes` controls sampling and `maxBytes` refuses oversized messages rather than silently clipping their most important part. `unassessable` is a distinct result, never interpreted as safe. The caller chooses a source-specific fallback: external tool text should be withheld from powerful sessions or routed to review; owner conversation may continue under existing tool permissions while recording the assessment gap. The hook itself never bans.

For live integration, configuration should live with agent policy and permit per-source overrides, not as a single global Boolean. Put hook calls after transport authentication and normalization, before the content joins the model context. Keep slash commands, structured question answers, and low-risk deterministic flows outside the model guard; they still need their own permission checks. Capture a stable content hash, source, byte length, route, threshold version, latency, and verified actor reference where appropriate. Keep raw text out of security logs. Use a private review store only if review is enabled and retention is specified.

## Moderation

Blocking one turn may be automated only after a labelled false-positive benchmark and a shadow run. A blocked user should receive a neutral retry or review message, without revealing the rubric. Never automatically ban from one score. Escalation to a Telegram restriction requires a verified `from.id`, repeated distinct events, owner review, and an auditable transport-specific action. Owner voice cannot lead to an account sanction; noisy STT increases false positives.

## Validation and rollout

1. Build a fixture set from synthetic direct attacks, indirect tool/page attacks, quoted educational examples, ordinary commands, multilingual text, long inputs, and STT errors. Label expected route and source authority separately.
2. Run the Jev assessment on synthetic fixtures, record scores, latency, and false positive/negative cases. Set separate thresholds for direct requests versus lower-trust data.
3. Add actor provenance to Telegram and media callbacks. Wire observe hooks at the listed boundaries with explicit provider and data scope. No live content leaves the machine merely because a key exists.
4. After owner review of shadow results, enable block for chosen external sources. Preserve an unassessable fallback and a human override. Add action screening for sensitive tool calls independently of input screening.

Initial synthetic pilot on 2026-10-15: eight prelabelled cases were assessed by the direct TypeSafe API. All eight matched the expected pass/block route at review threshold 0.40 and block threshold 0.85. Scores for the four attack cases were 0.97–0.99; scores for the four benign or quoted cases were 0.02–0.20. Calls took 217–318 ms each. This small, constructed set is a wiring smoke test, not a measured detection rate. The sandboxed attempt had eight network failures, correctly surfaced as `unassessable`; the network-enabled retry produced these results.

This design follows [OWASP's prompt injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) on trust boundaries and tool permissions, and [TypeSafe's guardrail cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails) on separating assessment probabilities from application routing policy.
