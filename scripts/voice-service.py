#!/usr/bin/env python3
"""Launch public Twilio routes and private control routes; decrypt only in memory."""
import argparse, asyncio, contextlib, json, os, signal, stat, subprocess, sys
from pathlib import Path

def private_bytes(path, limit):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_size>limit:
            raise ValueError('Private owner file required')
        return os.read(fd,limit+1)
    finally:os.close(fd)

def read_config(path):
    return json.loads(private_bytes(path,16384))

def load_secrets(paths):
    # The launcher inherits an explicitly configured key-file path. Never search
    # user defaults or print decryption diagnostics/key material.
    key_path=os.environ.get('SOPS_AGE_KEY_FILE')
    if not key_path:raise ValueError('Explicit SOPS key file required')
    private_bytes(key_path,65536)
    secrets={}
    for path in paths:
        encrypted=private_bytes(path,65536)
        document=json.loads(encrypted)
        metadata=document.get('sops') if isinstance(document,dict) else None
        if not isinstance(metadata,dict) or not metadata.get('age') or not str(metadata.get('mac','')).startswith('ENC['):
            raise ValueError('SOPS age metadata required')
        if not all(isinstance(v,str) and v.startswith('ENC[') for k,v in document.items() if k!='sops'):
            raise ValueError('Only encrypted flat secret values accepted')
        result=subprocess.run(['sops','decrypt','--input-type','json','--output-type','json','/dev/stdin'],
            input=encrypted,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False,timeout=20)
        if result.returncode or len(result.stdout)>65536:raise ValueError('Unable to load encrypted voice secrets')
        values=json.loads(result.stdout)
        if not isinstance(values,dict):raise ValueError('Invalid encrypted secret format')
        secrets.update(values)
    return secrets

async def serve_apps(public,control,*,ports=(8790,8793),close=None):
    import uvicorn
    class CoordinatedServer(uvicorn.Server):
        @contextlib.contextmanager
        def capture_signals(self):
            yield
    servers=[CoordinatedServer(uvicorn.Config(app,host='127.0.0.1',port=port,
        access_log=False,log_level='warning',proxy_headers=False,ws_max_size=16384,
        timeout_graceful_shutdown=10)) for app,port in zip((public,control),ports)]
    loop=asyncio.get_running_loop()
    previous={sig:signal.getsignal(sig) for sig in (signal.SIGINT,signal.SIGTERM)}
    def stop_all():
        for server in servers:server.should_exit=True
    for sig in previous:loop.add_signal_handler(sig,stop_all)
    tasks=[asyncio.create_task(server.serve()) for server in servers]
    try:
        # A failed listener also stops its peer; never run half a service.
        await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop_all()
        try:
            async with asyncio.timeout(15):
                await asyncio.gather(*tasks,return_exceptions=True)
        except TimeoutError:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
        pending=set().union(*(server.server_state.tasks for server in servers))
        for task in pending:task.cancel()
        if pending:
            # Uvicorn cancels timed-out requests without awaiting their finally
            # blocks. Await ours before allowing SQLite to close.
            async with asyncio.timeout(8):
                await asyncio.gather(*pending,return_exceptions=True)
        for sig,handler in previous.items():
            loop.remove_signal_handler(sig)
            signal.signal(sig,handler)
        # No listener/request tasks may use the ledger after this boundary.
        if close:close()
    for task in tasks:
        if not task.cancelled() and task.exception():raise task.exception()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',required=True)
    parser.add_argument('--secrets',required=True,action='append',help='SOPS JSON file; repeat for speech secrets')
    args=parser.parse_args()
    os.umask(0o077)
    secrets=load_secrets(args.secrets)
    config=read_config(args.config)
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'voice'))
    from service import Config,create_apps
    from loguru import logger
    logger.remove()
    os.environ['DEEPGRAM_API_KEY']=secrets['DEEPGRAM_API_KEY']
    c=Config(public_url=config['public_url'],account_sid=secrets['TWILIO_ACCOUNT_SID'],auth_token=secrets['TWILIO_AUTH_TOKEN'],
        api_key_sid=secrets['TWILIO_API_KEY_SID'],api_key_secret=secrets['TWILIO_API_KEY_SECRET'],
        owner_number=config.get('owner_number') or os.environ['MY_PHONE_NUMBER'],from_number=config.get('from_number') or os.environ['TWILIO_FROM_NUMBER'],
        pin=secrets['PHONE_PIN'],control_token=secrets['PHONE_CONTROL_TOKEN'],bridge_token=secrets['VOICE_BRIDGE_TOKEN'],
        ledger_path=config['ledger_path'],bridge_url=config.get('bridge_url','http://127.0.0.1:8792'),duration=config.get('duration',180),cost_owner_id=config.get('costOwnerId',''),cost_recipient_ref=config.get('costRecipientRef',''))
    public,control=create_apps(c)
    asyncio.run(serve_apps(public,control,close=public.state.ledger.close))

if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:pass
    except Exception:raise SystemExit('Voice service failed to start; check private configuration and encrypted credentials') from None
