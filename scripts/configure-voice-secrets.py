#!/usr/bin/env python3
"""Collect a phone PIN using a masked macOS dialog; save only SOPS ciphertext."""
import argparse,json,os,re,secrets,subprocess,tempfile
from pathlib import Path

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--twilio-source',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
 a=p.parse_args();os.umask(0o077)
 if a.output.exists():raise ValueError('Existing encrypted credentials refused; review before changing')
 st=a.twilio_source.lstat()
 if a.twilio_source.is_symlink() or st.st_uid!=os.getuid() or st.st_mode&0o077:raise ValueError('Private owner credential source required')
 raw=json.loads(a.twilio_source.read_text());keys=['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_API_KEY_SID','TWILIO_API_KEY_SECRET']
 values={k:raw[k] for k in keys}
 keyfile=Path.home()/'.config/sops/age/keys.txt'
 recipient=re.search(r'public key:\s*(age1[0-9a-z]{58})',keyfile.read_text())
 if not recipient:raise ValueError('SOPS age recipient unavailable')
 env=dict(os.environ,SOPS_AGE_KEY_FILE=str(keyfile))
 with tempfile.TemporaryDirectory(prefix='pibot-sops-config-') as temp:
  config=Path(temp)/'sops.yaml';config.write_text('creation_rules:\n  - path_regex: .*\n    age: '+recipient.group(1)+'\n')
  command=['/opt/homebrew/bin/sops','--config',str(config),'--encrypt','--age',recipient.group(1),'--input-type','json','--output-type','json','/dev/stdin']
  if subprocess.run(command,input=b'{"probe":"nonsecret"}',capture_output=True,env=env).returncode:raise ValueError('SOPS encryption preflight failed')
  prompt='text returned of (display dialog "Choose a six-digit PIN. You will enter it on phone calls before PiBot can access your tools and history." default answer "" with hidden answer buttons {"Cancel", "Save encrypted"} default button "Save encrypted" with title "PiBot phone access")'
  result=subprocess.run(['/usr/bin/osascript','-e',prompt],capture_output=True,text=True)
  if result.returncode:raise SystemExit('Cancelled; nothing changed.')
  pin=result.stdout.strip()
  if not re.fullmatch(r'[0-9]{6}',pin):raise ValueError('PIN must contain exactly six digits; nothing saved')
  values.update(PHONE_PIN=pin,PHONE_CONTROL_TOKEN=secrets.token_hex(32),VOICE_BRIDGE_TOKEN=secrets.token_hex(32))
  encrypted=subprocess.run(command,input=json.dumps(values).encode(),capture_output=True,env=env)
  if encrypted.returncode:raise ValueError('Encryption failed; nothing saved')
  check=json.loads(encrypted.stdout)
  if 'sops' not in check or any(not str(check.get(k,'')).startswith('ENC[') for k in values):raise ValueError('Ciphertext validation failed')
  a.output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with a.output.open('xb') as f:f.write(encrypted.stdout)
 print('Phone credentials and PIN saved with SOPS encryption. No plaintext file created.')
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Phone credential setup failed; existing configuration was not changed.') from None
