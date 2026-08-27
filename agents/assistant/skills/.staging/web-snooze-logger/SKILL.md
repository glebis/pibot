---
name: web-snooze-logger
description: Use when any web question (feedback, toast, trace, latency, etc.) is sent and the user eventually taps—log the round-trip delay and any visible error without chatting.
---

# web-snooze-logger

Use when any web question (feedback, toast, trace, latency, etc.) is sent and the user eventually taps—log the round-trip delay and any visible error without chatting.

## Steps
1. Capture the exact send timestamp of the web question.
2. On tap event, compute milliseconds elapsed.
3. If the tap payload contains an error string, append it.
4. Append one structured line to `web-question.log`:
   `YYYY-MM-DD HH:MM:SS,zzz | delay=NNNNms | err="…"`
5. Never emit a chat reply.