"""Speech-only Realtime facade over a pinned canonical Hermes browser call.

The voice model never receives native tools or approval verbs. Only the existing
HermesBridge turn/receipt path can execute work; speech notes are not native turns.
"""
from __future__ import annotations

import asyncio
import hashlib


BLOCKED = ('This voice call cannot submit more work. Check the selected native Hermes session, '
           'resolve any pending input there, then end this call before starting another. '
           'No work was approved, retried or cancelled by this voice interface.')
UNKNOWN = ('The Hermes turn did not return a confirmed answer. Check the selected native Hermes session '
           'before sending more work. I have detached without cancelling or retrying it. ' + BLOCKED)


class HermesRealtimeCall:
    def __init__(self, bridge, session_id):
        self.bridge = bridge
        self.session_id = session_id
        self.blocked = False

    async def setup(self):
        return {
            'tool_choice': 'required',
            'instructions': (
                'You are a speech interface to the selected existing Hermes session, not an independent agent. '
                'Greet briefly on connection without calling tools. For each owner request, call hermes_turn '
                'once with the owner\'s request faithfully transcribed, in its original language. '
                'Do not answer substantive requests yourself or invent results. Speak the returned answer '
                'faithfully, in the owner\'s language. Native tools, decisions, approvals and clarification '
                'belong only to Hermes. Never treat spoken approval as approval of a native prompt. '
                'If busy, input-required, failed or outcome-unknown, explain the returned status and stop; '
                'never retry, replay, cancel work or claim success. The owner must inspect the native session.'
            ),
            'tools': [{
                'name': 'hermes_turn',
                'description': 'Submit one owner request to the selected canonical Hermes session, once. Never retry an uncertain outcome.',
                'parameters': {'type': 'object', 'properties': {
                    'text': {'type': 'string', 'description': 'The owner request, faithfully transcribed in its original language.'},
                }, 'required': ['text']},
            }],
        }

    async def tool(self, name, args, call_id):
        if (name != 'hermes_turn' or not isinstance(args, dict) or set(args) != {'text'}
                or not isinstance(args['text'], str) or not 0 < len(args['text'].strip()) <= 4000
                or not isinstance(call_id, str) or not 0 < len(call_id) <= 512):
            return 'Invalid Hermes voice request. No work was submitted.'
        if self.blocked:
            return BLOCKED
        request_id = 'realtime-' + hashlib.sha256((self.session_id + '\0' + call_id).encode()).hexdigest()
        # Fail closed *before* IO, including cancellation on barge-in/disconnect.
        # A new model-generated tool ID must never replay an ambiguous submission.
        self.blocked = True
        try:
            async with asyncio.timeout(48):
                response = await self.bridge.post(f'/voice/sessions/{self.session_id}/turn',
                                                  json={'requestId': request_id, 'text': args['text']})
            data = response.json()
            if response.status_code == 409:
                if data.get('error') == 'agent_busy':
                    return 'This Hermes session is busy. No new message was submitted. ' + BLOCKED
                if data.get('error') == 'hermes_input_required':
                    return 'Hermes needs your input or approval. Open the selected native Hermes session. ' + BLOCKED
                return UNKNOWN
            response.raise_for_status()
            answer = data.get('text')
            if not isinstance(answer, str) or not answer.strip():
                return UNKNOWN
            self.blocked = False
            return answer
        except asyncio.CancelledError:
            raise
        except Exception:
            return UNKNOWN

    async def note(self, role, text):
        # Realtime transcripts are shown by CallNotes on the browser data channel.
        # Do not append voice-model chatter to native history or submit it twice.
        pass
