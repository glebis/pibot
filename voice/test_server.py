import asyncio
import importlib.util
import os
import tempfile
from pathlib import Path
from unittest.mock import patch
import httpx
import pytest
from fastapi.testclient import TestClient
from server import create_app, private_token

TOKEN = 'ab' * 32
HEADERS = {'authorization': 'Bearer ' + TOKEN}

class Bridge:
    def __init__(self):
        self.calls = []
    async def get(self, path):
        self.calls.append(('get', path))
        return httpx.Response(200, json={'agents': [{'id':'test','name':'Test','available':True}]}, request=httpx.Request('GET','http://test'))
    async def post(self, path, json):
        self.calls.append(('post', path))
        return httpx.Response(200, json={'sessionId':'session-1'}, request=httpx.Request('POST','http://test'))
    async def delete(self, path):
        self.calls.append(('delete', path))
        return httpx.Response(200, json={'closed':True})

class Connection:
    async def disconnect(self):
        pass
class RTC:
    async def handle_web_request(self, request, callback):
        await callback(Connection())
        return {'sdp':'v=0 fake','type':'answer','pc_id':'pc-1'}
    async def close(self):
        pass
async def pipeline(connection, turn):
    await asyncio.Event().wait()

def client(bridge=None):
    return TestClient(create_app(TOKEN, 'cd'*32, client=bridge or Bridge(), rtc_factory=RTC, pipeline=pipeline), base_url='http://127.0.0.1:8788')

def test_requires_token_host_and_origin():
    b=Bridge()
    with client(b) as c:
        assert c.get('/api/agents').status_code == 401
        assert c.get('/api/agents',headers={**HEADERS,'host':'attacker.example:8788'}).status_code == 403
        assert c.get('/api/agents',headers={**HEADERS,'origin':'https://attacker.example'}).status_code == 403
        assert not b.calls
        r=c.get('/api/agents',headers=HEADERS)
        assert r.status_code==200 and r.headers['cache-control']=='no-store'
        assert r.json()['speechProvider']=='Deepgram'

def test_missing_speech_key_blocks_creation():
    b=Bridge()
    with patch.dict(os.environ,{},clear=True),client(b) as c:
        assert not c.get('/api/agents',headers=HEADERS).json()['audioReady']
        assert c.post('/api/offer',headers=HEADERS,json={'agentId':'test','sdp':'v=0','type':'offer'}).status_code==503
        assert not any(x[0]=='post' for x in b.calls)

def test_one_session_and_explicit_cleanup():
    b=Bridge()
    with patch.dict(os.environ,{'DEEPGRAM_API_KEY':'fake-test-only'}),client(b) as c:
        body={'agentId':'test','sdp':'v=0 fake','type':'offer'}
        assert c.post('/api/offer',headers=HEADERS,json=body).status_code==200
        assert c.post('/api/offer',headers=HEADERS,json=body).status_code==409
        assert c.delete('/api/session',headers=HEADERS).json()=={'closed':True}
        assert ('delete','/v1/sessions/session-1') in b.calls

def test_offer_limits_and_unknown_fields():
    b=Bridge()
    with patch.dict(os.environ,{'DEEPGRAM_API_KEY':'fake-test-only'}),client(b) as c:
        assert c.post('/api/offer',headers=HEADERS,json={'agentId':'test','sdp':'v=0','type':'offer','token':'no'}).status_code==400
        assert c.post('/api/offer',headers=HEADERS,json={'agentId':'test','sdp':'v=0'+'a'*66000,'type':'offer'}).status_code==413
        assert not b.calls

def test_private_credentials():
    with tempfile.TemporaryDirectory() as d:
        p=Path(d)/'token';p.write_text(TOKEN);p.chmod(0o600)
        assert private_token(str(p))==TOKEN
        p.chmod(0o644)
        with pytest.raises(ValueError):private_token(str(p))

class CanonicalBridge(Bridge):
    async def get(self, path):
        self.calls.append(('get', path))
        return httpx.Response(200, json={'bindings': [{'agentId':'coach','chatKey':'telegram:42'}]}, request=httpx.Request('GET','http://test'))
    async def post(self, path, json):
        self.calls.append(('post', path, json))
        return httpx.Response(200, json={'sessionId':'s-1'}, request=httpx.Request('POST','http://test'))

def test_canonical_mode_uses_bound_shared_session():
    b=CanonicalBridge()
    app=create_app(TOKEN,'cd'*32,client=b,rtc_factory=RTC,pipeline=pipeline,canonical=True)
    with patch.dict(os.environ,{'DEEPGRAM_API_KEY':'k'}),TestClient(app,base_url='http://127.0.0.1:8788') as c:
        data=c.get('/api/agents',headers=HEADERS).json()
        assert data['mode']=='shared' and [a['id'] for a in data['agents']]==['coach']
        assert c.post('/api/offer',headers=HEADERS,json={'agentId':'other','sdp':'v=0','type':'offer'}).status_code==503
        assert c.post('/api/offer',headers=HEADERS,json={'agentId':'coach','sdp':'v=0','type':'offer'}).status_code==200
        assert ('post','/voice/browser-sessions',{'agentId':'coach','chatKey':'telegram:42'}) in b.calls
        c.delete('/api/session',headers=HEADERS)
        assert ('delete','/voice/sessions/s-1') in b.calls

def test_public_origin_is_exact_and_https_only():
    with pytest.raises(ValueError):
        create_app(TOKEN,'cd'*32,client=Bridge(),public_origins=('http://box.ts.net',))
    app=create_app(TOKEN,'cd'*32,client=Bridge(),public_origins=('https://box.tail1.ts.net:8444',))
    with TestClient(app,base_url='http://127.0.0.1:8788') as c:
        ok={**HEADERS,'host':'box.tail1.ts.net:8444','origin':'https://box.tail1.ts.net:8444'}
        assert c.get('/api/agents',headers=ok).status_code==200
        assert c.get('/api/agents',headers={**ok,'origin':'https://box.tail1.ts.net'}).status_code==403
