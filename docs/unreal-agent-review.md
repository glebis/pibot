# Unreal Agent — external harness review

Review note, 2026-09-27. Source:
<https://github.com/unreallabsai/unreal-agent>, read at `1b9f778` (2026-09-23,
Go 1.27, 62k LOC of which ~20k is generated OpenAI types). Read-only review of a
clone; nothing was imported, vendored, or executed.

Purpose: extract what this harness's invariants say about pibot's own gaps —
especially the failure classes pibot's incident history already records. This is
a lens, not a spec: the items below are candidates, and each one names the pibot
evidence that makes it a candidate.

## What the project is (and is not)

A library-first agent harness with no transports and no product surface:

| Package | Responsibility |
|---|---|
| `harness/inbox` | Session-scoped input deduplication; inputs carry caller-supplied stable IDs; kinds `external` / `control` / `crash` |
| `harness/coordinator` | Single-use decision loop: persists accepted inputs, owns one LLM turn at a time, resolves tool translators, dispatches committed operations |
| `harness/sessionstore` (+`localfile`) | Append-only versioned session log, item observers, operation state, fork, resume state |
| `harness/contextbuilder` | Stateful, I/O-pure model-request assembly |
| `harness/llm` (+`responsesapi`) | Normalized provider adapter, retry policy, streaming |
| `harness/tool` | Fixed tool set with pure translators; skills as registry citizens |
| `harness/operation` + `primitives` | Durable, versioned, serializable operations on a swappable actor runtime |

**Stack delta that dominates the comparison:** unreal-agent owns the turn loop,
tool execution, and session format. pibot delegates all three to
`@earendil-works/pi-coding-agent`. So most of this architecture is not
portable, and "replace the loop" is explicitly out of scope — it would mean
forking the SDK. What *is* portable are five invariants, and they land on gaps
pibot can point at in its own code.

## How it works — the parts that carry the invariants

### 1. Input idempotency

`inbox.Input` = `{ID, Kind, Payload}`; `Validate()` rejects an empty ID.
`Inbox.run` keeps a `seen` set and drops duplicates, seeded at construction from
`seenIDs` supplied by the caller. Accepted inputs are persisted as session items
(`Store.AppendInput`), and `ResumeState.ExternalInputIDs` returns the ID set on
resume — so dedup survives a restart, not just a redelivery. Control messages
are themselves inputs (`StopHard`, `StopWhenIdle`, `Heartbeat`,
`UpdateSettings`), which means stop/heartbeat are modelled as data on one
serialized path instead of as side channels.

### 2. Tool call → operation, with the intent persisted before execution

`tool.tool.go` splits translation from execution:

- `Translate(Context, llm.ToolCall) CallStatus` runs **synchronously on the
  coordinator's event loop and must not perform I/O**. `Context.Submit(spec)`
  allocates an operation ID and records inert data — it does not hand work to
  another queue.
- `CallStatus` = validation error, or `WaitingFor []operation.ID`.
  `ResultTranslator.TranslateResult` later formats the recorded status plus
  prepared operation output into a model-facing result.
- `SessionStore.AppendToolCallStatus` persists the status **and its operation
  snapshots atomically**; the first append initializes those operations.

Execution lives in `operation.Manager` — an actor runtime over serializable,
versioned values (`Spec`/`Operation` with `Type`, `Version`, `State`,
`Idempotency`, `MaxOutputLength`), with states
`ready/awaiting/canceling/completed/failed/canceled` and `Manager.Add` that must
start an operation **at most once per ID per process lifetime**. Handlers are
written as resumable phase machines: `shell.go` keeps a `ShellPhase` plus
process-group id and pending exit code in the persisted operation state, so a
restarted process re-enters the shell operation where it stopped. `Step` returns
the next durable checkpoint or nil to leave it unchanged, and primitives
(`shell`, `file`, `image`, `process`, `timer`, `sse`/`remote_sse`) report events
back on a channel.

