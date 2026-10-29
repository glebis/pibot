"""Hermes protocol/HTTP tests with fake transports; no models, speech or real submissions."""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from hermes_bridge import HermesBridge, HermesTransport, Target, trusted_imports


class RPC:
    def __init__(self, *, running=False, prompts=None, outcome='completed', event=None,
                 status='terminal', failure=False, admission='adm-1'):
        self.calls = []
        self.events = asyncio.Queue()
        self.running = running
        self.prompts = prompts or []
        self.outcome = outcome
        self.status = status
        self.failure = failure
        self.event = event
        self.admission = admission

    async def rpc(self, method, **params):
        self.calls.append((method, params))
        if method == 'session.resume':
            return {'running': self.running, 'pending': [], 'prompts': self.prompts}
        if method == 'prompt.submit':
            if self.failure:
                raise OSError('PRIVATE CONTENT MUST NOT LEAK')
            if self.event:
                self.events.put_nowait(self.event)
            return {'admission_id': 'adm-1', 'status': 'started'}
        if method == 'prompt.receipt':
            return {'admission_id': self.admission, 'status': self.status, 'outcome': self.outcome,
                    'result': {'final_response': 'fixture answer'}}
        raise AssertionError('Forbidden RPC: ' + method)


class Transport:
    def __init__(self, rpc=None):
        self.target = Target('researcher', Path('/private/fixture/researcher'), 'fixture-session')
        self.rpc = rpc or RPC()
        self.connected = []
        self.closed = 0

    async def discover(self):
        return {self.target.id: self.target}

    @asynccontextmanager
    async def connect(self, home):
        self.connected.append(home)
        try:
            yield self.rpc
        finally:
            self.closed += 1


class Fallback:
    def __init__(self):
        self.calls = []

    async def get(self, path):
        self.calls.append(('get', path))
        return HermesBridge.response(200, {'bindings': [{'agentId': 'coach', 'chatKey': 'telegram:fixture'}]})

    async def post(self, path, json):
        self.calls.append(('post', path, json))
        return HermesBridge.response(200, {'sessionId': 'pibot-session'})

    async def delete(self, path):
        self.calls.append(('delete', path))
        return HermesBridge.response(200, {'closed': True})

    async def aclose(self):
        pass


async def create(bridge, transport, **extra):
    r = await bridge.post('/voice/browser-sessions', json={
        'agentId': transport.target.id, 'chatKey': transport.target.id, **extra})
    assert r.status_code == 200
    return r.json()['sessionId']


def execute(coro):
    return asyncio.run(coro)


def test_metadata_discovery_and_fallback_preserved():
    async def check():
        t, f = Transport(), Fallback()
        b = HermesBridge(f, t)
        rows = (await b.get('/voice/bindings')).json()['bindings']
        assert rows[0]['agentId'] == 'coach'
        assert rows[1]['backend'] == 'hermes' and rows[1]['modes'] == ['agent', 'realtime']
        assert len(rows[1]['agentId']) <= 64
        assert rows[1]['toolSelection'] is False
        assert not t.rpc.calls
        await b.post('/voice/browser-sessions', json={'agentId': 'coach'})
        assert f.calls[-1][0] == 'post'
        await b.delete('/voice/sessions/pibot-session')
        assert f.calls[-1][0] == 'delete'
    execute(check())


@pytest.mark.parametrize('extra', [{'tools': []}, {'allowedTools': ['read']}, {'mode': 'front'}, {'mode': 'realtime'}, {'unexpected': True}])
def test_reject_unenforceable_policy(extra):
    async def check():
        t = Transport()
        b = HermesBridge(Fallback(), t)
        r = await b.post('/voice/browser-sessions', json={
            'agentId': t.target.id, 'chatKey': t.target.id, **extra})
        assert r.status_code == 400 and not t.rpc.calls
    execute(check())


def test_exact_target_stable_identity_receipt_and_detach():
    async def check():
        t = Transport()
        b = HermesBridge(Fallback(), t)
        sid = await create(b, t)
        path = f'/voice/sessions/{sid}/turn'
        r = await b.post(path, json={'requestId': 'stable-uuid', 'text': 'fixture input'})
        assert r.status_code == 200 and r.json()['text'] == 'fixture answer'
        assert t.connected == [t.target.home]
        assert t.rpc.calls[0] == ('session.resume', {'session_id': 'fixture-session', 'omit_messages': True})
        assert t.rpc.calls[1] == ('prompt.submit', {'session_id': 'fixture-session', 'text': 'fixture input', 'submission_id': 'stable-uuid'})
        assert t.rpc.calls[2][1]['include_result'] is True
        await b.post(path, json={'requestId': 'stable-uuid', 'text': 'fixture input'})
        assert len([c for c in t.rpc.calls if c[0] == 'prompt.submit']) == 1
        await b.delete('/voice/sessions/' + sid)
        assert t.closed == 1 and not b.calls
        assert (await b.post(path, json={'requestId': 'x', 'text': 'x'})).status_code == 404
    execute(check())


