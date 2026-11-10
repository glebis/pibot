---
name: pibot-agents
description: Inspect PiBot agents and delegated runs through the PiBot agents bb plugin.
---

Use `bb pibot-agents list` for agent metadata and `bb pibot-agents processes`
for a bounded snapshot. Commands are read-only and do not probe model providers.
Open PiBot agents in bb navigation for task cancellation, agent creation,
text chat, dictation, and live voice calls.

Configure service origins and their separate secret bearer tokens in plugin
settings. Dashboard and voice services must already be running; this plugin
never launches, deploys, or restarts PiBot. An unavailable service is unknown
state, not an empty roster.

Agents retain their own capabilities/provider policies. Conversations require
an existing canonical chat binding; tools are opt-in for each new session and
approvals stay in the authenticated PiBot chat. Do not guess bindings or resend
an uncertain turn. Do not put tokens or transcripts in a thread or Git.

Task cancellation targets the named durable run. It does not kill arbitrary OS
processes or reset queues, schedules, replay blocks, or circuit breakers.

`bb pibot-agents connect-local <absolute-pibot-root>` imports existing local
dashboard/bridge credentials into bb secret settings without printing them.
Use only with owner authorization to connect these services. It never starts or
restarts them and does not guess an audio endpoint.
