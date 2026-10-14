"""One explicitly bound Twilio call into the isolated PiBot voice bridge."""
from __future__ import annotations
import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import os
import re
import stat
from dataclasses import dataclass
from urllib.parse import urlparse, quote
from uuid import uuid4
import aiohttp
from fastapi import FastAPI, WebSocket

SID = re.compile(r"^[A-Z]{2}[0-9a-fA-F]{32}$")


def private_value(path: str, prefix: str | None = None) -> str:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 256:
            raise ValueError("Private owner file required")
        value = os.read(fd, 256).decode().strip()
        if prefix and (not SID.fullmatch(value) or not value.startswith(prefix)):
            raise ValueError("Invalid call binding")
        if not prefix and (len(value) != 64 or not re.fullmatch(r"[0-9a-f]{64}", value)):
            raise ValueError("Invalid bridge credential")
        return value
    finally:
        os.close(fd)


@dataclass(frozen=True)
class PhoneConfig:
    public_url: str
    auth_token: str
    account_sid: str
    call_sid_file: str
    agent_id: str
    bridge_token: str
    bridge_url: str = "http://127.0.0.1:8789"
    duration: float = 180

    def __post_init__(self):
        parsed = urlparse(self.public_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise ValueError("PHONE_PUBLIC_URL must be an HTTPS origin")
        if not self.auth_token or not re.fullmatch(r"AC[0-9a-fA-F]{32}", self.account_sid):
            raise ValueError("Twilio account credentials required")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", self.agent_id) or not 0 < self.duration <= 180:
            raise ValueError("Invalid bounded phone configuration")
        bridge = urlparse(self.bridge_url)
        if bridge.scheme != "http" or bridge.hostname != "127.0.0.1" or bridge.path or bridge.query or bridge.fragment or bridge.username:
            raise ValueError("Loopback bridge required")

    @property
    def websocket_signature_url(self):
        return self.public_url.rstrip("/") + "/ws"


def diagnostic(event: str, error: Exception | None = None):
    # Static lifecycle labels and exception class only; never values or content.
    suffix = " " + type(error).__name__ if error is not None else ""
    print("phone_voice " + event + suffix, flush=True)


def valid_signature(config: PhoneConfig, supplied: str) -> bool:
    # Twilio documents a possible trailing slash on WSS signatures. Restrict
    # compatibility to this exact configured origin/path, never request headers.
    # https://www.twilio.com/docs/usage/security
    url = config.websocket_signature_url
    candidates = (url, url + "/", "wss" + url[5:], "wss" + url[5:] + "/")
    matched = False
    for candidate in candidates:
        expected = base64.b64encode(hmac.new(config.auth_token.encode(), candidate.encode(), hashlib.sha1).digest()).decode()
        matched = hmac.compare_digest(expected, supplied) or matched
    return matched


def validate_start(frame: dict, config: PhoneConfig) -> tuple[str, str]:
    start = frame.get("start", {})
    stream = start.get("streamSid")
    call = start.get("callSid")
    if (frame.get("event") != "start" or not isinstance(stream, str)
            or not re.fullmatch(r"MZ[0-9a-fA-F]{32}", stream)
            or frame.get("streamSid") != stream
            or start.get("accountSid") != config.account_sid
            or call != private_value(config.call_sid_file, "CA")
            or start.get("mediaFormat") != {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1}):
        raise ValueError("Unapproved media stream")
    return stream, call


async def handshake(websocket: WebSocket, config: PhoneConfig) -> tuple[str, str]:
    async def frame():
        raw = await websocket.receive_text()
        if len(raw.encode()) > 8192:
            raise ValueError("Handshake too large")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Invalid handshake")
        return value
    async with asyncio.timeout(10):
        connected = await frame()
        if connected.get("event") != "connected" or connected.get("protocol") != "Call" or connected.get("version") != "1.0.0":
            raise ValueError("Invalid media protocol")
        return validate_start(await frame(), config)


async def run_phone(websocket, stream_sid, call_sid, config, turn, *, greeting=None):
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams
    from pipecat.frames.frames import TTSSpeakFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.deepgram.tts import DeepgramTTSService
    from pipecat.serializers.twilio import TwilioFrameSerializer
    from pipecat.transports.websocket.fastapi import FastAPIWebsocketTransport, FastAPIWebsocketParams
    from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies
    from pipeline import PiBotTurnProcessor
    from bounded_speech import BoundedSTT, BoundedTTS, SpeechBudget
    key = os.environ.get("DEEPGRAM_API_KEY", "")
    if not key:
        raise ValueError("Speech credential unavailable")
    serializer = TwilioFrameSerializer(stream_sid=stream_sid, call_sid=call_sid,
        account_sid=config.account_sid, auth_token=config.auth_token,
        params=TwilioFrameSerializer.InputParams(auto_hang_up=True))
    transport = FastAPIWebsocketTransport(websocket, FastAPIWebsocketParams(
        audio_in_enabled=True, audio_out_enabled=True, add_wav_header=False, serializer=serializer))
    user, assistant = LLMContextAggregatorPair(LLMContext(), user_params=LLMUserAggregatorParams(
        vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.6)),
        user_turn_strategies=UserTurnStrategies(stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.6)])))
    async def invoke(text, _request_id):
        return await turn(text)
    async def spoken_status(event):
        if event.get("type") in ("error", "busy"):
            message = ("The agent is still working. Please wait before speaking again." if event["type"] == "busy"
                       else "The agent did not return a reply. An action may still have completed. Please check your messages before repeating it.")
            await task.queue_frames([TTSSpeakFrame(message)])
    processor = PiBotTurnProcessor(invoke, spoken_status)
    budget = SpeechBudget(config.duration)
    task = PipelineTask(Pipeline([transport.input(),
        BoundedSTT(budget=budget, api_key=key, settings=DeepgramSTTService.Settings(model="nova-3-general")),
        user, processor,
        BoundedTTS(budget=budget, api_key=key, settings=DeepgramTTSService.Settings(voice="aura-2-orion-en")),
        transport.output(), assistant]), params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=8000),
        enable_rtvi=False, idle_timeout_secs=60)
    @transport.event_handler("on_client_connected")
    async def connected(_transport, _websocket):
        await task.queue_frames([TTSSpeakFrame(greeting or "Hello, this is your PiBot voice test. We have up to three minutes. What would you like to discuss?")])
    @transport.event_handler("on_client_disconnected")
    async def disconnected(_transport, _websocket):
        await task.cancel()
    await PipelineRunner(handle_sigint=False, handle_sigterm=False).run(task)