@pytest.mark.parametrize('rpc,error', [
    (RPC(running=True), 'agent_busy'),
    (RPC(prompts=[{'kind': 'approval'}]), 'hermes_input_required'),
    (RPC(outcome='failed'), 'hermes_turn_failed'),
    (RPC(outcome='cancelled'), 'hermes_turn_failed'),
    (RPC(status='unknown'), 'hermes_detached'),
    (RPC(admission='someone-elses-admission'), 'hermes_detached'),
    (RPC(failure=True), 'hermes_detached'),
])
def test_busy_approval_failure_unknown_and_wrong_receipt(rpc, error):
    async def check():
        t = Transport(rpc)
        b = HermesBridge(Fallback(), t)
        sid = await create(b, t)
        result = await b.post(f'/voice/sessions/{sid}/turn', json={'requestId': 'stable', 'text': 'test'})
        assert result.status_code == 409 and result.json()['error'] == error
        assert 'PRIVATE' not in result.text and 'fixture answer' not in result.text
        if rpc.running or rpc.prompts:
            assert not any(c[0] == 'prompt.submit' for c in rpc.calls)
        assert {c[0] for c in rpc.calls} <= {'session.resume', 'prompt.submit', 'prompt.receipt'}
        assert t.closed == 1
    execute(check())


def test_native_approval_event_never_approved():
    async def check():
        event = {'method': 'event', 'params': {'session_id': 'fixture-session', 'type': 'approval.request',
                                              'payload': {'command': 'PRIVATE fixture'}}}
        rpc = RPC(event=event, status='started')
        t = Transport(rpc)
        b = HermesBridge(Fallback(), t)
        sid = await create(b, t)
        r = await b.post(f'/voice/sessions/{sid}/turn', json={'requestId': 'x', 'text': 'test'})
        assert r.json() == {'error': 'hermes_input_required', 'admissionId': 'adm-1'}
        assert not any(c[0].endswith('.respond') for c in rpc.calls)
    execute(check())


def test_unrelated_completion_not_spoken():
    async def check():
        rpc = RPC(event={'method': 'event', 'params': {'session_id': 'fixture-session', 'type': 'message.complete',
                         'payload': {'admission_id': 'other', 'outcome': 'completed', 'text': 'PRIVATE OTHER ANSWER'}}})
        t = Transport(rpc)
        b = HermesBridge(Fallback(), t)
        sid = await create(b, t)
        r = await b.post(f'/voice/sessions/{sid}/turn', json={'requestId': 'x', 'text': 'test'})
        assert r.json()['text'] == 'fixture answer' and 'PRIVATE' not in r.text
    execute(check())


def test_timeout_and_disconnect_detach_no_retry_or_cancel():
    async def check():
        t = Transport(RPC(status='started'))
        b = HermesBridge(Fallback(), t, turn_timeout=.01, poll_interval=.001)
        sid = await create(b, t)
        path = f'/voice/sessions/{sid}/turn'
        r = await b.post(path, json={'requestId': 'x', 'text': 'test'})
        assert r.json()['error'] == 'hermes_detached'
        await b.post(path, json={'requestId': 'x', 'text': 'test'})
        assert len([c for c in t.rpc.calls if c[0] == 'prompt.submit']) == 1
        assert t.closed == 1
        b.turn_timeout = 30
        task = asyncio.create_task(b.post(path, json={'requestId': 'y', 'text': 'test'}))
        while len([c for c in t.rpc.calls if c[0] == 'prompt.submit']) < 2:
            await asyncio.sleep(.001)
        await b.delete('/voice/sessions/' + sid)
        assert task.cancelled() and t.closed == 2
        assert {c[0] for c in t.rpc.calls} <= {'session.resume', 'prompt.submit', 'prompt.receipt'}
    execute(check())


def test_untrusted_repo_refused(tmp_path):
    with pytest.raises(ValueError):
        trusted_imports('relative/repo')
    repo = tmp_path / 'repo'
    (repo / 'hermes_cli').mkdir(parents=True)
    (repo / 'gateway').mkdir()
    for name in ('gateway_client.py', 'gateway_runtime.py'):
        (repo / 'hermes_cli' / name).write_text('raise AssertionError("must not import")')
    repo.chmod(0o777)
    with pytest.raises(ValueError, match='owner-controlled'):
        trusted_imports(str(repo))


