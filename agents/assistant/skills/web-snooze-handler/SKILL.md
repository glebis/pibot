---
name: web-snooze-handler
description: Use when a web snooze is detected to acknowledge it, log the delay reason, and offer a lightweight re-plan.
---

# web-snooze-handler

Use when a web snooze is detected to acknowledge it, log the delay reason, and offer a lightweight re-plan.

1. Reply in ≤1 sentence: calm, slightly wry acknowledgement.
2. If the user gave a reason, store it under `memory.snooze_reasons` as `{timestamp, reason}`.
3. Offer exactly one micro-action: “Want me to slide a 10-min catch-up into the next free slot?” (or stay silent if no reason was given).
4. Never produce a report or list.