Consequence: a crash cannot lose or double-run a tool call. On resume the
coordinator reloads history (`loadHistory` → `restoreItem`), reconciles calls
whose operations reached terminal state (`reconcileToolCalls`), and re-dispatches
unfinished ones to the manager, whose `Add` is per-ID idempotent. A tool call
still running is surfaced to the model as a normal result:
`ToolCallRunningPayload` = "Tool call is still running… continue with independent
work, or end your turn to wait for it." A pending call also keeps a heartbeat
alive (`ToolHeartbeatInterval` → `postHeartbeat` injects a control input naming
the running calls), so a long operation never looks like a hung turn.

### 3. Versioned, refusing session format

`localfile/codec.go`: `formatVersion = 2`, written into the first record.
Version 1 → explicit error, "cannot be resumed"; any other version →
"unsupported session format version". Testdata holds `golden-session`,
`golden-fork`, `legacy-session` and `soft-stop-session` fixtures, so format
changes have to be conscious.

### 4. Bounded output that keeps both ends

`operation/output.go` `BoundOutput`: half the budget from the head, half from the
tail, joined by `...N bytes truncated; complete output in <path>...`; default
40 000, cap 1 000 000. UTF-8 safe; the full artifact stays on disk.

### 5. Retry policy that trusts provider hints, and fails open

`llm/responsesapi/retry.go`: `Retry-After` header parsing (delta-seconds and
HTTP-date) and a `try again in Ns` message parse; overload codes
(`server_is_overloaded`, `slow_down`) get a deliberately longer backoff; jitter
is subtracted; the classifier fails open (unknown ⇒ retry) with a hard
non-retryable list (`context_length_exceeded`, `insufficient_quota`,
policy-violation codes, invalid key/token). `Response` carries normalized
`StopReason` (`complete`/`max_output_tokens`/`refused`) and `Failure{Code,
Message}`, and `Usage` separates cached, cache-write and reasoning tokens.

### Methodology

`coordinator/fault_fuzz_test.go` fuzzes the loop with faults injected at 14 named
dependency boundaries under `synctest` (deterministic virtual clock);
`fault_fakes_test.go` builds stores that commit-whole-or-error and never mutate
history on failure; `sessionstore/localfile/store_test.go` is the largest test
file in the repo. The `benchmarks/harbor` adapter pins a built bundle by revision
and checksum.

## Applied to pibot

Ranked by evidence-to-cost ratio. Each item cites the pibot code that makes it a
real gap.

### P1 — inbound idempotency at one boundary

**Gap.** pibot has no inbound dedup. `TelegramDuplicateGuard`
(`src/transports/telegram.ts:36-60`) is outbound-only, in-memory, 512 entries,
time-windowed. grammy commits its getUpdates offset in memory, so a crash or
restart mid-turn can redeliver a user message and re-run the turn. Host-generated
prompts (scheduler fires, heartbeat, proactive cards) are guarded case-by-case in
each engine.

**Harness invariant.** Stable caller-supplied input ID, dedup set that survives
restart (`ResumeState.ExternalInputIDs`), persisted as a session item.

**Shape.** One inbox per chat: `{id, kind, payload}` where `id` is
`telegram:<chat>:<message_id>` / `schedule:<id>:<fire_ts>` /
`heartbeat:<agent>:<window>`, checked before `handleIncoming` and journaled so
the seen-set survives restart. Control-shaped inputs (stop/drain) can ride the
same path.

### P2 — journal tool-call intent, reconcile at boot

**Gap.** Tools run inline inside the SDK session and the session log records
completed messages (`dist/core/session-manager.d.ts:217 appendMessage`), so an
interrupt leaves a call with no result and no evidence it ever started. pibot's
current answer is inference: `AmbiguousReplayError`
(`src/core/bot.ts:2835`) and `automaticReplayBlocked`
(`src/core/cascade.ts:110`) — the right *policy* bolted onto a missing
*mechanism*.

