# Proactive-Agent Pilot + Analytics Dashboard — Design (MVP)

Date: 2026-09-16 · Status: approved by owner (via researcher relay) · bd: pibot-1db

## Goal

Make proactive agent messages measurable. Pilot = **commitment follow-through** over 2 weeks.
Every proactive message in the pilot produces privacy-safe, metadata-only events; the web
dashboard turns them into metrics the owner can act on.

## Relationship to existing code

- `scheduler-plugin.ts` already has `promise_make` / `promise_keep` (kind `promise`,
  auto-confirmed, LLM-composed fires). These stay functional but are NOT measurable.
  The pilot adds a measurable layer on top: `kind: "commitment"` jobs + a durable store.
- Existing `EventLog` is per-agent, bounded (500 lines), mixed-purpose — unsuitable as an
  analytics source. The pilot gets a dedicated store under `data/proactive/` (gitignored,
  0600 perms, metadata only).

## Data model (`src/core/proactive-store.ts`)

```ts
type CommitmentOrigin = "explicit" | "inferred";
type CommitmentStatus =
  | "proposed"      // inferred, awaiting owner confirmation
  | "active"        // in the loop (explicit starts here; inferred after Confirm)
  | "completed"     // Done ✓ at deadline
  | "missed"        // Not yet at deadline
  | "renegotiated"  // owner pushed the deadline (old commitment closed, successor created)
  | "dismissed"     // owner dismissed a proposed (inferred) capture
  | "cancelled";    // explicit cancel

interface Commitment {
  id: string;            // uid("cm", 6)
  agentId: string;
  chat: ChatRef;         // "transport:chatId" the loop lives in
  text: string;          // ≤160 chars, owner-visible preview only
  dueAt: number;
  origin: CommitmentOrigin;
  status: CommitmentStatus;
  createdAt: number;
  confirmedAt?: number;  // when a proposed capture was confirmed (inferred only)
  closedAt?: number;
  rating?: "up" | "down"; // helpfulness tap on the loop's final message
  groupId?: string;       // scheduler groupId of its jobs
}

interface ProactiveEvent {
  ts: number;
  id: string;            // opaque uid (correlation id — no content)
  commitmentId?: string;
  agentId: string;
  loop: "pilot" | "heartbeat";
  stage: "proposed" | "confirmed" | "delivered" | "seen" | "acted"
       | "skipped" | "dismissed" | "ignored";
  outcome?: string;      // short token: "precheck:block", "deadline:done", "budget:over"
  channel: "telegram" | "web";
}
```

Storage: `data/proactive/commitments.json` (writeJsonAtomic) + `data/proactive/events.jsonl`
(append-only). Retention: events older than 90 days pruned (boot + rolling check).
Privacy (per pibot-4ji rules): no message bodies, no prompts, no replies — previews ≤160
chars on commitments only; events are pure metadata; opaque correlation ids.

## Semantics: delivered / seen / acted / noise

- **delivered** — the proactive push resolved without throwing.
- **seen** — owner pressed any button on the proactive card (Telegram callback), i.e. the
  message was touched.
- **acted** — owner pressed a *meaningful* choice (on-track / blocked / renegotiate / done /
  confirm / rating). Every acted event implies seen.
- **ignored** — delivered + no seen within 48h (computed at query time; no timers).
- **noise** — dismissed confirmations + ignored + 👎 ratings.
- **helpfulness** — 👍/👎 tap on each loop's final message + weekly scorecard rating.

## Capture

- **Explicit**: `/commit <text> by <when>` in any chat with the agent. `when` reuses
  `parseWhen` (`in 3d`, `friday 18:00`, ISO…). Status → `active` immediately; loop starts.
- **Inferred**: agent tool `commitment_capture` (plugin). Creates `status:"proposed"` and
  pushes a confirmation card [Confirm] [Dismiss] to the owner's chat with that agent.
  Only `Confirm` starts the loop. `Dismiss` logs `dismissed`. The tool reply states the
  item is *proposed, awaiting confirmation* — honest to the model and the user.
- Analytics never mix origins: every commitment carries `origin`; summaries split
  explicit / inferred (+ confirm rate, dismiss rate for inferred).

## Loop (deterministic; scheduler-driven; ≤3 proactive messages per commitment)

Jobs (kind `commitment`, delivery `direct`, `groupId: cmg:<id>` share-cancel):

1. **Pre-check** at `dueAt − precheckLead` (default 24h; if created later, at midpoint):
   card [On track] [Blocked] [Renegotiate]. On track → `acted:precheck:on-track`.
2. **Blocked** → exactly one follow-up: one next-action suggestion (cheap-model ephemeral
   session, cascade-aware, deterministic fallback text if no model). Logs delivery.
3. **Deadline**: card [Done ✓] [Not yet] [+1d].
   Done → `completed`. Not yet → `missed`. +1d → successor commitment (renegotiated).
4. **Renegotiate** (pre-check card): [+1d] [+3d] [+1w] [Cancel] — deterministic offsets,
   no free-text interception. Successor is `active`, predecessor `renegotiated`.
5. **Final message** of a closed loop carries 👍/👎 → commitment.rating + event.
6. **Weekly scorecard** per pilot agent (Monday 09:00, repeat weekly): stats from the
   store + [Useful] [Too much] rating buttons.

Budget/governance: manifest `proactive.pilot` (default off), `proactive.dailyBudget`
(default 6 delivered pilot messages / agent / day — enforced before each proactive send,
over-budget logs `skipped:budget:over`), `proactive.precheckLead` (default "24h").

## Event sourcing points

- `deliverFire` kind `commitment` → engine composes card → push → `delivered` (+commitmentId).
- `handleAction` prefix `cm:` → seen + acted/outcome records.
- `HeartbeatEngine` speak → `loop:"heartbeat"`, `delivered` (via deliverToAgent origin tag).
- Dashboard is read-only in MVP; pilot on/off + budget are manifest edits (dashboard form).

## Dashboard (`/analytics`, read-only MVP)

- Query filters: `days` (7|14|30, default 14), `agent`, `loop` (all|pilot|heartbeat).
- Metric row (pure `summarize()`): delivered, seen %, acted %, completion % (completed /
  (completed+missed), explicit-only toggle via origin split), helpfulness (👍 share),
  noise % (ignored + dismissed + 👎 share).
- Commitment table: status pill, origin pill, due, rating; `<details>` per row = event
  drill-down (type, stage, outcome, channel, latency, opaque id).
- Link from overview page. Existing auth + dark SSR styling, no new deps, no JS.

## Testing

- Store: TDD (append/query/prune/origin split, summarize math incl. ignored-at-48h).
- Engine: fake timers for pre-check/deadline/successor/budget; action handling; inferred
  confirmation gate (dismiss/confirm).
- Web: route renders filters + metric labels; drill-down contains commitment ids.
- Live behavior (Telegram buttons) verified only via the live-test harness at deploy time
  (gated on explicit owner authorization, outside this repo work).

## Out of scope (follow-ups)

- Free-text renegotiation, proof-of-completion media, per-message thumbs on heartbeat
  speaks, agent-side analytics queries, non-pilot loops beyond heartbeat speaks.