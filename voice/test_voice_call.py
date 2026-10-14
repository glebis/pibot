import importlib.util,json
from pathlib import Path
import pytest

SCRIPT=Path(__file__).parents[1]/'scripts'/'voice-call.py'
if not SCRIPT.exists():SCRIPT=Path(__file__).with_name('voice-call.py')
spec=importlib.util.spec_from_file_location('voice_call',SCRIPT)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
TOKENS={'PHONE_CONTROL_TOKEN':'ab'*32,'VOICE_BRIDGE_TOKEN':'cd'*32}

class HTTP:
 def __init__(self,bindings):self.bindings=bindings;self.calls=[];self.unknown=False
 def __call__(self,method,url,token,body=None):
  self.calls.append((method,url,body))
  if method=='GET':return {'bindings':self.bindings}
  if self.unknown:raise m.UnknownOutcome('unknown')
  return {'attemptId':body['attemptId'],'state':'accepted','providerCallId':'CA'+'1'*32}
def run(args,http,out):return m.run(['--secrets','private.enc.json',*args],load=lambda _:TOKENS,send=http,out=out.append)
def test_list_never_dials_or_prints_chat():
 h=HTTP([{'agentId':'agent','chatKey':'telegram:123'}]);out=[];run(['--list'],h,out)
 assert out==['agent'] and [c[0] for c in h.calls]==['GET']
 assert '123' not in str(out)
@pytest.mark.parametrize('bindings',[[],[{'agentId':'other','chatKey':'telegram:123'}],[{'agentId':'agent','chatKey':'telegram:123'},{'agentId':'agent','chatKey':'telegram:456'}]])
def test_missing_or_ambiguous_agent_never_dials(bindings):
 h=HTTP(bindings)
 with pytest.raises(ValueError):run(['--call','--agent','agent'],h,[])
 assert all(c[0]=='GET' for c in h.calls)
def test_call_once_and_preserves_lookup_on_unknown():
 h=HTTP([{'agentId':'agent','chatKey':'telegram:123'}]);h.unknown=True;out=[]
 with pytest.raises(m.UnknownOutcome):run(['--call','--agent','agent','--duration','60'],h,out)
 assert [c[0] for c in h.calls]==['GET','POST']
 assert h.calls[-1][2]['maxDurationSeconds']==60
 assert json.loads(out[0])['attemptId'].startswith('manual-')
 assert 'chatKey' not in str(out)
def test_requires_explicit_call_and_valid_duration():
 h=HTTP([])
 with pytest.raises(ValueError):run(['--call','--agent','agent','--duration','181'],h,[])
 assert not h.calls
 with pytest.raises(SystemExit):run(['--agent','agent'],h,[])
def test_status_does_not_get_bindings_or_dial():
 calls=[];out=[]
 def send(method,url,token,body=None):
  calls.append((method,url));return {'attemptId':'manual-id','state':'unknown'}
 run(['--status','manual-id'],send,out)
 assert calls==[('GET','http://127.0.0.1:8793/control/calls/manual-id')]
 assert json.loads(out[0])=={'attemptId':'manual-id','state':'unknown'}
