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


def canonical_bridge():
    """Port and token of the bot's canonical voice bridge (shared Telegram sessions)."""
    config_file = Path(os.environ.get('PIBOT_VOICE_CONFIG', ROOT/'data'/'voice'/'bridge.json'))
    st = config_file.lstat()
    if not config_file.is_file() or config_file.is_symlink() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise RuntimeError('The bot voice bridge config must be a private owner file')
    config = json.loads(config_file.read_text())
    env = dict(os.environ, SOPS_AGE_KEY_FILE=os.environ.get('SOPS_AGE_KEY_FILE', str(Path.home()/'.config/sops/age/keys.txt')))
    out = subprocess.run(['sops', '-d', '--output-type', 'json', config['secretsFile']], env=env, capture_output=True, timeout=20)
    token = json.loads(out.stdout or b'{}').get('VOICE_BRIDGE_TOKEN', '') if out.returncode == 0 else ''
    if len(token) != 64:
        raise RuntimeError('Could not read the bot voice bridge credential (sops). No credential values were printed.')
    return int(config['bridgePort']), token


def openai_key():
    """OPENAI_API_KEY for the experimental realtime mode: environment first, then the owner's SOPS secrets."""
    key = os.environ.get('OPENAI_API_KEY', '').strip()
    if key:
        return key
    secrets_file = Path.home()/'.claude/skills/secrets.enc.yaml'
    if not secrets_file.is_file():
        return ''
    env = dict(os.environ, SOPS_AGE_KEY_FILE=os.environ.get('SOPS_AGE_KEY_FILE', str(Path.home()/'.config/sops/age/keys.txt')))
    try:
        out = subprocess.run(['sops', '-d', '--extract', '["OPENAI_API_KEY"]', str(secrets_file)], env=env, capture_output=True, timeout=20)
        return out.stdout.decode().strip() if out.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def page_token(rotate=False):
    """The page's private key, kept across restarts (owner-only file) so remembered links keep working."""
    path = ROOT/'data'/'voice'/'page-token'
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not rotate and path.is_file() and not path.is_symlink():
        st = path.stat()
        token = path.read_text().strip()
        if st.st_uid == os.getuid() and not st.st_mode & 0o077 and len(token) == 64 and all(c in '0123456789abcdef' for c in token):
            return token
    token = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(token + '\n')
    return token


