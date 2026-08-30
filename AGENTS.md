# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Runtime diagnostics

- Daemon stdout/stderr: `/Users/glebkalinin/ai_projects/pibot/data/daemon.log`
- Durable model circuit-breaker and dead-letter state: `/Users/glebkalinin/ai_projects/pibot/data/cascade-state.json`
- PiBot-dev turn logs: `${PIBOT_AGENTS_DIR:-~/.local/share/pibot/agents}/pibot-dev/sessions/*.jsonl`
- PiBot-dev compact events: `${PIBOT_AGENTS_DIR:-~/.local/share/pibot/agents}/pibot-dev/state/events.jsonl`

Treat cascade, session, and event files as private: they can contain user message text. For “couldn't reach any model” incidents, correlate the daemon error category with the persisted circuit state; restarting alone does not clear persisted breakers or queued messages.

### Operational safety

- Inspect private runtime files narrowly: filter by bounded time, agent, event type, or error category. Do not print whole session, cascade, event, settings, or environment files into tool output.
- Treat queues, circuit breakers, heartbeat deduplication/fatigue state, and replay blocks as durable state. A restart is not a reset and must never be used as a substitute for diagnosis.
- Do not clear, flush, reorder, rearm, delete, or reroute queues, schedules, breakers, heartbeat state, or replay blocks unless the user explicitly authorizes that exact mutation. Ambiguous or partially delivered work stays blocked for review.
- For proactive-message incidents, establish three facts independently: the causal trigger, the content origin, and the delivery/replay route. Do not infer one from another merely because their schedules align.
- Heartbeats are silent when there is no new meaningful user-relevant information. Never add automatic replay, repeated unchanged output, or automatic avatar/profile rotation.

### Deployment and runtime health

- Commit, push, deploy, or restart only with explicit user authorization. Preserve unrelated work and stage exact paths only.
- Restart the existing launchd job at most once per authorized deployment. Afterward verify one active job with a successful exit state, one dashboard listener bound to loopback, an authentication challenge for unauthenticated dashboard access, every configured Telegram poller connected, and no immediate fatal, replay, or delivery error.
- The launchd wrapper and its runtime child may both appear in process listings; determine duplicate service instances from the launchd job, PiBot lock, listeners, and poller conflicts rather than raw process count alone.

### Agents, bots, capabilities, and providers

- Skills, capabilities, model policy, and provider allowlists belong to an agent. A Telegram bot transport binds to an agent; there is no bot-specific capability override unless the architecture explicitly adds one.
- The same agent reached through multiple bot transports exposes the same capability set. Any mutation must still target only the invoking transport. Resolve the current main-bot chat-to-agent mapping from runtime state instead of assuming the default agent.
- Live agent manifests, sessions, memories, skills, and generated artifacts are private runtime state outside Git. Preserve owner-only permissions and never copy them into the repository merely to make a commit.
- Never print decrypted settings, tokens, keys, credential values, or secret-bearing environment content. Presence/health checks must return provider and status metadata only.
- Credentials do not grant an agent provider access by themselves: provider use remains explicitly allowed by agent policy. Discovery and status checks must not make external or paid calls; external generation and profile mutations require explicit owner intent.

### Dirty worktrees and Beads

- Check `git status` before and after work. Never reset, checkout, overwrite, stage, or commit unrelated user/agent changes.
- Stage explicit files or index hunks only; never use broad staging in a dirty worktree. Report remaining staged and unstaged changes separately.
- `.beads/issues.jsonl` is a passive export and may contain reordering or other agents' updates. Use the Beads database as source of truth and, when a Git record is required, stage only the task-specific record rather than the whole unrelated export delta.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
