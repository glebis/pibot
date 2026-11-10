import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
export type LocalConfig={dashboardUrl:string;dashboardToken:string;bridgeUrl:string;bridgeToken:string};
const failure=()=>new Error('Local PiBot configuration is unavailable or unsafe. Check private configuration and SOPS access.');
function within(parent:string,child:string){const rel=relative(parent,child);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);}
async function privateBytes(file:string,limit:number):Promise<Buffer>{
 const before=await lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid?.()||(before.mode&0o077)||before.size>limit)throw failure();
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=await fd.stat();if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>limit||st.ino!==before.ino||st.dev!==before.dev)throw failure();
 const bytes=Buffer.alloc(limit+1);const {bytesRead}=await fd.read(bytes,0,bytes.length,0);if(bytesRead>limit)throw failure();return bytes.subarray(0,bytesRead);
 }finally{await fd.close();}
}
function token(value:unknown,hex=false):string{if(typeof value!=='string'||(hex?!/^[a-f0-9]{64}$/.test(value):!/^[\x21-\x7e]{16,512}$/.test(value)))throw failure();return value;}
async function extract(cipher:Buffer,expression:string,keyFile:string):Promise<unknown>{
 const stdout=await new Promise<string>((resolve,reject)=>{
 const child=execFile('sops',['decrypt','--input-type','json','--output-type','json','--extract',expression,'/dev/stdin'],{env:{...process.env,SOPS_AGE_KEY_FILE:keyFile},timeout:20_000,maxBuffer:8192,encoding:'utf8'},(error,out)=>error?reject(failure()):resolve(out));
 child.stdin?.on('error',()=>{});child.stdin?.end(cipher);
 });
 const trimmed=stdout.trim();return trimmed.startsWith('"')?JSON.parse(trimmed):trimmed;
}
async function localSource(root:string){
 if(!isAbsolute(root))throw failure();
 const canonicalRoot=await realpath(root);const data=await realpath(join(canonicalRoot,'data'));
 if(!within(canonicalRoot,data))throw failure();
 const known=async(name:string,limit:number)=>{
  const file=join(data,name);const resolved=await realpath(file);
  if(!within(data,resolved)||resolved!==file)throw failure();return privateBytes(file,limit);
 };
 const keyFile=process.env.SOPS_AGE_KEY_FILE||join(homedir(),'.config/sops/age/keys.txt');await privateBytes(keyFile,65536);
 const dashboard=async()=>({dashboardUrl:'http://127.0.0.1:7860',dashboardToken:token(await extract(await known('settings.enc.json',1048576),'["web"]["token"]',keyFile))});
 return {data,known,keyFile,dashboard};
}
/** Owner-authorized dashboard discovery; independent of voice configuration. */
export async function readLocalDashboardConfig(root:string):Promise<Pick<LocalConfig,'dashboardUrl'|'dashboardToken'>>{
 try{return await (await localSource(root)).dashboard();}catch{throw failure();}
}
/** Explicit connect-local only. No runtime writes, service starts, or fallback credential scans. */
export async function readLocalConfig(root:string):Promise<LocalConfig>{
 try{
 const {data,known,keyFile,dashboard}=await localSource(root);
 const bridge=JSON.parse((await known('voice/bridge.json',16384)).toString('utf8')) as {bridgePort?:unknown;secretsFile?:unknown};
 if(!Number.isInteger(bridge.bridgePort)||Number(bridge.bridgePort)<1024||Number(bridge.bridgePort)>65535||typeof bridge.secretsFile!=='string'||!isAbsolute(bridge.secretsFile))throw failure();
 const source=await realpath(bridge.secretsFile);if(!within(data,source)||source!==bridge.secretsFile||!source.endsWith('.enc.json'))throw failure();
 const dashboardConfig=await dashboard();
 const bridgeToken=token(await extract(await privateBytes(source,1048576),'["VOICE_BRIDGE_TOKEN"]',keyFile),true);
 return {...dashboardConfig,bridgeUrl:`http://127.0.0.1:${bridge.bridgePort}`,bridgeToken};
 }catch{throw failure();}
}

/** Read only the speech key and canonical bridge credential for an explicit local audio start. */
export async function readLocalAudioStartConfig(root:string):Promise<{bridgePort:number;bridgeToken:string;speechKey:string}>{
 try{
 const {data,known,keyFile}=await localSource(root);
 const bridge=JSON.parse((await known('voice/bridge.json',16384)).toString('utf8'));
 if(!Number.isInteger(bridge.bridgePort)||bridge.bridgePort<1024||bridge.bridgePort>65535||typeof bridge.secretsFile!=='string')throw failure();
 const source=await realpath(bridge.secretsFile);if(!within(data,source)||source!==bridge.secretsFile||!source.endsWith('.enc.json'))throw failure();
 return {bridgePort:bridge.bridgePort,bridgeToken:token(await extract(await privateBytes(source,1048576),'["VOICE_BRIDGE_TOKEN"]',keyFile),true),speechKey:token(await extract(await known('voice-speech.enc.json',1048576),'["DEEPGRAM_API_KEY"]',keyFile))};
 }catch{throw failure();}
}

/** Existing browser interface credential; read only, never rotate it. */
export async function readLocalAudioToken(root:string):Promise<string>{
 try{return token((await (await localSource(root)).known('voice/page-token',1024)).toString('utf8').trim(),true);}catch{throw failure();}
}
