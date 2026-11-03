# PiBot agents for bb

A bb navigation page for PiBot's persistent agents, active model turns,
durable delegated runs, and the daemon's child-process tree. Select an agent
for text chat, bb voice dictation, or a live microphone/audio conversation.

## Install

From this directory, with Node 22+ and bb available:

```sh
npm ci --include=dev
npm run typecheck
npm test
bb plugin build
bb plugin install . --yes
```

Open **PiBot agents** in bb's navigation. The plugin targets bb >=0.48 and
Plugin SDK >=0.6.104. The installed SDK is pinned and can be checked with
`bb plugin types --check .`.

## Connect services

In **Settings → Plugins → PiBot agents**, enter the actual origin and secret
bearer token for each service. Defaults are suggestions, not discovery:

| Service | Default origin | Credential |
| --- | --- | --- |
| PiBot dashboard | `http://127.0.0.1:7860` | `PIBOT_WEB_TOKEN` |
| Canonical voice bridge | `http://127.0.0.1:8789` | `VOICE_BRIDGE_TOKEN` |
| Voice audio service | `http://127.0.0.1:8788` | voice service page/API token |

Use the existing secure credential source; never paste tokens into a bb
thread or commit them. Tokens remain server-side in bb secret settings.
Changes take effect on the next request; an existing session retains the
endpoint and credential it opened with.

The dashboard must include `src/web-bb-routes.ts` from this change. Live calls
also need the updated `voice/server.py` for session-scoped cleanup. This plugin
starts the local audio interface on an explicit **Live voice** request if
its loopback port is free. It checks readiness before requesting the microphone,
reuses an existing authenticated interface, and refuses to replace another
listener. It never starts or restarts the PiBot daemon or canonical bridge.
Local startup uses the existing Pipecat Python environment and private speech
credentials; `scripts/start-voice.sh` documents their setup. Configuration and
history checks remain passive and never contact a model provider.
`bb pibot-agents prepare-audio` runs the same startup/readiness check without
requesting the microphone or opening a model session; it returns readiness only.

Loopback URLs refer to the machine running the **bb server**. For a remote bb
server, use reachable HTTPS origins. Audio uses WebRTC with no external STUN
or TURN: browser and voice host need a direct route (local network or suitable
tailnet). Microphone access needs a secure browser context and permission.

## Workflows

- **Inspect:** the overview polls every five seconds without overlapping polls.
  A failed poll retains a clearly marked stale snapshot. Agent cards show the
  configured model, provider policy and capabilities. Durable tasks are grouped
  by their recorded agent. OS children show their real PID/PPID tree; the
  system has no general causal tree connecting every CLI process to an agent.
- **Create:** enter an ID and description. New agents are reactive (`off`) with
  no capabilities; creation does not arm schedules or provision Telegram bots.
  Set capabilities and model policy through PiBot's normal owner workflow.
- **Manage:** cancel a named active durable run. The runtime decides whether it
  is still cancellable. No arbitrary process kill, queue flush, replay, circuit
  reset, schedule mutation, or automatic restart is exposed.
- **Chat:** select an existing live canonical agent/chat binding and type directly. Type or use bb's native dictation. Transcripts remain editable;
  recording/transcription blocks Send. Agent replies return through the shared
  PiBot session. The current canonical session loads automatically for the selected
  agent/chat binding. **Load session** refreshes it; **Load earlier messages**
  pages through saved history in batches of 50 without starting a model turn.
- **Voice:** start a live call explicitly. The configured PiBot voice service
  handles speech recognition and spoken responses using its configured speech
  provider (currently Deepgram). Calls can incur that provider's costs. An
  agent with multiple canonical bindings must use text chat's explicit binding
  selection; live voice requires one unambiguous binding. Mute/stop controls
  release microphone tracks and close only this plugin's call.

Tools start disabled. **Allow tools** opts into the agent's existing allowed
capabilities, never expands them, and keeps approvals in the authenticated
PiBot chat. Text conversations do not reserve an idle session. Different agents/chats and
clients can send independently; only overlapping turns against the same
canonical session remain protected by PiBot's turn gate. Drafts and pending
requests stay with their originating agent/chat. Live audio still has one
call slot, independent of text conversations; calls expire after 15 minutes.

A timeout or disconnected response is an **unconfirmed outcome**. The plugin
never retries a mutation automatically; inspect the canonical chat before
sending the same work again. If closing a call fails, use the stop control
again or inspect the voice service; do not start a second call blindly.

## Read-only CLI

```sh
bb pibot-agents list
bb pibot-agents processes
```

Responses contain bounded metadata. They exclude session files, memories,
private task instructions/results, process arguments and credential values.
The plugin does not persist conversation transcripts.

## Development and verification

`npm test` runs backend and frontend contract tests with stubbed services.
`npm run typecheck` checks the plugin; root PiBot checks cover the added
bearer-only dashboard API. `python3 -m pytest -q voice/test_server.py` covers
the voice service and scoped cleanup. `bb plugin build` emits ignored local
artifacts in `dist/`. Use `bb plugin dev` only after installing the plugin.

