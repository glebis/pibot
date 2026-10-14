#!/usr/bin/env python3
"""Start two isolated local voice-test processes; Ctrl+C stops only these children."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--speech-env-file', type=Path, help='Read only DEEPGRAM_API_KEY from this private environment file')
    parser.add_argument('--no-open', action='store_true', help='Do not open the private browser link')
    parser.add_argument('--check', action='store_true', help='Check dependencies, credential presence and free ports without starting services')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    from dotenv import dotenv_values
    import importlib.metadata
    if importlib.metadata.version('pipecat-ai') != '1.0.0':
        raise RuntimeError('This voice slice requires the tested Pipecat 1.0.0 environment')
    key = os.environ.get('DEEPGRAM_API_KEY', '')
    if args.speech_env_file:
        if args.speech_env_file.is_symlink() or not args.speech_env_file.is_file():
            raise RuntimeError('Speech environment file must be a regular file')
        key = dotenv_values(args.speech_env_file).get('DEEPGRAM_API_KEY') or ''
    if not key.strip():
        raise RuntimeError('Set DEEPGRAM_API_KEY or pass --speech-env-file. No credential values will be printed.')
    voice_port = int(os.environ.get('PIBOT_VOICE_PORT', '8788'))
    bridge_port = int(os.environ.get('PIBOT_VOICE_BRIDGE_PORT', '8789'))
    if voice_port == bridge_port or not all(1024 <= p <= 65535 for p in (voice_port, bridge_port)):
        raise RuntimeError('Choose distinct local ports between 1024 and 65535')
    for port in (voice_port, bridge_port):
        with socket.socket() as probe:
            try: probe.bind(('127.0.0.1', port))
            except OSError: raise RuntimeError(f'Port {port} is occupied; existing processes were left untouched') from None
    tsx = ROOT / 'node_modules/.bin/tsx'
    if not tsx.exists():
        raise RuntimeError('Install PiBot dependencies first')
    from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequestHandler
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.deepgram.tts import DeepgramTTSService
    if args.check:
        print('Ready: Pipecat 1.0.0, speech credential present, dedicated ports free. No services or provider requests started.')
        return
    os.umask(0o077)
    state = Path(tempfile.mkdtemp(prefix='pibot-voice-'))
    state.chmod(0o700)
    voice_token, bridge_token = secrets.token_hex(32), secrets.token_hex(32)
    for name, token in [('voice-token', voice_token), ('bridge-token', bridge_token)]:
        p = state/name
        p.write_text(token)
        p.chmod(0o600)
    private_url = f'http://127.0.0.1:{voice_port}/#token={voice_token}'
    (state/'open-voice.html').write_text('<!doctype html><meta http-equiv="refresh" content="0;url=' + private_url + '"><title>Open private voice test</title>')
    env = dict(os.environ, PIBOT_VOICE_TOKEN_FILE=str(state/'voice-token'), PIBOT_VOICE_BRIDGE_TOKEN_FILE=str(state/'bridge-token'), PIBOT_VOICE_PORT=str(voice_port), PIBOT_VOICE_BRIDGE_PORT=str(bridge_port))
    bridge_env = env.copy()
    bridge_env.pop('DEEPGRAM_API_KEY', None)
    audio_env = dict(env, DEEPGRAM_API_KEY=key)
    children = []
    logs = []
    try:
        for name, argv, child_env in [('bridge', [str(tsx), 'scripts/voice-agent-bridge.ts'], bridge_env), ('audio', [sys.executable, 'voice/server.py'], audio_env)]:
            log = open(state/f'{name}.log', 'wb')
            logs.append(log)
            children.append(subprocess.Popen(argv, cwd=ROOT, env=child_env, stdin=subprocess.DEVNULL, stdout=log, stderr=log))
        deadline = time.monotonic()+30
        agents = None
        while time.monotonic()<deadline:
            if any(p.poll() is not None for p in children):
                raise RuntimeError(f'Voice startup failed; private diagnostic files are in {state}')
            try:
                req=urllib.request.Request(f'http://127.0.0.1:{voice_port}/api/agents', headers={'Authorization':f'Bearer {voice_token}'})
                with urllib.request.urlopen(req,timeout=1) as response:
                    agents=json.load(response)
                break
            except Exception:
                time.sleep(.25)
        if agents is None:
            raise RuntimeError('Local voice services did not become ready')
        available=sum(bool(a.get('available')) for a in agents.get('agents',[]))
        print(f'Voice test ready at http://127.0.0.1:{voice_port}. {available} agent(s) available. Speech services connect when you click Start; agent generation begins when you speak.',flush=True)
        print(f'Private launch page: {state / "open-voice.html"}',flush=True)
        # Owner-only pointer for the bot's /voicetest command (removed when this test stops).
        launch_file = ROOT/'data'/'voice'/'test-launch.url'
        launch_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(launch_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f: f.write(private_url + '\n')
        print('Click Start in the browser to enable your microphone. Ctrl+C here stops this test only.',flush=True)
        if not args.no_open:
            webbrowser.open(private_url)
        while all(p.poll() is None for p in children):
            time.sleep(.5)
        raise RuntimeError('A voice-test process stopped; start a fresh test before continuing')
    finally:
        for p in children:
            if p.poll() is None: p.terminate()
        for p in children:
            try: p.wait(timeout=8)
            except subprocess.TimeoutExpired:
                p.kill();p.wait(timeout=3)
        for log in logs:log.close()
        # The page is gone: stop advertising its URL to /voicetest.
        try:
            launch_file = ROOT/'data'/'voice'/'test-launch.url'
            if launch_file.read_text().strip() == private_url: launch_file.unlink()
        except (OSError, NameError): pass
        # Private credentials stay in their 0700 temporary directory; do not delete user data.

if __name__ == '__main__':
    try:main()
    except KeyboardInterrupt:print('\nVoice test stopped.')
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Voice test failed. Check dependencies and configuration.',file=sys.stderr)
        raise SystemExit(1)
