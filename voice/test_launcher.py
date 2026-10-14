import importlib.util,json,os,signal,socket,subprocess,sys,time
from pathlib import Path
from unittest.mock import patch
import pytest

LAUNCHER=Path(__file__).parents[1]/'scripts'/'voice-service.py'
if not LAUNCHER.exists():LAUNCHER=Path(__file__).with_name('voice-service.py')
spec=importlib.util.spec_from_file_location('voice_launcher',LAUNCHER)
launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)

def test_secret_file_private_sops_metadata(tmp_path):
    key=tmp_path/'key';key.write_text('test-key');key.chmod(0o600)
    secret=tmp_path/'secret.json';secret.write_text(json.dumps({'DEEPGRAM_API_KEY':'plaintext'}));secret.chmod(0o600)
    with patch.dict(os.environ,{'SOPS_AGE_KEY_FILE':str(key)}),patch('subprocess.run') as run:
        with pytest.raises(ValueError):launcher.load_secrets([str(secret)])
        run.assert_not_called()
        secret.chmod(0o644)
        with pytest.raises(ValueError):launcher.load_secrets([str(secret)])
        run.assert_not_called()

def test_decrypt_uses_validated_bytes_in_memory(tmp_path):
    key=tmp_path/'key';key.write_text('test-key');key.chmod(0o600)
    secret=tmp_path/'secret.json'
    document={'DEEPGRAM_API_KEY':'ENC[cipher]','sops':{'age':[{'recipient':'age1test'}],'mac':'ENC[mac]'}}
    secret.write_text(json.dumps(document));secret.chmod(0o600)
    result=subprocess.CompletedProcess([],0,b'{"DEEPGRAM_API_KEY":"offline"}',b'')
    with patch.dict(os.environ,{'SOPS_AGE_KEY_FILE':str(key)}),patch('subprocess.run',return_value=result) as run:
        assert launcher.load_secrets([str(secret)])=={'DEEPGRAM_API_KEY':'offline'}
        assert run.call_args.args[0][-1]=='/dev/stdin'
        assert json.loads(run.call_args.kwargs['input'])==document

def test_sigterm_stops_both_servers_before_ledger_close(tmp_path):
    ports=[]
    for _ in range(2):
        with socket.socket() as s:s.bind(('127.0.0.1',0));ports.append(s.getsockname()[1])
    code='''
import asyncio,importlib.util,sys
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI
spec=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2])
def app(name):
 @asynccontextmanager
 async def lifespan(a):
  yield
  (root/(name+'.closed')).write_text('closed')
 return FastAPI(lifespan=lifespan)
def close():
 assert (root/'one.closed').exists() and (root/'two.closed').exists()
 (root/'ledger.closed').write_text('closed')
asyncio.run(m.serve_apps(app('one'),app('two'),ports=(int(sys.argv[3]),int(sys.argv[4])),close=close))
'''
    child=subprocess.Popen([sys.executable,'-c',code,str(LAUNCHER),str(tmp_path),*map(str,ports)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            ready=True
            for port in ports:
                try:
                    with socket.create_connection(('127.0.0.1',port),timeout=.1):pass
                except OSError:ready=False
            if ready:break
            if child.poll() is not None:raise AssertionError('Smoke server failed to start')
            time.sleep(.05)
        else:raise AssertionError('Smoke listeners not ready')
        child.send_signal(signal.SIGTERM)
        out,err=child.communicate(timeout=10)
        assert child.returncode==0,err.decode()
        assert (tmp_path/'ledger.closed').exists()
        for port in ports:
            with pytest.raises(OSError):socket.create_connection(('127.0.0.1',port),timeout=.1)
    finally:
        if child.poll() is None:
            child.terminate()
            try:child.wait(timeout=3)
            except subprocess.TimeoutExpired:child.kill();child.wait()
