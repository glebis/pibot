from dataclasses import replace
from types import SimpleNamespace
import pytest
from costs import CostEvidence,PUBLIC_RATES_REVIEWED_AT,PUBLIC_RATES_EXPIRE_AT

@pytest.mark.asyncio
async def test_cost_scope_cap_and_stable_digest():
    clock=[PUBLIC_RATES_REVIEWED_AT+100]
    config=SimpleNamespace(cost_owner_id='owner',cost_recipient_ref='phone-owner',owner_number='+491234567890',duration=180)
    calls=[]
    async def rates():
        calls.append(1)
        return {'price_unit':'USD','outbound_prefix_prices':[{'destination_prefixes':['49'],'current_price':'0.3763','base_price':'0.3763'}]}
    e=CostEvidence(config,fetch_rates=rates,clock=lambda:clock[0])
    first=await e.check();clock[0]+=1;second=await e.check()
    assert first['maxExposureMinor']==174 and first['verified']
    assert first['digest']==second['digest'] and first['checkedAt']!=second['checkedAt']
    assert first['costScope']=='telephone_speech_infrastructure' and first['modelBudgetBound'] is False
    assert len(calls)==1
    clock[0]+=86400
    assert (await e.check())['verified'] and len(calls)==2
    clock[0]=PUBLIC_RATES_EXPIRE_AT
    assert (await e.check())['verified'] is False

@pytest.mark.asyncio
async def test_bad_or_unavailable_rates_deny():
    c=SimpleNamespace(cost_owner_id='owner',cost_recipient_ref='phone',owner_number='+49123',duration=180)
    async def rates():raise RuntimeError('secret')
    proof=await CostEvidence(c,fetch_rates=rates,clock=lambda:PUBLIC_RATES_REVIEWED_AT+1).check()
    assert proof=={'verified':False,'reason':'rate_evidence_unavailable'}
    c.cost_owner_id=''
    assert (await CostEvidence(c,fetch_rates=rates).check())['verified'] is False

@pytest.mark.asyncio
async def test_speech_budgets_guard_actual_provider_calls(monkeypatch):
    from bounded_speech import SpeechBudget,BoundedSTT,BoundedTTS
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.deepgram.tts import DeepgramTTSService
    sent=[]
    async def audio(self,payload):sent.append(('audio',len(payload)));yield None
    async def text(self,value,context):sent.append(('text',len(value.encode())));yield None
    monkeypatch.setattr(DeepgramSTTService,'run_stt',audio)
    monkeypatch.setattr(DeepgramTTSService,'run_tts',text)
    budget=SpeechBudget(1)
    stt=BoundedSTT(budget=budget,api_key='offline-test')
    tts=BoundedTTS(budget=budget,api_key='offline-test')
    assert [x async for x in stt.run_stt(b'x'*32000)]==[None]
    assert [x async for x in tts.run_tts('é'*3000,'context')]==[None]
    assert [x async for x in stt.run_stt(b'x')][0].fatal
    assert [x async for x in tts.run_tts('a','context')][0].fatal
    assert sent==[('audio',32000),('text',6000)]

def test_cost_endpoint_private_and_requires_fixed_identity(tmp_path):
    from fastapi.testclient import TestClient
    from service import Config,create_apps
    tmp_path.chmod(0o700)
    c=Config('https://voice.test','AC'+'1'*32,'secret','SK'+'2'*32,'key','+491234567890','+15551234567','123456','ab'*32,'cd'*32,str(tmp_path/'ledger.sqlite'))
    public,control=create_apps(c)
    with TestClient(control,client=('127.0.0.1',1234)) as client:
        assert client.get('/control/cost-evidence').status_code==403
        proof=client.get('/control/cost-evidence',headers={'authorization':'Bearer '+c.control_token}).json()
        assert proof['verified'] is False
    assert TestClient(public).get('/control/cost-evidence').status_code==404

@pytest.mark.asyncio
async def test_stt_connection_never_retries(monkeypatch):
    from bounded_speech import BoundedSTT,SpeechBudget
    from unittest.mock import AsyncMock
    stt=BoundedSTT(budget=SpeechBudget(180),api_key='offline-test')
    calls=[]
    class Connection:
        async def __aenter__(self):calls.append(1);raise RuntimeError('private provider failure')
        async def __aexit__(self,*args):pass
    class Listen:
        def connect(self,**kwargs):return Connection()
    stt._client=SimpleNamespace(listen=SimpleNamespace(v1=Listen()))
    stt.push_frame=AsyncMock()
    await stt._connection_handler()
    assert len(calls)==1
    assert stt.push_frame.await_args.args[0].fatal
    assert 'private provider' not in stt.push_frame.await_args.args[0].error
