"""Offline phone binding/lifecycle tests; no calls or speech requests."""
import base64
import hashlib
import hmac
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from phone_server import PhoneConfig, create_app, valid_signature, validate_start

ACCOUNT = 'AC' + '1' * 32
CALL = 'CA' + '2' * 32
STREAM = 'MZ' + '3' * 32

@pytest.fixture
def config(tmp_path):
    binding = tmp_path / 'call.sid'
    binding.write_text(CALL)
    binding.chmod(0o600)
    return PhoneConfig('https://example.test', 'fake-auth-token', ACCOUNT, str(binding), 'pibot', 'ab'*32)

def signature(config):
    return base64.b64encode(hmac.new(config.auth_token.encode(), (config.public_url+'/ws').encode(), hashlib.sha1).digest()).decode()

def start():
    return {'event':'start','streamSid':STREAM,'start': {'streamSid':STREAM,'callSid':CALL,'accountSid':ACCOUNT,
        'mediaFormat':{'encoding':'audio/x-mulaw','sampleRate':8000,'channels':1}}}

def send_start(ws, frame=None):
    ws.send_json({'event':'connected','protocol':'Call','version':'1.0.0'})
    ws.send_json(frame or start())

class Bridge:
    def __init__(self): self.calls=[]
    async def create(self): self.calls.append('create'); return 'session-1'
    async def turn(self,sid,text): self.calls.append(('turn',sid,text)); return 'answer'
    async def close(self,sid): self.calls.append(('close',sid))

async def done(*args): pass

def test_signature_only_exact_configured_url(config):
    assert valid_signature(config,signature(config))
    assert not valid_signature(config,'fake')
    wrong=base64.b64encode(hmac.new(config.auth_token.encode(),b'wss://example.test/ws',hashlib.sha1).digest()).decode()
    assert valid_signature(config,wrong)
    unrelated=base64.b64encode(hmac.new(config.auth_token.encode(),b'https://other.test/ws',hashlib.sha1).digest()).decode()
    assert not valid_signature(config,unrelated)
    slash=base64.b64encode(hmac.new(config.auth_token.encode(),b'https://example.test/ws/',hashlib.sha1).digest()).decode()
    assert valid_signature(config,slash)

def test_start_binding_and_private_file(config):
    assert validate_start(start(),config)==(STREAM,CALL)
    for field,bad in [('callSid','CA'+'4'*32),('accountSid','AC'+'4'*32),('streamSid','MZ'+'4'*32)]:
        frame=start();frame['start'][field]=bad
        with pytest.raises(ValueError):validate_start(frame,config)
    Path(config.call_sid_file).chmod(0o644)
    with pytest.raises(ValueError):validate_start(start(),config)

def test_invalid_signature_never_opens_bridge(config):
    bridge=Bridge()
    with TestClient(create_app(config,bridge=bridge,runner=done)) as client:
        assert client.get('/health').json()=={'ok':True}
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/ws',headers={'x-twilio-signature':'wrong'}):pass
    assert bridge.calls==[]

def test_invalid_start_never_opens_bridge(config):
    bridge=Bridge()
    with TestClient(create_app(config,bridge=bridge,runner=done)) as client:
        with client.websocket_connect('/ws',headers={'x-twilio-signature':signature(config)}) as ws:
            frame=start();frame['start']['callSid']='CA'+'4'*32
            send_start(ws,frame)
            with pytest.raises(WebSocketDisconnect):ws.receive_text()
    assert bridge.calls==[]

def test_valid_call_closes_bridge_and_refuses_second_call(config):
    bridge=Bridge()
    with TestClient(create_app(config,bridge=bridge,runner=done)) as client:
        with client.websocket_connect('/ws',headers={'x-twilio-signature':signature(config)}) as ws:
            send_start(ws)
            with pytest.raises(WebSocketDisconnect):ws.receive_text()
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/ws',headers={'x-twilio-signature':signature(config)}):pass
    assert bridge.calls==['create',('close','session-1')]

def test_pipeline_failure_closes_bridge(config):
    bridge=Bridge()
    async def broken(*args):raise RuntimeError('secret-provider-text')
    with TestClient(create_app(config,bridge=bridge,runner=broken)) as client:
        with client.websocket_connect('/ws',headers={'x-twilio-signature':signature(config)}) as ws:
            send_start(ws)
            with pytest.raises(WebSocketDisconnect):ws.receive_text()
    assert bridge.calls==['create',('close','session-1')]

def test_deadline_cancels_and_cleans_up(config):
    import asyncio
    from dataclasses import replace
    bridge=Bridge()
    async def wait(*args):await asyncio.Event().wait()
    config=replace(config,duration=.01)
    with TestClient(create_app(config,bridge=bridge,runner=wait)) as client:
        with client.websocket_connect('/ws',headers={'x-twilio-signature':signature(config)}) as ws:
            send_start(ws)
            with pytest.raises(WebSocketDisconnect):ws.receive_text()
    assert bridge.calls==['create',('close','session-1')]
