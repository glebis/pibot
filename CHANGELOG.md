# Changelog

Notable changes to pibot. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
dates are local. Entries here describe what shipped and what it costs the owner,
not just what the commit touched.

## 2026-09-26

### Added

- **`/goal` — a bounded autonomy loop for multi-turn work.** Set an objective
  (`/goal <objective>`) or have a model expand it into an evidence-based
  completion contract (`/goal draft <objective>`: outcome / verification /
  constraints / boundaries / stop_when). Each turn carries a compact `[goal]`
  block; after the turn a judge returns `done` | `continue` | `wait`, and
  `continue` re-prompts for the next step. `/goal status`, `/goal sub <criterion>`,
  `/goal max <n>`, `/goal pause|resume|done|clear` manage it. State is per chat and
  survives restarts.
  Bounds are part of the design: 8 turns by default (max 50), auto-pause after three
  unreadable judge replies, no stacked auto-turns, a deferral while snoozed, never
  during scheduler/heartbeat/handoff traffic, and a newer message from the owner
  *steers* (their turn is the next step) rather than killing the loop.
- **Jev as an optional, configurable goal judge.** Default local. An agent opts in
  with `goal: { judge: "jev", dataScope: "redacted_approved", providers: ["typesafe-ai"] }`
  and the daemon must also allow it — `PIBOT_GOAL_JUDGE=off|shadow|jev`. Jev answers
  three typed questions (verdict, "is the contract's verification visible in the
  reply", "is progress externally blocked"), a `done` without visible verification is
  downgraded to `continue`, and a `done` below 0.6 confidence is refused as a verdict.
  Every failure is typed, logged with its cause, and falls back to the local judge.
- **`PIBOT_GOAL_JUDGE=shadow`.** Measures Jev against the local judge without letting
  it act: local stays authoritative and each judged turn logs one comparison line
  (`local=done jev=continue agreement=no confidence=0.88`). First two live
  comparisons: 1 agreement, 1 disagreement, and on inspection the local judge was
  right (Jev read "report the suite's status" as "make it pass") — which is exactly
  why this mode exists before trust.

### Fixed

- **`/goal` was invisible** in `/help` and the Telegram command menu while `/minimal`
  had made it into both.
- **A judged continuation that threw stalled the goal silently** — no judge, no
  notice, and a log line claiming the prompt "will re-fire" when nothing re-fires a
  goal turn. It now parks loudly: status paused, an event with the error, and an
  owner-visible `/goal resume` prompt.
- **An environment-dependent test** (`goal-jev.test.ts`) asserted `missing_key` by
  reading the ambient `AI_GATEWAY_API_KEY`, so it passed in a shell and failed inside
  the daemon, which injects that key from the encrypted store. Found by the agent
  itself while running the suite under a `/goal`; the assertion now injects the
  absence explicitly. Same class as `pibot-z95.5`.

## 2026-09-25

### Added

- **Minimal voice communication (`/minimal`).** A per-chat mode for replies meant to
  be listened to: a prompt-side directive for speakable output plus a deterministic
  filter (URLs, code, markdown, hashes, emoji, provider specs, path prefixes), a cap
  of 4 sentences / 400 characters on *spoken* output only, operational notices exempt,
  and never an empty reply. Styling happens before synthesis, so the audio itself is
  minimal. Per-agent default `speech.minimal`, `/minimal on|off|default` per chat.
- **Advisory Jev shadow observer for skill evolution** (`pibot-n13`): a bounded,
  redacted snapshot at the probe/judge boundary, default off, dry-run by default, and
  provably unable to change scores, staging, promotion, announcements, or backlog
  closure. Plus a pure replay harness (independence and provenance checks, blinded
  A/B, false-pass/false-review verdicts) and the epic's spec + plan.
- **Encrypted homes for the remaining credentials**: the live-test harness's
  `telegram-test.env` became `telegram-test.enc.json` (sops/age, with the plaintext
  file removed only after a verified ciphertext round-trip), and the dashboard token
  moved from the launchd plist into `settings.enc.json`. Persisting a credential when
  sops is unavailable now fails instead of writing plaintext.
- **Programmatic agent creation** (owner API + CLI).
- `urlsUnder` URL-prefix rule in the exec allowlist; read-only GitHub fetches via
  host-pinned `curl` + `gh repo view|api repos`.

### Security

- **Credentials are redacted at the console boundary.** `daemon.log` *is* the
  daemon's stdout/stderr, and grammy/node-fetch error objects carry request URLs in
  their stack text — 7 plaintext bot tokens had accumulated, two of them recoverable.
  One shared scrubber now serves both the console and the event log (PEM blocks,
  Telegram tokens with the bot id kept, `sk-`/`AIza`/`xox`/GitHub/AWS prefixes, JWTs,
  assignment and Bearer forms), rendering through `util.format` so nested object
  fields and stacks are covered. Existing leaked lines were masked in place,
  length-preserving, so the running daemon's append fd stayed valid.
- **Agent runtime state is owner-only.** A process-wide `umask 077` plus a boot-time
  repair, after 346 world-readable paths were found under `agentsDir` (session
  transcripts, memory notes, staged skills) — `hardenRuntimeDataDir` had only ever
  covered `dataDir`.
- **Pending rotation**: the two sub-bot tokens and the dashboard token above are
  masked on disk but were exposed in plaintext for ~10 days; `pibot-z8w` tracks
  rotation, which encryption cannot substitute for.

### Fixed

- **An explicit path request survives minimal mode.** The directive promised "full
  path when asked" while the filter shortened every path unconditionally; found by
  live-testing the mode against the real bot.
- Markdown links (`[text](https://…)`) in bot replies render as anchors.
- Telegram: managed-token API takes a scalar `user_id`; sub-bot wiring falls back to
  `replaceManagedBotToken` during propagation lag; managed-bot generation surfaced.
- Heartbeat: valueless status-report speaks suppressed; 24h rotation floor on
  maintenance-panel freshness.
- Cascade: skip unavailable models and walk the full chain.

## 2026-09-18

### Added

- **Silent-turn notices.** A turn can succeed while its terminal message carries no
  text block (the model ends on reasoning only); the owner's chat then stayed silent
  with no error, no dead letter, and no log line. It now logs a `silent turn` event
  and says plainly that the turn produced nothing.

### Fixed

- **Crossed HTML entities no longer cost a message.** `toTelegramHtml` ran three
  sequential regex passes, so overlapping delimiters crossed tags and Telegram
  rejected the whole reply with `400 can't parse entities: Unmatched end tag at byte
  offset 604`. It is now a single stack-disciplined pass (crossed tags are
  impossible), with a plain-text resend when Telegram still rejects the markup.
- **Outbound replies survive network flaps**: pre-connection failures
  (ENOTFOUND/EAI_AGAIN/ECONNREFUSED/host-unreachable) retry twice with backoff, while
  ambiguous failures stay un-retried so a duplicate reply is never risked.
- **The 👀→👍 reaction no longer lies**: it settles after a successful send and
  downgrades to 👎 when the send fails.
- **The duplicate backstop keys on turn identity, not reply text**, so two identical
  answers to two different messages both arrive while an accidental double-fire of the
  same turn is still suppressed.
- **A failed reply attachment is surfaced** (event + owner notice) instead of only
  reaching the console.
