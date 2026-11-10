# Restore scoped vault discovery across knower sessions

6 November 2026 · Prepared, not started · P1 · Existing issue **pibot-0xpf.6**

## Problem and evidence

Saving a note does not reliably make it retrievable by a subsequent knower session.
On Nov5 18:56 CET knower could not locate an existing Workroom trail after guessing paths:
[tg source](tg://openmessage?user_id=8817061827&message_id=580361).
At19:01 knower reported saving a video-skills landscape and at19:43 an Agentic Video MoC;
at20:23 a delegated knower lookup reported no note/MoC match for open-record-replay:
[save](tg://openmessage?user_id=8817061827&message_id=580370),
[MoC](tg://openmessage?user_id=8817061827&message_id=580387),
[lookup](tg://openmessage?user_id=8694340006&message_id=580391).
The lookup did acknowledge incomplete indexing and a truncated MoC. Its relay is not a second incident.

Read-only checks in the Nov5 review confirmed the Trail, landscape and MoC existed and the latter
two contained the term. This is evidence of retrieval gaps, not absence of files or a Workroom
product defect. The earlier15:53 Workroom-context answer preceded creation of the Trail and is
not failure evidence. Do not use real private note contents as fixtures or commit them.

Full source report (reference only; the brief is self-contained):
`/Users/glebkalinin/Brains/brain/Claude-Drafts/20261105-telegram-bots-patterns.md`.
Existing reliability epic: pibot-0xpf. Related issues: closed pibot-sm7 (vault-file activation),
pibot-wcp0 (exec refusals/confined processing extracts). Reuse these records; no new daily-review epic.

## Inspect first

Read the worktree's AGENTS.md and current issue/status/comments before coding. You are not alone
in the repository: preserve others' changes and adjust to concurrent work; do not revert them.
The initial inspection found vault_read/vault_write exact-path operations in
`src/plugins/vault-plugin.ts`, its tests in `src/plugins/vault-plugin.test.ts`, and knower's
manifest with vault-file and memory capabilities. This does not prove that every other search
route is absent. Inspect memory search/indexing, capability registry/tool discovery and existing
prompt guidance first. Reuse a working scoped path if available; fix the actual integration gap.

## Scope and ownership

Own the narrow PiBot vault-discovery implementation, tests and documentation. Likely files:
`src/plugins/vault-plugin.ts`, its test file, and minimal capability registry/prompt integration
if inspection requires it. Prefer existing abstractions and no new dependencies.

- Offer bounded vault-scoped filename/title/content discovery that finds the Workroom Trail from
  'workroom trail' and a newly saved landscape/MoC from a term in its content.
- Return exact vault-relative paths, explicit searched scope, truncation/continuation and freshness
  metadata. Distinguish a complete no-match from partial coverage or an unavailable/stale index.
- Ensure a successful save can be followed by lookup, including through a fresh plugin/session
  instance. Document and test the post-save lookup receipt/flow; a write acknowledgement alone
  must not imply indexing completed.
- Bound file count, bytes scanned, result count and excerpts. Skip nontext/binary and hidden
  control directories as appropriate; define deterministic ordering/continuation semantics.
- Reuse existing vault realpath confinement. Keep traversal and symlink escapes denied for both
  reads and discovery; do not introduce unrestricted shell/listing or broaden the vault root.
- Add meaningful synthetic fixtures for fresh-save discovery, filename/title matching, content
  matching, long/truncated results, stale/unavailable coverage and confinement. Include a fresh
  instance lookup so same-session memory is not the reason a test passes.

## Not in scope

- Hermes research chronology/protocol changes: independent project, not PiBot code.
- Replaying the recovered Shape of Work append, changing cida status, or rebuilding its gate.
- Disk pressure fixes (pibot-78qw), digest changes, unrelated media/voice/dashboard work.
- Live agent manifests, private vault data, credentials, queues, schedules, models or permissions.
- Service restart/deployment, Telegram/mail messages, paid/external calls, installs, publication.
- Merge, push, PR creation, staging source-checkout changes or closing existing issues.

## Worktree and baseline

The source checkout was on `voice-shared-session-tasks` at `3ee4665` when prepared. It has many
uncommitted/untracked changes (media/voice/dashboard plus prior cida/jiqv source fixes).
A handoff worktree starts from committed history and will NOT contain those changes. The brief
can be passed as a file without committing it. At launch, report the actual base branch/commit
and missing dependencies. Do not copy the dirty checkout wholesale, commit it to obtain a base,
or silently recreate unrelated fixes. If the committed base lacks a required dependency, stop
with the exact prerequisite rather than changing shared state.

No agent/worktree/epic has been launched by preparing this document. On later authorized launch,
use the installed handoff script and ACP client, normally cmd acp in its own herdr workspace.
If that script creates an operational handoff epic, link it to existing pibot-0xpf.6 instead of
registering duplicate findings; keep pibot-0xpf as the daily-review umbrella.

## Done when

1. Synthetic fixtures resolve the Workroom-shaped Trail and a newly saved term from a fresh
   session, returning exact paths and honest coverage/freshness.
2. Partial/truncated/unavailable results never assert vault-wide absence; continuation is usable
   and bounded. Duplicate MoCs are not suggested merely because coverage was incomplete.
3. Out-of-vault/traversal/symlink attempts remain denied, and scan/output budgets are tested.
4. Targeted tests, typecheck and diff hygiene pass; unrelated changes remain untouched.
5. Delivery separately states implementation, activation and live verification. Only implementation
   and local deterministic verification are in this handoff. A later owner-authorized live read-only
   lookup must verify effective knower tools and the original scenario; no activation claim here.

## Checks

Run from the isolated worktree after dependencies are available. Do not install dependencies
without authorization; if absent, report the prerequisite. Add new discovery tests to the vault
plugin test file or update this brief's checks if the smallest design uses a separate suite.
Each fenced line below is one command, executed independently by handoff collect.

```bash
npm test -- --configLoader runner src/plugins/vault-plugin.test.ts src/core/capabilities.test.ts
npm run typecheck
git diff --check
```

## Delivery

Report files changed, exact check results, remaining limitations and implementation/activation/live
verification separately. Once launch is authorized, follow the handoff rules for commits confined
to its own branch with explicit paths. Do not merge/push/restart. Record missing prerequisites
and unresolved owner decisions rather than working around them.
