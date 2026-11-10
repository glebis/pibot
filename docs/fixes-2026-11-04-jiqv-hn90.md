# PiBot reliability fixes — 2026-11-04

Issues: `pibot-jiqv` and `pibot-hn90`. Final state: all six findings from the follow-up audit have source fixes and local verification. Both issues remain open for scenario-specific live verification. The source is uncommitted; the authorized restart and transport-health verification are recorded below. This report supersedes the earlier implementation summary at this path.

## Audit fixes

| Finding | Implemented behavior | Verification |
| --- | --- | --- |
| Groq parts executor bypassed diagnosis | The actual pinned `groq_parts.py` failure path in `exec_run` returns service/executor/time/source/category metadata and omits raw wrapper error prose. Exact wrapper `(401)`, `(429)`, `(403)`, missing-key, network, timeout, stdin and refusal shapes are covered. An unknown-source 401 requests source inspection (`rotation=source-unresolved`), rather than a global replacement key. Existing generic exec behavior and allowlist boundaries are preserved. | Production `exec_run` tests with local mock executables; no wrapper/provider execution. |
| Acknowledgements counted as work | Ambiguous replies, acknowledgements, pending/future/negated work and refusals are non-usable context. Positive result signals are explicitly required. Markdown and `Result:`/`Summary:` label bodies are checked before a result is accepted, including EN/RU nested refusals. | Classifier and collector regressions; independent assertion probes. |
| Context evicted usable evidence | The bounded collector evicts context first. A separate bounded `usableReceipt` retains a substantive excerpt and complete reported paths independently of the rolling 6000-character context. Status/list show the protected receipt separately, label rolling text as context, and conservatively label legacy marker-only records. | Collector >8-refusal case, real ledger eviction, multiline/no-path result and actual task-tool retrieval tests; independent protected-receipt probe. |
| Reconciliation notice omitted evidence | The pre-terminal deadline race builds the checkpoint and owner notice from the recovered receipt and remaining gate. A late failed-to-partial promotion removes the stale timeout reason and records the recovered result. It does not send a second task notification. Cancellation/done statuses are preserved. | Real ledger notification, reason and no-repeat-notification tests; independent assertion probes. |
| Late replies invented a deadline | Default late-result formatting is neutral about why the parent ended. The deadline path supplies its known deadline-specific gate explicitly. No normal finish/cancellation/generic failure is inferred to be a deadline. | Neutral-late-reply regressions and independent positive late-result probe. |
| STT delivery truncated diagnosis | `SttResult.diagnostic` survives local-to-Groq failure aggregation and failed long-audio chunks. Owner messages render compact structured fields before any error detail, preserving service/executor/source/category/action/rotation without forwarding provider error payloads. Duration routing and no-local-fallback rules are preserved. | Actual media-callback pushed-message tests for 401/429/403/network with preceding local failures, and long-audio 401; STT/chunk propagation tests. |

## Final verification

- `npm test -- --configLoader runner`: **3029 passed, 157 files, exit 0**. Final run started 22:43:37 Europe/Berlin, after the last classifier correction.
- `npm run typecheck`: **exit 0**.
- Independent assertion-based audit reproductions: **exit 0**. They verify acknowledgement/labeled refusal classification, neutral late wording, collector retention, pre-terminal owner evidence, protected durable receipt, stale-reason removal and silent late promotion.
- `git diff --check`: **exit 0**.
- Three implementation subagents owned separate recovery, provider and owner-delivery files. A bounded cross-review found the exact-wrapper status mismatch and nested labeled-refusal loophole; both were corrected before the final combined run.
- The original 92 unrelated added BB lines in `bot.ts` remain present. No broad restore, staging, commit, push or cleanup was performed.

Complete logs and the assertion script are under `/private/tmp/pibot-audit-fixes-20261104/`: `full-tests-final.log`, `typecheck-final.log`, `probes-final.log`, `diff-check-final.log`, `results-final.txt`, and `verify-audit-fixes.mts`.

## Scope and remaining limits

The source-fix checks above used the deterministic test lane and mocked/local fixture executors. At that stage, no environment/live lane, Telegram harness, paid provider call, credential read, external script mutation, daemon restart or deployment was performed. Subsequent activation and Telegram health checks are recorded below; real provider behavior and key validity remain unverified.

Reply classification remains a conservative language heuristic, and a usable receipt is delegate-reported, not independently verified execution or artifact existence. Evidence informs the retry decision; it is not a paid-ASR lock. Live callback identity remains in-process and does not survive a daemon restart.

Two additional pre-existing gaps noted separately in the audit were outside the six requested fixes: the Groq-only missing-host-key owner gate and the inter-agent acceptance/session-reservation race. Neither is claimed fixed here.


## Authorized activation receipt — 2026-11-04 (Europe/Berlin)

The user explicitly requested restart and verification after the audit fixes. The existing `gui/501/com.glebkalinin.pibot` job was restarted exactly once with `launchctl kickstart -k`; its working directory remains this checkout. No service configuration, queues, breakers, schedules, credentials or source files were manually changed for activation.

- Launchd runs: **13 → 14**, active count **1**, state **running**, last exit code **0**. Wrapper PID **21671**, runtime/lock PID **21672** (wrapper is its parent).
- One dashboard listener: runtime PID21672, **127.0.0.1:7860**; unauthenticated GET returns **302**.
- All **10** Telegram pollers started (main bot plus **9** attached sub-bots); no sub-bot reported offline.
- The checked-in attach harness passed **4/4** before restart against knower.
- Post-restart attach checks against `@pimother_knower_bot` and `@pimother_pibotdev2_bot` each passed **5/5**, exit0: `/status`, unknown-command reply, settled **👍** reaction, and a clean 15-second log soak (plus attach-mode validation). All six probe messages per post-restart bot were removed successfully.
- The checked-in attach mode skips its existing reaction canary. A temporary copy under `/private/tmp/pibot-restart-20261104/attach-with-reaction.mts` added the existing canary, required final 👍 rather than any reaction, and tracked its direct status reply for cleanup. Repository harness source was unchanged.
- The bounded post-restart daemon-log scan found **0** instance conflicts, fatal errors, poller stops, delivery errors or replay errors.

Evidence: `/private/tmp/pibot-restart-20261104/health.json`, `baseline.json`, `before-smoke.log`, `knower-after-smoke.log`, `dev-after-smoke.log`.

This establishes source activation and live Telegram transport health. It does not independently verify an actual long-running parent/delegate recovery, a real Groq transcription, current key validity or restart-durable callback identity. Both issues remain open; no paid-provider canary, task retry, commit or push was performed.
