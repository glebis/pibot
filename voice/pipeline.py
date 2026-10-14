"""Local browser audio pipeline for PiBot; no independent LLM or phone transport."""
from __future__ import annotations

import asyncio
import inspect
import os
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote, urlparse
from uuid import uuid4

import aiohttp
from pipecat.frames.frames import (
    CancelFrame, EndFrame, Frame, InterruptionFrame, LLMContextFrame,
    LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

StatusCallback = Callable[[dict[str, Any]], Any]
TurnCallback = Callable[[str, str], Awaitable[str]]


class BridgeTurnError(Exception):
    """Safe bridge failure whose message never contains provider or user data."""


async def request_turn(client: aiohttp.ClientSession, bridge_url: str,
                       bridge_token: str, session_id: str,
                       text: str, request_id: str) -> str:
    """Submit exactly once. Timeouts have unknown outcome and are never retried."""
    parsed = urlparse(bridge_url)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ("", "/")):
        raise BridgeTurnError("Invalid local bridge address")
    try:
        async with client.post(
            f"{bridge_url.rstrip('/')}/v1/sessions/{quote(session_id, safe='')}/turn",
            headers={"Authorization": f"Bearer {bridge_token}"},
            json={"requestId": request_id, "text": text},
            timeout=aiohttp.ClientTimeout(total=45), allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise BridgeTurnError("Agent turn unavailable; it was not retried")
            raw = bytearray()
            async for chunk in response.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw) > 65536:
                    raise BridgeTurnError("Agent response was too large")
            import json
            body = json.loads(raw)
            if not isinstance(body, dict) or not isinstance(body.get("text"), str):
                raise BridgeTurnError("Invalid agent response")
            result = body["text"].strip()
            if not result or len(result) > 12000:
                raise BridgeTurnError("Agent response was empty or too long")
            return result
    except asyncio.CancelledError:
        raise
    except BridgeTurnError:
        raise
    except Exception:
        raise BridgeTurnError("Agent response unavailable; outcome unknown and not retried") from None


class PiBotTurnProcessor(FrameProcessor):
    """Consume complete aggregated turns and speak the selected PiBot agent's reply.

    Barge-in silences a pending reply but never resubmits an agent action. A second
    turn while one is running is explicitly refused rather than queued invisibly.
    """

    def __init__(self, turn: TurnCallback, on_status: StatusCallback | None = None):
        super().__init__()
        self._turn = turn
        self._on_status = on_status
        self._active: asyncio.Task | None = None
        self._seen_user_count = 0
        self._speech_epoch = 0
        self._closed = False

    async def notify(self, event: dict[str, Any]) -> None:
        if self._on_status:
            try:
                result = self._on_status(event)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                pass  # Browser status failure must not replay an agent turn.

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InterruptionFrame):
            self._speech_epoch += 1
        if isinstance(frame, (CancelFrame, EndFrame)):
            self._closed = True
            if self._active:
                self._active.cancel()
        if isinstance(frame, LLMContextFrame) and direction == FrameDirection.DOWNSTREAM:
            await self.accept_context(frame.context.get_messages())
            return
        await self.push_frame(frame, direction)

    async def accept_context(self, messages: list[dict]) -> None:
        user_messages = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
        count = len(user_messages)
        if self._closed or count <= self._seen_user_count:
            return
        self._seen_user_count = count
        content = user_messages[-1].get("content")
        text = content.strip() if isinstance(content, str) else ""
        if not text or len(text) > 4000:
            await self.notify({"type": "error", "message": "Please use a shorter spoken turn."})
            return
        if self._active and not self._active.done():
            await self.notify({"type": "busy", "message": "Agent is still working. This new turn was not sent; please repeat when ready."})
            return
        request_id = str(uuid4())
        epoch = self._speech_epoch
        await self.notify({"type": "transcript", "role": "user", "text": text})
        await self.notify({"type": "status", "status": "thinking"})
        self._active = asyncio.create_task(self._answer(text, request_id, epoch))

    async def _answer(self, text: str, request_id: str, epoch: int):
        try:
            answer = await self._turn(text, request_id)
            if not isinstance(answer, str) or not answer.strip() or len(answer) > 12000:
                raise BridgeTurnError("Agent response was empty or too long")
            await self.notify({"type": "transcript", "role": "assistant", "text": answer})
            if not self._closed and epoch == self._speech_epoch:
                await self.push_frame(LLMFullResponseStartFrame())
                await self.push_frame(LLMTextFrame(answer))
                await self.push_frame(LLMFullResponseEndFrame())
        except asyncio.CancelledError:
            raise
        except Exception:
            await self.notify({"type": "error", "message": "The agent turn did not return a reply. It may still have completed; it was not retried. Check the agent before repeating an action."})
        finally:
            if not self._closed:
                await self.notify({"type": "status", "status": "listening"})

    async def cleanup(self):
        self._closed = True
        if self._active and not self._active.done():
            self._active.cancel()
            await asyncio.gather(self._active, return_exceptions=True)
        await super().cleanup()


async def run_voice(connection: Any, turn: Callable[[str], Awaitable[str]],
                    on_status: StatusCallback | None = None) -> None:
    """Run one connected voice session; caller owns bridge DELETE and total lifetime.

    Requires DEEPGRAM_API_KEY. Speech is sent to Deepgram for transcription and
    synthesis; model reasoning stays with the selected PiBot agent. No key is
    loaded implicitly from another project's environment file.
    """
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.deepgram.tts import DeepgramTTSService
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
    from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies

    key = os.environ.get("DEEPGRAM_API_KEY", "").strip()
    if not key:
        raise RuntimeError("DEEPGRAM_API_KEY is required for browser voice")
    transport = SmallWebRTCTransport(connection, TransportParams(audio_in_enabled=True, audio_out_enabled=True))
    user, assistant = LLMContextAggregatorPair(
        LLMContext(), user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.6)),
            user_turn_strategies=UserTurnStrategies(stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.6)]),
        ),
    )
    async def status(event):
        event_type = event.get("role") if event.get("type") == "transcript" else "status"
        connection.send_app_message({"type": event_type, "text": event.get("text") or event.get("message") or event.get("status", "")})
        if on_status:
            result = on_status(event)
            if inspect.isawaitable(result):
                await result

    async def invoke(text: str, _request_id: str) -> str:
        return await turn(text)
    processor = PiBotTurnProcessor(invoke, status)
    pipeline = Pipeline([
        transport.input(),
        DeepgramSTTService(api_key=key, settings=DeepgramSTTService.Settings(model="nova-3-general")),
        user, processor,
        DeepgramTTSService(api_key=key, settings=DeepgramTTSService.Settings(voice="aura-2-orion-en")),
        transport.output(), assistant,
    ])
    task = PipelineTask(pipeline, params=PipelineParams(), enable_rtvi=False, idle_timeout_secs=120)
    @transport.event_handler("on_client_connected")
    async def connected(_transport, _client):
        await processor.notify({"type": "status", "status": "listening"})
    @transport.event_handler("on_client_disconnected")
    async def disconnected(_transport, _client):
        await task.cancel()
    await PipelineRunner(handle_sigint=False, handle_sigterm=False).run(task)
