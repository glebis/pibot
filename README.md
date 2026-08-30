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

Available ids are `scheduler`, `memory`, `calendar-read`, `calendar-write`, `gmail-read`, `linear`, `skills`, `knowledge`, `agent-comms`, `questions`, `attend`, `telegram-responder`, `delegate`, `developer`, and `remote-workshop`. Calendar and Linear mutations require owner confirmation. Dependencies are loaded and advertised only when available. Ordinary agents receive no generic filesystem tools by default; `tools` is an explicit SDK/custom-tool allowlist and `capabilities` controls host plugins.

`providers` is a per-agent model-provider allowlist. Without it, only models named directly in `model`/`cascade` are used; global and authenticated-provider fallback discovery is disabled.

## Run

```bash
npm install
npm run cli                      # terminal chat + dashboard, no tokens needed
cp .env.example .env             # add TELEGRAM_BOT_TOKEN for the real thing
npm start                        # telegram bot
```

The **web dashboard** runs at `http://127.0.0.1:7860` (disable: `PIBOT_WEB=0`, port: `PIBOT_WEB_PORT`). It is always locked: set `PIBOT_WEB_TOKEN` for the first login, then enrol a passkey. First-passkey enrolment requires that token-authenticated session.

The dashboard provides:
agent CRUD, manifest editor (model/heartbeat/evolution/quiet hours), persona + memory editors,
schedule table with cancel, snooze/wake, staged-skill review (promote/reject), run-evolution, event tail.

Chat commands: `/help` `/agents` `/agent <name>` `/newagent <name> <persona>` `/schedules` `/snooze 2h` `/wake` `/status` `/skills` `/evolve [goal]` `/evolve status|promote|reject`

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

## Roadmap

- Skill Forge pattern-mining from event/session history (from `pi-skill-evolution`)
- Multi-strategy mutation archive (compress/quality/radical, from `@artale/pi-evolve`)
- Image capability
- Stronger process-level sandboxing for agent-private extensions
## License

MIT — see [LICENSE](LICENSE).
