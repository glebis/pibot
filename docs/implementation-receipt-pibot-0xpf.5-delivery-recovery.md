# Implementation receipt — invoking-chat delivery + recovery-decision propagation

Branch: `handoff/pibot-xdfx-delivery-recovery` (isolated worktree)
Base: `2e9c93a` (`voice-shared-session-tasks`)
Issues: `pibot-0xpf.5` (P1), `pibot-cida` (P0) — neither is closed by this change.

This receipt covers source + local deterministic checks only. No activation, restart, live
Telegram send, vault access, or original-scenario replay was performed or is claimed.

## Inspect-first findings

Already present in the committed base / earlier uncommitted prep:

- `Delivery` tuple + `describeDeliveryGap` (media type, message id, peer, account, id namespace)
  and the `expectedMedia` / `expectedPeer` / `expectedAccount` / `expectedIdProtocol` contract.
- `runLedgerTask` media delivery through `taskDeliveryTarget`/`sendTaskMedia`, with transport
  receipts (`taskReceipt`) feeding the ledger gate.
- `TaskDecision` / `recordDecision` / `ArtifactReceipt` / `expectedArtifactPath` scaffolding and
  `deliveryChat` plumbing through `CapabilityContext`, tasks and agent-comms.
- Existing late-reply / timeout run joining (`agentRuns`, `waitForAgentRun`) and restart resume.

The exact production gaps fixed here:

1. `taskOwnerAsk` recorded ANY non-empty answer and the prompt called it “already authorized”.
   There was no structural approval contract, so a denial or clarifying answer could authorize.
2. One per-task approval key (and one `decision` slot) collided across different actions; a
   restore answer could replay to a later delete/send question. Caller keys were not namespaced,
   a missing canonical qid was fabricated from the key, and persistence errors were swallowed.
3. `agentTurn` session key and `agentRuns` / loop-dedupe identity used only the agent/from pair,
   while cached tool closures captured `deliveryChat`. Chat B could reuse chat A's route.
4. In the full-capability delegated lane, `sessionFor`'s `ask_user` still rendered in the
   executor's own bot chat instead of the original invoking chat.
5. Artifact readback was synchronous/unbounded, followed symlinks, accepted relative paths, and
   never distinguished existence/content readback from byte-exact restoration. The ledger also
   trusted a non-readback `evidence` claim.

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
  - `taskOwnerAsk` builds the per-task/owner/action key, cites the real journal qid (no fallback to
    the key), derives approval structurally from `QuestionSpec.approveOption`, and propagates
    persistence errors instead of pretending durability.
  - `describeTaskDecisions` renders `AUTHORIZED`, `REFUSED`, or `ANSWERED, NOT AN APPROVAL`; only
    an approved decision says “do not ask again”.
  - `readArtifactReadback` is async, bounded (64 MiB), rejects relative paths, symlinks, non-regular
    files, empty files, and paths outside the declared scope; it labels existence vs byte-exact.
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
  distinct actions remaining distinct; route-scoped session keys; simultaneous same-text requests
  from different origins do not join; worker→dev owner questions render in the worker chat;
  runner-prompt decision rendering; artifact readback for real/missing/relative/out-of-scope,
  symlink, oversized and hash-mismatch cases.
- `src/plugins/tasks-plugin.test.ts` / `src/plugins/agent-comms-origin.test.ts`: delegated task
  origin binding, explicit alternate target, artifact contract persistence, and origin-chat
  propagation through the executor capability context.

## Checks (local, synthetic)

```text
npm test -- --configLoader runner src/durable/task-ledger.test.ts src/core/bot.test.ts \
  src/plugins/tasks-plugin.test.ts src/plugins/agent-comms-plugin.test.ts \
  src/plugins/agent-comms-origin.test.ts
→ 5 files passed, 294 tests passed (2026-11-10)

npm run typecheck
→ tsc --noEmit: passed

git diff --check
→ clean
```

Adjacent suites also run clean: `questions.test.ts`, `question-store.test.ts`,
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

1. Neutral exact decision + approval/action scope + refusal/clarification semantics — fixed;
   production-flow denial/clarification tests added; approval derived from a declared option, not
   English matching.
2. Per-action replay identity, task/owner naming, canonical qid required, persistence errors
   surfaced — fixed; two-approval/replay and rejection tests added.
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
