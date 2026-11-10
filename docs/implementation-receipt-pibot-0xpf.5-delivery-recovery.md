# Implementation receipt — invoking-chat delivery + recovery-decision propagation

Branch: `handoff/pibot-xdfx-delivery-recovery` (isolated worktree)
Base: `2e9c93a` (`voice-shared-session-tasks`)
Issues: `pibot-0xpf.5` (P1), `pibot-cida` (P0) — neither is closed by this change.

This receipt covers source + local deterministic checks only. No activation, restart, live
Telegram send, vault access, or original-scenario replay was performed or is claimed.

## Inspect-first findings

Already present in the committed base (`2e9c93a`):

- `Delivery` tuple + `describeDeliveryGap` (media type, message id, peer, account, id namespace)
  and the `expectedMedia` / `expectedPeer` / `expectedAccount` / `expectedIdProtocol` contract.
- `runLedgerTask` media delivery through `taskDeliveryTarget`/`sendTaskMedia`, with transport
  receipts (`taskReceipt`) feeding the ledger gate.
- Existing late-reply / timeout run joining (`agentRuns`, `waitForAgentRun`) and restart resume.
- Task questions routed to the origin chat via `questions.ask`, but only through a per-text
  `questionKey` — no durable owner-decision record, no structural approval contract, no canonical
  qid citation, and no artifact contract/readback.

The exact committed-base production gaps fixed here:

1. `agentTurn` did not bind delegation to the ORIGINAL invoking route. Session keys, in-flight run
   identity and loop dedupe used only the agent/from pair, delegated `ask_user` rendered in the
   executor's own chat, and delegated MEDIA followed the executor's chat. That is the observed
   worker→dev→knower wrong-peer failure.
2. Task owner answers were not correlated into the durable task record at all. A resume, restart or
   executor handoff had no way to inherit an accepted decision, and nothing prevented a relayed
   "Gleb said yes" from being treated as authority.
3. The completion gate had no host readback for a contracted deliverable. "Ledger updated" prose was
   indistinguishable from an actual restored artifact.

Scaffolding introduced by THIS handoff's first pass (not in the committed base, not deployed), then
hardened after the focused review:

- `TaskDecision` / `recordDecision` / `taskDecisionKey`, `ArtifactReceipt` / `expectedArtifactPath`
  and the `deliveryChat` plumbing were added by the first pass. The review corrections below apply
  to that draft, not to a shipped production implementation.
- Draft defects caught and fixed in this round: caller-supplied `questionKey` could replay an
  unrelated action; lexical scope + final-component `lstat` missed an intermediate-symlink escape;
  and `recordDecision` returning `undefined` (absent/wrong/completed task) was not treated as a
  persistence failure.

## What changed (production call paths)

### Scope A — invoking destination

- `src/core/bot.ts`
  - `agentSessionKey()` / `agentRunKey()` scope both session and in-flight run identity to the
    original route (`transport:chatId`) when one exists, preserving the old key when it does not.
  - `agentAsk` loop-dedupe key and in-flight lookup include the origin route.
  - `sessionFor` routes `ask_user` to `opts.deliveryChat` (the original invoking chat) while the
    executor keeps its own capability identity; speech/video-note sends already validate against
    the same route via `deliveryTargetAllowed`.
  - Delegated reply MEDIA is sent to the origin route only, with the session's own event delivery
    suppressed so the same media cannot be delivered twice.
- `src/core/capabilities.ts`
  - Delegated `deliveryChat` now drives tasks, agent-comms and speech target binding; the executor's
    own transport chat can no longer silently replace the requested destination.
- Existing gates are reused, not replaced: wrong-peer success stays `partial`, an unreachable
  explicit target is a `BlockedError`, and `expectedPeer` continues to authorise a deliberate
  alternate destination.

### Scope B — accepted recovery decision + verified artifact

- `src/durable/task-ledger.ts`
  - `TaskDecision` now records the exact action, full option list, exact choice, option index and a
    structural `outcome` (`approved` | `declined` | `answer`). Only `approved` authorizes.
  - `taskDecisionKey(taskId, ownerChatKey, actionKey)` namespaces every question. `recordDecision`
    rejects a non-canonical source, a fabricated qid, a key not scoped to the task/owner, and a
    choice that does not match its declared option. First decision per question key wins.
  - `LedgerEntry.decisions[]` replaces the single slot; checkpoint and `TaskRun` carry the list, so
    a resume/handoff inherits every decision and never reuses a different action's answer.
  - `ArtifactReceipt.verification` distinguishes `existence` (no original hash known) from
    `byte-exact`; a hash mismatch stays `reconstructed` and `partial`. A non-readback claim is
    rejected. `expectedArtifactPath` must be absolute and inside an optional `artifactScope`.
- `src/core/bot.ts`
  - `taskOwnerAsk` binds replay identity to the IMMUTABLE action contract (text, options, kind and
    `approveOption`) even when a caller supplies its own `questionKey`, then scopes it to the
    task/owner chat. It cites the real journal qid (no fallback to the key), derives approval
    structurally from `QuestionSpec.approveOption`, and fails closed when `recordDecision` resolves
    without persisting the matching decision (absent/wrong-agent/inactive task).
  - `describeTaskDecisions` renders `AUTHORIZED`, `REFUSED`, or `ANSWERED, NOT AN APPROVAL`; only
    an approved decision says “do not ask again”.
  - `readArtifactReadback` is async and bounded (64 MiB). It rejects relative paths and a symlinked
    final component, resolves canonical target and scope so an INTERMEDIATE symlink cannot escape
    the declared scope (and, with no scope, is confined to the contracted path's own real
    directory), opens with `O_NOFOLLOW`, `fstat`s the descriptor, and bounds the bytes actually
    read. It labels existence vs byte-exact.