These checks do not prove a live model, microphone, or Telegram round-trip.
Any deployment/restart and paid live conversation require owner authorization.

For an explicitly authorized local connection, `bb pibot-agents connect-local
/absolute/path/to/pibot` imports only the existing encrypted dashboard token
and canonical bridge token directly into bb's secret settings. It verifies
private-file ownership/permissions and uses SOPS in memory. Credentials never
appear in shell arguments or command output. It does not deploy or restart
PiBot. Audio still requires a confirmed service origin and matching credential;
the importer does not guess occupied ports or probe model providers.

Dashboard token discovery is enabled by default. When this plugin lives inside
its PiBot checkout, it finds that checkout from its installation location;
otherwise set **Local PiBot checkout** in plugin settings. It reads only the
`web.token` value from that checkout's SOPS-encrypted settings and stores it as
a bb secret. It preserves an existing token and dashboard URL, requires a
loopback dashboard origin, and never scans unrelated credential sources. Turn
off **Discover local dashboard token automatically** to use manual credentials.
A failed discovery is attempted again after changing the checkout/URL or
reloading the plugin. SOPS and the owner's age key must be available on the bb
server machine. This discovers credentials; it does not deploy new endpoints.

All connection settings are also editable **in the PiBot agents page**. Use
**Connections** to open its overlay panel. Close it with the same control, the
backdrop, or Escape. It shows the detected
checkout, has an optional advanced path override, supports blank-to-preserve
password fields and explicit token clearing, and offers **Connect local PiBot**
for the existing dashboard/chat-bridge credentials. You do not need to leave
the page or paste tokens into a chat.


The main view gives the conversation the available viewport. Connection
settings and runtime monitoring are collapsed by default after the dashboard
and chat bridge connect; optional audio setup does not keep them expanded.
Model/provider/capability metadata occupies one line.

Saved history is a bounded, read-only view of the exact session mapped in the
agent's `sessions/index.json`. It follows the persisted current branch, shows
user/assistant text, and omits tool/thinking records. Like Pi, it stops at a
missing ancestor and shows the connected branch with an earlier-history boundary
notice; it never joins disconnected entries. Duplicate IDs and cycles are
rejected. It supports existing
indexed files in that same agent's legacy checkout storage without moving or
rewriting them. Unindexed archives are never selected automatically. The UI
continues the same canonical agent/chat session when a message is sent; it does not reset the session or switch its branch. Disk history can lag
a branch change that has not yet been persisted. History is available for
local PiBot services; an advanced agent-storage override lives in the inline
connection settings. Reads are limited to 64 MiB per session file.

The selected conversation updates automatically when its exact indexed session
or index changes, including replies and session switches made through Telegram.
Only an opaque invalidation key is broadcast; history still passes the local
binding and private-file checks. Native file notifications are debounced by
50 ms, with a 500 ms exact-file metadata fallback for missed or exhausted watches.
The app also reconciles on reconnect/focus and every minute as a recovery check.
Drafts stay intact; expanded earlier pages are retained for proven continuations
and replaced when the saved session or branch changes. Updates reflect persisted
history, rather than tokens that have not yet been saved. Watchers expire after
15 idle minutes, are capped at 32 targets, and close on plugin disposal.


**Read aloud** prefers local Kokoro when the installed Pipecat Python environment
(or `PIBOT_VOICE_PYTHON` override), Kokoro module, and cached model/voice files
are available. It reuses `~/.cache/kokoro-onnx/kokoro-v1.0.onnx` and
`voices-v1.0.bin`, with local `afplay` playback. Discovery never installs packages
or downloads models. Until Kokoro is ready, the built-in macOS `/usr/bin/say`
remains the fallback. Text goes through stdin, never a shell or command-line
arguments. Temporary audio remains private and is moved through `trash` on cleanup.
**Stop reading** stops only the plugin's playback, and switching messages or
closing the page cleans it up. This feature requires bb to run on a Mac; it
does not use browser speech synthesis or a paid voice service. Long voice-call
instructions attached to saved messages appear in a collapsed disclosure.


Message bodies use a statically bundled Markdown/GFM renderer so a failed bb
lazy-loaded Markdown chunk cannot hide the conversation. Links still use bb's
`UrlLink` primitive. Raw HTML is escaped, and unsafe URL schemes are rejected.
Saved and new messages use the same renderer.


The composer is available as soon as an agent/chat is selected. Each send opens
a short-lived, text-purpose bridge connection and closes only that connection
after the reply. It does not hold a global reservation between messages. The
bridge supports up to 32 simultaneous text connections separately from its
single audio/phone connection. Text-purpose support requires the updated PiBot
bridge; the plugin refuses to silently reserve an old global audio slot.
Request IDs deduplicate in-flight and recently completed submissions, including
uncertain outcomes; no automatic send/replay retries occur.
