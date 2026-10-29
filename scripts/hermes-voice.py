#!/usr/bin/env python3
"""Same-user Hermes collaboration. `list` is read-only; `send` requires explicit consent.

Metadata only on stdout: no titles, transcripts, tool output, credentials or model replies.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'voice'))
from hermes_bridge import HermesBridge, HermesTransport
import httpx


async def run(args):
    transport = HermesTransport(args.repo, args.profiles)
    targets = await transport.discover()
    if args.command == 'list':
        rows = [{'target': t.id, 'profile': t.profile, 'sessionId': t.session_id,
                 'running': t.running} for t in targets.values()]
        print(json.dumps({'targets': rows, 'count': len(rows), 'profiles': transport.profile_status,
                          'limitPerProfile': 200}))
        return 0
    if not args.confirm_submit or args.target not in targets:
        raise ValueError('Submission requires an exact live target and --confirm-submit')
    # Read message from stdin, not argv/process listings. The owner explicitly requested this work.
    text = sys.stdin.read(32001)
    if not 0 < len(text.strip()) <= 32000:
        raise ValueError('Invalid input')
    async with httpx.AsyncClient() as fallback:
        bridge = HermesBridge(fallback, transport)
        created = await bridge.post('/voice/browser-sessions', json={
            'agentId': args.target, 'chatKey': args.target, 'mode': 'agent'})
        created.raise_for_status()
        sid = created.json()['sessionId']
        try:
            response = await bridge.post(f'/voice/sessions/{sid}/turn',
                                         json={'requestId': args.request_id, 'text': text})
            data = response.json()
            print(json.dumps({'target': args.target, 'requestId': args.request_id,
                              'status': 'completed' if response.status_code == 200 else data.get('error', 'unknown'),
                              'admissionId': data.get('admissionId')}))
            return 0 if response.status_code == 200 else 3
        finally:
            await bridge.delete('/voice/sessions/' + sid)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default=os.environ.get('PIBOT_HERMES_REPO'),
                        help='Explicit absolute trusted Hermes checkout (or PIBOT_HERMES_REPO)')
    parser.add_argument('--profiles', default=os.environ.get('PIBOT_HERMES_PROFILES'),
                        help='Comma-separated profile allowlist; default: default,content,ops,researcher')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('list', help='Discover live sessions without starting gateways or submitting work')
    send = commands.add_parser('send', help='Submit stdin to an exact session; may run paid models and tools')
    send.add_argument('--target', required=True)
    send.add_argument('--request-id', default=str(uuid4()), help='Stable canonical submission identity')
    send.add_argument('--confirm-submit', action='store_true', help='Explicitly authorize native model/tool execution')
    args = parser.parse_args()
    if not args.repo:
        parser.error('--repo or PIBOT_HERMES_REPO is required')
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print('Detached. Check the native session; no work was cancelled or retried.', file=sys.stderr)
        return 130
    except Exception:
        print('Hermes collaboration unavailable or invalid request. Check configuration and the native session; do not automatically resend.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
