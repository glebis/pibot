"""Offline tests: no microphone, model calls, or live PiBot turns."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock

from pipeline import BridgeTurnError, PiBotTurnProcessor, request_turn
from pipecat.frames.frames import LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame


class ProcessorTests(unittest.IsolatedAsyncioTestCase):
    async def test_aggregated_turn_only_once_and_speech_frames(self):
        turn = AsyncMock(return_value="Done.")
        p = PiBotTurnProcessor(turn)
        p.push_frame = AsyncMock()
        messages = [{"role": "user", "content": "Hello. Second sentence."}]
        await p.accept_context(messages)
        await p._active
        await p.accept_context(messages)
        turn.assert_awaited_once()
        self.assertEqual(turn.await_args.args[0], "Hello. Second sentence.")
        self.assertEqual([type(x.args[0]) for x in p.push_frame.await_args_list],
                         [LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame])

    async def test_busy_turn_not_queued_or_replayed(self):
        gate = asyncio.Event()
        async def slow(*_):
            await gate.wait()
            return "Done"
        turn = AsyncMock(side_effect=slow)
        events = []
        p = PiBotTurnProcessor(turn, events.append)
        p.push_frame = AsyncMock()
        first = [{"role": "user", "content": "first"}]
        await p.accept_context(first)
        await asyncio.sleep(0)
        await p.accept_context(first + [{"role": "user", "content": "second"}])
        gate.set()
        await p._active
        self.assertEqual(turn.await_count, 1)
        self.assertTrue(any(e["type"] == "busy" for e in events))

    async def test_interruption_suppresses_speech_not_backend_completion(self):
        gate = asyncio.Event()
        async def slow(*_):
            await gate.wait()
            return "Done"
        p = PiBotTurnProcessor(slow)
        p.push_frame = AsyncMock()
        await p.accept_context([{"role": "user", "content": "do it"}])
        p._speech_epoch += 1
        gate.set()
        await p._active
        p.push_frame.assert_not_awaited()

    async def test_error_never_retries_or_leaks_exception(self):
        turn = AsyncMock(side_effect=RuntimeError("secret-token"))
        events = []
        p = PiBotTurnProcessor(turn, events.append)
        p.push_frame = AsyncMock()
        await p.accept_context([{"role": "user", "content": "hello"}])
        await p._active
        turn.assert_awaited_once()
        self.assertNotIn("secret-token", str(events))
        p.push_frame.assert_not_awaited()


class Response:
    status = 200
    def __init__(self, body):
        class Content:
            async def iter_chunked(self, _size):
                raw = json.dumps(body).encode()
                yield raw[:3]
                yield raw[3:]
        self.content = Content()
    async def __aenter__(self): return self
    async def __aexit__(self, *_): return False


class Client:
    def __init__(self, response): self.response, self.calls = response, []
    def post(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.response


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_single_request_with_id_and_no_redirect(self):
        client = Client(Response({"text": "Answer"}))
        self.assertEqual(await request_turn(client, "http://127.0.0.1:8789", "token", "session", "hi", "request"), "Answer")
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0][1]["json"], {"requestId": "request", "text": "hi"})
        self.assertFalse(client.calls[0][1]["allow_redirects"])
        self.assertEqual(client.calls[0][1]["timeout"].total, 45)

    async def test_bad_response_not_retried(self):
        client = Client(Response({"wrong": "secret"}))
        with self.assertRaises(BridgeTurnError):
            await request_turn(client, "http://127.0.0.1:8789", "token", "session", "hi", "request")
        self.assertEqual(len(client.calls), 1)

    async def test_external_bridge_refused(self):
        client = Client(Response({"text": "Answer"}))
        with self.assertRaises(BridgeTurnError):
            await request_turn(client, "https://example.com", "token", "session", "hi", "request")
        self.assertEqual(client.calls, [])

if __name__ == "__main__":
    unittest.main()