def tailscale_origin(voice_port):
    """https origin of a tailnet-only `tailscale serve` for the page; never a Funnel (public) one."""
    try:
        out = subprocess.run(['tailscale', 'serve', 'status', '--json'], capture_output=True, timeout=5)
        status = json.loads(out.stdout or b'{}')
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    public = {k for k, v in (status.get('AllowFunnel') or {}).items() if v}
    for host_port, web in (status.get('Web') or {}).items():
        proxy = ((web.get('Handlers') or {}).get('/') or {}).get('Proxy', '')
        if proxy.rstrip('/') in (f'http://127.0.0.1:{voice_port}', f'http://localhost:{voice_port}') and host_port not in public:
            host, _, port = host_port.rpartition(':')
            return f'https://{host}' if port == '443' else f'https://{host_port}'
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--speech-env-file', type=Path, help='Read only DEEPGRAM_API_KEY from this private environment file')
    parser.add_argument('--no-open', action='store_true', help='Do not open the private browser link')
    parser.add_argument('--new-token', action='store_true', help='Issue a fresh page key (old links and remembered keys stop working)')
    parser.add_argument('--isolated', action='store_true', help='Use an isolated persona copy instead of the bot\'s shared Telegram session')
    parser.add_argument('--hermes-repo', type=Path, help='Opt in to live Hermes sessions from this trusted absolute checkout (or PIBOT_HERMES_REPO)')
    parser.add_argument('--hermes-profiles', help='Comma-separated Hermes profile allowlist; default: default,content,ops,researcher')
    parser.add_argument('--check', action='store_true', help='Check dependencies, credential presence and free ports without starting services')
    args = parser.parse_args()
    if args.hermes_repo:
        os.environ['PIBOT_HERMES_REPO'] = str(args.hermes_repo)
    if args.hermes_profiles is not None:
        os.environ['PIBOT_HERMES_PROFILES'] = args.hermes_profiles
    if os.environ.get('PIBOT_HERMES_REPO'):
        if args.isolated:
            parser.error('Hermes requires canonical mode, not --isolated')
        sys.path.insert(0, str(ROOT / 'voice'))
        from hermes_bridge import HermesTransport
        HermesTransport(os.environ['PIBOT_HERMES_REPO'], os.environ.get('PIBOT_HERMES_PROFILES'))
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
    canonical_token = None
    if args.isolated:
        bridge_port = int(os.environ.get('PIBOT_VOICE_BRIDGE_PORT', '8789'))
    else:
        bridge_port, canonical_token = canonical_bridge()
        try:
            req = urllib.request.Request(f'http://127.0.0.1:{bridge_port}/health', headers={'Authorization': f'Bearer {canonical_token}'})
            with urllib.request.urlopen(req, timeout=3) as response: response.read()
        except Exception:
            raise RuntimeError('The bot voice bridge is not reachable. Is PiBot running with PIBOT_VOICE_CONFIG? Or pass --isolated.') from None
    if voice_port == bridge_port or not all(1024 <= p <= 65535 for p in (voice_port, bridge_port)):
        raise RuntimeError('Choose distinct local ports between 1024 and 65535')
    for port in ((voice_port, bridge_port) if args.isolated else (voice_port,)):
        # a just-stopped service can hold the port for a few seconds; wait briefly before giving up
        for attempt in range(20):
            with socket.socket() as probe:
                # like the real server: lingering closed connections (TIME_WAIT) must not count as "occupied"
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind(('127.0.0.1', port)); probe.listen(1); break
                except OSError:
                    if attempt == 19: raise RuntimeError(f'Port {port} is occupied; existing processes were left untouched') from None
            time.sleep(0.5)
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
    voice_token, bridge_token = page_token(args.new_token), canonical_token or secrets.token_hex(32)
    for name, token in [('voice-token', voice_token), ('bridge-token', bridge_token)]:
        p = state/name
        p.write_text(token)
        p.chmod(0o600)
    private_url = f'http://127.0.0.1:{voice_port}/#token={voice_token}'
    ts_origin = tailscale_origin(voice_port)
    (state/'open-voice.html').write_text('<!doctype html><meta http-equiv="refresh" content="0;url=' + private_url + '"><title>Open private voice test</title>')
    env = dict(os.environ, PIBOT_VOICE_TOKEN_FILE=str(state/'voice-token'), PIBOT_VOICE_BRIDGE_TOKEN_FILE=str(state/'bridge-token'), PIBOT_VOICE_PORT=str(voice_port), PIBOT_VOICE_BRIDGE_PORT=str(bridge_port),
               PIBOT_VOICE_BRIDGE_MODE='isolated' if args.isolated else 'canonical', PIBOT_VOICE_PUBLIC_ORIGINS=ts_origin or '')
    bridge_env = env.copy()
    bridge_env.pop('DEEPGRAM_API_KEY', None)
    bridge_env.pop('OPENAI_API_KEY', None)
    audio_env = dict(env, DEEPGRAM_API_KEY=key)
    realtime_key = '' if args.isolated else openai_key()
    if realtime_key:
        audio_env['OPENAI_API_KEY'] = realtime_key  # only the audio process; never the bridge
    else:
        audio_env.pop('OPENAI_API_KEY', None)
    children = []
    logs = []
    try:
        services = [('bridge', [str(tsx), 'scripts/voice-agent-bridge.ts'], bridge_env)] if args.isolated else []
        for name, argv, child_env in services + [('audio', [sys.executable, 'voice/server.py'], audio_env)]:
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
        # Owner-only pointer for the bot's /voice command (removed when this test stops).
        launch_file = ROOT/'data'/'voice'/'test-launch.url'
        launch_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(launch_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        # Line 1: loopback page; line 2 (optional): tailnet-only HTTPS page, same private key.
        with os.fdopen(fd, 'w') as f: f.write(private_url + '\n' + (f'{ts_origin}/#token={voice_token}\n' if ts_origin else ''))
        if ts_origin: print(f'Tailnet page: {ts_origin} (tailnet only)', flush=True)
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
        # The page is gone: stop advertising its URL to /voice.
        try:
            launch_file = ROOT/'data'/'voice'/'test-launch.url'
            if launch_file.read_text().splitlines()[0] == private_url: launch_file.unlink()
        except (OSError, NameError): pass
        # Private credentials stay in their 0700 temporary directory; do not delete user data.

if __name__ == '__main__':
    try:main()
    except KeyboardInterrupt:print('\nVoice test stopped.')
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Voice test failed. Check dependencies and configuration.',file=sys.stderr)
        raise SystemExit(1)
