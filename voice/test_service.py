import base64,hashlib,hmac,time
from dataclasses import replace
import pytest
from fastapi.testclient import TestClient
from service import Config,Ledger,create_apps,bridge_greeting,DEFAULT_GREETING

@pytest.fixture
def config(tmp_path):
    tmp_path.chmod(0o700)
    return Config('https://voice.test','AC'+'1'*32,'secret','SK'+'2'*32,'key','+491234567890','+15551234567','123456','ab'*32,'cd'*32,str(tmp_path/'calls.db'))
class Network:
    def __init__(self):self.dials=0;self.calls=[];self.fail=False
    async def dial(self,id,duration):
        self.dials+=1;self.duration=duration
        if self.fail:raise TimeoutError()
        return {'sid':'CA'+'3'*32}
    async def bridge(self,*args):self.calls.append(args);return {'sessionId':'session1','text':'answer'}
def clients(c,n):
    public,control=create_apps(c,network=n)
    return public,TestClient(public),TestClient(control,client=('127.0.0.1',54321))
def dial(client,c,id='attempt1'):
    return client.post('/control/calls',headers={'authorization':'Bearer '+c.control_token},json={'attemptId':id,'agentId':'pibot','chatKey':'telegram:123','reason':'urgent'})
def callback(client,c,path,**extra):
    data={'AccountSid':c.account_sid,'To':c.owner_number,'From':c.from_number,'CallSid':'CA'+'3'*32,**extra}
    url=c.public_url+path;payload=url+''.join(k+v for k,v in sorted(data.items()))
    sig=base64.b64encode(hmac.new(c.auth_token.encode(),payload.encode(),hashlib.sha1).digest()).decode()
    return client.post(path,data=data,headers={'x-twilio-signature':sig})
def test_auth_local_and_separate_public(config):
    n=Network();app,p,c=clients(config,n)
    assert c.post('/control/calls',json={}).status_code==403
    assert p.post('/control/calls',json={}).status_code==404
    assert n.dials==0

def test_idempotent_and_unknown_not_retried(config):
    n=Network();n.fail=True;app,p,c=clients(config,n)
    assert dial(c,config).json()['state']=='unknown'
    assert dial(c,config).json()['state']=='unknown'
    assert dial(c,config,'attempt2').status_code==409
    assert n.dials==1

def test_pin_gate_and_three_failures(config):
    n=Network();app,p,c=clients(config,n);dial(c,config)
    assert 'Gather' in callback(p,config,'/answer?attempt=attempt1').text
    for _ in range(3):r=callback(p,config,'/authenticate?attempt=attempt1',Digits='000000')
    assert 'Hangup' in r.text and '<Connect>' not in r.text
    assert n.calls==[]

def test_pin_success_expiry_and_fixed_path(config):
    n=Network();app,p,c=clients(config,n);dial(c,config)
    callback(p,config,'/answer?attempt=attempt1')
    r=callback(p,config,'/authenticate?attempt=attempt1',Digits=config.pin)
    assert 'wss://voice.test/ws/attempt1' in r.text and '/ws/attempt1?' not in r.text
    assert app.state.ledger.get('attempt1')['state']=='authenticated'
    assert not n.calls

def test_expired_pin_denied(config):
    n=Network();app,p,c=clients(config,n);dial(c,config)
    callback(p,config,'/answer?attempt=attempt1')
    app.state.ledger.db.execute('UPDATE calls SET auth_started=?',(time.time()-31,))
    assert '<Connect>' not in callback(p,config,'/authenticate?attempt=attempt1',Digits=config.pin).text

def test_restart_never_replays(config):
    n=Network();app,p,c=clients(config,n);dial(c,config)
    app.state.ledger.close()
    ledger=Ledger(config.ledger_path)
    assert ledger.get('attempt1')['state']=='unknown'
    assert n.dials==1

def test_status_completion_allows_new_attempt(config):
    n=Network();app,p,c=clients(config,n);dial(c,config)
    assert callback(p,config,'/status?attempt=attempt1',CallStatus='completed').status_code==204
    assert app.state.ledger.get('attempt1')['state']=='completed'


