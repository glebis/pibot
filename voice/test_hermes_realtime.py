"""Realtime speech facade tests; fake native authority, never speech/model calls."""
import asyncio

import pytest

from hermes_bridge import HermesBridge
from hermes_realtime import HermesRealtimeCall
from test_hermes_bridge import Fallback, RPC, Transport, create


@pytest.mark.parametrize('rpc,expected', [
    (RPC(running=True), 'busy'),
    (RPC(prompts=[{'kind': 'approval'}]), 'native Hermes session'),
    (RPC(event={'method': 'event', 'params': {'session_id': 'fixture-session',
        'type': 'approval.request', 'payload': {'command': 'PRIVATE COMMAND'}}}, status='started'), 'native Hermes session'),
    (RPC(outcome='failed'), 'not return a confirmed answer'),
    (RPC(outcome='cancelled'), 'not return a confirmed answer'),
    (RPC(status='unknown'), 'not return a confirmed answer'),
    (RPC(admission='wrong-admission'), 'not return a confirmed answer'),
    (RPC(failure=True), 'not return a confirmed answer'),
])
def test_unsafe_outcome_is_spoken_safely_and_blocks_model_retries(rpc, expected):
    async def check():
        transport = Transport(rpc)
        bridge = HermesBridge(Fallback(), transport)
        sid = await create(bridge, transport)
        call = HermesRealtimeCall(bridge, sid)
        answer = await call.tool('hermes_turn', {'text': 'fixture request'}, 'call-1')
        assert expected in answer
        assert 'PRIVATE' not in answer and 'fixture answer' not in answer and 'Telegram' not in answer
        before = list(rpc.calls)
        # Neither a repeated ID nor the voice model inventing a new one can replay work.
        await call.tool('hermes_turn', {'text': 'fixture request'}, 'call-1')
        blocked = await call.tool('hermes_turn', {'text': 'fixture request'}, 'call-2')
        assert 'native Hermes session' in blocked
        assert rpc.calls == before
        if rpc.running or rpc.prompts:
            assert not any(method == 'prompt.submit' for method, _ in rpc.calls)
        assert {method for method, _ in rpc.calls} <= {'session.resume', 'prompt.submit', 'prompt.receipt'}
        await bridge.delete('/voice/sessions/' + sid)
    asyncio.run(check())


@pytest.mark.parametrize('name,args,call_id', [
    ('approval.respond', {'text': 'yes'}, 'call-1'),
    ('hermes_turn', {}, 'call-1'),
    ('hermes_turn', {'text': 'x', 'tools': []}, 'call-1'),
    ('hermes_turn', {'text': ''}, 'call-1'),
    ('hermes_turn', {'text': ' '}, 'call-1'),
    ('hermes_turn', {'text': 3}, 'call-1'),
    ('hermes_turn', {'text': 'x' * 4001}, 'call-1'),
    ('hermes_turn', {'text': 'x'}, ''),
    ('hermes_turn', {'text': 'x'}, None),
])
def test_invalid_model_tool_call_cannot_submit_native_work(name, args, call_id):
    async def check():
        transport = Transport()
        bridge = HermesBridge(Fallback(), transport)
        call = HermesRealtimeCall(bridge, await create(bridge, transport))
        answer = await call.tool(name, args, call_id)
        assert 'Invalid' in answer
        assert not transport.rpc.calls
    asyncio.run(check())


def test_tool_identity_is_stable_within_call_but_unique_across_calls():
    async def check():
        transport = Transport()
        bridge = HermesBridge(Fallback(), transport)
        first = HermesRealtimeCall(bridge, await create(bridge, transport))
        second = HermesRealtimeCall(bridge, await create(bridge, transport))
        # Provider IDs are opaque (not necessarily valid native submission IDs).
        tool_id = 'call/provider:opaque'
        assert await first.tool('hermes_turn', {'text': 'first'}, tool_id) == 'fixture answer'
        assert await first.tool('hermes_turn', {'text': 'first'}, tool_id) == 'fixture answer'
        assert await second.tool('hermes_turn', {'text': 'second'}, tool_id) == 'fixture answer'
        submissions = [p for method, p in transport.rpc.calls if method == 'prompt.submit']
        assert len(submissions) == 2
        assert submissions[0]['submission_id'] != submissions[1]['submission_id']
        assert [p['text'] for p in submissions] == ['first', 'second']
    asyncio.run(check())


