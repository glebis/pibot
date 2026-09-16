# Proactive Pilot + Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, this
> host has no code-executing subagents). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make proactive messages measurable — commitment follow-through pilot + `/analytics` dashboard.

**Architecture:** Dedicated metadata-only store (`data/proactive/`) fed by a deterministic
CommitmentEngine that owns `kind:"commitment"` scheduler jobs and `cm:` card actions; read-only
`/analytics` SSR page. Existing `promise_make` stays untouched; new `commitment_capture` tool
routes inferred captures through an owner-confirmation gate.

**Tech Stack:** TypeScript, Hono SSR (existing dark UI), grammy cards/callbacks, vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-proactive-pilot-analytics-design.md`

## Global Constraints

- Metadata only: no message bodies/prompts in events; commitment previews ≤160 chars (verbatim from spec).
- `data/proactive/` is runtime-private (already gitignored via `data/`); files 0600.
- Retention: events pruned at 90 days (spec).
- ≤3 proactive pilot messages per commitment (spec). `proactive.pilot` default OFF.
- Dirty-tree rule: never stage the unrelated in-flight hunks (task-acks in bot.ts/web.ts) in our checkpoints.
- Every milestone lands via dev_stage only when typecheck + FULL suite are green.

---

### Task 1: ProactiveStore — durable commitments + metadata events (new files only)

**Files:**
- Create: `src/core/proactive-store.ts`
- Test: `src/core/proactive-store.test.ts`

**Interfaces (produced):**
- `interface Commitment`, `interface ProactiveEvent` (fields per spec)
- `class ProactiveStore { constructor(dataDir: string); appendEvent(e: ProactiveEvent): void; createCommitment(c: Omit<Commitment,"id"|"createdAt"|"status"> & {status?: CommitmentStatus, id?: string}): Commitment; updateCommitment(id: string, patch: Partial<Commitment>): Commitment | undefined; getCommitment(id: string): Commitment | undefined; commitments(f?: { agentId?: string; origin?: string; status?: string; since?: number }): Commitment[]; events(f?: { agentId?: string; loop?: string; since?: number; commitmentId?: string }): ProactiveEvent[]; prune(now?: number, retentionMs?: number): number; }`
- `parseCommitDue(rest: string): { text: string; whenRaw: string; dueAt: number; repeat?: ScheduleRepeat } | undefined` — splits trailing "by <when>" / "in <dur>" and delegates to `parseWhen`.
- `summarize(events: ProactiveEvent[], commitments: Commitment[], opts: { since: number; now: number; agentId?: string; loop?: string }): Summary` with `{ delivered, seenPct, actedPct, completedPct, helpfulPct, noisePct, ignored, explicitCount, inferredCount, confirmRate, byStage }`.

- [ ] Step 1: failing tests — store CRUD roundtrip + origin/status filters; `parseCommitDue` ("send invoice by friday 18:00" → text/when split; no-when → undefined; "in 2d"); `summarize` math: delivered counts pilot+heartbeat per filter; acted⊂seen; ignored = delivered with no seen after 48h (fake now); completion %; noise % = (ignored+dismissed+down)/(delivered); prune drops >90d.
- [ ] Step 2: `npx vitest run src/core/proactive-store.test.ts` → RED (module missing).
- [ ] Step 3: implement store (JSON via util readJson/writeJsonAtomic; events.jsonl append 0600; prune on boot + every 200 appends; ids `uid("cm",6)`/`uid("ev",8)`).
- [ ] Step 4: tests GREEN; `dev_test src/core/proactive-store`.

### Task 2: CommitmentEngine — loop + confirmation gate (new file + types)

**Files:**
- Create: `src/core/commitments.ts`, test `src/core/commitments.test.ts`
- Modify: `src/core/types.ts` — `ScheduleKind` += `"commitment"`; `AgentManifest` += `proactive?: { pilot?: boolean; dailyBudget?: number; precheckLead?: string }`

**Interfaces:**
- Consumes: `ProactiveStore`, `Scheduler` (`create/cancel/list/get/assertCapacity`), `EventLog`.
- Produces: `class CommitmentEngine { constructor(deps); captureExplicit(agentId, chat, text, whenRaw): { commitment?: Commitment; reply: string }; captureInferred(agentId, chat, text, whenRaw): { commitment: Commitment; reply: string }; confirm(id): boolean; dismiss(id): boolean; onFire(job: Schedule): Promise<void>; handleAction(action: string, chatId: string): Promise<string | void>; deliverHeartbeatSpeak(agentId, ok: boolean): void; }`
- Host deps: `{ agents, scheduler, events, store, bot: { deliverToAgent(agentId, text, card?): Promise<boolean /*delivered*/>; pushChat(chat, text, card): Promise<boolean> }, suggestNextAction?(agentId, text): Promise<string>, now?: () => number }`.

- [ ] Step 1: failing tests (fake `now`): explicit capture → active + pre-check job (dueAt−24h) + deadline job share `groupId cmg:<id>`, ≤3 msgs budget counters; deadline later than precheck-lead → precheck at midpoint; `onFire` precheck → pushChat card (buttons `cm:<id>:track|block|reneg`); actions record seen+acted; `cm:<id>:block` → follow-up text via suggestNextAction fallback + `delivered`; `cm:<id>:done` → status completed + rating card on final message; `cm:<id>:notyet` → missed; `cm:<id>:+1d` → renegotiated + successor active; inferred capture → proposed, NO jobs, confirmation card; `cm:<id>:confirm` → active + jobs scheduled + `confirmed` event; `cm:<id>:dismiss` → dismissed; dailyBudget exceeded → `skipped` outcome, no push; pilot disabled → capture replies "pilot off", no events.
- [ ] Step 2: RED via `npx vitest run src/core/commitments.test.ts`.
- [ ] Step 3: implement engine (pure helpers exported: `precheckAt(dueAt, leadMs, createdAt, now)`, `commitmentCard(stage, c)`, `isOverBudget(store, agentId, budget, now)`).
- [ ] Step 4: GREEN + `dev_test src/core/commitments`.

### Task 3: Agent capture tool + host wiring

**Files:**
- Create: `src/plugins/commitment-plugin.ts`, test `src/plugins/commitment-plugin.test.ts`
- Modify: `src/core/capabilities.ts` (register `commitments` capability, create→ `commitmentPlugin({engine, agentId, chat})`, only when `manifest.proactive?.pilot`), `src/core/bot.ts` (deps `commitments?`; `deliverFire` branch `kind==="commitment"` → `onFire`; `handleAction` prefix `cm:` → engine; in `deliverToAgent` heartbeat-origin path: store `loop:"heartbeat",stage:"delivered"`), `src/index.ts` (construct store+engine; pass into bot deps + capability ctx + web deps).

- [ ] Step 1: failing plugin test — tool reply contains "awaiting your confirmation" and creates proposed commitment; disabled pilot → reply says disabled.
- [ ] Step 2: RED, then implement plugin mirroring `schedulerPlugin` shape.
- [ ] Step 3: wiring edits (smallest hunks; tree also holds unrelated task-acks hunks — hand-stage ours later, never `git add -A` from bash).
- [ ] Step 4: GREEN + full `dev_test`.

### Task 4: /commit command

**Files:**
- Modify: `src/core/commands.ts` (CommandContext += `commitments?`; route `/commit`; help line), test additions in existing command test file (`src/core/bot.test.ts` command coverage).

- [ ] Step 1: failing test — `/commit send invoice by tomorrow 9am` → agent reply includes commitment id + due; `/commit` without "by" → usage hint; pilot off → hint.
- [ ] Step 2: RED → implement → GREEN.

### Task 5: /analytics dashboard

**Files:**
- Modify: `src/web.ts` (WebDeps += `proactiveStore?`; `GET /analytics`; overview link; manifest form pilot toggle + POST handler field), test `src/web.test.ts` (new describe block).

- [ ] Step 1: failing web tests — `/analytics?days=14` renders metric labels (Delivered/Seen/Acted/Completion/Helpfulness/Noise), agent+loop filter links, commitment row with id + `<details>` drill-down; manifest toggle saves `proactive.pilot` true/false.
- [ ] Step 2: RED → implement (GET-only page, `<details>` drill-down, links carry filters) → GREEN.

### Task 6: Milestone landing

- [ ] `dev_test` (full). Then dev_stage per milestone:
  - M1 = Task 1 (new files only). M2 = Tasks 2–4 (needs the dirty-tree resolution: if task-acks still unlanded, hand-stage our hunks and skip dev_stage for bot.ts/web.ts paths — raw git commit is forbidden, so report instead). M3 = Task 5.
- [ ] Update bd pibot-1db with progress; close when M3 landed.

## Self-review

- Spec coverage: capture both origins (T2/T3/T4) · loop stages (T2) · store+retention (T1) · semantics delivered/seen/acted/ignored (T1 summarize) · dashboard filters+drill-down (T5) · governance budget+opt-out (T2/T5) · scorecard (T2 onFire "scorecard" job, weekly repeat) ✔
- No placeholders: real signatures above; card/button text pinned in Task 2 test bodies.
- Type consistency: `cm:<id>:<verb>` verbs — `track|block|reneg+1d|+3d|+1w|cancel|done|notyet|confirm|dismiss|up|down` used identically in T2 tests, T3 handleAction, T5 drill-down outcomes.