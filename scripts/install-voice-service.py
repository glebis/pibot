#!/usr/bin/env python3
"""Prepare or install a per-user PiBot voice LaunchAgent. Never writes plaintext secrets."""
import argparse,json,os,plistlib,subprocess,sys
from pathlib import Path

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--config',type=Path,required=True)
 p.add_argument('--secrets',type=Path,action='append',required=True)
 p.add_argument('--python',type=Path,required=True)
 p.add_argument('--install',action='store_true',help='Install and start the prepared voice service only')
 p.add_argument('--output',type=Path,help='Write a reviewable plist without starting it')
 a=p.parse_args();root=Path(__file__).resolve().parents[1];label='com.glebkalinin.pibot.voice'
 if a.install and a.output:p.error('Choose --install or --output')
 for file in [a.config,*a.secrets]:
  st=file.lstat()
  if not file.is_absolute() or file.is_symlink() or not file.is_file() or st.st_uid!=os.getuid() or st.st_mode&0o077:raise ValueError('Configuration and encrypted files must be private regular owner files')
 for file in a.secrets:
  data=json.loads(file.read_text())
  if 'sops' not in data:raise ValueError('Every secret file must be SOPS encrypted')
  if any(isinstance(v,str) and not v.startswith('ENC[') for k,v in data.items() if k!='sops'):raise ValueError('Unencrypted secret field refused')
 if not a.python.is_absolute() or not os.access(a.python,os.X_OK):raise ValueError('Explicit executable Python required')
 config=json.loads(a.config.read_text());state=Path(config['ledger_path']).parent
 if not state.is_absolute() or not state.is_dir() or state.stat().st_mode&0o077:raise ValueError('Existing private state directory required')
 args=[str(a.python),str(root/'scripts/voice-service.py'),'--config',str(a.config)]
 for file in a.secrets:args+=['--secrets',str(file)]
 doc={'Label':label,'ProgramArguments':args,'WorkingDirectory':str(root),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,'Umask':63,
      'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin','SOPS_AGE_KEY_FILE':str(Path.home()/'.config/sops/age/keys.txt')},
      'StandardOutPath':str(state/'service.log'),'StandardErrorPath':str(state/'service.log')}
 target=Path.home()/'Library/LaunchAgents'/f'{label}.plist' if a.install else a.output
 if target is None:print(plistlib.dumps(doc).decode());return
 if target.exists():raise ValueError('Existing service file refused; inspect it before replacing')
 os.umask(0o077);target.parent.mkdir(parents=True,exist_ok=True)
 with target.open('xb') as f:f.write(plistlib.dumps(doc))
 if a.install:
  subprocess.run(['/bin/launchctl','bootstrap',f'gui/{os.getuid()}',str(target)],check=True)
  print('Voice service installed. Verify authenticated agent bridge and public tunnel before calling.')
 else:print('Reviewable service definition written; nothing installed or started.')
if __name__=='__main__':main()
