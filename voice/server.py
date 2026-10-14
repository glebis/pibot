"""Loopback-only, user-started Pipecat voice test. No telephone transport."""
from __future__ import annotations
import asyncio
import contextlib
import hmac
import os
import stat
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse


def private_token(file: str) -> str:
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_size > 128:
            raise ValueError("Voice credential must be a private owner file")
        token = os.read(fd, 128).decode().strip()
        if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
            raise ValueError("Invalid voice credential")
        return token
    finally:
        os.close(fd)


class VoiceSession:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.session_id = None
        self.task = None
        self.connection = None
        self.closing = False


def create_app(token: str, bridge_token: str, port: int = 8788, bridge_port: int = 8789,
               *, client=None, rtc_factory=None, pipeline=None, duration: float = 900,
               canonical: bool = False, public_origins: tuple[str, ...] = ()) -> FastAPI:
    """canonical=True talks to the bot's canonical voice bridge: turns run in the agent's
    shared Telegram session (history, tools, approvals in chat) instead of an isolated copy.
    public_origins are extra exact https origins (e.g. a tailnet-only Tailscale serve)."""
    for o in public_origins:
        if not o.startswith("https://") or "/" in o[8:] or not o[8:]:
            raise ValueError("Public voice origins must be bare https origins")
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}", *(o[8:] for o in public_origins)}
    allowed_origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}", *public_origins}
    state = VoiceSession()
    bridge = client or httpx.AsyncClient(base_url=f"http://127.0.0.1:{bridge_port}",
        headers={"authorization": f"Bearer {bridge_token}"}, timeout=httpx.Timeout(50), follow_redirects=False)
    handler = None

    async def close_session():
        if state.closing:
            return
        state.closing = True
        try:
            task, sid, connection = state.task, state.session_id, state.connection
            state.task = state.session_id = state.connection = None
            if task and task is not asyncio.current_task():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            if connection:
                with contextlib.suppress(Exception):
                    await connection.disconnect()
            if sid:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(bridge.delete(f"/voice/sessions/{sid}" if canonical else f"/v1/sessions/{sid}"), 5)
        finally:
            state.closing = False

    @asynccontextmanager
    async def lifespan(app):
        yield
        await close_session()
        if handler:
            await handler.close()
        if client is None:
            await bridge.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.voice = state

    @app.middleware("http")
    async def boundary(request, call_next):
        from fastapi.responses import JSONResponse
        host = request.headers.get("host", "")
        if host not in allowed_hosts:
            return JSONResponse({"error": "Local host required"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin not in allowed_origins:
            return JSONResponse({"error": "Local origin required"}, status_code=403)
        if request.url.path.startswith("/api/"):
            if not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}"):
                return JSONResponse({"error": "Voice session key required"}, status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Permissions-Policy"] = "microphone=(self), camera=()"
        return response

    @app.get("/")
    async def home():
        return HTMLResponse(Path(__file__).with_name("client.html").read_text())

    async def bindings() -> dict[str, str]:
        """agentId -> owner chatKey, from the bot's live voice bindings."""
        r = await bridge.get("/voice/bindings")
        r.raise_for_status()
        out: dict[str, str] = {}
        for b in r.json().get("bindings", []):
            if isinstance(b, dict) and isinstance(b.get("agentId"), str) and isinstance(b.get("chatKey"), str):
                out.setdefault(b["agentId"], b["chatKey"])
        return out

    @app.get("/api/agents")
    async def agents():
        try:
            if canonical:
                data = {"mode": "shared", "agents": [{"id": a, "name": a, "model": "shared with your Telegram chat", "available": True}
                                                       for a in sorted(await bindings())]}
            else:
                r = await bridge.get("/v1/agents")
                r.raise_for_status()
                data = {**r.json(), "mode": "isolated"}
            return {**data, "audioReady": bool(os.environ.get("DEEPGRAM_API_KEY")),
                    "speechProvider": "Deepgram"}
        except Exception:
            raise HTTPException(503, "Agent bridge unavailable") from None

    @app.post("/api/offer")
    async def offer(request: Request):
        nonlocal handler
        if not os.environ.get("DEEPGRAM_API_KEY"):
            raise HTTPException(503, "Deepgram speech credential is not configured")
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(415, "JSON required")
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 65536:
                raise HTTPException(413, "Offer too large")
        try:
            import json
            body = json.loads(raw)
            if set(body) != {"agentId", "sdp", "type"} or body["type"] != "offer" or not isinstance(body["sdp"], str) or not body["sdp"].startswith("v=0") or not isinstance(body["agentId"], str) or not 1 <= len(body["agentId"]) <= 64:
                raise ValueError()
        except Exception:
            raise HTTPException(400, "Invalid voice offer") from None
        async with state.lock:
            if state.session_id or state.closing:
                raise HTTPException(409, "A voice session is already active")
            try:
                if canonical:
                    chat_key = (await bindings()).get(body["agentId"])
                    if not chat_key:
                        raise ValueError("Agent is not bound to a voice chat")
                    response = await bridge.post("/voice/browser-sessions", json={"agentId": body["agentId"], "chatKey": chat_key})
                else:
                    response = await bridge.post("/v1/sessions", json={"agentId": body["agentId"]})
                response.raise_for_status()
                state.session_id = response.json()["sessionId"]
                if handler is None:
                    if rtc_factory:
                        handler = rtc_factory()
                    else:
                        from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequestHandler
                        handler = SmallWebRTCRequestHandler(ice_servers=[])
                if pipeline is None:
                    from pipeline import run_voice
                    runner = run_voice
                else:
                    runner = pipeline
                sid = state.session_id

                async def turn(text):
                    async with asyncio.timeout(48):
                        path = f"/voice/sessions/{sid}/turn" if canonical else f"/v1/sessions/{sid}/turn"
                        r = await bridge.post(path, json={"requestId": str(uuid4()), "text": text})
                        if canonical and r.status_code == 409:
                            error = r.json().get("error")
                            if error == "turn_detached":
                                # The shared turn keeps running; the bot delivers its answer in Telegram.
                                return "That is taking longer. I'll keep working, and the answer will arrive in your Telegram chat."
                            if error == "agent_busy":
                                return "I'm still busy with an earlier message in this chat. Give me a moment and ask again."
                        r.raise_for_status()
                        result = r.json()["text"]
                        if not isinstance(result, str) or not result.strip():
                            raise ValueError("Empty response")
                        return result

                async def connected(connection):
                    state.connection = connection
                    async def run():
                        try:
                            print("voice: session connected", flush=True)
                            async with asyncio.timeout(duration):
                                await runner(connection, turn)
                            print("voice: session ended", flush=True)
                        except asyncio.CancelledError:
                            raise
                        except Exception as error:
                            # Never log speech, provider errors, credentials or SDP — only the error class.
                            print(f"voice: session failed ({type(error).__name__})", flush=True)
                            with contextlib.suppress(Exception):
                                connection.send_app_message({"type": "status", "text": "Voice session ended. Check configuration and start again."})
                        finally:
                            await close_session()
                    state.task = asyncio.create_task(run())

                from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest
                answer = await asyncio.wait_for(handler.handle_web_request(SmallWebRTCRequest(sdp=body["sdp"], type="offer"), connected), 20)
                if not answer or state.task is None:
                    raise ValueError("Voice connection did not start")
                return answer
            except Exception as error:
                print(f"voice: offer failed ({type(error).__name__})", flush=True)
                await close_session()
                raise HTTPException(503, "Voice connection could not start") from None

    @app.delete("/api/session")
    async def stop():
        async with state.lock:
            await close_session()
        return {"closed": True}

    return app


if __name__ == "__main__":
    import uvicorn
    from loguru import logger
    # Pipecat DEBUG frames may contain private transcripts. Keep service logs quiet.
    # DEBUG DIAGNOSTIC (Oct 14): keep warnings/errors — loguru.remove() silenced even
    # provider failures, making browser-voice sessions undiagnosable. Remove this
    # override once the mic-path incident is closed.
    logger.remove()
    logger.add(lambda m: print(m, end=""), level="WARNING")
    os.umask(0o077)
    voice_port = int(os.environ.get("PIBOT_VOICE_PORT", "8788"))
    bridge_port = int(os.environ.get("PIBOT_VOICE_BRIDGE_PORT", "8789"))
    if not all(1024 <= p <= 65535 for p in (voice_port, bridge_port)) or voice_port == bridge_port:
        raise SystemExit("Invalid voice ports")
    origins = tuple(o.strip() for o in os.environ.get("PIBOT_VOICE_PUBLIC_ORIGINS", "").split(",") if o.strip())
    app = create_app(private_token(os.environ["PIBOT_VOICE_TOKEN_FILE"]), private_token(os.environ["PIBOT_VOICE_BRIDGE_TOKEN_FILE"]), voice_port, bridge_port,
                     canonical=os.environ.get("PIBOT_VOICE_BRIDGE_MODE") == "canonical", public_origins=origins)
    uvicorn.run(app, host="127.0.0.1", port=voice_port, access_log=False, log_level="warning")
