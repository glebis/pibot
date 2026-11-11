# Delivery and recovery handoff — merge, activation and live verification

Date: 11 November 2026, Europe/Berlin. Source activation: `c97e66a` on `main`, merging
`handoff/pibot-xdfx-delivery-recovery` through `27fac0a` into the newer `6696767` main.
Tracking: `pibot-xdfx`, `pibot-0xpf.5`, `pibot-cida`.

## Merge and preservation

Resolved conflicts semantically, retaining main's task correlation, internal/owner audience gate,
deadline/late-evidence reconciliation, content readback and provider diagnostic phase safeguards.
Added the handoff's invoking-route isolation, neutral owner decisions, immutable replay identity and
bounded artifact readback. Communications hooks now forward the explicit audience. New composition
regressions require both content and artifact contracts when both are declared.

The only pre-existing dirty paths were `.beads/issues.jsonl` and the untracked
`docs/2026-11-10-delivery-recovery-handoff.md`. Their SHA-256 fingerprints were unchanged after the
merge and live canaries. Neither was staged or committed. No reset, stash, queue clear, schedule
resumption or permission expansion was performed.

## Verification before activation

- Full integrated suite: **161 files / 3,238 tests passed**; repository pre-commit hook repeated
  the suite successfully.
- `npm run typecheck`: passed.
- Staged and working diff checks: clean.
- One initial test expected the old communications-hook signature; its assertion was updated to
  include main's intent/audience arguments while retaining the original-peer assertion.

## Activation and service health

Restarted the existing `com.glebkalinin.pibot` launchd job exactly once with `kickstart -k`.
The job stayed running (wrapper PID 29827, runtime/lock/listener PID 29848; launchd runs counter 3).
One listener bound to `127.0.0.1:7860`; unauthenticated dashboard request returned HTTP 302.
All ten configured Telegram pollers reconnected. No immediate fatal, replay, conflicting-poller,
ledger-unavailable or delivery error was found in the bounded post-restart log.
The launchd last-exit value 143 describes the terminated previous wrapper, not a crash of the new
running child; there was no second restart.

Required attach smoke:

```sh
npx tsx scripts/telegram-live-test.mts --attach --chat @pimother_worker_bot --no-prompt --keep-probes
```

**4/4 passed**: attach gate, `/status` round-trip, unknown-command reply and 15-second clean log
soak. Probe messages were retained. Attach mode does not test reactions or these feature paths;
the separate canaries below provide that evidence.

## Live synthetic feature checks

Messages identified Codex as Gleb's agent. Only synthetic files under
`/private/tmp/pibot-live-20261111` were used; the real missing vault note was not accessed or restored.

| Check | Independent evidence | Result |
| --- | --- | --- |
| Worker → dev owner-facing attachment | Worker request [581159](tg://openmessage?user_id=8900661099&message_id=581159), scoped confirmation [581161](tg://openmessage?user_id=8900661099&message_id=581161), received photo [581163](tg://openmessage?user_id=8900661099&message_id=581163), attributed dev reply [581164](tg://openmessage?user_id=8900661099&message_id=581164). Bounded worker/dev/knower readback found one attachment in worker and none in the other two dialogs. | Invoking-peer routing passed for this synthetic attachment. |
| Canonical owner decision and same-answer replay | Task `tmwbcliis5j4s`, original chat `telegram:worker:<redacted-owner-chat>`. Approval prompt [581168](tg://openmessage?user_id=8900661099&message_id=581168), answer [581169](tg://openmessage?user_id=8900661099&message_id=581169). Three unique `ask_user` calls in the task trace: two identical copy approvals and one different action. Question journal contains only two question records. | Identical approval replayed without a second prompt. Canonical decision `q_tgkzz5` is persisted as `approved`, with exact choice/action/options and owner provenance. |
| Separate refusal | Different prompt [581170](tg://openmessage?user_id=8900661099&message_id=581170), refusal [581171](tg://openmessage?user_id=8900661099&message_id=581171). Ledger has `q_h9g2z1`, outcome `declined`; independent filesystem check finds no `denied.txt`. | Earlier approval did not authorize the different action. |
| Actual artifact, not bookkeeping | Task `tmwbcliis5j4s` is `done`; host receipt names `restored.txt`, 68 bytes, `evidence: readback`, `verification: byte-exact`. Independent filesystem SHA-256 matches source and receipt: `051a83917833e5e34914fa5a4289ece44036588ff44f7e13b8b29ca516855c6d`. Completion [581172](tg://openmessage?user_id=8900661099&message_id=581172). | Verified synthetic copy completed. |
| Missing artifact despite nonempty summary | Task `tmwbcq7ifburg`, title `PIBOT-LIVE-20261111-MISSING`, expected `must-stay-missing.txt`. Ledger status `partial`, no artifact receipt; independent filesystem check confirms absence. Owner notice [581175](tg://openmessage?user_id=8900661099&message_id=581175). | Bookkeeping-only result did not become `done`. |

## Residual finding and verification limits

Worker's [581165](tg://openmessage?user_id=8900661099&message_id=581165) incorrectly said the routing
canary lacked its attachment line, even though photo 581163 had arrived. The owner-facing delegation
path consumes `MEDIA` for actual delivery, and the caller sees cleaned reply text rather than a
machine-readable delivery receipt. Delivery itself passed; caller reporting did not. No resend was
made. Follow-up: return the transport delivery outcome to the delegator and distinguish consumed
attachment syntax from failed delivery. Done when the same canary reports the observed delivery
correctly without forwarding or duplicating media. Record under the existing delivery/reliability
issues; do not close them based on this run.

These are bounded synthetic live proofs, not a replay of the original private video or missing-note
incident. No original video was re-downloaded/resubmitted/deleted; no real note was reconstructed.
Decision replay was verified within the running process and persisted journal; restart survival
remains backed by the ledger-reopen regressions, not a second live restart.

Bot API acknowledgement evidence was not relabelled as Telegram readback. The independent authorized
user-account read established the canary's actual destination, but no automatic MTProto readback
route, Saved Messages support or Bot API/MTProto message-ID equivalence was added. Historical cause
and missing-file provenance remain unknown.
