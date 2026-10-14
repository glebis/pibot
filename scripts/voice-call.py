#!/usr/bin/env python3
"""Operator-only manual call control. Automatic calls must use the consent gate."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from urllib import request, error
from uuid import uuid4


class UnknownOutcome(Exception):
    pass


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http(method, url, token, body=None):
    data=None if body is None else json.dumps(body).encode()
    req=request.Request(url,data=data,method=method,headers={
        'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with request.build_opener(NoRedirect).open(req,timeout=20) as response:
            raw=response.read(65537)
            if len(raw)>65536:raise ValueError('Response limit')
            value=json.loads(raw)
            if not isinstance(value,dict):raise ValueError('Invalid response')
            return value
    except Exception:
        raise UnknownOutcome('Request did not return a verified receipt; do not repeat a call. Check its attempt status.') from None


def secrets_loader(path):
    launcher=Path(__file__).with_name('voice-service.py')
    spec=importlib.util.spec_from_file_location('pibot_voice_launcher',launcher)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.load_secrets([path])


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--secrets',required=True,help='Private SOPS voice-service.enc.json; SOPS_AGE_KEY_FILE must be explicit')
    group=p.add_mutually_exclusive_group(required=True)
    group.add_argument('--list',action='store_true',help='List canonical agent IDs only; never calls')
    group.add_argument('--call',action='store_true',help='Explicitly initiate one call to the configured owner')
    group.add_argument('--status',metavar='ATTEMPT_ID',help='Inspect an existing attempt; never calls')
    p.add_argument('--agent',help='Exact canonical agent ID, required with --call')
    p.add_argument('--duration',type=int,default=180,help='Maximum seconds, 1..180')
    return p


def run(argv=None,*,load=secrets_loader,send=http,out=print):
    args=parser().parse_args(argv)
    if not 1<=args.duration<=180:raise ValueError('Duration must be 1..180 seconds')
    if args.call and (not args.agent or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',args.agent)):raise ValueError('Exact agent ID required')
    if not args.call and args.agent:raise ValueError('--agent requires --call')
    if args.status and not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',args.status):raise ValueError('Invalid attempt ID')
    secrets=load(args.secrets)
    control=secrets.get('PHONE_CONTROL_TOKEN','');bridge=secrets.get('VOICE_BRIDGE_TOKEN','')
    if not all(isinstance(t,str) and re.fullmatch(r'[0-9a-f]{64}',t) for t in (control,bridge)):raise ValueError('Private voice tokens unavailable')
    def receipt(value,attempt):
        if value.get('attemptId')!=attempt or value.get('state') not in {'dispatching','accepted','authenticated','streaming','unknown','completed','rejected','denied'}:raise UnknownOutcome('Invalid receipt; inspect this attempt before another call')
        result={'attemptId':attempt,'state':value['state']}
        sid=value.get('providerCallId')
        if isinstance(sid,str) and re.fullmatch(r'CA[0-9a-fA-F]{32}',sid):result['providerCallId']=sid
        out(json.dumps(result))
    if args.status:
        receipt(send('GET','http://127.0.0.1:8793/control/calls/'+args.status,control),args.status)
        return
    bindings=send('GET','http://127.0.0.1:8792/voice/bindings',bridge).get('bindings')
    if not isinstance(bindings,list):raise ValueError('Canonical bindings unavailable')
    valid=[b for b in bindings if isinstance(b,dict) and isinstance(b.get('agentId'),str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',b['agentId']) and isinstance(b.get('chatKey'),str) and re.fullmatch(r'telegram(?::[A-Za-z0-9_-]+)?:[1-9][0-9]{0,19}',b['chatKey'])]
    if args.list:
        for agent in sorted({b['agentId'] for b in valid}):out(agent)
        return
    matches=[b for b in valid if b['agentId']==args.agent]
    if len(matches)!=1:raise ValueError('Agent must have exactly one current canonical private chat binding')
    attempt='manual-'+uuid4().hex
    # Emit the durable lookup key before the only network mutation, even when its
    # outcome later becomes unknown. This is an operator invocation, not consent.
    out(json.dumps({'attemptId':attempt,'state':'submitting'}))
    result=send('POST','http://127.0.0.1:8793/control/calls',control,{
        'attemptId':attempt,'agentId':args.agent,'chatKey':matches[0]['chatKey'],
        'reason':'Explicit operator call','maxDurationSeconds':args.duration})
    receipt(result,attempt)


if __name__=='__main__':
    try:run()
    except (ValueError,UnknownOutcome) as exc:raise SystemExit(str(exc)) from None
    except Exception:raise SystemExit('Voice operator command failed; credentials and private details were not logged.') from None
