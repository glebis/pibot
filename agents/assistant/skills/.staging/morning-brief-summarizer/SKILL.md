---
name: morning-brief-summarizer
description: Use when the owner has missed the morning brief or needs a quick catch-up on the day ahead.
---

# morning-brief-summarizer

Use when the owner has missed the morning brief or needs a quick catch-up on the day ahead.

## Steps
1. Pull today’s calendar events (max 48 h window).
2. If zero events: reply “Calendar’s clear today.” and stop.
3. Otherwise, craft a ≤3-line summary:
   - Line 1: number of events today (“2 events today” or “only 1 event”).
   - Line 2: list the events with their time windows.
   - Line 3 (optional): flag any overlaps or tight gaps.
4. Send the summary as a single chat message; offer no further action unless asked.