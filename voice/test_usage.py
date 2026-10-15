from dataclasses import replace
import pytest
from service import Config,Ledger,create_apps
from fastapi.testclient import TestClient
from usage import UsageEvidence
from costs import PUBLIC_RATES_REVIEWED_AT

@pytest.fixture
def config(tmp_path):
    tmp_path.chmod(0o700)
    return Config('https://voice.test','AC'+'1'*32,'secret','SK'+'2'*32,'key','+491234567890','+15551234567','123456','ab'*32,'cd'*32,str(tmp_path/'calls.db'))

def row():return dict(id='attempt1',sid='CA'+'3'*32,auth_started=None,usage_evidence_version=1,max_duration=180)
def body(c):return dict(sid=row()['sid'],account_sid=c.account_sid,to=c.owner_number,**{'from':c.from_number},status='busy',duration='0',price='-0.000',price_unit='USD')
async def evidence(c,b,r=None):
    async def fetch(sid):return b
    return await UsageEvidence(c,fetch,clock=lambda:PUBLIC_RATES_REVIEWED_AT+1).check(r or row())

@pytest.mark.asyncio
async def test_confirmed_zero_and_ceil(config):
    assert (await evidence(config,body(config)))['remainingExposureMinor']==0
    b=body(config);b['price']='-0.000001'
    assert (await evidence(config,b))['confirmedTwilioMinor']==1

@pytest.mark.asyncio
@pytest.mark.parametrize('field,value',[('price',None),('price','NaN'),('price','Infinity'),('price','0.20'),('price','-1e-3'),('price',0),('price_unit','EUR'),('sid','CA'+'4'*32),('account_sid','AC'+'4'*32),('to','+491111111111'),('from','+15555555555'),('duration',None),('duration',0),('duration','-1'),('duration','1.1')])
async def test_invalid_keeps_reservation(config,field,value):
    b=body(config);b[field]=value;r=await evidence(config,b)
    assert 'confirmedTwilioMinor' not in r and r['remainingExposureMinor'] is None

@pytest.mark.asyncio
async def test_pending_legacy_authenticated_expired(config):
    b=body(config);b['status']='in-progress'
    assert not (await evidence(config,b))['terminal']
    b=body(config);r=row();r['usage_evidence_version']=None
    result=await evidence(config,b,r)
    assert result['confirmedTwilioMinor']==0 and result['remainingExposureMinor'] is None
    r=row();r['auth_started']=10
    assert (await evidence(config,b,r))['remainingExposureMinor']==23
    async def fetch(sid):return b
    result=await UsageEvidence(config,fetch,clock=lambda:PUBLIC_RATES_REVIEWED_AT+8*86400).check(r)
    assert result['remainingExposureMinor'] is None

@pytest.mark.asyncio
async def test_cache_and_provider_failure(config):
    calls=[]
    async def fetch(sid):calls.append(sid);raise TimeoutError()
    e=UsageEvidence(config,fetch,clock=lambda:PUBLIC_RATES_REVIEWED_AT+1)
    assert (await e.check(row()))['remainingExposureMinor'] is None
    await e.check(row());assert len(calls)==1


def test_endpoint_auth_identity_and_legacy_migration(config):
    class Network:
        dials=0
        async def dial(self,*args):self.dials+=1;raise AssertionError('Read-only usage must not dial')
        async def usage(self,sid):return body(config)
    public,control=create_apps(config,network=Network());ledger=public.state.ledger
    ledger.reserve('attempt1','assistant','telegram:123');ledger.bind('attempt1',row()['sid'])
    c=TestClient(control,client=('127.0.0.1',45678));headers={'authorization':'Bearer '+config.control_token}
    assert c.get('/control/calls/attempt1/usage').status_code==403
    assert c.get('/control/calls/missing/usage',headers=headers).status_code==404
    assert c.get('/control/calls/bad!/usage',headers=headers).status_code==400
    assert Network.dials==0
    assert TestClient(public).get('/control/calls/attempt1/usage').status_code==404
    result=c.get('/control/calls/attempt1/usage',headers=headers).json()
    assert result['confirmedTwilioMinor']==0 and result['remainingExposureMinor']==0
    assert config.owner_number not in str(result) and config.from_number not in str(result)
    ledger.close()


def test_additive_migration_does_not_certify_historical_calls(config):
    import sqlite3
    db=sqlite3.connect(config.ledger_path)
    db.execute('CREATE TABLE calls (id TEXT PRIMARY KEY, agent TEXT, chat TEXT, state TEXT, sid TEXT UNIQUE, created REAL, auth_started REAL, tries INTEGER DEFAULT 0)')
    db.execute("INSERT INTO calls VALUES ('old','assistant','telegram:123','completed',NULL,1,NULL,0)")
    db.commit();db.close();__import__("os").chmod(config.ledger_path,0o600)
    ledger=Ledger(config.ledger_path)
    assert ledger.get('old')['usage_evidence_version'] is None
    ledger.reserve('new','assistant','telegram:123')
    ledger.db.execute("UPDATE calls SET auth_started=123,state='completed' WHERE id='new'")
    ledger.close();ledger=Ledger(config.ledger_path)
    assert ledger.get('new')['auth_started']==123 and ledger.get('new')['usage_evidence_version']==1
    ledger.close()

@pytest.mark.asyncio
async def test_connected_keeps_bounded_residual_and_cache(config):
    calls=[]
    async def fetch(sid):calls.append(sid);b=body(config);b.update(status='completed',duration='60',price='-0.3763');return b
    now=[PUBLIC_RATES_REVIEWED_AT+1]
    e=UsageEvidence(config,fetch,clock=lambda:now[0])
    result=await e.check(row())
    assert result['confirmedTwilioMinor']==38 and result['remainingExposureMinor']==23
    assert result['residualKind']=='bounded_speech_and_media_exposure'
    now[0]+=30
    assert (await e.check(row()))['checkedAt']==result['checkedAt']
    assert len(calls)==1
    now[0]+=31;await e.check(row());assert len(calls)==2

@pytest.mark.asyncio
async def test_over_cap_duration_keeps_residual_unknown(config):
    b=body(config);b.update(status='completed',duration='181',price='-1.50')
    result=await evidence(config,b)
    assert result['confirmedTwilioMinor']==150 and result['remainingExposureMinor'] is None