- `src/core/questions.ts`, `src/plugins/question-plugin.ts`,
  `src/plugins/tasks-plugin.ts`
  - `approveOption` is the explicit structural approval contract; absent/unknown = fail closed.
  - Task records surface `decisions[]`, `artifactScope` and the artifact verification label.

## Deterministic regression coverage

- `src/durable/task-ledger.test.ts`: neutral decision persistence + restart reuse; two distinct
  approvals and same-question replay; forged/relayed rejection; non-namespaced key/qid rejection;
  bookkeeping-only partial; host-readback completion; byte-exact vs existence; reconstruction;
  non-readback claim; absolute-path/scope validation; blocked execution preserves the decision;
  wrong-peer/right-peer receipts; id-protocol mismatch; idempotent repeated start.
- `src/core/bot.test.ts`: production task-session `ask_user` wiring for approval, denial,
  clarification and sibling-chat isolation; replay of the same approval without re-asking and
  distinct actions remaining distinct; the same caller-supplied `questionKey` with a changed
  action/approving option re-asks while an identical contract still replays; persistence rejection
  and an `undefined` (nothing persisted) result both fail closed; route-scoped session keys;
  simultaneous same-text requests from different origins do not join; worker→dev owner questions
  render in the worker chat; runner-prompt decision rendering; artifact readback for
  real/missing/relative/out-of-scope, symlink, oversized, hash-mismatch, and intermediate-symlink
  escape cases.
- `src/plugins/tasks-plugin.test.ts` / `src/plugins/agent-comms-origin.test.ts`: delegated task
  origin binding, explicit alternate target, artifact contract persistence, and origin-chat
  propagation through the executor capability context.

## Checks (local, synthetic)

```text
npm test -- --configLoader runner src/durable/task-ledger.test.ts src/core/bot.test.ts \
  src/plugins/tasks-plugin.test.ts src/plugins/agent-comms-plugin.test.ts \
  src/plugins/agent-comms-origin.test.ts
→ 5 files passed, 297 tests passed (2026-11-11, Europe/Berlin)

npm test -- --configLoader runner src/core/bot.test.ts
→ 1 file passed, 203 tests passed (2026-11-11)

npm run typecheck
→ tsc --noEmit: passed (2026-11-11)

git diff --check
→ clean (2026-11-11)
```

Adjacent suites also ran clean on 2026-11-10: `questions.test.ts`, `question-store.test.ts`,
`question-plugin.test.ts`, `capabilities.test.ts`, `agent-manager*.test.ts` (83 tests).

## Limitations / unverified

- Source and unit/integration checks only. Nothing is deployed or activated; the running daemon
  does not yet contain these changes.
- No live video send/resend/delete, Telegram API call, restore of the Lance note, ASR/download, or
  vault/private-runtime read was performed.
- A restore with no known original hash is verified as existence/content readback, not byte-exact
  restoration. A hash mismatch is deliberately labelled reconstruction and stays `partial`.
- The shared checkout contains unrelated uncommitted cida/task-evidence/media/voice/dashboard work.
  This branch does not include or touch it; integration must be assessed by the supervisor.
- No merge, rebase, push, PR, issue closure, queue/cursor/schedule/config change, or restart.

## Review-item disposition

First-pass review (draft hardening, previously addressed):

1. Neutral exact decision + approval/action scope + refusal/clarification semantics — fixed;
   production-flow denial/clarification tests added; approval derived from a declared option, not
   English matching.
2. Per-action replay identity, task/owner naming, canonical qid required, persistence errors
   surfaced — fixed. The no-re-ask assertion calls `ask` again on the same live bus; the separate
   ledger-reopen test is the restart-persistence case.
3. Session/run/dedupe identity scoped to the original route — fixed; A-then-B and simultaneous
   distinct-origin tests added.
4. Delegated `ask_user` routed to the original invoking chat while retaining executor capability
   identity — fixed; worker→dev question routing test added.
5. Sibling “owner approved” cannot populate a trusted decision — production path only records an
   answer returned by the canonical question journal; sibling-chat answer test added.
6. Artifact path validation (absolute, scope, regular, non-symlink, bounded), existence vs
   byte-exact labelling, bounded fixtures — fixed; tests added.
7. Regression fixtures exercise production delegation routing, media receipts and restart paths;
   no assertions were removed — confirmed by the suites above.

Focused follow-up review (2026-11-11, this round):

8. `taskOwnerAsk` replay identity now always includes the immutable action contract
   (text + options + kind + `approveOption`), not just a caller `questionKey`. Regression: same
   caller key with Restore A vs Delete B, and with a changed approving option, re-asks; an identical
   contract still replays without re-asking.
9. `readArtifactReadback` now resolves canonical target and scope, rejects symlink traversal
   (including an intermediate `scope/link/secret.md`), confines the no-scope case to the contracted
   path's own real directory, opens with `O_NOFOLLOW`, `fstat`s the descriptor and bounds bytes
   actually read. Regression: intermediate-symlink escape rejected while a direct in-scope file is
   still attested.
10. `taskOwnerAsk` now fails closed when `recordDecision` resolves without the matching persisted
    decision (absent/wrong-agent/inactive task), with a precise error. Regression: a fake ledger
    returning `undefined` rejects instead of proceeding.