@pytest.mark.parametrize('detach', ['timeout', 'barge-in', 'hangup'])
def test_timeout_barge_in_and_hangup_never_cancel_or_replay_native_work(detach):
    async def check():
        transport = Transport(RPC(status='started'))
        bridge = HermesBridge(Fallback(), transport, turn_timeout=.01 if detach == 'timeout' else 30, poll_interval=.001)
        sid = await create(bridge, transport)
        call = HermesRealtimeCall(bridge, sid)
        task = asyncio.create_task(call.tool('hermes_turn', {'text': 'fixture request'}, 'call-1'))
        async with asyncio.timeout(1):
            while not any(method == 'prompt.submit' for method, _ in transport.rpc.calls):
                await asyncio.sleep(.001)
        # Overlapping tool calls cannot queue more native work.
        assert 'cannot submit more work' in await call.tool('hermes_turn', {'text': 'overlap'}, 'parallel')
        if detach == 'timeout':
            assert 'not return a confirmed answer' in await task
        else:
            if detach == 'hangup':
                await bridge.delete('/voice/sessions/' + sid)
            else:
                task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        before = list(transport.rpc.calls)
        assert 'native Hermes session' in await call.tool('hermes_turn', {'text': 'retry'}, 'call-2')
        assert transport.rpc.calls == before
        assert sum(method == 'prompt.submit' for method, _ in before) == 1
        assert {method for method, _ in before} <= {'session.resume', 'prompt.submit', 'prompt.receipt'}
        assert transport.closed == 1
    asyncio.run(check())


def test_real_realtime_pipeline_builds_native_facade_and_dispatches_result_offline(monkeypatch):
    """Exercise production run_realtime, real provider settings/schema and callback wiring.

    WebRTC, turn aggregators and the runner are replaced: no socket, microphone,
    speech model or local turn-detection model starts.
    """
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from pipeline import run_realtime, CallNotes
    from pipecat.frames.frames import TranscriptionFrame, TTSTextFrame, LLMFullResponseEndFrame
    from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
    from pipecat.pipeline.runner import PipelineRunner
    import pipecat.transports.smallwebrtc.transport as rtc_module
    import hermes_realtime_service as llm_module
    from hermes_realtime_service import HermesRealtimeLLMService
    import pipecat.processors.aggregators.llm_response_universal as aggregator_module

    observed = {}
    class Provider(HermesRealtimeLLMService):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            observed['provider'] = self
        async def _connect(self):
            raise AssertionError('Network forbidden in offline test')
    class AudioTransport:
        def __init__(self, connection, params):
            self.events = {}
            observed['transport'] = self
        def input(self): return FrameProcessor()
        def output(self): return FrameProcessor()
        def event_handler(self, name):
            def register(callback):
                self.events[name] = callback
                return callback
            return register
    async def run(_runner, task):
        provider = observed['provider']
        settings = provider._settings.session_properties
        assert settings.instructions == observed['setup']['instructions']
        # Automatic server-VAD owner responses must not permit speech-only answers.
        assert settings.tool_choice == 'required'
        assert settings.audio.input.transcription is not None
        assert set(provider._functions) == {'hermes_turn'}
        # Capture real Pipecat serialized events: initial greeting and completed
        # tool results use _create_response, while VAD uses session defaults.
        from pipecat.processors.aggregators.llm_context import LLMContext
        wire = []
        provider._ws_send = AsyncMock(side_effect=wire.append)
        provider.push_frame = AsyncMock()
        provider._api_session_ready = True
        context = LLMContext([{'role': 'user', 'content': '(Greet briefly.)'}], tools=settings.tools)
        await provider._handle_context(context)
        greeting = [e for e in wire if e['type'] == 'response.create']
        assert len(greeting) == 1
        assert greeting[0]['response']['tool_choice'] == 'none'
        assert greeting[0]['response']['output_modalities'] == ['audio']
        updates = [e['session'] for e in wire if e['type'] == 'session.update']
        assert updates[-1]['tool_choice'] == 'required'
        assert [t['name'] for t in updates[-1]['tools']] == ['hermes_turn']
        assert updates[-1]['audio']['input']['turn_detection'].get('create_response', True) is True
        wire.clear()
        context.add_message({'role': 'tool', 'tool_call_id': 'native-result', 'content': 'fixture answer'})
        await provider._handle_context(context)
        assert [e['type'] for e in wire] == ['conversation.item.create', 'response.create']
        assert wire[0]['item']['type'] == 'function_call_output'
        import json
        assert json.loads(wire[0]['item']['output']) == 'fixture answer'
        assert wire[1]['response']['tool_choice'] == 'none'
        # The exemption is response-local: the next automatic owner turn is
        # still required to delegate, even if it barges into result speech.
        assert settings.tool_choice == 'required'
        assert not any(e['type'] == 'session.update' for e in wire)
        wire.clear()
        await provider._handle_context(context)
        assert wire == []  # A repeated context cannot trigger a tool/speech loop.
        entry = provider._functions['hermes_turn']
        # Do not enable Pipecat asynchronous tools: they inject a cancel tool.
        assert entry.cancel_on_interruption is True
        callback = AsyncMock()
        await entry.handler(SimpleNamespace(function_name='hermes_turn', arguments={'text': '  Можем обсудить моё исследование?  '},
                                            tool_call_id='tool-1', result_callback=callback))
        callback.assert_awaited_once_with('fixture answer')
        # Browser transcripts flow through the actual CallNotes processor, not native notes.
        messages = []
        notes = CallNotes(observed['call'].note, messages.append)
        notes.push_frame = AsyncMock()
        await notes.process_frame(TranscriptionFrame('  Можем обсудить моё исследование?  ', 'owner', 'fixture'), FrameDirection.UPSTREAM)
        await notes.process_frame(TTSTextFrame('fixture answer', aggregated_by='sentence'), FrameDirection.DOWNSTREAM)
        await notes.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
        assert messages == [{'type': 'user', 'text': 'Можем обсудить моё исследование?'}, {'type': 'assistant', 'text': 'fixture answer'}]
        assert set(observed['transport'].events) == {'on_client_connected', 'on_client_disconnected'}
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-not-a-real-key')
    monkeypatch.setattr(llm_module, 'HermesRealtimeLLMService', Provider)
    monkeypatch.setattr(rtc_module, 'SmallWebRTCTransport', AudioTransport)
    monkeypatch.setattr(aggregator_module, 'LLMContextAggregatorPair', lambda context: (FrameProcessor(), FrameProcessor()))
    monkeypatch.setattr(PipelineRunner, 'run', run)
    async def check():
        transport, fallback = Transport(), Fallback()
        bridge = HermesBridge(fallback, transport)
        sid = await create(bridge, transport)
        call = HermesRealtimeCall(bridge, sid)
        observed['call'], observed['setup'] = call, await call.setup()
        await run_realtime(SimpleNamespace(send_app_message=lambda message: None), call)
        submissions = [p for method, p in transport.rpc.calls if method == 'prompt.submit']
        assert len(submissions) == 1 and submissions[0]['text'] == '  Можем обсудить моё исследование?  '
        assert submissions[0]['session_id'] == transport.target.session_id
        assert not fallback.calls
    asyncio.run(check())