def test_profile_discovery_uses_readable_titles_without_exposing_conversations():
    async def check():
        transport = object.__new__(HermesTransport)
        transport.homes = {'default': Path('/fixture/default'), 'ops': Path('/fixture/ops')}
        calls = []
        class ListRPC:
            async def rpc(self, method, **params):
                calls.append((method, params))
                return {'sessions': [{'session_id': 's-1', 'title': '  План\nработы  ', 'source': 'telegram',
                                      'running': False, 'messages': ['PRIVATE CONTENT'], 'system_prompt': 'PRIVATE PROMPT'}]}
        @asynccontextmanager
        async def connect(home):
            yield ListRPC()
        transport.connect = connect
        targets = await transport.discover()
        assert len(targets) == 2
        assert calls == [('session.list', {'scope': 'live', 'limit': 200})] * 2
        assert all('План работы' in t.metadata()['name'] for t in targets.values())
        assert all('Telegram' in t.metadata()['name'] for t in targets.values())
        assert all('PRIVATE' not in str(t.metadata()) for t in targets.values())
    execute(check())


def test_session_label_is_bounded_and_removes_control_characters_without_changing_identity():
    home = Path('/fixture/default')
    sid = 'local-' + 'a' * 64
    target = Target('default', home, sid, title='План\x00\x1b работы ' + 'длинный ' * 30, source='telegram')
    metadata = target.metadata()
    assert all(c.isprintable() for c in metadata['name'])
    assert 'План работы' in metadata['name']
    assert len(metadata['name']) < 140
    assert sid not in metadata['name']
    assert metadata['sessionId'] == sid
    assert metadata['id'] == Target('default', home, sid).metadata()['id']


def test_untitled_session_label_identifies_source_without_showing_long_id():
    sid = 'local-' + 'b' * 64
    metadata = Target('researcher', Path('/fixture/researcher'), sid, source='cron').metadata()
    assert 'Scheduled task' in metadata['name']
    assert 'researcher' in metadata['name']
    assert sid not in metadata['name'] and sid[-8:] in metadata['name']


def test_connect_uses_official_discovery_and_home_specific_ticket_only(monkeypatch):
    from types import SimpleNamespace
    import websockets.asyncio.client
    records = []
    home = Path('/fixture/profiles/researcher')
    endpoint = object()
    def discover(selected, *, timeout):
        records.append(('discover', selected, timeout))
        return SimpleNamespace(endpoint=endpoint)
    def ticket(selected, target):
        records.append(('ticket', selected, target))
        return 'fixture-private-ticket'
    @asynccontextmanager
    async def socket(url, **kwargs):
        records.append(('websocket', url, kwargs))
        yield SimpleNamespace(subprotocol='fixture-protocol')
    @asynccontextmanager
    async def gateway(ws):
        records.append(('client', ws.subprotocol))
        yield 'fixture-client'
    monkeypatch.setattr(websockets.asyncio.client, 'connect', socket)
    transport = object.__new__(HermesTransport)
    transport.runtime = SimpleNamespace(discover_gateway_endpoint=discover, attachable=lambda result: True)
    transport.client = SimpleNamespace(_session_ticket=ticket,
        gateway_ws_target=lambda e, t: ('ws://127.0.0.1:1234/api/ws', ['fixture-protocol', t]),
        GATEWAY_WS_PROTOCOL='fixture-protocol', GatewayClient=gateway)
    async def check():
        async with transport.connect(home) as rpc:
            assert rpc == 'fixture-client'
    execute(check())
    assert records[0] == ('discover', home, 2)
    assert records[1] == ('ticket', home, endpoint)
    assert records[2][2]['proxy'] is None
    assert records[2][2]['subprotocols'] == ['fixture-protocol', 'fixture-private-ticket']
    # No ensure/start/connect_gateway implicit-home API is provided to this fixture.


def test_completed_event_survives_until_later_terminal_receipt():
    class DelayedReceipt(RPC):
        def __init__(self):
            super().__init__(event={'params': {'session_id': 'fixture-session',
                'type': 'message.complete', 'payload': {'admission_id': 'adm-1',
                'outcome': 'completed', 'text': 'confirmed event answer'}}})
            self.polls = 0

        async def rpc(self, method, **params):
            result = await super().rpc(method, **params)
            if method == 'prompt.receipt':
                self.polls += 1
                result['status'] = 'started' if self.polls == 1 else 'terminal'
                result['result'] = {}
            return result

    async def check():
        transport = Transport(DelayedReceipt())
        bridge = HermesBridge(Fallback(), transport, poll_interval=0)
        sid = await create(bridge, transport)
        response = await bridge.post(f'/voice/sessions/{sid}/turn',
                                     json={'requestId': 'delayed', 'text': 'fixture input'})
        assert response.status_code == 200
        assert response.json()['text'] == 'confirmed event answer'
    execute(check())
