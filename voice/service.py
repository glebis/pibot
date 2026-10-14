"""Persistent outbound-only phone service: fixed owner, PIN gate, no call replay."""
from __future__ import annotations
import asyncio, base64, contextlib, fcntl, hashlib, hmac, ipaddress, json, os, re, sqlite3, stat, time
from dataclasses import dataclass, replace
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse
from uuid import uuid4
from xml.sax.saxutils import escape
import aiohttp
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import Response
from phone_server import run_phone

IDENT = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
DEFAULT_GREETING = 'Hello. Your PiBot agent is ready. What would you like to discuss?'

def bridge_greeting(result):
    # Only called on the authenticated loopback session response, after PIN and
    # Twilio stream binding. Never use public call/websocket payloads as speech.
    value = result.get('greeting')
    if not isinstance(value, str) or not value.strip() or len(value) > 1600:
        return DEFAULT_GREETING
    if any(ord(char) < 32 and char not in '\n\r\t' for char in value):
        return DEFAULT_GREETING
    try:
        if len(value.encode('utf-8')) > 6000:
            return DEFAULT_GREETING
    except UnicodeError:
        return DEFAULT_GREETING
    return ' '.join(value.split())

ACTIVE = ('dispatching','accepted','authenticated','streaming','unknown','denied')

@dataclass(frozen=True)
class Config:
    public_url: str
    account_sid: str
    auth_token: str
    api_key_sid: str
    api_key_secret: str
    owner_number: str
    from_number: str
    pin: str
    control_token: str
    bridge_token: str
    ledger_path: str
    bridge_url: str = 'http://127.0.0.1:8792'
    duration: int = 180
    cost_owner_id: str = ""
    cost_recipient_ref: str = ""
    def __post_init__(self):
        p=urlparse(self.public_url); b=urlparse(self.bridge_url)
        if p.scheme!='https' or not p.hostname or p.path not in ('','/') or p.query or p.fragment or p.username: raise ValueError('HTTPS public origin required')
        if b.scheme!='http' or b.hostname!='127.0.0.1' or b.path or b.query or b.fragment or b.username: raise ValueError('Local bridge required')
        if not re.fullmatch(r'AC[0-9a-fA-F]{32}',self.account_sid) or not re.fullmatch(r'SK[0-9a-fA-F]{32}',self.api_key_sid): raise ValueError('Invalid Twilio account/key')
        if not all(re.fullmatch(r'\+[1-9][0-9]{7,14}',x) for x in (self.owner_number,self.from_number)): raise ValueError('Invalid phone binding')
        if not re.fullmatch(r'[0-9]{6,12}',self.pin) or not all(re.fullmatch(r'[0-9a-f]{64}',x) for x in (self.control_token,self.bridge_token)): raise ValueError('Invalid private credentials')
        if self.cost_recipient_ref and not re.fullmatch(r'[A-Za-z0-9._:-]{1,160}',self.cost_recipient_ref):raise ValueError('Opaque cost recipient reference required')
        if not self.auth_token or not self.api_key_secret or not 1<=self.duration<=180: raise ValueError('Invalid service policy')

