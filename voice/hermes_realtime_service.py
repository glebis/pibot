"""Hermes-only response policy for the installed Pipecat Realtime service.

Server-VAD owner responses inherit session tool_choice=required (only hermes_turn
is exposed). Pipecat 1.0's explicit _create_response path is used for the initial
context/greeting and completed function outputs. Those responses must speak, not
call Hermes again. Never relax the session default: a barge-in must still delegate.
"""
from pipecat.services.openai.realtime import events
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService


class HermesRealtimeLLMService(OpenAIRealtimeLLMService):
    async def send_client_event(self, event):
        if isinstance(event, events.ResponseCreateEvent):
            # Response-local only; mutating session policy here would race VAD.
            response = event.response or events.ResponseProperties()
            event = event.model_copy(update={
                'response': response.model_copy(update={'tool_choice': 'none'}),
            })
        await super().send_client_event(event)
