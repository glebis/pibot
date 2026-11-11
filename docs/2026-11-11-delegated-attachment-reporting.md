# Delegated attachment reporting — fixed and verified live

11 November 2026, Europe/Berlin. Issue: `pibot-0xpf.8`.
This resolves the reporting discrepancy recorded in
`docs/2026-11-11-delivery-recovery-live-verification.md`.

## Problem and change

An owner-facing `agent_ask` result consumed `MEDIA` syntax while sending the attachment, then
returned only cleaned delegate text. Worker interpreted the missing syntax as missing media,
even though the attachment had arrived. The transport receipt was discarded.

`prepareDelegatedReply` now returns a caller-only host delivery report before delegate prose.
It copies actual receipt fields and reports each attachment as acknowledged, unverified,
mismatched, unavailable or uncertain. A successful API acknowledgement remains `ack`, not an
independent readback or human view. The report explains that consumed `MEDIA` does not mean a
missing attachment and forbids blind resend/forward/retry. Send exceptions remain uncertain.
Diagnostic callback failures cannot alter the recorded send outcome or cause extra sends.

The owner-facing delegated text stays clean. Internal coordination keeps its raw reply and
performs no owner send. Text-only replies, origin-route isolation, in-flight joining and task
correlation remain intact. No communications-hook signature changed.

## Validation

- 11 compact production-boundary tests cover actual receipts, missing/incomplete receipts,
  wrong peers, unavailable transport, uncertain sends, mixed outcomes, diagnostic failures,
  exactly-one send, internal/text-only behavior and receipt visibility before long reply truncation.
- New boundary suite plus existing bot suite: **240 passed**.
- Full clean-worktree suite with normal host permissions: **162 files / 3,249 tests passed**.
- Typecheck and diff checks passed.
- An initial sandbox-only full run failed existing Unix-socket tests with `listen EPERM`;
  the focused authority suite and then the complete suite passed with host socket permissions.

## Activation and independent live evidence

The user requested live verification before commit. The reviewed patch was applied to the
runtime checkout without committing, its file fingerprints recorded, then PiBot was restarted
exactly once for this deployment. The verified files were unchanged before the final commit.

Service health: launchd running, last exit code 0, one runtime/lock/listener PID 90189, one
loopback dashboard listener, unauthenticated dashboard HTTP 302, all ten Telegram pollers
connected, and no critical runtime/delivery errors in the bounded post-restart log.
The required attach smoke passed **4/4** using `--attach --chat @pimother_worker_bot
--no-prompt --keep-probes`; no agents or schedules changed and probes were retained.

Fresh canary `PIBOT-REPORT-E011AE19` used a newly generated synthetic PNG; no original media or
previous attachment was read, re-downloaded, resent, forwarded or deleted.

- Request: [581180](tg://openmessage?user_id=8900661099&message_id=581180).
- Scoped confirmation: [581182](tg://openmessage?user_id=8900661099&message_id=581182).
- Actual attachment in worker: [581184](tg://openmessage?user_id=8900661099&message_id=581184).
- Attributed dev reply: [581185](tg://openmessage?user_id=8900661099&message_id=581185).
- Correct worker report: [581186](tg://openmessage?user_id=8900661099&message_id=581186).

The actual `agent_ask` tool result, not a model assertion, contained one acknowledged attachment,
zero unverified/mismatched/uncertain/unavailable outcomes, `mediaType: photo`, sending account
`@pimother_worker_bot`, `idProtocol: bot_api`, `messageId: 532`, and `evidence: ack`.
The peer matched the invoking worker route. The independent authorized Telegram user-account
read found one new attachment in worker and none in dev or knower in the bounded test window.
The user-account message ID 581184 and Bot API ID 532 belong to different namespaces; this report
does not equate them. Correlation uses the fresh nonce, adjacent attributed reply and bounded time.

Worker correctly reported that the image went to this chat and that the returned evidence was
an API acknowledgement, not independent readback or proof of rendering. It did not report the
attachment missing and did not retry or forward it.

## Preservation and limits

Pre-existing unrelated dirty source/test files and the untracked handoff brief were not changed or staged;
all saved non-Beads fingerprints matched after live verification. The already-dirty Beads export
was left unstaged; tracker writes update the existing database normally.
No production queue, access grant, schedule, original media, private note or model policy changed.
Broader automatic Telegram readback and historical incident-verification issues remain separate;
this closes only the delegated-attachment reporting bug.