**Harness invariant.** Translation is pure; the status and operation snapshots
are persisted atomically before execution; resume reconciles unfinished work and
reports running calls to the model instead of losing them.

**Shape.** Not a durable-execution rewrite. Append
`{turnKey, callId, tool, argsHash, startedAt}` and a terminal status to a side
journal; on boot, mark unterminated entries ambiguous-blocked so nothing
auto-replays. That replaces the heuristic with a record.

### P3 — version persisted state, refuse on unknown, freeze fixtures

**Gap.** Boot paths use `readJson(path, {defaults})`. An older or unrecognised
`cascade-state.json`, `heartbeat-state.json`, scheduler or proactive file is
silently reinterpreted on restart — the failure mode AGENTS.md names directly
("a restart is not a reset and must never be used as a substitute for
diagnosis").

**Harness invariant.** `formatVersion` in the first record; legacy version →
explicit refusal; golden + legacy fixtures in testdata.

**Shape.** `version` field per state file, refuse-and-report on unknown, one
frozen fixture per file so a format change fails a test rather than a restart.

### P2b — keep the tail of bounded output

**Gap.** `truncate()` (`src/core/util.ts:324`) is head-only: the error at the end
of a long output is exactly what gets cut.

**Shape.** Port `BoundOutput` (~15 lines): head + tail + truncation marker +
path to the full artifact under `data/`.

### P2c — use provider retry hints in cascade cooldowns

**Gap.** `COOLDOWN_MS` in `src/core/cascade.ts` is a flat 90s for rate-limit with
no `Retry-After` input; `retry_after` is parsed only for Telegram sends
(`src/transports/telegram.ts:30-32`).

**Note.** pibot's error classification is *more* granular than the harness's and
should stay. The port is narrow: feed a parsed hint into the rate-limit and
transient classes, and treat overload wording as a longer backoff.

### P2d — graceful stop

**Gap.** `shutdown` in `src/index.ts` stops the scheduler and transports and
exits; an in-flight turn is aborted with no drain and no ambiguity marker.

**Harness invariant.** Stop is an input: `StopHard` cancels operations,
`StopWhenIdle` drains until idle.

**Shape.** Bounded drain on SIGTERM, and if the turn is force-cancelled, record
it ambiguous so the P2 journal blocks any replay.

### Direction (not a task yet)

- **Session fork for evolution A/B.** The SDK already supports it
  (`session-manager.d.ts`: `branch`, `createBranchedSession`); pibot's
  `EvolutionEngine` currently runs matched synthetic probes. Forking real history
  at a turn boundary would let candidate skills be judged on actual traffic
  without touching the live chat.
- **Context report.** `contextbuilder.Builder.Build()` returns
  `(Request, Report)` where `Report.Changes` enumerates `omitted` / `truncated` /
  `compacted` with source and reason. The interface commits to it; the shipped
  builder does not yet populate it. The idea is worth having: pibot compacts but
  keeps no record of what was dropped, which is the first question in any "why
  did it forget X" investigation.
- **Capability-as-operation.** One serializable `Operation` with a swappable
  manager would unify local execution, herdr delegation, and a future remote
  sandbox into one abstraction instead of three plugins. Real, but pibot's
  plugins are not in enough pain yet.

### Explicitly not portable

- Replacing the turn loop with a Go-style coordinator (means forking the SDK;
  the SDK's tree/branch model already exceeds the harness's linear fork).
- The operation actor runtime and remote-job/SSE operation shipping.
- Harbor benchmark adapter, the 5-class error taxonomy, hosted-tool plumbing.

### Testing to borrow

Fault injection at named dependency boundaries, fuzzed under a deterministic
clock, plus golden/legacy fixtures for every persisted format. pibot has solid
per-module coverage but no fault injection on the persistence and delivery paths
— which is where every incident in its own history lives (ENOSPC, cascade down,
replay).
