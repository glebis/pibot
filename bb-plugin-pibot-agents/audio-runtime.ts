import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {access,lstat,mkdtemp,realpath,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {connect} from 'node:net';
import {readLocalAudioStartConfig,readLocalAudioToken} from './local-config';
import {endpoint,request,type Endpoint} from './client';
export function localAudioStartable(url:string,root:string){try{const target=endpoint(url,'validation-only');return !!root&&isAbsolute(root)&&target.url==='http://127.0.0.1:8788';}catch{return false;}}
export async function audioListening():Promise<boolean>{return new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:8788});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',(e:NodeJS.ErrnoException)=>{socket.destroy();if(e.code==='ECONNREFUSED')resolve(false);else reject(new Error('Could not determine local voice service status.'))});socket.once('timeout',()=>{socket.destroy();reject(new Error('Local voice service status timed out.'))});});}
/** PiBot voice serves its HTML client at `/` without auth; other local services (e.g. claude-relay's JSON status) must not be mistaken for it. */
export async function listenerIsPibotVoice():Promise<boolean>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
 try{const r=await fetch('http://127.0.0.1:8788/',{redirect:'error',signal:controller.signal});await r.body?.cancel().catch(()=>{});return r.ok&&!!r.headers.get('content-type')?.includes('text/html');}
 catch{return false;}finally{clearTimeout(timer);}
}
export const portConflict=()=>new Error('Port 8788 is held by another local service, not PiBot voice (claude-relay defaults to this port). Stop it or set RELAY_PORT to another port, then retry.');
const failure=(stage="startup")=>new Error(`Local voice could not start (${stage}). Check the Pipecat Python environment, private speech credentials, and canonical bridge.`);
export function createLocalAudioRuntime(){
 let child:ChildProcess|undefined,pending:Promise<Endpoint>|undefined,disposed=false,ownedTarget:Endpoint|undefined,ownedRoot:string|undefined,pendingRoot:string|undefined,state:string|undefined;
 const cleanup=async()=>{const dir=state;if(!dir)return;await new Promise<void>((resolve,reject)=>execFile('/usr/bin/trash',[dir],{timeout:5000},error=>error?reject(failure()):resolve()));if(state===dir)state=undefined;};
 async function start(root:string):Promise<Endpoint>{
  let stage="checkout";
  try{
   const base=await realpath(root);const script=join(base,'voice/server.py');const st=await lstat(script);
   if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022))throw failure();
   stage="Python environment";const python=process.env.PIBOT_VOICE_PYTHON||join(homedir(),'Library/Application Support/uv/tools/pipecat-ai-mcp-server/bin/python');
   if(!isAbsolute(python))throw failure();await access(python,constants.X_OK);
   stage="private speech configuration";const config=await readLocalAudioStartConfig(base);
   if(config.bridgePort===8788)throw failure();
   stage="canonical bridge health";await request(endpoint(`http://127.0.0.1:${config.bridgePort}`,config.bridgeToken),'/health','GET',undefined,undefined,3000);
   if(disposed||await audioListening())throw failure();
   stage="private startup credentials";state=await mkdtemp(join(tmpdir(),'pibot-bb-audio-'));
   const token=randomBytes(32).toString('hex');
   await writeFile(join(state,'audio-token'),token,{mode:0o600,flag:'wx'});await writeFile(join(state,'bridge-token'),config.bridgeToken,{mode:0o600,flag:'wx'});
   const env:NodeJS.ProcessEnv={...process.env,PIBOT_VOICE_TOKEN_FILE:join(state,'audio-token'),PIBOT_VOICE_BRIDGE_TOKEN_FILE:join(state,'bridge-token'),PIBOT_VOICE_PORT:'8788',PIBOT_VOICE_BRIDGE_PORT:String(config.bridgePort),PIBOT_VOICE_BRIDGE_MODE:'canonical',DEEPGRAM_API_KEY:config.speechKey};
   // BB may carry request-proxy settings that Python cannot parse. The local
   // audio process uses its canonical loopback bridge directly.
   for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[key];
   env.NO_PROXY=env.no_proxy='127.0.0.1,localhost';
   delete env.OPENAI_API_KEY;delete env.PIBOT_VOICE_PUBLIC_ORIGINS;delete env.PIBOT_HERMES_REPO;delete env.PIBOT_HERMES_PROFILES;
   stage="audio process readiness";child=spawn(python,[script],{cwd:base,env,stdio:['ignore','ignore','pipe']});let failed=false;
   // Classify startup failures without retaining or exposing raw service logs.
   child.once('error',()=>{failed=true;stage='audio process spawn'});
   child.stderr?.on('data',(chunk:Buffer)=>{const text=chunk.toString('utf8').slice(0,16384);if(text.includes('ModuleNotFoundError'))stage='missing Python dependency';else if(text.includes('ImportError'))stage='Python dependency import';else if(text.includes('PermissionError'))stage='startup file permissions';else if(text.includes('address already in use'))stage='voice port occupied';else if(text.includes('Voice credential must'))stage='startup credential file permissions';else if(text.includes('Invalid voice credential'))stage='startup credential format';else if(text.includes('Public voice origins'))stage='audio origin environment';else if(text.includes('signal'))stage='Python signal runtime';else if(/\b[A-Za-z]+Error:/.test(text))stage='audio process '+text.match(/\b([A-Za-z]+Error):/)![1];});
   const target=endpoint('http://127.0.0.1:8788',token),deadline=Date.now()+30_000;
   while(Date.now()<deadline){if(disposed||failed)throw failure();if(child.exitCode!=null){stage+=`: process exit ${child.exitCode}`;throw failure();}
    let ready=false;try{const info=await request(target,'/api/agents','GET',undefined,undefined,1000) as {mode?:unknown;audioReady?:unknown;agents?:unknown};ready=info.mode==='shared'&&info.audioReady===true&&Array.isArray(info.agents);}catch{}
    if(disposed)throw failure();
    if(ready){ownedTarget=target;ownedRoot=base;await cleanup().catch(()=>{});return target;}
    await new Promise(resolve=>setTimeout(resolve,250));
   }
   throw failure();
  }catch{child?.kill('SIGTERM');child=undefined;ownedTarget=undefined;ownedRoot=undefined;await cleanup().catch(()=>{});throw failure(stage);}
 }
 return {async ensure(url:string,token:string|undefined,root:string):Promise<Endpoint>{
   if(disposed)throw failure();
   if(!localAudioStartable(url,root))return endpoint(url,token);
   const base=await realpath(root);
   if(pending){if(pendingRoot!==base)throw new Error('Local voice is starting from a different checkout. Wait before changing connections.');return pending;}
   if(ownedTarget&&child&&child.exitCode==null&&!child.killed){if(ownedRoot!==base)throw new Error('Local voice is running from a different checkout. Reload the plugin before changing connections.');return ownedTarget;}
   pendingRoot=base;pending=(async()=>{if(!await audioListening())return start(base);if(!await listenerIsPibotVoice())throw portConflict();return endpoint(url,token||await readLocalAudioToken(base));})();try{return await pending}finally{pending=undefined;pendingRoot=undefined;}
 },async dispose(){disposed=true;child?.kill('SIGTERM');child=undefined;ownedTarget=undefined;ownedRoot=undefined;await cleanup().catch(()=>{});}};
}
