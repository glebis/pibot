# PiBot — P0 pibot-cida append gate + P1 pibot-jiqv digest verdict (2026-11-05)

Findings from the Nov 5 daily review. Both were inspection-only in the review; this record
covers the source fix and its deterministic verification. **Neither issue is closed and
neither was deployed**: no restart, no live task retry, no live search, and the production
note `~/.local/share/pibot/agents/creator/shape of work.md` was not touched.

## P0 — pibot-cida: verify append outcomes

**Observed failure.** On Nov 4 16:25 CET the creator answered a note-append task with
"Task done" and "Not saved" in the same result, and the ledger still recorded
`status: "completed"` (task id 143, ledgerId `tmw29qe0k5gs6`, agent `creator`, acceptance
criteria "Durable note contains owner's initial idea and meta-layer addition, verified after
write."). The 191-byte note never received the addition:

> as a meta-layer + allows you to see patterns, tensions, changes in quality of interactions

**Root cause (generic, not creator-specific).** `src/durable/task-ledger.ts` had exactly one
completion gate: `expectedMedia` plus the delivery tuple (peer/account/idProtocol). The task
record carried `acceptanceCriteria` — written by `start_task`, persisted in the entry — but the
`work` phase never read it. Nothing in the system could distinguish "I wrote it" from "I could
not open the file", so the verdict came only from the presence of a non-empty result string.

**Fix.**
- `LedgerTaskInput.expectedContent` + `LedgerEntry.readback` and a new `ContentReadback`
  (`{ path, text, afterWrite }`) in `src/durable/task-ledger.ts`.
- `describeContentGap()` (pure) rejects completion in five distinct shapes: no readback
  supplied, readback not taken after the write, readback names a different artifact than
  `outputLocation`, post-write text that does not contain the expected addition, and the addition
  appearing more than once — a retried append must not duplicate the sentence. Matching collapses
  whitespace runs so a wrapped/indented line still matches, but a partial sentence does not.
- The gate can only downgrade: a failed content check sets `final = "partial"` and becomes the
  recorded `error`, so the owner notice says `🟡 Task partial` (checked by the head line, not the
  body prose the agent wrote).
- `PiBot.taskContentReadback()` in `src/core/bot.ts` performs the actual read **after the turn
  ends** and supplies it with the run result. `afterWrite` is true only when the file's mtime is
  at least as new as this task's run start (`taskRunStartedAt`), so a stale artifact that already
  contained the text cannot satisfy the gate. A missing or unreadable file produces an empty
  non-post-write readback instead of throwing; a non-absolute `outputLocation` is reported as
  unverified rather than guessed.
- `start_task` exposes `expectedContent` (1000-char cap) and persists it with the durable task
  contract, so a resumed attempt is held to the same gate.

**Verification (ledger fixture, incapable executor).** `src/durable/task-ledger.test.ts`:
"records partial when an incapable executor reports success but wrote nothing" replays the real
shape (result text "Task done. Not saved: file access is unavailable…", readback of the unchanged
note) and asserts `partial` + `did not happen after the write`; further cases cover no readback,
post-write text without the addition, a readback naming another file, a done case where the
addition appears exactly once, a duplicate append (`contains it 2 times`), a resumed attempt that
leaves the single addition in place, whitespace-wrapped matching, and a no-`expectedContent` task
that keeps the plain delivery gate. `src/core/bot.test.ts` ("task content readback") covers the
real filesystem: post-write proof (the write happens inside the turn, so its mtime is genuinely
post-run-start), an unchanged file with a backdated mtime, a deleted artifact, a relative
`outputLocation`, and a task naming no expected addition.

**Not done.** The production task was not retried and the note was not modified — both need
separate authorization. Live verification (a real task whose write is blocked, then a real
verified continuation under the same task) is still owed; it requires deploying this build.

## P1 — pibot-jiqv: unavailable research vs empty digest

**Observed failure.** At 08:07 CET the researcher reported its scrape was still running (no
candidates yet); seconds later the knower reported "Thin wire — completed". THIN means "every
subject was searched and nothing qualified". It was used for "the search had not finished", so
the owner was told the day was quiet when the evidence was missing.

**Root cause.** No canonical verdict existed in source. The digest ran from the knower's
`proactive-research` skill prose (`~/.local/share/pibot/agents/knower/skills/proactive-research/
SKILL.md`, "thin day is acceptable — say so plainly"), so a model chose the wording with no
shared definition and no structural distinction between "searched and empty" and "not searched".

**Fix.** New `src/core/digest-verdict.ts` (pure, no I/O):
- Input is a list of `DigestSubjectSearch { subject, state: completed|running|deferred|failed,
  qualified, note? }` — the recorded outcome of each subject's search.
- `digestVerdict()` returns `drop | thin | partial | unavailable | skipped`. `thin` is reachable
  ONLY when every active subject is `completed` and the qualified total is zero. A missed window
  with no completed search is `unavailable`; a missed window alongside completed ones is
  `partial`. The gap list names the reason per subject ("search still running", "not searched
  (deferred)", "search failed") and the headline never uses THIN wording for them.
- `reconcileLateDigest()` recomputes the verdict from the SAME recorded searches when a late
  reply lands and always reports `resubmitted: false`; `describeLateDigestChange()` states what
  changed and that no subject was searched twice, so late results upgrade the verdict without
  duplicate searches and without resending the earlier drop.

**Wiring.** `src/plugins/digest-plugin.ts` exposes the decision as an opt-in `digest` capability
(`defaultEnabled: false`) with two tools, so a turn no longer authors the verdict:
- `digest_verdict({ subjects })` normalizes each `state`, drops a `qualified` count that belongs
  to a non-completed search (a running subject cannot inflate a drop), writes the verdict to
  `<agentDir>/state/digest-verdict.json` (dir 0700) and returns the headline, the per-subject gap
  lines and an explicit "a late result can still change this verdict; do not call the day thin".
- `digest_late_result({ subjects })` reads the stored verdict, recomputes it through
  `reconcileLateDigest()` and reports the change (`unavailable → drop`, `partial → thin`) with
  "No subject was searched twice; the earlier report stands as sent." — or an explicit no-change
  line when the record already matched. With no stored verdict it refuses to reconcile rather
  than inventing a baseline. The stored file is left untouched when nothing changed.

**Verification.** `src/core/digest-verdict.test.ts` replays the Nov 4 shape (a `running` subject
is `unavailable` and its headline explicitly says "NOT a thin day"), a genuinely empty completed
day (`thin`), a mixed day (`partial`, with completed subjects listed as covered), deferred vs
failed gap wording, a normal drop, no-subject skip, negative counts, and both late-reconciliation
directions (unavailable → drop, partial → thin) each asserting `resubmitted === false`.
`src/plugins/digest-plugin.test.ts` (11 cases) covers the tool surface end to end: a still-running
search is reported `unavailable` and never "Thin wire", a genuinely quiet day is `thin`, an
omitted count on a completed search reads as zero, a running subject's count cannot inflate a
drop, an empty registry is `skipped`, the verdict file lands in `state/` at 0700, the late upgrade
and partial→thin paths, the no-change path, refusal without a baseline, and the file staying byte
identical when nothing changed. One registry case also asserts the capability is opt-in and that
its prompt forbids thin wording for a missed window.

## Verification run

- `npm test -- --configLoader runner`: **3085 passed, 159 files, exit 0**.
- `npm run typecheck`: **exit 0**.
- `git diff --check`: **exit 0**.

## Activation (owner-authorized, 2026-11-05)

Both live-state mutations were applied only after explicit owner approval ("Apply both now"):

1. `~/.local/share/pibot/agents/knower/agent.json` — `digest` appended to `capabilities`
   (backup: `agent.json.bak-20261105-digest-capability`). Verified through the real registry, not
   the file: `AgentManager.resolveAgentInventory("knower", …)` now lists `digest` and exposes
   `digest_verdict` / `digest_late_result` in `tools`.
2. `~/.local/share/pibot/agents/knower/skills/proactive-research/SKILL.md` (backup:
   `SKILL.md.bak-20261105-digest-verdict`) — the digest flow now calls `digest_verdict` before
   writing to the chat, with per-subject `state`/`qualified` instructions, an explicit ban on
   calling an unfinished day thin, a step to fold a late answer through `digest_late_result`
   without re-searching or resending, and a Gotchas line recording the Nov 4 incident. The
   researcher ask template no longer says "thin day is acceptable"; it asks for "searched,
   nothing qualified" per subject and "still running" when the search did not finish.

Nothing was restarted: the manifest change takes effect when the knower's next session is built.

## Limits

- Feeding the verdict its `qualified` counts from the registry's seen-ledger is still manual: the
  caller states what happened per subject. A structural link to the seen-ledger would make the
  verdict automatic rather than reported.
- No live search, schedule change, model change, restart or queue mutation was performed. No
  fixtures were taken from production provider calls; all checks are local and deterministic.
- The pre-existing uncommitted changes in this worktree were left as they were; only the files
  listed in this report were edited.
