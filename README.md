# pibot

Personal agent companions built on the [pi SDK](https://github.com/badlogic/pi-mono). Chat with agents over Telegram (or a local CLI); every agent has its own plugin system, memory, calendar awareness, a scheduling heartbeat, and goal-driven skill self-evolution.

## Design in one paragraph

**Every agent is a private runtime directory** under `~/.local/share/pibot/agents/` by default (`PIBOT_AGENTS_DIR` overrides it). Only the generic scaffold in `agents/_template/` belongs in source control:

```
~/.local/share/pibot/agents/<name>/
  agent.json      # manifest: model, heartbeat rhythm, evolution config
  AGENTS.md       # persona (loaded as context by pi)
  memory/         # long-term memory, owned by the agent
  skills/         # evolved + self-saved skills (SKILL.md per skill)
  extensions/     # agent-private pi extensions (plugins)
  sessions/       # persistent per-chat conversation state
  state/events.jsonl  # event log — feeds heartbeat + evolution
```

The host process (`src/`) runs a **scheduler** (JSON-backed timer wheel with snooze semantics), a **heartbeat engine** (economical ephemeral cheap-model ticks that decide whether anything is worth saying), and pluggable **transports** (Telegram, CLI). One capability registry binds each host plugin's factory, tool allowlist, dependency check, and prompt description so agents are never told about unavailable tools. Each agent additionally loads its own private extensions and skills.

### Per-agent capabilities

`agent.json` may set `capabilities` to an explicit list. Omitting it uses the conservative default: `scheduler`, `memory`, `calendar-read`, `skills`, `agent-comms`, and `questions` (the last two only when their host hooks exist). External-data or mutation capabilities are opt-in:

```json
{
  "capabilities": ["scheduler", "memory", "calendar-read", "skills", "agent-comms", "questions", "gmail-read", "knowledge"]
}
```

Available ids are `avatar`, `speech`, `scheduler`, `memory`, `calendar-read`, `calendar-write`, `gmail-read`, `linear`, `skills`, `knowledge`, `agent-comms`, `questions`, `attend`, `telegram-responder`, `delegate`, `herdr`, `developer`, and `remote-workshop`. Avatar, Calendar, and Linear mutations require owner confirmation. Dependencies are loaded and advertised only when available. Ordinary agents receive no generic filesystem tools by default; `tools` is an explicit SDK/custom-tool allowlist and `capabilities` controls host plugins.

The `herdr` capability (requires the `herdr` CLI and a running herdr instance) lets an agent run subagents in new tabs of the owner's herdr UI: `herdr_dispatch` spawns claude/codex/pi/opencode in a fresh tab with a self-contained brief, waits for `done`, and returns the transcript (`--detach` returns immediately; `herdr_read` and `herdr_wait` observe the pane afterwards). The target workspace resolves from the invoking herdr pane, `$PIBOT_HERDR_WORKSPACE`, or an explicit `workspace` argument; briefs are passed as temp files and never carry secrets.

`providers` is a per-agent model-provider allowlist. Without it, only models named directly in `model`/`cascade` are used; global and authenticated-provider fallback discovery is disabled.

### Telegram bot avatars

Avatar access is opt-in per agent. Add `avatar` to that agent's manifest; bots bound to other agents do not gain the capability:

```json
{
  "capabilities": ["scheduler", "memory", "avatar"]
}
```

Generation uses the deterministic, offline `local` provider by default. Optional external image providers are configured separately and remain unavailable until explicitly configured; provider discovery does not call them. Generated JPG artifacts remain private in the owning agent's runtime data.

`avatar_generate` only creates a candidate. A later `avatar_apply` targets the Telegram bot handling that chat and presents an explicit **Confirm / Cancel** choice before changing its profile photo. PiBot never rotates avatars on a timer or applies a generated image automatically.

## Run

```bash
npm install
npm run cli                      # terminal chat + dashboard, no tokens needed
cp .env.example .env             # add TELEGRAM_BOT_TOKEN for the real thing
npm start                        # telegram bot
```

The **web dashboard** runs at `http://127.0.0.1:7860` (disable: `PIBOT_WEB=0`, port: `PIBOT_WEB_PORT`). It is always locked: set `PIBOT_WEB_TOKEN` for the first login, then enrol a passkey. First-passkey enrolment requires that token-authenticated session.

### Voice notes & media
Beyond text, the bot accepts Telegram **voice**, **audio**, **video notes**, and audio documents (locally validated and transcribed → routed like typed text), plus **photos/documents** (agent gets the local file path + caption). Unsupported media is declined instead of dropped. Video-note audio is extracted locally; the video itself is never passed into the agent context.

Transcription is local-first and controlled by `STT_PROVIDERS` (default `whisperkit,local_whisper`):

- `whisperkit-cli` — Apple Silicon native (default local-first on macOS; model `STT_WHISPERKIT_MODEL`, default `whisper-tiny`, cached in `~/Library/whisperkit`)
- local fallback: the `whisper` CLI on PATH (model override `STT_LOCAL_MODEL`)
- optional external fallback: `groq` with `GROQ_API_KEY` (model override `STT_GROQ_MODEL`) is used only when the resolved agent manifest explicitly lists it under `speech.sttProviders` and sets `speech.allowExternalStt: true`
- `STT_LANGUAGE` — optional ISO-639-1 language hint (omit for auto-detect)

Downloaded speech media uses private runtime storage, opaque filenames, local media probing, bounded duration/size/timeouts, and is removed after the transcription attempt. Photos and ordinary documents follow the separate bounded retention work tracked for runtime media.

Outgoing speech is local-only and opt-in per agent. Add `speech` to that agent's `capabilities`. `speech_generate` uses macOS `say` plus local `ffmpeg` to create either an OGG/Opus Telegram voice message or M4A music-player audio; it never sends. `speech_send` sends the selected artifact only to the same invoking Telegram chat through the normal per-chat queue, rate-limit retry, and duplicate guard. A successful send deletes the artifact; unsent artifacts expire after 24 hours.

Speech is never generated or sent automatically, and it has no heartbeat, scheduler, replay, or automatic reply-conversion hook. No external TTS provider or credential is included in this foundation.

The dashboard provides:
agent CRUD, manifest editor (model/heartbeat/evolution/quiet hours), persona + memory editors,
schedule table with cancel, snooze/wake, staged-skill review (promote/reject), run-evolution, event tail.

Chat commands: `/help` `/agents` `/agent <name>` `/newagent <name> <persona>` `/handoff <agent> [note]` `/schedules` `/snooze 2h` `/wake` `/status` `/skills` `/evolve [goal]` `/evolve status|promote|reject`

### Handoff between agents

Agents can delegate among themselves (`agent_message` / `agent_ask` / `agent_list`), and a conversation can move between agents with full context: `/handoff <agent> [note]` or an agent calling its `handoff` tool packages the thread into a **task brief** (task, context, artifacts, done, next step — distilled by a cheap ephemeral model, raw transcript fallback) and delivers it to the target's session in the same chat, which is then rebound so the user's next message reaches the target. In a dedicated sub-bot chat the chat stays pinned to its agent — there the brief lands in the target's inter-agent pair session instead. External delegation is opt-in per agent: `delegate` (claude/codex/gemini CLIs) and `herdr` (subagents in herdr tabs).

## Scheduling & the one-button flow

Ask naturally: *"remind me to stretch in 20 minutes"*, *"note to take: check the lab results tomorrow 9am"*, *"daily standup note at 08:00"*, *"every 2h drink water"*, *"friday 18:00 submit the report"*.

- The agent calls `schedule_create` (instant — no confirmation ritual), you get a **card with inline buttons**: ✅ OK · ⏰ +10m · 🕒 +1h · 🗑 Cancel.
- `wake: "important"` items fire even when everything is snoozed.
- `delivery: "agent"` wakes the agent to compose the message itself; `direct` sends a quick formatted ping.
- **Promises**: *"I'll send Anna the invoice by Friday"* → `promise_make` tracks it with an automatic pre-check, `/promises` lists open ones.
- `/snooze 2h` pauses the whole rhythm (heartbeats skip a beat, normal items defer, important pierce).

## Heartbeat (economical aliveness)

**Give each agent a checklist:** edit `~/.local/share/pibot/agents/<name>/HEARTBEAT.md` — a tiny, user-editable list the agent follows on every tick (OpenClaw's most-loved pattern). Agents can also send images: include `MEDIA: <url>` in a reply.

Every agent's manifest sets a rhythm (`interval`, cheap `model`, `quietHours`). Each tick spawns an **ephemeral cheap-model session** (never touching the main session's cache) with a compact digest: persona + memory + pending items + recent events. It decides via one tool call: `speak` (short proactive message), `escalate` (hand to the full agent brain), or nothing (a few hundred tokens).

**Adaptive wakeups (self-paced rhythm, from Ouroboros's `set_next_wakeup`):** the heartbeat decision can also include `wakeup` ("10m"…"12h") — the agent compresses the next gap when something is brewing and stretches it when everything is quiet, instead of firing on a fixed drumbeat. Hard bounds come from the global clamp (5m–12h), narrowed per-agent via manifest `heartbeat.minInterval` / `heartbeat.maxInterval` (editable in the dashboard). Skipped ticks (quiet hours, snooze, backoff) always fall back to the base rhythm.

**Maintenance rotation (one item per wakeup):** each tick's digest ends with a maintenance panel — freshness of `memory/MEMORY.md`, `AGENTS.md`, memory notes, event consolidation, and the last maintenance entry (Ouroboros CONSCIOUSNESS.md pattern). The agent services **at most one** stale item per tick and rotates, recording what it did via the `maintain` field: a one-line durable note appended to `memory/maintenance.jsonl` (also logged as a `maintenance` event, visible to you in the dashboard event tail). Everything fresh → silence + longer wakeup; maintenance never breaks a tick. One verb runs host-side machinery: `maintain: "consolidate events"` triggers the consolidation pipeline for real.

## Event consolidation (Skill Forge blueprint)

The event log is ephemeral (bounded, redacted JSONL). The consolidation pipeline distills it into **durable memory** per agent (adapted from Ouroboros's `consolidator.py` + `memory.py`):

- **Block-based memory** — `memory/consolidated/blocks.json` holds summary/gap/era blocks; `CONSOLIDATED.md` and `journal.jsonl` are regenerated views + run records.
- **Advance-only cursor** — meta records the last-consumed `events.jsonl` offset; a model failure never advances it (nothing is ever lost to a bad run).
- **Gap blocks** — event-log rotation (head trimming) is reconciled by timestamp and recorded as an explicit gap block: lost/skipped events are never silently dropped.
- **Cheap-model distillation** — unconsolidated events are summarized into dense blocks; durable lessons are promoted into `memory/notes/` (memory-plugin-compatible) with an index inside `CONSOLIDATED.md`.
- **Eras** — older blocks compress into era blocks once the count grows (deterministic fallback keeps every record if the model is down).
- **Triggers** — evolution cycles distill first (unless `consolidation.enabled: false`) and feed the distilled view into skill proposals; heartbeats can service it via the maintenance verb; the opt-in scheduler job (`consolidation.enabled: true`, `interval`, `model`) runs it on its own rhythm; `/consolidate [status]` runs it manually.

## Self-evolution (Hermes-style, pibot-native)

Adapted from [NousResearch/hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) (GEPA loop: propose → evaluate → guardrails → apply) and the pi ecosystem's existing packages (`pi-agent-skill-evolution`, `pk-pi-hermes-evolve`, `@artale/pi-evolve`, `pi-skill-evolution`) — none of which fit pibot's per-agent architecture, so the loop is built in:

```
collect (events + persona + skills) → propose (cheap model)
  → guardrails (name, size ≤15KB, structure, patch-applies)
  → stage in skills/.staging/
  → eval probes (ephemeral sessions with the candidate skill loaded, LLM judge 1-5)
  → avg ≥ 4: promote + git commit + announce   |   else: stays staged for review
```

- **Automatic**: `evolution.enabled: true` in agent.json runs a cycle on a rhythm (default 6h, max 4/day), announces promotions in chat.
- **Improvement backlog** (per agent, `memory/improvement-backlog.md`): durable, deduplicated candidates ranked priority → recurrence → recency (ported from Ouroboros's improvement backlog — a repeated irritation is *counted*, never dropped). Heartbeats append candidates via `maintain: "backlog: <summary>"`; the digest shows the top 5 to every heartbeat and evolution cycle; a goal-less `/evolve` (scheduled tick, dashboard) targets the top-ranked open item as its goal, and landing the skill closes what it addressed (`closesBacklog` proposal field + staging sidecar, close-on-promote). Advisory only — implementation always goes through the gated cycle.
- **Manual**: `/evolve [goal]` runs a cycle now; `npm run evolve -- assistant "get better at morning briefings"`.
- **Staging workflow**: `/evolve status` → `/evolve promote <name>` / `/evolve reject <name>`. Probes below 4 avg never auto-apply.
- **Agents evolve themselves mid-chat** too: `skill_save` / `skill_patch` / `skill_list` (Hermes `skill_manage` style) after non-trivial workflows.

## Architecture

```
src/
  config.ts               env + .env
  core/
    types.ts              manifests, schedules, transports
    util.ts               natural-language time parsing ("in 20m", "daily at 08:00", "friday 18:00")
    scheduler.ts          job store + timer wheel + snooze + promises + card flow
    agent-manager.ts      agent discovery, scaffolding, per-chat pi sessions
    heartbeat.ts          ephemeral cheap-model ticks (speak/escalate/note)
    bot.ts                command routing, cards, fire delivery, time envelope
    evolution.ts          goal-driven skill evolution (staging + probes + gates)
    consolidation.ts      event log → durable memory (blocks, gaps, eras, lessons)
    events.ts             per-agent event log (feeds heartbeat + evolution)
  plugins/                shared agent plugins
    scheduler-plugin.ts   schedule_create/list/cancel, snooze, promise_make/keep
    memory-plugin.ts      memory_save / memory_recall
    calendar-plugin.ts    calendar_today (icalBuddy + gws)
    skill-manage-plugin.ts agents save their own skills
  transports/
    telegram.ts           grammY, long polling, inline keyboards
    cli.ts                terminal chat with numbered cards
```

## Developer agent (off by default)

Set `PIBOT_DEV_AGENT=1` to scaffold the built-in **`pibot-dev`** agent: it develops, tests, and stages the bot's own source.

- React-only (no heartbeat, no evolution) — it never self-initiates; you talk to it (`/agent pibot-dev`, or hand a task off via `agent_message`).
- Its session runs with `workspace: "repo"` — the pibot repo root is its cwd, and it gets `bash` plus three tools:
  - `dev_status` — branch / git status / diffstat / recent commits
  - `dev_test` — runs `tsc --noEmit` + the vitest suite (optionally scoped)
  - `dev_stage` — lands the change as a git checkpoint commit, but **only** after re-running the full gate (typecheck + tests). Refuses on red or when forbidden paths changed (`.env`, `data/`, sessions, node_modules).
- You review source changes in git history (`git log`, `git revert`); runtime staging logs stay private under the configured agent directory.

```bash
echo 'PIBOT_DEV_AGENT=1' >> .env   # enable at next restart
git revert <commit>                # rollback any staged change
```

## Testing

```bash
npm test              # full Vitest suite
npm run test:coverage
npm run evolve -- assistant "goal text"   # CLI evolution cycle
```

`.git/hooks/pre-commit` runs typecheck + tests before every commit (TDD gate).

### Telegram live-test harness (end-to-end, autonomous)

Unit mocks can't catch transport-level bugs (a message-outbox self-deadlock shipped exactly that way behind 419 passing tests). The live harness drives a bot through the real Telegram round-trip — send a command as a user, await the reply, assert reactions and the daemon log:

```bash
npx tsx scripts/telegram-live-test.mts --attach --chat @thebot   # post-deploy smoke vs a running bot (DM: use the bot's @username)
npx tsx scripts/telegram-live-test.mts                                  # full: isolated daemon + dedicated test bot
```

- **spawn mode** (default) boots an isolated daemon (`PIBOT_DATA_DIR`/`PIBOT_AGENTS_DIR` override, dedicated test-bot token, its own dashboard port) with a **pre-seeded test agent** (heartbeat@1m + 8 distillable events) and runs the full scenario set: boot health (lock, pollers, dashboard auth challenge), `/status` round-trip, unknown-command reply, **seeded consolidation round** (model distills the 8 events → blocks.json + journal + rendered CONSOLIDATED.md), consolidation idempotence (second call is a no-op), **live heartbeat tick** (1m interval, silent-rule asserted), the reaction-settle wedge canary (👀→👍 on the sent command — catches outbox deadlocks), a no-error log soak, and lock cleanup on shutdown.
- **`--attach` mode** runs read-only smoke against any already-running bot chat (no side-effecting commands) — this is the post-deploy verification step before trusting a restart. It sends through **your user account**, so target the bot's **@username**: a numeric id is resolved as a peer of yours, and your own numeric (allowlist) id lands the smoke commands in Saved Messages where the bot never sees them.
- Missing vars (`TELEGRAM_LIVE_TEST_TOKEN`, `TELEGRAM_LIVE_TEST_CHAT_ID`) are **requested via an AppleScript dialog** — hidden input for the token; plain input with the production allowlist id pre-filled for the chat id — and persisted to `data/telegram-test.env` (0600, gitignored): set once, prompted never again. `--no-prompt` disables the dialog. One-time prerequisites: a **test bot** via BotFather (never reuse the production token), `/start`-ed once from your account. The DM chat target is derived from the token itself, so `--chat` is unnecessary in spawn mode.

## Roadmap

- Skill Forge pattern-mining beyond the event log: mine session transcripts and staged-skill outcomes (the event-log distillation foundation ships in `consolidation.ts`)
- Multi-strategy mutation archive (compress/quality/radical, from `@artale/pi-evolve`)
- Rich image-generation previews and provider-specific adapters beyond bot avatars
- Stronger process-level sandboxing for agent-private extensions
## License

MIT — see [LICENSE](LICENSE).
