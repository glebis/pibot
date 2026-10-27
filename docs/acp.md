# Agent Client Protocol (ACP)

pibot speaks ACP on **both** sides of the wire — it can drive an external ACP
agent, and it can serve its own agents to an ACP client.

[ACP](https://agentclientprotocol.com) is how editors (Zed, …) launch and drive
coding agents: JSON-RPC 2.0 over stdio, **one message per line** (newline
delimited, UTF-8, no embedded newlines). The stable wire version is `1`.

```
src/acp/
  protocol.ts   ACP v1 wire types + NDJSON framing (shared by both sides)
  client.ts     drive an external ACP agent (initialize/newSession/prompt)
  server.ts     ACP server: initialize / session/new / prompt / cancel / set_mode
  agent.ts      bridge ACP sessions to pibot agent sessions (event → session/update)
  main.ts       stdio entry point: pibot AS an ACP agent
src/plugins/
  acp-plugin.ts the `acp_run` capability an agent calls
```

## 1. pibot as an ACP client (`acp_run`)

The `acp` capability lets a pibot agent hand one self-contained coding task to
an external ACP agent and get the answer back — the ACP counterpart of
`delegate_cli` / `herdr`. The default target is **`cmd acp`** (Command Code).

```json
{ "capabilities": ["scheduler", "memory", "exec", "acp"] }
```

The tool:

- spawns the agent as a subprocess with an **allowlisted environment**
  (`child-env.ts`) — no decrypted secrets leak into it;
- performs `initialize`, then `session/new` with the resolved workspace as cwd;
- **answers the agent's callbacks** while it works:
  - `session/request_permission` → selects `allow_once` (or `reject_once` with
    `permission: "reject"`; per-run override via the tool's `permission` param);
  - `fs/read_text_file` / `fs/write_text_file` → served, **confined to the
    workspace root** (a request for a path outside it is refused);
  - we advertise **no** terminal capability, so the agent falls back to its own;
- streams the `session/update` notifications and returns the agent's final text
  plus a compact list of the tool calls it made;
- always disposes the subprocess (SIGTERM, then SIGKILL) — including when the
  run fails or times out.

`cwd` is confined exactly like `delegate_cli` (`resolveDelegateCwd`): it must
resolve inside the agent workspace.

### Which agents can be driven

`ACP_AGENTS` in `src/acp/client.ts` is the registry. Today it holds one entry:

| name  | command     | label         |
| ----- | ----------- | ------------- |
| `cmd` | `cmd acp`   | Command Code  |

The capability is offered only when the binary actually resolves on `PATH`.
Adding another ACP agent is one line in the registry.

## 2. pibot as an ACP agent (server)

Any ACP client can spawn pibot and chat with one of its agents:

```bash
npm run acp                      # or: npx tsx src/acp/main.ts
PIBOT_ACP_AGENT=assistant npm run acp
```

`PIBOT_ACP_AGENT` selects which pibot agent is served (defaults to
`PIBOT_DEFAULT_AGENT`, else the first discovered agent). Point Zed's ACP agent
config at that command.

The server implements `initialize`, `authenticate`, `session/new`,
`session/prompt`, `session/cancel`, and `session/set_mode`. Each ACP session
maps to **one pibot chat session** (`<agentId>::acp-<sessionId>`), so an editor
session is a normal, persistent pibot conversation. The SDK's streaming events
are translated into ACP notifications:

| SDK event                                        | ACP session/update      |
| ------------------------------------------------ | ----------------------- |
| `message_update` → `text_delta`                   | `agent_message_chunk`   |
| `message_update` → `thinking_delta`               | `agent_thought_chunk`   |
| `tool_execution_start`                            | `tool_call`             |
| `tool_execution_end`                              | `tool_call_update`      |

A turn that ends without any streamed text (a non-streaming model, or a turn
that ends on a tool call) sends the final assistant text once, so the client is
never left blank. `session/cancel` aborts the running pibot turn and answers
with `stopReason: "cancelled"`.

> **stdout is the protocol.** `main.ts` forces every `console.log/info/debug/trace`
> onto stderr — a stray line on stdout would be parsed as a broken ACP message.

Notes / limits:

- `loadSession` is **false** — history replay on `session/load` is not
  implemented, so a client must not call it (it answers method-not-found).
- The ACP session's `cwd` is recorded and logged but does **not** override the
  agent's workspace: pibot agents stay pinned to their own directory (or the
  repo, for a `workspace: "repo"` agent). Agent isolation is deliberate.
- The server process owns its own agent sessions and a throwaway scheduler
  (`<dataDir>/acp`), separate from the running daemon. Run it on the same
  machine as the daemon for the same agents, but expect independent sessions.

## 3. Testing

Unit + integration tests (deterministic, run in CI):

```bash
npx vitest run src/acp src/plugins/acp-plugin.test.ts
```

They cover the framing (including multi-byte splits), the server's request
routing, cancellation and error paths, the event→`session/update` mapping, and
the client **driven against a real subprocess** (`node` acting as a minimal ACP
agent) for permission requests, confined fs reads/writes and cancellation.

Live smoke against the real binary — the acceptance check:

```bash
npm run test:acp                                   # drives `cmd acp` in cwd
npx tsx scripts/acp-smoke.mts "Summarize README.md" --cwd ~/some/repo
npx tsx scripts/acp-smoke.mts --server             # verify pibot's own ACP server
```

`--permission reject` flips the client's answer to permission requests;
`--timeout` caps the turn. Exit code is `0` only when the turn completed.
