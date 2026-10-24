# Reliability audit — Oct 24 batch (bd: pibot-hwkj)

Per-priority findings for the live fleet: current behavior, evidence, and fixes that exist but lack activation/verification. All paths relative to the pibot repo. Audited 2026-10-24 (assistant session, exec granted).

## 1. Evidence-based completion claims
- **Current:** `src/durable/task-ledger.ts:18` defines `LedgerStatus = "queued" | "running" | "done" | "failed" | "cancelled"` — no `partial` or `blocked` states. `done` is set from result text alone (`task-ledger.ts:160`).
- **Delivery receipts:** `src/transports/telegram.ts:65-67,510` extract `message_id` but only `markIncoming` persists it (inbound side); outbound task completion records ok/fail text in the ledger's `notify` phase, **not** the sent message ID.
- **Media-type check:** video_note routing exists (`src/core/bot.ts:1536`), but nothing verifies a *requested* media type against the *actually delivered* kind — the open goal text ("a normal video does not satisfy a video-note request") is unimplemented.
- **Remaining gap:** add `partial`/`blocked` statuses + outbound `message_id`/`mediaType` fields to the ledger.

## 2. Capability checks before accepting work
- **Current:** `src/core/capabilities.ts` builds per-agent tool sets from manifests; commit `528835e` added live session capability refresh + heartbeat escalation-loop triage.
- **Gap:** no pre-acceptance probe that distinguishes interactive/background/heartbeat/voice/remote session modes; incompatible tasks are still attempted by default. `pibot-4wq1` (capability-profiles, dep: this audit) tracks it.

## 3. One authoritative task record
- **Current:** runtime tasks live in `src/durable/task-ledger.ts`; bd tickets are passively serviced in heartbeat ticks (`src/core/heartbeat.ts:73,432-433,707`, commit `3eb8f3e`). Two ledgers coexist with no linkage of bd IDs into ledger entries.
- **Gap:** `pibot-r47f` (task-record-canon) open — define the canonical record shape linking ledger entries ↔ bd tickets ↔ Linear.

## 4. Blocker-driven recovery instead of retry loops
- **Current:** `src/core/scheduler.ts` supports pause + `pauseReason` + `first-failure` (lines 24, 342) and prunes stale jobs (line 97); heartbeat escalation-loop triage files one dev ticket and suppresses repeats (`src/core/heartbeat.ts:271,314,600`, bd pibot-3w03).
- **Existing but unverified:** `pibot-0h8` in_progress (reject invalid schedule routes, pause permanent delivery failures) — activation pending.

## 5. Verify fixes in the running system
- **Current:** coverage gates (`coverage/`, `TESTING_COVERAGE_POLICY.md`, vitest configs); closed live-test harness `pibot-iue` (telethon-driven isolated daemon).
- **Gap:** no durable separation of implemented → activated → end-to-end-verified per fix; verification is ad hoc per bead closure. Needs a receipt format (bead comment or findings schema).

## 6. Resource and provider health
- **Current:** `src/core/disk-guard.ts` (ENOSPC catch, headroom via `freeBytes`), secrets redaction in `redact.ts` / `log-redact.ts`.
- **Gap:** no pre-work provider/quota/credential preflight; no concurrency caps on downloads/transcription/rendering. `pibot-kdpg` (resource-preflight) open.

## 7. Source ingestion standardisation
- **Current:** reply context flows through `src/transports/telegram.ts:287-295` (quoted truncation) into turns; link triage in `src/plugins/link-triage-plugin.ts`.
- **Gap:** forwarded-message metadata and non-text sends are dropped silently — open bugs `pibot-24b4` / `pibot-28xx`; no URL canonicalisation or duplicate detection in the pipeline.

## 8. Notification noise
- **Current:** `src/core/task-acks.ts:151` comms toggle (`comms.taskAcks`); mention-only group gate (`src/transports/telegram-gate.test.ts`, `groupMentionOnly`); `pibot-itkd` closed (owner-only heartbeat routing + operational-text suppression in group sends).
- **Gap:** no general operations channel separation — telemetry still goes to agent-owned chats; dedupe of repeated blockers is scheduler-level only.

## 9. Fact/calculation validation
- **Current:** `src/core/jev-evaluator.ts` / `goal-jev.ts` score goals but contain no arithmetic/unit verification (grep: zero hits).
- **Gap:** no programmatic numeric checks; judge calibration outstanding (`pibot-9dh`).

## 10. Proactive work aligned with ≤3 weekly outcomes
- **Current:** `src/core/goals.ts` goal contracts carry an `outcome` + verification field (lines 17, 68-77); commitment analytics dashboard shipped (`pibot-1db` closed).
- **Gap:** no enforced cap of three primary outcomes, no blocker-age / manual-handoff metrics collection.

## Cross-cutting conclusion
Fixes exist for most backbone behaviors (ledger, dedupe/pause, escalation triage, gates, disk guard, acks). The systemic gap is **not** missing code but missing *activation+verification records*: states 1 (partial/blocked + receipt fields), 5 (verification ledger), 6 (preflight), 7 (forwarded/URL canon), 9 (numeric checks), 10 (outcome cap). `cmd acp` remains nonexistent on this host and in this repo — no implementation target.