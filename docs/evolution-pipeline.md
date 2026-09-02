# Skill-evolution pipeline

Schema + logic description of how a proposed skill becomes live. Kept next to the
code it describes — **when you change the pipeline, change this file in the same
commit** so the schema stays a review lens, not a museum piece.

```
TRIGGERS                          THE CYCLE (src/core/evolution.ts)
──────                            ──────────────────────────────────
/evolve <goal> (owner, force) ─┐  ① COLLECT   live skills · heartbeat digest ·
                               ├─►              recent proposals · consolidated memory
heartbeat evolution job ───────┘  ② PROPOSE   cheap-model ephemeral session:
(budget 4 runs/day)                             create | patch + eval probes
                                  ③ GATES      name & structure · patch target /
goal = explicit <goal>                         create collision · probes required ·
  else top open backlog item                   stagnation (same skill ×3 → reject)
                                    │ fail ──► ⛔ REJECTED (logged, nothing staged)
                                    │ pass
                                  ④ STAGE    agents/<id>/skills/.staging/<skill>/SKILL.md
                                               (+ backlog sidecar with closable ids)
                                  ⑤ EVAL     ≤2 probes vs staged dir → judge 1–5 each
                                    │
                          avg ≥ 4 AND no risky pattern?
                            │ yes                 │ no (low scores · risky pattern)
                            ▼                     ▼
                     ✅ AUTO-PROMOTE        HUMAN REVIEW (see below)
```

## Human review — the chat navigation

- **Scheduled staging** pushes a review card to the owner chat immediately
  (`bot.ts`, `job.kind === "evolution"`).
- **`/evolve status`** scans staged candidates across **all agents** and renders
  at most **`EVOLVE_STATUS_MAX_CARDS = 10`** cards per invocation, then appends
  `…and N more staged. Work through these first, then /evolve status again.`
  — the queue drains in batches instead of flooding the chat. *(added b4659a5,
  Sep 2 2026: previously unbounded — one card per candidate per agent.)*
- Card buttons → `evo:<token>:y|n|peek` callbacks in `bot.ts`:
  - ✅ promote — same path as auto-promote (live file + `.bak` + git checkpoint
    `evolve(<id>): <skill> — <rationale>` + announcement + backlog close)
  - ✖ reject — staging dir removed
  - 📄 peek — full candidate text
- Review tokens: opaque (Telegram callback_data ≤64 bytes), 24 h TTL, dropped on
  decision → tapping a stale/handled card is a gentle no-op, never a double-apply.

## Gates (what stops a bad skill)

| Gate | Rule |
|---|---|
| Structure | name/description valid; body must have actionable structure (steps/list) |
| Patch/collision | `patch` requires the skill to exist and `find` text to match; `create` fails if it exists |
| Probes | proposal must carry eval probes |
| Stagnation | same skill proposed ≥3× in recent events → reject ("try a different improvement") |
| Risky pattern | auto-promote blocked if content matches `RISKY_PATTERNS` (exec, fetch, eval, child_process, sops, rm -rf, require/import, process.env, prompt-injection) → manual review instead |

## Code map

| File | Role |
|---|---|
| `src/core/evolution.ts` | the cycle: collect → propose → gates → stage → probes → promote/stage; review-token minting |
| `src/core/commands.ts` | `/evolve status` cards (the cap lives here), `/evolve <goal>` |
| `src/core/bot.ts` | `evo:<token>:y|n|peek` callback dispatch; scheduled stage → immediate card |
| `src/core/heartbeat.ts` | feeds the improvement backlog that goal-less cycles draw from |
| `src/core/bot.test.ts` | cap test: 10 cards max + batch note, tokens minted only for shown candidates |