class PhoneBridge:
    def __init__(self, config): self.config = config
    async def create(self):
        async with aiohttp.ClientSession() as client:
            async with client.post(self.config.bridge_url + "/v1/sessions", json={"agentId": self.config.agent_id},
                headers={"Authorization": "Bearer " + self.config.bridge_token}, timeout=aiohttp.ClientTimeout(total=10), allow_redirects=False) as response:
                if response.status != 200: raise ValueError("Bridge unavailable")
                raw = bytearray()
                async for chunk in response.content.iter_chunked(4096):
                    raw.extend(chunk)
                    if len(raw) > 4096: raise ValueError("Invalid bridge response")
                sid = json.loads(raw).get("sessionId")
                if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sid): raise ValueError("Invalid session")
                return sid
    async def turn(self, sid, text):
        from pipeline import request_turn
        async with aiohttp.ClientSession() as client:
            return await request_turn(client, self.config.bridge_url, self.config.bridge_token, sid, text, str(uuid4()))
    async def close(self, sid):
        async with aiohttp.ClientSession() as client:
            async with client.delete(self.config.bridge_url + "/v1/sessions/" + quote(sid, safe=""),
                headers={"Authorization": "Bearer " + self.config.bridge_token}, timeout=aiohttp.ClientTimeout(total=5), allow_redirects=False) as response:
                if response.status != 200: raise ValueError("Bridge cleanup failed")


def create_app(config: PhoneConfig, *, bridge=None, runner=run_phone):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    bridge = bridge or PhoneBridge(config)
    lock = asyncio.Lock()
    used = False
    @app.get("/health")
    async def health(): return {"ok": True}
    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        nonlocal used
        if websocket.url.query or not valid_signature(config, websocket.headers.get("x-twilio-signature", "")):
            diagnostic("signature_rejected")
            await websocket.close(code=1008)
            return
        if lock.locked():
            await websocket.close(code=1008)
            return
        async with lock:
            if used:
                await websocket.close(code=1008)
                return
            await websocket.accept()
            sid = None
            bound = False
            try:
                stream_sid, call_sid = await handshake(websocket, config)
                bound = True
                diagnostic("stream_bound")
                used = True
                async with asyncio.timeout(config.duration):
                    sid = await bridge.create()
                    async def turn(text):
                        answer = await bridge.turn(sid, text)
                        diagnostic("model_reply_received")
                        return answer
                    diagnostic("pipeline_started")
                    await runner(websocket, stream_sid, call_sid, config, turn)
                    diagnostic("pipeline_stopped")
            except Exception as error:
                diagnostic("pipeline_error" if bound else "handshake_rejected", error)
            finally:
                with contextlib.suppress(Exception):
                    await websocket.close(code=1000)
                if sid:
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(bridge.close(sid), 6)
    return app


if __name__ == "__main__":
    import uvicorn
    from loguru import logger
    logger.remove()
    os.umask(0o077)
    config = PhoneConfig(public_url=os.environ["PHONE_PUBLIC_URL"], auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        account_sid=os.environ["TWILIO_ACCOUNT_SID"], call_sid_file=os.environ["PHONE_CALL_SID_FILE"],
        agent_id=os.environ["PHONE_AGENT_ID"], bridge_token=private_value(os.environ["BRIDGE_TOKEN_FILE"]),
        bridge_url=os.environ.get("BRIDGE_URL", "http://127.0.0.1:8789"))
    if not os.environ.get("DEEPGRAM_API_KEY"): raise SystemExit("Speech credential required")
    uvicorn.run(create_app(config), host="127.0.0.1", port=8790, access_log=False, log_level="warning", ws_max_size=16384)
