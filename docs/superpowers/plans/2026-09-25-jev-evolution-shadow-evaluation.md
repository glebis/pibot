# Jev Shadow Evaluation for Skill Evolution — Implementation Plan

Spec: `docs/superpowers/specs/2026-09-25-jev-evolution-shadow-evaluation.md` · bd: pibot-n13
Executor: inline (superpowers:executing-plans). Ledger: this file's "Execution ledger" section.

## Goal

An advisory, default-off Jev observer at the evolution engine's probe/judge boundary that
provably cannot change scores, staging, promotion, announcements, or backlog closure — plus
a replay harness for the owner-reviewed evaluation.

## File structure

| File | Responsibility |
|---|---|
| `src/core/jev-shadow.ts` (new) | Snapshot shape, permission gate, sanitizer/bounder, bounded observer queue, metadata-only record + bounded store. No policy decisions. |
| `src/core/jev-replay.ts` (new) | Fixture validation, baseline provenance (hash), blinded A/B order, variance repeats, report aggregation. Pure functions. |
| `src/core/types.ts` | `evolution.shadow` manifest field. |
| `src/core/evolution.ts` | Judge parse status; snapshot capture; non-awaited observe; metadata decision record. |
| `src/core/jev-shadow.test.ts`, `src/core/jev-replay.test.ts` (new) | Boundary + harness tests. |
| `docs/evolution-pipeline.md` | Short shadow-section note (runtime path gains an off-by-default seam). |

## Tasks

### T1 — Manifest flag (default off), provider/data scoped
Steps: failing test (manifest accepts `evolution.shadow`, absent = off) → add type → test green.
Deliverable: `evolution.shadow?: { enabled?: boolean; dataScope?: "synthetic" | "redacted_approved"; providers?: string[] }`.

### T2 — Snapshot + permission gate
Steps: failing tests → implement → green.
- A snapshot carries only: opaque run/probe ids, agent id, create/patch, candidate/baseline
  hashes, rubric version, task, criteria, candidate reply, optional baseline reply, missing-evidence flags.
- `permitted()` requires the per-agent flag **and** an approved data scope **and** the provider
  (`typesafe-ai`) in the allowed list. A configured gateway key alone is NOT permission.
- Field bounds + redaction of known sensitive patterns; if the serialized state cannot fit the
  evaluator's 16 KiB limit after shedding the optional baseline reply → `unassessable`.

### T3 — Bounded observer
Steps: failing tests → implement → green.
- `observe()` is synchronous, fire-and-forget, never throws; returns a discriminated result via callback.
- Bounded queue (drop excess, counted), per-agent per-day call budget, short per-call timeout, no retries beyond the client's bound.
- Results: `evaluated` | `unassessable` | `not_permitted` | `failed`. Metadata-only records
  (no task/criteria/reply text), bounded private store.

### T4 — Evolution integration (the authority stays with the current judge)
Steps: failing tests → implement → green.
- `judge()` may return `{ score, parse }`; a bare `number` still works (back-compat).
- Snapshot captured after `runProbe` returns while the candidate still exists; `observe` not awaited.
- Record the cycle's outcome (`promoted` | `staged`) as metadata.
- **Boundary tests:** Jev success, disagreement, timeout, invalid output, and provider denial must
  each leave score, staging, promotion, announcement, and backlog closure byte-identical.

### T5 — Replay harness (pure) + synthetic fixtures
Steps: failing tests → implement → green.
- Fixture validation: independent tasks/criteria, verified baseline provenance by hash, data-scope class.
- Blinded A/B order (seeded), variance repeats, and a report aggregating false-pass, false-review,
  unassessable share, disagreement, latency, cost.

### T6 — Docs + commit
Plan status, spec status line, `docs/evolution-pipeline.md` note, exact-path commit.

## Not in this increment (needs the owner, not code)

- Authoring the real replay set from staged/historical candidates with **owner-reviewed** tasks and
  criteria, and the **blinded human labels** the report compares against. The harness accepts them;
  until then it runs on synthetic fixtures (spec: "use synthetic or individually approved redacted
  cases").
- Enabling any shadow flag for a live agent, and any later review-only escalation policy — both
  require a separate owner decision, per the spec.

## Execution ledger

- **T1 done** — `types.ts` carries `evolution.shadow` (flag / dataScope / providers), absent = off.
- **T2 done** — `jev-shadow.ts`: snapshot → bounded, redacted, untrusted-framed input; permission gate.
- **T3 done** — bounded observer: drop-excess queue, per-agent daily budget, typed results, metadata-only records.
- **T4 done** — engine integration: judge may return `{score, parse}` (bare number still fine); snapshot after each probe reply; `observe` never awaited; decision recorded as metadata.
- **T5 done** — `jev-replay.ts`: selection (independence + provenance), blinded A/B, verdicts, repeats, report.

### Rulings

- **Criteria are never truncated.** Bounding them could hide a required criterion, so an oversize
  rubric becomes `unassessable`; only the task and the replies are truncated, and the flags say so.
  Cost if wrong: a long-rubric case yields no judgment instead of a partial one — which is the
  failure mode the spec asks for.
- **Live cycles ask the criteria question only.** Running a baseline probe would double probe cost,
  which the spec forbids; the snapshot therefore marks `baseline_reply` missing and the pairwise
  question belongs to the replay harness. Cost if wrong: live shadow cannot speak to
  improvement-vs-baseline — the replay set answers that instead.
- **Budget exhaustion is reported as `not_permitted` with reason `budget_exhausted`**, keeping the
  spec's four result kinds intact rather than inventing a fifth. Cost if wrong: a reader must look
  at the reason code to tell permission from spend.
- **No daemon wiring in this increment.** The spec lists live deployment as out of scope, so the
  observer is constructible and tested but not constructed by `index.ts`.
- **`maxQueue` bounds waiting items**; the running call is extra, so the in-flight bound is
  `maxQueue + 1`.
