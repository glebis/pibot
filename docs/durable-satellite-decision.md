# Decision (2026-10-29, bd pibot-8ptd): retire the phase-1 durable satellite goal

**Decision: do not wire a daemon-owned pi-durable satellite. The phase-1 goal from
pibot-icv is retired.** `src/durable/satellite.ts` and `src/durable/telegram-surface.ts`
stay as a tested, clearly-labelled prototype, not as half-finished production work.

## What was asked

pibot-icv recorded a three-phase plan: (1) prototype a pi-durable harness for one satellite
agent with Telegram as a surface; (2) keep pibot core on pi-coding-agent 1.0 meanwhile;
(3) revisit a full core migration only after the satellite proves checkpoint/resume +
multi-surface value. Phase 2 is done and `pibot-icv.1` is closed. Phase 1 never started:
no daemon-owned satellite, no `attachTelegramSurface` caller outside tests and the CLI
script, no `data/satellite/` directory.

pibot-8ptd asked: wire it, or retire it explicitly.

## Why retire

### 1. The capability gap is not a seam, it is the whole product

The satellite's entire tool surface is one read-only tool:

```
list_workspace   — list up to 200 filenames in the workspace directory      (src/durable/satellite.ts:26)
```

A pibot agent on pi-coding-agent gets far more than that: **28 capability definitions** in
`src/core/capabilities.ts` (link-triage, speech, avatar, dictionary, scheduler, tasks,
commitments, research-intake, memory, calendar-read/write, gmail-read, linear, skills,
knowledge, vault-file, docs-file, agent-comms, questions, telegram-send, …) backed by
**29 plugins** in `src/plugins/` registering **89 tools**, plus skills, long-term memory,
the cascade, heartbeat, proactive scheduling, and the `SessionManager`-based session model
(`src/core/agent-manager.ts:271`).

pi-durable does ship `CodingTools` (`@earendil-works/pi-durable/tools` → `read`, `write`,
`edit`, `bash`), so the *mechanical* part of a port is available. But "wire the satellite
into the daemon" is not four tools — it is reimplementing the capability registry, the
plugin model, the agent factory, skills, memory, and the session store on a second harness.
That is phase 3, the full core migration, and phase 3 was explicitly gated on phase 1
proving value **in production**. Phase 1 never ran, so that gate was never passed.

### 2. The seam's actual value already shipped — somewhere else

The satellite's stated benefit was checkpoint/resume plus exactly-once work by
`requestId`. That benefit is now delivered in production without moving agents onto a
second harness. All of these landed this session (2026-10-29):

| durability need | what now provides it | bead |
| --- | --- | --- |
| background task survives restart | pi-durable task ledger (`src/durable/task-ledger.ts`) | (pre-existing) |
| task ledger one writer + visible corruption | `src/durable/storage-lock.ts` | pibot-cea8 |
| task ledger log compaction + measured replay | `src/durable/compact-ledger.ts`, `docs/durable-ledger.md` | pibot-b708 |
| outbound Telegram message not lost/duplicated | `src/core/delivery-ledger.ts` | pibot-qy88 |
| owner question survives restart, answered-once | `src/core/question-store.ts` | pibot-jciq |
| reminder fires at-most-once across a crash | `src/core/scheduler.ts` claim/settle | pibot-awhs |

Each is a targeted piece of durable state on the existing agent stack. Together they cover
what the satellite was meant to prove, at a fraction of the blast radius of a second
harness.

### 3. Two harnesses in one daemon is net duplication

A daemon-owned satellite means two storage directories, two lock holders, two model
provider stacks, two task schedulers, two sets of credentials resolution, and two places a
crash can resume. With `delivery-ledger` and the scheduler now durable, the daemon already
has the properties the satellite would have added; the satellite would add a second owner
for the same concerns.

### 4. The prerequisites finished, and they argue against wiring

pibot-8ptd was blocked on pibot-cea8 (a second writer needs the lock) and pibot-qy88 (a
durable outbox to deliver into). Both are closed. Reading them together is the point: the
lock exists precisely because a second writer is dangerous, and the outbox exists because
the daemon's own delivery needed exactly the guarantee the satellite was going to provide.
They made the daemon durable; they did not make a second harness necessary.

## What stays, and how it is labelled

- `src/durable/satellite.ts` — unchanged in behaviour. Header now states it is a
  **prototype with no production caller**, and points here.
- `src/durable/telegram-surface.ts` — same. It remains the reference implementation for
  exactly-once Telegram requestIds; `src/core/delivery-ledger.ts` is the production answer
  and the two should not be confused.
- `scripts/durable-satellite.mts` — kept. It is how a future migration would prototype, and
  it refuses a live ledger directory (`assertNotLiveLedger`).
- Tests stay green and unskipped: the seam is verified, not abandoned-by-neglect.

## What would reopen this

Reopen only if a phase-3 migration is deliberately chosen, and only with these answered
first:

1. Which pibot capabilities must exist on pi-durable before an agent can move? (Today: 1 of
   89 tools, 0 of 28 capability definitions.)
2. Where do `SessionManager` sessions live during and after a migration? Session history is
   the one thing pibot does not currently store durably — that is the real phase-3 question,
   and it is a session-store question, not a satellite question.
3. What is the rollback? A second harness means a cutover, not a flag.

Until then, the durable investment goes into the existing agent stack — the file list in the
table above is where.
