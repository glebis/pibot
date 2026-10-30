# Durable task ledger: ownership, replay cost, compaction

Reference for `data/durable/tasks` (the pi-durable ledger behind durable background tasks).
Written for bd pibot-b708 / pibot-cea8.

## What is on disk

| file | what it is | grows? |
| --- | --- | --- |
| `main.jsonl` | one commit marker per commit, replayed at boot | **yes, forever** |
| `doc-<id>.jsonl` | document revisions (`history: "latest"`) | reclaimed by the backend |
| `task-<id>.jsonl` | per-task checkpoint records | reclaimed when the task is terminal |
| `.pibot-ledger.lock` | owner record (`pid`, `host`, `command`, `acquiredAt`) | rewritten per owner |

`KEEP_FINISHED = 200` (`src/durable/task-ledger.ts`) bounds the ledger *document*, not the
log: pruning finished task entries commits a new revision, which appends another marker.
That is why the log looks unbounded even though the document is. The backend does reclaim
sidecars (`reclaimSidecars()`, `node_modules/@earendil-works/pi-durable/dist/storage/jsonl/storage.js`)
and `document.retire` empties a retired document's sidecar, but **no code path rewrites
`main.jsonl`**. There is no public `compact()` on `Storage`, `JsonlStorage` or `Harness` —
recorded as an upstream gap.

## Measured replay cost (2026-10-29, this machine)

Real ledger, 116 tasks:

```
main.jsonl   717 commit markers, 327 KB (467 B/marker)
boot replay  10–29 ms open + 3–4 ms first list
synthetic    200 tasks → 1201 markers / 239 KB → 15 ms open
             600 tasks → 2401 markers / 561 KB → 33 ms open
```

Replay is linear in markers, so a 10× log is roughly 10× the open time: ~100–280 ms for
7 170 markers. That is still small, but it is paid on every daemon start and it is pure
history, so it should not accumulate indefinitely.

## Compaction (offline, supervised)

```bash
npx tsx scripts/ledger-compact.mts --measure     # read-only: markers, bytes, replay cost
# stop the daemon first — --compact refuses while it holds the lock
npx tsx scripts/ledger-compact.mts --compact
```

Measured on a copy of the real ledger:

```
markers  717 → 2
bytes    327 KB → 1 KB
carried  116 tasks, 116 requestIds
boot     28 ms → 4 ms
```

What `--compact` does (`src/durable/compact-ledger.ts`, `rewriteLedgerStorage`):

1. takes the directory lock; a running daemon makes it fail loudly, not race;
2. refuses while **any** task of any carried agent is still `queued`/`running` — a rebuilt
   ledger would restart or orphan real work;
3. exports the whole document (`TaskLedger.exportSnapshot()`), writes it into a fresh
   sibling directory in **one** commit (`importSnapshot()`), which is the only way to get a
   one-marker log with no public compaction API;
4. re-reads the rebuilt ledger and compares per-agent task counts against the original;
5. swaps the directories by two renames and keeps the original as
   `<dir>.pre-compact-<timestamp>` — never deleted by the script;
6. a failure at any step leaves the original directory in place, and a failed swap renames
   the backup straight back.

Both `tasks` and `requests` are carried, so the exactly-once `requestId` map survives: a
retried `start()` after compaction still replays the original task instead of re-running it
(asserted in `src/durable/compact-ledger.test.ts`).

Delete `<dir>.pre-compact-<ts>` only after the daemon boots clean.

## One writer per directory

`openTaskLedger` and `openSatellite` take an O_EXCL lock (`src/durable/storage-lock.ts`)
and fail with the holder named. A corrupt ledger stops the daemon with an owner-visible
notice instead of silently running without durable tasks (`LedgerUnreadableError`).

Consequence worth knowing: `scripts/durable-satellite.mts --storage-dir` must never point
at this directory. It now refuses a directory that already holds `main.jsonl` unless
`--force-live` is passed.

## Status of the durable satellite

`src/durable/satellite.ts` and `src/durable/telegram-surface.ts` are prototypes with no
production caller. The phase-1 "daemon-owned satellite" goal is retired — see
`docs/durable-satellite-decision.md` (bd pibot-8ptd). The task ledger documented here is the
one pi-durable consumer in production.