def test_pi_realtime_pipeline_keeps_original_service_and_wire_policy(monkeypatch):
    """Control: the shared pipeline must not install the Hermes adapter for Pi."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from pipeline import run_realtime
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.processors.aggregators.llm_context import LLMContext
    import pipecat.services.openai.realtime.llm as llm_module
    import pipecat.transports.smallwebrtc.transport as rtc_module
    import pipecat.processors.aggregators.llm_response_universal as aggregator_module

    observed = {}
    base = llm_module.OpenAIRealtimeLLMService
    class Provider(base):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            observed['provider'] = self
        async def _connect(self):
            raise AssertionError('Network forbidden in offline test')
    class AudioTransport:
        def __init__(self, *args): pass
        def input(self): return FrameProcessor()
        def output(self): return FrameProcessor()
        def event_handler(self, name): return lambda callback: callback
    async def run(_runner, _task):
        provider = observed['provider']
        assert type(provider) is Provider
        assert provider._settings.session_properties.tool_choice is None
        assert set(provider._functions) == {'pi_task'}
        wire = []
        provider._ws_send = AsyncMock(side_effect=wire.append)
        provider.push_frame = AsyncMock()
        provider._api_session_ready = True
        await provider._handle_context(LLMContext([{'role': 'user', 'content': '(Greet.)'}]))
        response = next(e for e in wire if e['type'] == 'response.create')
        assert 'tool_choice' not in response['response']
        update = next(e for e in wire if e['type'] == 'session.update')
        assert 'tool_choice' not in update['session']
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-not-a-real-key')
    monkeypatch.setattr(llm_module, 'OpenAIRealtimeLLMService', Provider)
    monkeypatch.setattr(rtc_module, 'SmallWebRTCTransport', AudioTransport)
    monkeypatch.setattr(aggregator_module, 'LLMContextAggregatorPair', lambda context: (FrameProcessor(), FrameProcessor()))
    monkeypatch.setattr(PipelineRunner, 'run', run)
    call = SimpleNamespace(setup=AsyncMock(return_value={
        'instructions': 'Pi front fixture',
        'tools': [{'name': 'pi_task', 'description': 'Pi tool', 'parameters': {}}],
    }), note=AsyncMock(), tool=AsyncMock())
    asyncio.run(run_realtime(SimpleNamespace(send_app_message=lambda message: None), call))
