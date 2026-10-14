# PiBot voice

PiBot agents can be reached by voice in three ways. They differ in which agent you talk to and in what that agent can do.

| Path | Who starts it | Agent you talk to | Tools, memory, chat history |
|---|---|---|---|
| **Browser test page** (Pipecat) | You, on this Mac | An isolated copy of the agent | None: persona and allowed model only |
| **Phone call** (Twilio) | You: `/call` in Telegram, or the operator script | The real agent session for that chat | Yes: the same session as the Telegram chat |
| **Automatic escalation call** | PiBot, under a separate call consent | The real agent session | Yes. **Currently off** |

## Telegram commands

Both commands work only in your private owner chat. Groups, including allowlisted ones, and participant chats of sub-bots are refused.

- **`/voicetest`** replies with the private link to the browser test page, with the chat's current agent preselected. The link points at `127.0.0.1`, so it only opens on this Mac. It contains the page's private key, which then stays in the chat; delete the message if you'd rather not keep it. If the page isn't running, the bot tells you how to start it.
- **`/call`** asks "Call your phone as *agent*?" with **✅ Call** and **✖ Cancel** buttons. Nothing dials until you tap ✅.
  - The confirmation can be used once, only from the chat that asked, and expires after 2 minutes.
  - On ✅ the bot re-checks that the chat still has a voice binding, then asks the phone service to ring your configured number. You answer and enter your PIN.
  - Calls last at most 3 minutes.
  - If the outcome is uncertain (for example a timeout after the request was sent), the bot shows the attempt ID and tells you **not** to repeat the call. Check the attempt first.
  - If the phone service isn't running, the bot says so and nothing is sent.

## Browser test page

The test page lets you speak with an agent's persona and permitted model in an isolated conversation. It makes no phone calls, sends no Telegram messages, runs no tools and loads no chat history or shared memory.

Start it from the project:

```sh
./scripts/start-voice.sh --speech-env-file /Users/glebkalinin/ai_projects/pipecat-mcp-server/src/pipecat_mcp_server/.env
```

The launcher reads only the speech key from that file and never prints it. Alternatively, supply `DEEPGRAM_API_KEY` through the environment and omit the option. Use `--check` for dependency, credential-presence and free-port checks without starting anything. Ctrl+C stops only the two test processes.

While it runs, the launcher writes the private page link to `data/voice/test-launch.url` (owner-only) so `/voicetest` can hand it out, and removes it on exit. A link ending in `&agent=<id>` preselects that agent.

Press **Start**, allow microphone access, and speak. **Stop** releases the microphone and closes the session. Each session is limited to 15 minutes and 20 agent turns; inactivity also ends it. Nothing reconnects or retries automatically.

Speech recognition and synthesis use Deepgram. Spoken text and the persona go to the agent's permitted model provider; the chosen model is shown on the page and pinned for the session. Replies are shortened for listening and full paths are stripped.

## Phone calls

```
Twilio ⇄ Cloudflare gateway (pibot-voice-gateway) ⇄ Tailscale Funnel :8443 ⇄ phone service (8793 control, Twilio routes)
                                                                                 ⇅
                                                         PiBot daemon voice bridge (8792) ⇄ real agent session
```

- **Outbound only, to one fixed owner number.** The phone service never accepts inbound calls or calls anyone else.
- **PIN gate.** After you answer, the call asks for your PIN before connecting you to the agent.
- **One call at a time, 3 minutes maximum.** Each Twilio call can open only one bridge session.
- **No replay.** Every attempt is recorded in a ledger (`data/voice/calls.sqlite`). An attempt whose outcome is unknown is never retried automatically.
- **The gateway forwards only Twilio routes** (`/answer`, `/authenticate`, `/status` and the media stream) and only requests carrying a Twilio signature; the phone service verifies the signature.

Besides `/call`, you can place or inspect a call from the terminal:

```sh
SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt python3 scripts/voice-call.py --secrets data/voice-service.enc.json --list
SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt python3 scripts/voice-call.py --secrets data/voice-service.enc.json --call --agent assistant
SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt python3 scripts/voice-call.py --secrets data/voice-service.enc.json --status <attempt-id>
```

An agent can take a call only if it has exactly one current private owner chat (its *voice binding*). `--list` shows which agents qualify.

## Automatic escalation calls

PiBot can also call you on its own when something urgent needs a decision. This is **off**. It turns on only when the daemon is given `PIBOT_VOICE_ESCALATION_CONFIG`, and even then each call needs a separately approved call consent. A message mandate never counts as call consent. The consent sets daily limits, a cooldown, quiet hours (Europe/Berlin) and a maximum duration, and a trusted authority must confirm the price ceiling and the provider-side duration limit before any call.

## Services, ports and files

| What | How it runs | Address |
|---|---|---|
| Voice bridge (real sessions) | Inside the PiBot daemon when `PIBOT_VOICE_CONFIG` is set (`data/voice/bridge.json`) | `127.0.0.1:8792` |
| Phone service | launchd agent `com.glebkalinin.pibot.voice` (`scripts/voice-service.py`, config `data/voice/service.json`) | `127.0.0.1:8793` control, Twilio routes via the gateway |
| Browser test page | `scripts/start-voice.sh`, on demand | `127.0.0.1:8788` (page), `127.0.0.1:8789` (isolated bridge) |
| Public gateway | Cloudflare Worker `pibot-voice-gateway` (`voice/gateway/`) | `https://pibot-voice-gateway.glebis.workers.dev` |

Secrets live in SOPS-encrypted files and are decrypted only in memory: `data/voice-service.enc.json` (Twilio, PIN, control and bridge tokens) and `data/voice-speech.enc.json` (speech key). Config and token files must be owner-only (mode 0600) and are refused otherwise. All local services bind to `127.0.0.1` and check a bearer token on every request.

The gateway's upstream address is a Worker secret, never committed. Set it with `wrangler secret put VOICE_ORIGIN` from `voice/gateway/` as `https://<machine>.<tailnet>.ts.net:8443`. The gateway refuses any other shape. Deploys read `CLOUDFLARE_ACCOUNT_ID` from the gitignored `voice/gateway/.env`.

## Safeguards

- Separate credentials for the browser page, the bridge and call control; constant-time token checks; loopback binding; Host/Origin checks; bounded request bodies.
- `/call` and `/voicetest`: owner private chat only; single-use, chat-bound, expiring call confirmation; binding re-checked before dialing.
- Browser test: provider-policy checks, isolated in-memory history, no tools, not registered in PiBot's proactive routing.
- Phone: Twilio signature check, PIN gate, fixed owner number, one session per call, hard duration cap, no automatic retry.
- No speech-provider credentials in browser code; normal logs exclude transcripts and provider error payloads.

## Verification status

- **Automated (14 October 2026):** 100 TypeScript voice tests (bridge, escalation, coordinator runtime, owner commands, runtime) and 41 Python tests (browser server, pipeline, phone service, launcher, call script) pass offline. They don't contact speech providers or Twilio.
- **Live, 14 October 2026:** on the running bot, `/voicetest` returned the page link preselected with the agent, and `/call` showed the confirmation card; tapping ✖ Cancel cancelled it, and no call was placed.
- **Not yet verified here:** a real `/call` through to a ringing phone and a spoken round trip, and a live microphone → Deepgram → agent → spoken reply round trip on the browser page. A listening port or a passing offline test doesn't prove audio delivery.

The browser transport follows [Pipecat's SmallWebRTC design](https://docs.pipecat.ai/client/concepts/choosing-a-transport), tested with Pipecat 1.0.0. It is independent of the Pipecat MCP conversation tools.
