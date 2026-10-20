"""Opt-in same-user Hermes canonical gateway adapter; never starts an authority.

Only discovery, subscription and prompt admission are exposed. Approval/tool policy is
owned by Hermes, not by this viewer. Closing or timing out detaches, never interrupts.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import hashlib
import importlib
import os
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx


class HermesUnavailable(ValueError):
    def __init__(self):
        super().__init__("Hermes authority unavailable; inspect the native session before retrying")


def trusted_imports(repo: str):
    """Explicit owner-trusted checkout only; refuse shadowed/preloaded Hermes modules."""
    path = Path(repo).expanduser()
    if not path.is_absolute():
        raise ValueError("PIBOT_HERMES_REPO must be an absolute trusted checkout")
    path = path.resolve(strict=True)
    for ancestor in path.parents:
        st = ancestor.stat()
        if st.st_uid not in {0, os.getuid()} or st.st_mode & 0o022:
            raise ValueError("Hermes checkout ancestors must not be writable by others")
    for node in (path, path / 'hermes_cli', path / 'gateway',
                 path / 'hermes_cli/gateway_runtime.py', path / 'hermes_cli/gateway_client.py'):
        if not node.resolve().is_relative_to(path):
            raise ValueError("Hermes modules must remain inside the trusted checkout")
        st = node.stat()
        if st.st_uid != os.getuid() or st.st_mode & 0o022:
            raise ValueError("Hermes checkout must be owner-controlled and not writable by others")
    for name, module in list(sys.modules.items()):
        if name.split('.')[0] in {'hermes_cli', 'gateway', 'hermes_constants', 'tui_gateway'}:
            source = getattr(module, '__file__', None)
            if source and not Path(source).resolve().is_relative_to(path):
                raise ValueError("Hermes imports already loaded from a different checkout")
            if any(not Path(p).resolve().is_relative_to(path) for p in getattr(module, '__path__', [])):
                raise ValueError("Hermes namespace already loaded from a different checkout")
    if str(path) in sys.path:
        sys.path.remove(str(path))
    sys.path.insert(0, str(path))
    # Discovery lazily imports YAML support. Fail setup here rather than reporting
    # every running profile as unavailable when the voice environment lacks it.
    try:
        importlib.import_module('ruamel.yaml')
        importlib.import_module('websockets.asyncio.client')
    except ImportError:
        raise ValueError('Hermes voice dependencies missing; install voice/requirements-hermes.txt into the voice environment') from None
    runtime = importlib.import_module('hermes_cli.gateway_runtime')
    client = importlib.import_module('hermes_cli.gateway_client')
    for module in (runtime, client):
        if not module.__file__ or not Path(module.__file__).resolve().is_relative_to(path):
            raise ValueError("Untrusted Hermes import")
    return runtime, client


@dataclass(frozen=True)
class Target:
    profile: str
    home: Path
    session_id: str
    running: bool = False
    title: str = ''
    source: str = ''

    @property
    def id(self):
        return 'hermes-' + hashlib.sha256((str(self.home) + '\0' + self.session_id).encode()).hexdigest()[:48]

    def metadata(self):
        title = ' '.join(''.join(c if c.isprintable() else ' ' for c in self.title).split())[:72]
        source = {'telegram': 'Telegram', 'cron': 'Scheduled task', 'acp': 'Agent connection',
                  'cli': 'Terminal', 'local': 'Local session'}.get(self.source, 'Session')
        label = f'{source} — {title}' if title else source
        return {'id': self.id, 'name': f'Hermes · {self.profile} · {label} · {self.session_id[-8:]}',
                'model': 'native Hermes session · tools and approvals stay in Hermes',
                'available': True, 'backend': 'hermes', 'profile': self.profile,
                'sessionId': self.session_id, 'running': self.running,
                'modes': ['agent', 'realtime'], 'toolSelection': False, 'nativeApprovals': True}


class HermesTransport:
    def __init__(self, repo: str, profiles: str | None = None, home: Path | None = None):
        self.runtime, self.client = trusted_imports(repo)
        root = (home or Path.home() / '.hermes').expanduser().resolve()
        names = (profiles if profiles is not None else 'default,content,ops,researcher').split(',')
        if not names or any(not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', n) for n in names):
            raise ValueError('Invalid Hermes profile allowlist')
        self.homes = {n: root if n == 'default' else root / 'profiles' / n for n in dict.fromkeys(names)}
        self.profile_status = {}

    @asynccontextmanager
    async def connect(self, home):
        """Use official private socket validation and home-specific ticket, no env mutation.

        connect_gateway(endpoint=...) currently derives tickets from global HERMES_HOME;
        its official lower-level components preserve the selected profile without races.
        """
        try:
            found = await asyncio.to_thread(self.runtime.discover_gateway_endpoint, home, timeout=2)
            if not self.runtime.attachable(found):
                raise HermesUnavailable()
            endpoint = found.endpoint
            ticket = await asyncio.to_thread(self.client._session_ticket, home, endpoint)
            url, protocols = self.client.gateway_ws_target(endpoint, ticket)
            from websockets.asyncio.client import connect
            async with connect(url, subprotocols=protocols, proxy=None, open_timeout=5,
                               max_size=8 * 1024 * 1024) as ws:
                if ws.subprotocol != self.client.GATEWAY_WS_PROTOCOL:
                    raise HermesUnavailable()
                async with self.client.GatewayClient(ws) as rpc:
                    yield rpc
        except asyncio.CancelledError:
            raise
        except Exception:
            raise HermesUnavailable() from None

    async def discover(self):
        self.profile_status = {}
        async def profile(name, home):
            try:
                async with self.connect(home) as rpc:
                    data = await rpc.rpc('session.list', scope='live', limit=200)
                    self.profile_status[name] = {'available': True, 'count': len(data.get('sessions', [])),
                                                 'limit': 200}
                    return [Target(name, home, row['session_id'], row.get('running') is True,
                                   title if isinstance(title := row.get('title'), str) else '',
                                   source if isinstance(source := row.get('source'), str) else '')
                            for row in data.get('sessions', [])
                            if isinstance(row, dict) and isinstance(row.get('session_id'), str)]
            except HermesUnavailable:
                self.profile_status[name] = {'available': False, 'count': 0, 'limit': 200}
                return []  # stopped/inaccessible profiles are never started
        batches = await asyncio.gather(*(profile(n, h) for n, h in self.homes.items()))
        return {t.id: t for batch in batches for t in batch}


@dataclass
class Call:
    target: Target
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # A request identity is never submitted twice, including after an ambiguous failure.
    requests: dict = field(default_factory=dict)
    task: asyncio.Task | None = None


class HermesBridge:
    """httpx-compatible canonical bridge multiplexer, preserving PiBot fallback routes."""
    def __init__(self, fallback, transport, *, turn_timeout: float = 42, poll_interval: float = .4):
        self.fallback = fallback
        self.transport = transport
        self.calls: dict[str, Call] = {}
        self.turn_timeout = turn_timeout
        self.poll_interval = poll_interval

    @classmethod
    def from_env(cls, fallback):
        repo = os.environ.get('PIBOT_HERMES_REPO')
        return cls(fallback, HermesTransport(repo, os.environ.get('PIBOT_HERMES_PROFILES'))) if repo else fallback

    @staticmethod
    def is_hermes(agent_id):
        return isinstance(agent_id, str) and agent_id.startswith('hermes-')

    @staticmethod
    def response(status, data):
        return httpx.Response(status, json=data, request=httpx.Request('POST', 'http://local-hermes'))

    async def get(self, path):
        url = urlsplit(path)
        if url.path == '/voice/bindings':
            try:
                r = await self.fallback.get(path)
                r.raise_for_status()
                bindings = r.json().get('bindings', [])
            except Exception:
                bindings = []
            targets = await self.transport.discover()
            return self.response(200, {'bindings': [*bindings, *[
                {'agentId': t.id, 'chatKey': t.id, **t.metadata()} for t in targets.values()]]})
        agent = parse_qs(url.query).get('agentId', [''])[0]
        if self.is_hermes(agent):
            if url.path == '/voice/tools':
                return self.response(200, {'groups': [], 'toolSelection': False, 'nativeApprovals': True})
            if url.path == '/voice/tasks':
                return self.response(200, {'tasks': []})
            return self.response(400, {'error': 'unsupported_hermes_operation'})
        return await self.fallback.get(path)

    async def post(self, path, json):
        if path == '/voice/browser-sessions' and self.is_hermes(json.get('agentId')):
            if set(json) - {'agentId', 'chatKey', 'mode'} or json.get('mode') not in (None, 'agent'):
                return self.response(400, {'error': 'hermes_native_policy_required'})
            target = (await self.transport.discover()).get(json['agentId'])
            if not target or json.get('chatKey') != target.id:
                return self.response(404, {'error': 'hermes_session_unavailable'})
            sid = 'hermes-call-' + uuid4().hex
            self.calls[sid] = Call(target)
            return self.response(200, {'sessionId': sid, 'mode': 'agent', 'backend': 'hermes'})
        parts = path.strip('/').split('/')
        if len(parts) >= 3 and parts[:2] == ['voice', 'sessions'] and parts[2].startswith('hermes-call-'):
            call = self.calls.get(parts[2])
            if not call:
                return self.response(404, {'error': 'hermes_call_unavailable'})
            if len(parts) != 4 or parts[3] != 'turn':
                return self.response(400, {'error': 'unsupported_hermes_operation'})
            if (set(json) != {'requestId', 'text'} or not isinstance(json['requestId'], str)
                    or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', json['requestId'])
                    or not isinstance(json['text'], str) or not 0 < len(json['text'].strip()) <= 32000):
                return self.response(400, {'error': 'invalid_turn'})
            if call.lock.locked():
                return self.response(409, {'error': 'agent_busy'})
            async with call.lock:
                request_id = json['requestId']
                if request_id in call.requests:
                    return call.requests[request_id]
                if len(call.requests) >= 2000:
                    return self.response(409, {'error': 'hermes_detached'})
                # Mark before any IO: transport ambiguity must never cause an automatic resend.
                call.requests[request_id] = self.response(409, {'error': 'hermes_detached'})
                call.task = asyncio.current_task()
                try:
                    async with asyncio.timeout(self.turn_timeout):
                        result = await self.turn(call, request_id, json['text'])
                except asyncio.CancelledError:
                    raise
                except Exception:
                    result = call.requests[request_id]
                finally:
                    call.task = None
                call.requests[request_id] = result
                return result
        if self.is_hermes(json.get('agentId')):
            return self.response(400, {'error': 'unsupported_hermes_operation'})
        return await self.fallback.post(path, json=json)

    async def turn(self, call, request_id, text):
        target = call.target
        async with self.transport.connect(target.home) as rpc:
            snapshot = await rpc.rpc('session.resume', session_id=target.session_id, omit_messages=True)
            if snapshot.get('prompts'):
                return self.response(409, {'error': 'hermes_input_required'})
            if snapshot.get('running') or snapshot.get('pending'):
                return self.response(409, {'error': 'agent_busy'})
            receipt = await rpc.rpc('prompt.submit', session_id=target.session_id, text=text,
                                    submission_id=request_id)
            admission = receipt.get('admission_id')
            if not isinstance(admission, str) or not admission:
                return self.response(409, {'error': 'hermes_detached'})
            call.requests[request_id] = self.response(409, {'error': 'hermes_detached', 'admissionId': admission})
            complete = None
            while True:
                # Retain the matching completed event until its terminal receipt arrives.
                # Discard unrelated streams/tool payloads, never speak another admission's answer.
                while not rpc.events.empty():
                    frame = rpc.events.get_nowait()
                    if isinstance(frame, Exception):
                        raise HermesUnavailable()
                    params = frame.get('params', {})
                    if params.get('session_id') != target.session_id:
                        continue
                    kind = params.get('type', frame.get('method'))
                    payload = params.get('payload', params)
                    if kind in {'approval.request', 'clarify.request', 'clarify', 'approval'}:
                        return self.response(409, {'error': 'hermes_input_required', 'admissionId': admission})
                    if kind == 'message.complete' and payload.get('admission_id') == admission:
                        complete = payload
                receipt = await rpc.rpc('prompt.receipt', session_id=target.session_id,
                                        admission_id=admission, include_result=True)
                if receipt.get('admission_id') != admission:
                    raise HermesUnavailable()
                if receipt.get('status') == 'unknown':
                    return self.response(409, {'error': 'hermes_detached', 'admissionId': admission})
                if receipt.get('status') == 'terminal':
                    if receipt.get('outcome') != 'completed':
                        return self.response(409, {'error': 'hermes_turn_failed', 'admissionId': admission})
                    result = receipt.get('result') or {}
                    if isinstance(result, dict) and any(result.get(k) for k in ('failed', 'error', 'interrupted')):
                        return self.response(409, {'error': 'hermes_turn_failed', 'admissionId': admission})
                    answer = result.get('final_response') if isinstance(result, dict) else None
                    if not answer and complete and complete.get('outcome') == 'completed':
                        answer = complete.get('text')
                    if not isinstance(answer, str) or not answer.strip():
                        return self.response(409, {'error': 'hermes_turn_failed', 'admissionId': admission})
                    return self.response(200, {'text': answer, 'admissionId': admission})
                await asyncio.sleep(self.poll_interval)

    async def delete(self, path):
        sid = path.rsplit('/', 1)[-1]
        if sid.startswith('hermes-call-'):
            call = self.calls.pop(sid, None)
            if call and call.task and call.task is not asyncio.current_task():
                call.task.cancel()  # close viewer only; no prompt.cancel/session.interrupt
                try:
                    await call.task
                except (asyncio.CancelledError, Exception):
                    pass
            return self.response(200, {'closed': True})
        return await self.fallback.delete(path)

    async def aclose(self):
        for sid in list(self.calls):
            await self.delete('/voice/sessions/' + sid)
        await self.fallback.aclose()