def test_stream_requires_pin_and_cleans_bridge(config):
    from starlette.websockets import WebSocketDisconnect
    n=Network()
    original_bridge=n.bridge
    async def trusted_bridge(*args):
        result=await original_bridge(*args)
        if args[:2]==('POST','/voice/sessions'):result['greeting']='Your agent needs a decision. Please check Telegram to approve.'
        return result
    n.bridge=trusted_bridge
    spoken=[]
    async def runner(ws,stream,call,c,turn,**kwargs):
        spoken.append(kwargs['greeting'])
        assert await turn('hello')=='answer'
    app,control=create_apps(config,network=n,runner=runner)
    p=TestClient(app);client=TestClient(control,client=('127.0.0.1',4321))
    dial(client,config)
    url=config.public_url+'/ws/attempt1'
    sig=base64.b64encode(hmac.new(config.auth_token.encode(),url.encode(),hashlib.sha1).digest()).decode()
    with pytest.raises(WebSocketDisconnect):
        with p.websocket_connect('/ws/attempt1',headers={'x-twilio-signature':sig}):pass
    assert not n.calls
    assert not spoken
    callback(p,config,'/answer?attempt=attempt1')
    callback(p,config,'/authenticate?attempt=attempt1',Digits=config.pin)
    stream='MZ'+'4'*32
    with p.websocket_connect('/ws/attempt1',headers={'x-twilio-signature':sig}) as ws:
        ws.send_json({'event':'connected','protocol':'Call','version':'1.0.0'})
        ws.send_json({'event':'start','streamSid':stream,'start':{'streamSid':stream,'callSid':'CA'+'3'*32,'accountSid':config.account_sid,'mediaFormat':{'encoding':'audio/x-mulaw','sampleRate':8000,'channels':1}}})
        with pytest.raises(WebSocketDisconnect):ws.receive_text()
    assert [x[0] for x in n.calls]==['POST','POST','DELETE']
    assert n.calls[0][1]=='/voice/sessions'
    assert n.calls[0][2]['chatKey']=='telegram:123'
    assert spoken==['Your agent needs a decision. Please check Telegram to approve.']

def test_single_writer(config):
    ledger=Ledger(config.ledger_path)
    with pytest.raises(RuntimeError):Ledger(config.ledger_path)
    ledger.close()


def test_status_query_is_local_authenticated(config):
    n=Network();app,p,c=clients(config,n);dial(c,config)
    assert c.get('/control/calls/attempt1').status_code==403
    assert c.get('/control/calls/attempt1',headers={'authorization':'Bearer '+config.control_token}).json()=={'attemptId':'attempt1','state':'accepted','providerCallId':'CA'+'3'*32}
    assert p.get('/control/calls/attempt1').status_code==404


def test_duplicate_and_old_status_never_regresses_completion(config):
    n=Network();app,p,c=clients(config,n);dial(c,config)
    for status in ('completed','completed','ringing','in-progress'):
        assert callback(p,config,'/status?attempt=attempt1',CallStatus=status).status_code==204
        assert app.state.ledger.get('attempt1')['state']=='completed'

def test_duration_bound_and_provider_receipt(config):
    config=replace(config,duration=90)
    n=Network();app,p,c=clients(config,n)
    body={'attemptId':'attempt1','agentId':'pibot','chatKey':'telegram:123','maxDurationSeconds':120}
    headers={'authorization':'Bearer '+config.control_token}
    r=c.post('/control/calls',headers=headers,json=body)
    assert r.json()['providerCallId']=='CA'+'3'*32
    assert n.duration==90 and app.state.ledger.get('attempt1')['max_duration']==90
    body['maxDurationSeconds']=False
    assert c.post('/control/calls',headers=headers,json=body).status_code==400


@pytest.mark.parametrize('value', [None,42,{},'', '  ', 'x'*1601, '\x00unsafe', '\ud800', '😀'*1600])
def test_invalid_bridge_greeting_falls_back(value):
    assert bridge_greeting({'greeting':value})==DEFAULT_GREETING

def test_greeting_is_bounded_plain_text_and_optional():
    assert bridge_greeting({})==DEFAULT_GREETING
    assert bridge_greeting({'greeting':'Please\n review\t the question.'})=='Please review the question.'
    assert bridge_greeting({'greeting':'x'*1600})=='x'*1600