class Ledger:
    def __init__(self,path):
        p=Path(path);p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        info=p.parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise ValueError('Private ledger directory required')
        self.lock_fd=os.open(str(p)+'.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:fcntl.flock(self.lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BaseException:os.close(self.lock_fd);raise RuntimeError('Voice ledger already active')
        fd=os.open(p,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError('Private ledger required')
        finally:os.close(fd)
        self.db=sqlite3.connect(p,check_same_thread=False,isolation_level=None)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, agent TEXT, chat TEXT, state TEXT, sid TEXT UNIQUE, created REAL, auth_started REAL, tries INTEGER DEFAULT 0)')
        if 'max_duration' not in {r[1] for r in self.db.execute('PRAGMA table_info(calls)')}:
            self.db.execute('ALTER TABLE calls ADD COLUMN max_duration INTEGER NOT NULL DEFAULT 180')
        self.db.execute("UPDATE calls SET state='unknown' WHERE state IN ('dispatching','accepted','authenticated','streaming')")
    def close(self):
        self.db.close();os.close(self.lock_fd)
    def get(self,id):
        row=self.db.execute('SELECT id,agent,chat,state,sid,created,auth_started,tries,max_duration FROM calls WHERE id=?',(id,)).fetchone()
        return dict(zip(('id','agent','chat','state','sid','created','auth_started','tries','max_duration'),row)) if row else None
    def reserve(self,id,agent,chat,duration=180):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            old=self.get(id)
            if old:
                if old['agent']!=agent or old['chat']!=chat or old['max_duration']!=duration:raise ValueError('Attempt identity conflict')
                self.db.execute('COMMIT');return old,False
            if self.db.execute("SELECT 1 FROM calls WHERE state IN ('dispatching','accepted','authenticated','streaming','unknown','denied') LIMIT 1").fetchone():raise RuntimeError('Existing call needs completion or reconciliation')
            self.db.execute("INSERT INTO calls(id,agent,chat,state,created,max_duration) VALUES(?,?,?,'dispatching',?,?)",(id,agent,chat,time.time(),duration))
            self.db.execute('COMMIT');return self.get(id),True
        except BaseException:self.db.execute('ROLLBACK');raise
    def bind(self,id,sid):
        row=self.get(id)
        if not row or row['state'] not in ACTIVE or not re.fullmatch(r'CA[0-9a-fA-F]{32}',sid):raise ValueError('Invalid call binding')
        if row['sid'] and row['sid']!=sid:raise ValueError('Call identity mismatch')
        self.db.execute('UPDATE calls SET sid=? WHERE id=?',(sid,id))
        return self.get(id)
    def state(self,id,state):self.db.execute('UPDATE calls SET state=? WHERE id=?',(state,id))

async def bounded_json(response,limit=65536):
    data=bytearray()
    async for chunk in response.content.iter_chunked(8192):
        data.extend(chunk)
        if len(data)>limit:raise ValueError('Response limit')
    return json.loads(data)

class Network:
    def __init__(self,c):self.c=c
    async def dial(self,id,duration):
        url=self.c.public_url.rstrip('/')
        async with aiohttp.ClientSession() as client:
            async with client.post(f'https://api.twilio.com/2010-04-01/Accounts/{self.c.account_sid}/Calls.json',
                auth=aiohttp.BasicAuth(self.c.api_key_sid,self.c.api_key_secret),
                data={'To':self.c.owner_number,'From':self.c.from_number,'Url':url+'/answer?'+urlencode({'attempt':id}),
                    'Method':'POST','StatusCallback':url+'/status?'+urlencode({'attempt':id}),'StatusCallbackMethod':'POST',
                    'StatusCallbackEvent':'completed','TimeLimit':str(duration),'Timeout':'20'},
                timeout=aiohttp.ClientTimeout(total=15),allow_redirects=False) as r:
                if 400<=r.status<500:return {'rejected':True}
                if r.status!=201:raise ValueError('Unknown call outcome')
                body=await bounded_json(r)
                sid=body.get('sid')
                if not isinstance(sid,str) or not re.fullmatch(r'CA[0-9a-fA-F]{32}',sid):raise ValueError('Unknown call outcome')
                return {'sid':sid}
    async def bridge(self,method,path,body=None):
        async with aiohttp.ClientSession() as client:
            async with client.request(method,self.c.bridge_url+path,json=body,
                headers={'Authorization':'Bearer '+self.c.bridge_token},timeout=aiohttp.ClientTimeout(total=45 if path.endswith('/turn') else 6),allow_redirects=False) as r:
                if r.status not in (200,201):raise ValueError('Bridge unavailable')
                return await bounded_json(r)

def signature(c,url,fields,supplied):
    payload=url+''.join(k+v for k,v in sorted(fields))
    expected=base64.b64encode(hmac.new(c.auth_token.encode(),payload.encode(),hashlib.sha1).digest()).decode()
    return hmac.compare_digest(expected,supplied)

def xml(body):return Response('<?xml version="1.0"?><Response>'+body+'</Response>',media_type='application/xml')
def hangup():return xml('<Say voice="man">Unable to authenticate this call. Goodbye.</Say><Hangup/>')


def create_apps(c:Config,*,network=None,runner=run_phone):
    ledger=Ledger(c.ledger_path);network=network or Network(c)
    from costs import CostEvidence
    cost_evidence=CostEvidence(c)
    public=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
    control=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
    public.state.ledger=control.state.ledger=ledger
    stream_lock=asyncio.Lock()
    async def signed_form(request,completed_ok=False):
        data=bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data)>16384:raise HTTPException(413)
        try:fields=parse_qsl(data.decode(),keep_blank_values=True,strict_parsing=True)
        except Exception:raise HTTPException(400) from None
        if len(dict(fields))!=len(fields):raise HTTPException(400)
        url=c.public_url.rstrip('/')+request.url.path+('?' + request.url.query if request.url.query else '')
        if not signature(c,url,fields,request.headers.get('x-twilio-signature','')):raise HTTPException(403)
        form=dict(fields)
        if form.get('AccountSid')!=c.account_sid or form.get('To')!=c.owner_number or form.get('From')!=c.from_number:raise HTTPException(403)
        id=request.query_params.get('attempt','')
        try:
            previous=ledger.get(id)
            if completed_ok and previous and previous['state']=='completed' and previous['sid']==form.get('CallSid'):
                row=previous
            else:row=ledger.bind(id,form.get('CallSid',''))
        except Exception:raise HTTPException(403) from None
        return row,form
    @public.get('/health')
    async def health():return {'ok':True}
    def control_auth(request):
        try:local=ipaddress.ip_address(request.client.host).is_loopback
        except Exception:local=False
        if not local or not hmac.compare_digest(request.headers.get('authorization',''),'Bearer '+c.control_token):raise HTTPException(403)
    @control.get('/control/cost-evidence')
    async def evidence(request:Request):
        control_auth(request)
        return await cost_evidence.check()
    @control.get('/control/calls/{id}')
    async def inspect_call(id:str,request:Request):
        control_auth(request)
        row=ledger.get(id)
        if not row:raise HTTPException(404)
        return {'attemptId':id,'state':row['state'],'providerCallId':row['sid']}
    @control.post('/control/calls')
    async def dial(request:Request):
        control_auth(request)
        data=bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data)>4096:raise HTTPException(413)
        try:
            body=json.loads(data);id,agent,chat=body['attemptId'],body['agentId'],body['chatKey']
            if set(body)-{'attemptId','agentId','chatKey','reason','maxDurationSeconds'} or not all(isinstance(x,str) for x in (id,agent,chat)) or not IDENT.fullmatch(id) or not IDENT.fullmatch(agent) or not 1<=len(chat)<=256:raise ValueError()
            requested=body.get('maxDurationSeconds',c.duration)
            if isinstance(requested,bool) or not isinstance(requested,int) or not 1<=requested<=180:raise ValueError('Invalid duration')
            duration=min(c.duration,requested)
            row,fresh=ledger.reserve(id,agent,chat,duration)
        except RuntimeError:raise HTTPException(409,'Call needs reconciliation') from None
        except Exception:raise HTTPException(400,'Invalid call request') from None
        if fresh:
            try:
                result=await network.dial(id,row['max_duration'])
                if result.get('rejected'):ledger.state(id,'rejected')
                else:
                    row=ledger.bind(id,result['sid'])
                    if row['state']=='dispatching':ledger.state(id,'accepted')
            except Exception:
                if ledger.get(id)['state']=='dispatching':ledger.state(id,'unknown')
        final=ledger.get(id)
        print('voice_service call_'+final['state'],flush=True)
        return {'attemptId':id,'state':final['state'],'providerCallId':final['sid']}
    def gather(id):
        action=escape(c.public_url.rstrip('/')+'/authenticate?'+urlencode({'attempt':id}),{'"':'&quot;'})
        return xml(f'<Gather input="dtmf" numDigits="{len(c.pin)}" timeout="10" actionOnEmptyResult="true" action="{action}" method="POST"><Say voice="man">Enter your phone access PIN, then wait.</Say></Gather><Hangup/>')
    @public.post('/answer')
    async def answer(request:Request):
        row,_=await signed_form(request)
        if row['state'] not in ('dispatching','accepted','unknown'):return hangup()
        if row['auth_started'] is None:
            ledger.db.execute('UPDATE calls SET auth_started=? WHERE id=?',(time.time(),row['id']))
        elif time.time()-row['auth_started']>30:
            ledger.state(row['id'],'denied');return hangup()
        return gather(row['id'])
    @public.post('/authenticate')
    async def authenticate(request:Request):
        row,form=await signed_form(request)
        if row['state'] not in ('dispatching','accepted','unknown') or row['auth_started'] is None or time.time()-row['auth_started']>30 or row['tries']>=3:
            ledger.state(row['id'],'denied');return hangup()
        ledger.db.execute('UPDATE calls SET tries=tries+1 WHERE id=?',(row['id'],))
        if not hmac.compare_digest(form.get('Digits',''),c.pin):
            if row['tries']>=2:ledger.state(row['id'],'denied');return hangup()
            return gather(row['id'])
        ledger.state(row['id'],'authenticated')
        url='wss'+c.public_url.rstrip('/')[5:]+'/ws/'+row['id']
        return xml('<Connect><Stream url="'+escape(url,{'"':'&quot;'})+'"/></Connect><Hangup/>')
    @public.post('/status')
    async def status(request:Request):
        row,form=await signed_form(request,completed_ok=True)
        if form.get('CallStatus') in ('completed','failed','busy','no-answer','canceled'):ledger.state(row['id'],'completed')
        return Response(status_code=204)
    @public.websocket('/ws/{id}')
    async def websocket(ws:WebSocket,id:str):
        url=c.public_url.rstrip('/')+'/ws/'+id
        urls=(url,url+'/', 'wss'+url[5:],'wss'+url[5:]+'/')
        if ws.url.query or not any(signature(c,u,[],ws.headers.get('x-twilio-signature','')) for u in urls) or stream_lock.locked():await ws.close(code=1008);return
        row=ledger.get(id)
        if not row or row['state']!='authenticated':await ws.close(code=1008);return
        async with stream_lock:
            await ws.accept();sid=None
            try:
                async with asyncio.timeout(10):
                    async def frame():
                        raw=await ws.receive_text()
                        if len(raw)>8192:raise ValueError('Handshake limit')
                        return json.loads(raw)
                    connected=await frame();envelope=await frame();start=envelope.get('start',{})
                    if connected.get('event')!='connected' or connected.get('protocol')!='Call' or connected.get('version')!='1.0.0' or envelope.get('event')!='start' or envelope.get('streamSid')!=start.get('streamSid') or start.get('accountSid')!=c.account_sid or start.get('callSid')!=row['sid'] or not re.fullmatch(r'MZ[0-9a-fA-F]{32}',start.get('streamSid','')) or start.get('mediaFormat')!={'encoding':'audio/x-mulaw','sampleRate':8000,'channels':1}:raise ValueError('Invalid stream')
                ledger.state(id,'streaming')
                async with asyncio.timeout(min(c.duration,row['max_duration'])):
                    result=await network.bridge('POST','/voice/sessions',{'callSid':row['sid'],'agentId':row['agent'],'chatKey':row['chat']})
                    greeting=bridge_greeting(result)
                    sid=result['sessionId']
                    if not isinstance(sid,str) or not IDENT.fullmatch(sid):raise ValueError('Invalid bridge session')
                    async def turn(text):
                        result=await network.bridge('POST',f'/voice/sessions/{sid}/turn',{'requestId':str(uuid4()),'text':text})
                        answer=result.get('text')
                        if not isinstance(answer,str) or not answer.strip() or len(answer)>12000:raise ValueError('Invalid response')
                        return answer
                    await runner(ws,start['streamSid'],row['sid'],replace(c,duration=min(c.duration,row['max_duration'])),turn,
                        greeting=greeting)
            except Exception as error:
                print('voice_service pipeline_error '+type(error).__name__,flush=True)
            finally:
                print('voice_service pipeline_stopped',flush=True)
                with contextlib.suppress(Exception):await ws.close(code=1000)
                if sid:
                    with contextlib.suppress(Exception):await asyncio.wait_for(network.bridge('DELETE',f'/voice/sessions/{sid}'),6)
                # Completion is provider-confirmed by status callback. A lost callback
                # stays unknown; never release a possibly live call for auto-redial.
                if ledger.get(id)['state']!='completed':ledger.state(id,'unknown')
    return public,control
