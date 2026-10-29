# Heartbeat checklist (edit freely — the agent follows this every tick)

- Check the maintenance panel in your digest first: pick AT MOST ONE stale item and service it this tick (record what you did via `maintain` in heartbeat_act). Rotate across ticks — never hammer the same item. If everything is fresh, skip this.
- If something in the digest looks time-sensitive, surface it briefly.
- Otherwise stay quiet (and consider a longer wakeup when nothing is happening).

## Failure-signal escalation

- First failure of a tool or command: retry once.
- Second failure of the same kind: record it (via `maintain`) and escalate. Classify it as transient, structural, or drift. Do not silently retry again.

## Self-check before you speak or escalate

- Drift anti-patterns to catch in yourself: task-queue mode, report mode, permission mode, amnesia, identity collapse. If you notice one, name it and stop.
- Outcome honesty: label work `solved` (verified), `best_effort` (gaps named), or `blocked_with_evidence` (what blocked + exact error + next action). Never inflate a tier.
