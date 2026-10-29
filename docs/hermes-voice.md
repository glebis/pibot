# Browser voice and local collaboration with live Hermes sessions

This is an **opt-in browser voice path**, not a persona copy. **Agent** mode uses
microphone → Pipecat / Deepgram STT → the selected live Hermes session’s canonical
gateway → Deepgram TTS → browser. **Realtime** uses OpenAI speech-to-speech as a
voice interface, delegating owner requests to that same canonical Hermes turn path.
Existing PiBot Telegram voice targets remain available alongside Hermes targets.
Hermes keeps its existing model, history, tools, workspace and approval policy.

## Setup

1. Use a dedicated Python environment installed from `voice/requirements.txt` and
   `voice/requirements-hermes.txt`. The latter adds `websockets>=15` (the official
   client uses the modern asyncio API and `proxy=None`) and `ruamel.yaml` (the
   official discovery helper imports it lazily). Missing adapter dependencies fail
   setup explicitly. Install into the **voice environment**, not a production
   Hermes or MCP environment. The trusted Hermes checkout must provide
   `hermes_cli.gateway_runtime`, `hermes_cli.gateway_client`, and the canonical
   `hermes-gateway-v1` protocol. See [Hermes documentation](https://hermes-agent.nousresearch.com/docs).
2. Keep the existing canonical PiBot voice bridge running and configured as for the
   normal browser voice launcher. The launcher still checks that bridge; this feature
   does not start or restart PiBot or Hermes for you.
3. Explicitly choose an owner-controlled local Hermes checkout. This imports Python
   code from that checkout; **do not point it at downloaded/untrusted code**. The
   checkout, relevant modules, and ancestors must not be writable by other users.
4. Have the desired Hermes sessions already open. Default allowed authorities are
   `~/.hermes` plus `~/.hermes/profiles/{content,ops,researcher}`. A profile allowlist
   can narrow or replace those names; arbitrary remote endpoints and profile paths
   are not accepted.

Read-only discovery (no speech connection, model submission, or gateway startup):

```sh
python scripts/hermes-voice.py --repo /Users/glebkalinin/.hermes/hermes-agent list

# Restrict discovery to named profiles:
python scripts/hermes-voice.py --repo /Users/glebkalinin/.hermes/hermes-agent \
  --profiles default,researcher list
```

Output is JSON metadata only: exact opaque target ID, profile, session ID, running
flag, counts and per-profile availability. The human-readable label uses the native
session title (bounded to 72 printable characters), source and an eight-character
ID suffix; untitled sessions show their source instead. Labels can reveal session
topics, so keep this authenticated list private. Conversation text, prompts,
results and keys remain excluded. `available: false` means discovery/attach
failed or the authority is not running; the CLI does not repair or start it.
Each profile list is bounded to 200 live, non-hidden sessions; a count of 200 may
be a capped inventory, not proof that only 200 sessions exist. Stored-only sessions
are not listed. A running authority with no live sessions correctly reports zero.

Start the existing browser launcher **only when ready to make a call**:

```sh
./scripts/start-voice.sh \
  --hermes-repo /Users/glebkalinin/.hermes/hermes-agent \
  --hermes-profiles default,content,ops,researcher \
  --speech-env-file /absolute/path/to/private/speech.env
```

Equivalent opt-in environment variables are `PIBOT_HERMES_REPO` and
`PIBOT_HERMES_PROFILES`. They are inherited by the existing audio-process launcher.
No opt-in means the original PiBot behavior. `--isolated` is incompatible with
Hermes. `--check` validates launcher dependencies/configuration/ports without
starting services; use the discovery CLI separately to verify live Hermes access.
The existing launcher still requires its canonical PiBot bridge and speech key.
Do not run it against occupied production voice ports: it refuses rather than
replacing any process.

Open the private launch link using the existing `/voice` flow. The authenticated
`/api/agents` list includes entries named `Hermes · <profile> · <source> — <title> · <short ID>`.
Untitled sessions omit the title; long technical IDs are retained internally for
exact selection and routing, not shown as the label. This does not rename native sessions.
Choose the **exact session**, not merely a profile. Refresh the list if sessions
have changed. Selecting Hermes offers **Agent** and, when `OPENAI_API_KEY` is
configured, **Realtime**; Fast and the per-call tool picker stay hidden. Agent
remains the default for Hermes and requires `DEEPGRAM_API_KEY`. Realtime requires
`OPENAI_API_KEY`, not Deepgram; the existing launcher may still require the
Deepgram key at startup for its other voice modes. The page identifies the audio
provider and explains that tool policy is native. Starting connects
speech; speaking submits real work and can incur provider/tool costs. Stop detaches
this viewer. Calls retain the existing 15-minute browser cap.

## Local collaboration CLI

`list` is always read-only. `send` is a separate explicit action: it reads message
text from stdin (not argv/process listings), requires a freshly discoverable exact
target and `--confirm-submit`, and can run real paid models and tools. Example,
**only when the owner intends to submit work**:

```sh
# Replace the target and request identity deliberately. This is NOT a health check.
python scripts/hermes-voice.py --repo /Users/glebkalinin/.hermes/hermes-agent send \
  --target hermes-<exact-target-from-list> \
  --request-id <unique-stable-request-identity> --confirm-submit < private-message.txt
```

Only target/request/admission/status metadata is printed, never the model reply.
The CLI exits 0 for confirmed completion, 3 for busy/input-required/detached/failed,
2 for setup/request errors, or 130 on user interruption. Inspect the native Hermes
session for the actual answer. Keep the request identity for reconciliation; do
not invent a fresh identity and resend after an ambiguous result. No delivery,
model execution or approval is performed by the `list` smoke test.

## Ownership and failure semantics

- Discovery uses the official same-user private control-socket validation and
  home-specific ticket bootstrap. No token files are scraped and no global
  `HERMES_HOME` changes are made. Attach uses the official gateway client over
  canonical WebSocket RPC, never the API-owned-session-only REST surface.
- An Agent speech utterance’s `requestId` is passed unchanged as canonical `submission_id`.
  The browser adapter never automatically reconnects/resubmits an ambiguous turn.
  Repeated request IDs in the same call return the cached outcome, not a second
  submission. Canonical Hermes handles stable admission identities across viewers.
- Realtime uses the existing Pipecat `run_realtime` audio transport but **not** the
  Pi front. A `HermesRealtimeCall` facade exposes only `hermes_turn(text)` to the
  speech model, never native tools or approval/cancel verbs. It pins the exact
  browser-call ID created in Agent bridge mode. The native turn/receipt logic is
  unchanged. Each provider tool-call ID is deterministically hashed with the
  browser-call ID into a valid stable native submission identity; redelivery of
  the same ID cannot submit twice. Separate calls have separate identities.
  Busy, native input required, failure, timeout, transport ambiguity or interruption
  while awaiting a native answer blocks further submissions from that voice call,
  including a model-generated retry with a new tool ID. Inspect Hermes, resolve
  pending input there and end the call before deliberately starting another.
- Hermes Realtime enforces delegation on the wire: automatic server-VAD owner
  responses inherit `tool_choice=required` with only `hermes_turn` exposed.
  A Hermes-only Pipecat service adapter gives explicit greeting and completed-tool
  response creation a **response-local** `tool_choice=none`, permitting speech
  without recursively delegating the tool result. The session default never
  changes, including during barge-in. Pi Realtime retains its original service
  and automatic tool policy. This adapter depends on Pipecat 1.0's explicit
  response paths (initial context and completed tool results); recheck the wire
  tests before upgrading Pipecat or adding new explicit response paths.
- Realtime instructions require faithful transcription in the owner's original
  language and faithful voicing of native answers; the speech model is not the
  authority for substantive answers or actions. The tool requirement is enforced
  by API policy, not stronger prompting; transcription and answer rendering still
  depend on the speech model. OpenAI processes the audio, transcribed request and returned
  Hermes answer. Browser speech transcripts stay on the existing page data channel;
  the facade does not append speech-model chatter or duplicate utterances to native
  history. There are no Pi instructions/tool/note endpoints, task announcements or
  Telegram delivery promises for Hermes Realtime.
- Before submitting, the adapter subscribes with `session.resume(omit_messages=True)`.
  Already-busy or pending-input sessions are refused without a new submission.
  Another viewer can race the preflight: canonical Hermes may admit/queue that
  input. This adapter does not flush, reorder, cancel, or replay that queue.
- It correlates terminal completion with the returned admission ID and checks the
  canonical receipt’s outcome. Other viewers’ replies and tool streams are not
  spoken. Failed/interrupted/unknown turns are not presented as successful answers.
- Approvals and clarification remain **only in native Hermes**. This page never
  calls approval/clarify response verbs, enables unattended/YOLO mode, or changes
  the session’s tool policy. Answer the native prompt in Hermes. Pending native
  input produces a spoken instruction to open that session, without exposing the
  private command/question. Native session policy may itself already allow tools;
  browser voice does not make it safer or more restricted.
- Waiting is bounded (42 seconds at the adapter; 48 seconds at the browser server).
  On timeout, transport loss, cancellation or hangup the viewer detaches without
  `prompt.cancel`, `session.interrupt`, or terminating the authority. Accepted work
  can continue. Check Hermes before sending further work. No Telegram delivery is
  promised for Hermes replies. Known admission IDs are retained in CLI metadata.
- The server rejects `tools` / `allowedTools`, front and unsupported
  session/tool operations for Hermes. It cannot enforce PiBot call-scoped tool
  restrictions on a native Hermes session. PiBot task lists/cancellation are not
  mapped to Hermes work. Realtime is an audio-layer choice; the Hermes bridge
  itself still accepts only native Agent-mode session creation, never Pi front
  mode or direct voice-model tool execution.
- The existing bearer key, exact Host/Origin checks, loopback binding, no-store
  responses and private launcher links remain the access boundary. Anyone holding
  the page key and network access can invoke the selected native session: treat
  that link as an execution credential. Keep it private.

## Browser versus telephone calls

This change **does not connect Hermes to Twilio, make telephone calls, or change
production phone routing**. The existing `voice/phone_server.py` is a separate
call-bound, isolated bridge path, not this canonical browser path. Selecting a
Hermes browser target does not make it callable by phone.

`HermesBridge` exposes a reusable HTTP-client-compatible seam (`get`, `post`,
`delete`, `aclose`) with canonical binding/create/turn/detach routes. A future phone
transport can reuse it, but must explicitly bind an owner-approved call to an exact
session, retain Twilio signature/account/call checks, and preserve the same native
approval and ambiguous-outcome rules. No standalone unauthenticated HTTP adapter
service is exposed here.

## Verification scope

```sh
python -m pytest voice -q
node --test voice/test-client.mjs
npm run typecheck
npx vitest run src/voice/runtime.test.ts src/voice/owner-commands.test.ts src/voice/agent-bridge.test.ts
```

The Hermes protocol/HTTP/Pipecat callback tests use fake gateway and RTC transports;
they exercise offer → pipeline turn → canonical RPC → receipt → answer plus busy,
approval, failure, timeout, detach, identity correlation and policy rejection.
Realtime tests also construct the production pipeline with real provider schemas
and dispatch its tool/result callback offline, replacing audio transport, turn
aggregators and pipeline execution. They verify replay blocking, native receipt
correlation, timeout/barge-in/hangup detach and browser mode/provider selection.
They are **not live model/speech proof**. The live discovery CLI is a separate
read-only proof of actual private socket/ticket/WebSocket/session-list access.
No paid generation, microphone call, or telephone call is needed for these checks.
