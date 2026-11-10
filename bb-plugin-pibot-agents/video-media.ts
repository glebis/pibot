import {randomBytes} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,open,realpath,type FileHandle} from 'node:fs/promises';
import {basename,isAbsolute,join} from 'node:path';

const MAX_VIDEO_BYTES=200*1024*1024;
const VIDEO_NAME=/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.mp4$/;
const ROUTE='/api/v1/plugins/pibot-agents/http/video';
type Cap={id:string;key:string;file:string;checkout:string;version:string;size:number;expires:number;active:number};
const unavailable=()=>new Error('Video unavailable.');
const version=(st:BigIntStats)=>[st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs,st.mode,st.uid].join(':');
function owned(st:BigIntStats,privateFile=false){return st.uid===BigInt(process.getuid?.()??-1)&&(st.mode&BigInt(privateFile?0o077:0o022))===0n;}
async function metadata(file:string,checkout:string){
 if(!isAbsolute(checkout)||!isAbsolute(file)||!VIDEO_NAME.test(basename(file)))throw unavailable();
 const root=await realpath(checkout);
 if(root!==checkout||file!==join(root,'data','media',basename(file)))throw unavailable();
 for(const dir of [root,join(root,'data'),join(root,'data','media')]){
  const st=await lstat(dir,{bigint:true});
  if(!st.isDirectory()||st.isSymbolicLink()||!owned(st,dir===join(root,'data','media'))||await realpath(dir)!==dir)throw unavailable();
 }
 const st=await lstat(file,{bigint:true});
 if(!st.isFile()||st.isSymbolicLink()||!owned(st,true)||st.size<=0n||st.size>BigInt(MAX_VIDEO_BYTES)||await realpath(file)!==file)throw unavailable();
 return st;
}
async function safeOpen(file:string,checkout:string){
 const before=await metadata(file,checkout);
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const after=await fd.stat({bigint:true});if(!after.isFile()||version(before)!==version(after)||version(await metadata(file,checkout))!==version(after))throw unavailable();return {fd,stat:after};}
 catch(error){await fd.close();throw error;}
}
function range(value:string|null,size:number):{start:number;end:number;partial:boolean}|undefined{
 if(value===null)return {start:0,end:size-1,partial:false};
 const found=/^bytes=(\d*)-(\d*)$/.exec(value);if(!found||(!found[1]&&!found[2]))return;
 const left=found[1]?Number(found[1]):undefined,right=found[2]?Number(found[2]):undefined;
 if((left!==undefined&&!Number.isSafeInteger(left))||(right!==undefined&&!Number.isSafeInteger(right)))return;
 if(left===undefined){if(!right)return;return {start:Math.max(0,size-right),end:size-1,partial:true};}
 if(left>=size||(right!==undefined&&right<left))return;
 return {start:left,end:Math.min(right??size-1,size-1),partial:true};
}
/** Short-lived local capabilities; no caller-controlled path is ever accepted by HTTP. */
export function createVideoMedia(options:{now?:()=>number;ttlMs?:number;capacity?:number}={}){
 const now=options.now??Date.now,ttl=options.ttlMs??60*60*1000,capacity=options.capacity??1024;
 const caps=new Map<string,Cap>(),versions=new Map<string,string>(),streams=new Set<()=>void>();let disposed=false;
 function remove(cap:Cap){caps.delete(cap.id);if(versions.get(cap.key)===cap.id)versions.delete(cap.key);}
 function sweep(){for(const cap of caps.values())if(cap.expires<=now()&&!cap.active)remove(cap);}
 const headers=()=>new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':'video/mp4','Content-Disposition':'inline','Accept-Ranges':'bytes'});
 const missing=()=>new Response(null,{status:404,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 return {
  async issue(filePath:string,checkout:string):Promise<string|undefined>{
   if(disposed)return;
   try{
    const {fd,stat}=await safeOpen(filePath,checkout);await fd.close();if(disposed)return;
    sweep();const fileVersion=version(stat),key=`${filePath}\0${fileVersion}`,existing=caps.get(versions.get(key)??'');
    if(existing&&existing.expires>now()){existing.expires=now()+ttl;return `${ROUTE}?id=${existing.id}`;}
    if(existing)remove(existing);
    if(caps.size>=capacity){const oldest=[...caps.values()].find(cap=>!cap.active);if(!oldest)return;remove(oldest);}
    const id=randomBytes(24).toString('hex'),cap:Cap={id,key,file:filePath,checkout,version:fileVersion,size:Number(stat.size),expires:now()+ttl,active:0};caps.set(id,cap);versions.set(key,id);
    return `${ROUTE}?id=${id}`;
   }catch{return;}
  },
  async handle(request:Request):Promise<Response>{
   if(disposed)return missing();
   if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{Allow:'GET, HEAD','Cache-Control':'no-store'}});
   let id:string|null;try{const url=new URL(request.url);if([...url.searchParams.keys()].some(key=>key!=='id')||url.searchParams.getAll('id').length!==1)return missing();id=url.searchParams.get('id');}catch{return missing();}
   if(!id||!/^[a-f0-9]{48}$/.test(id))return missing();sweep();const cap=caps.get(id);if(!cap||cap.expires<=now())return missing();
   let fd:FileHandle;
   try{const opened=await safeOpen(cap.file,cap.checkout);fd=opened.fd;if(version(opened.stat)!==cap.version||disposed||caps.get(id)!==cap||request.signal.aborted){await fd.close();return missing();}}
   catch{return missing();}
   const selected=range(request.headers.get('Range'),cap.size),head=headers();
   if(!selected){await fd.close();head.set('Content-Range',`bytes */${cap.size}`);head.set('Content-Length','0');return new Response(null,{status:416,headers:head});}
   const {start,end,partial}=selected;head.set('Content-Length',String(end-start+1));if(partial)head.set('Content-Range',`bytes ${start}-${end}/${cap.size}`);
   if(request.method==='HEAD'){await fd.close();return new Response(null,{status:partial?206:200,headers:head});}
   cap.active++;let position=start,closed=false,closing:Promise<void>|undefined,controller:ReadableStreamDefaultController<Uint8Array>|undefined;
   const close=()=>{if(closing)return closing;closed=true;streams.delete(stop);request.signal.removeEventListener('abort',stop);cap.active--;return closing=fd.close().catch(()=>{});};
   const stop=()=>{if(closed)return;try{controller?.error(unavailable());}catch{}void close();};
   const body=new ReadableStream<Uint8Array>({
    start(c){controller=c;streams.add(stop);request.signal.addEventListener('abort',stop,{once:true});if(request.signal.aborted)stop();},
    async pull(c){
     if(closed)return;
     try{
      if(disposed||request.signal.aborted||cap.expires<=now()||caps.get(cap.id)!==cap||version(await metadata(cap.file,cap.checkout))!==cap.version||version(await fd.stat({bigint:true}))!==cap.version)throw unavailable();
      const bytes=Buffer.alloc(Math.min(64*1024,end-position+1));const read=await fd.read(bytes,0,bytes.length,position);
      if(closed)return;if(!read.bytesRead||version(await fd.stat({bigint:true}))!==cap.version||version(await metadata(cap.file,cap.checkout))!==cap.version)throw unavailable();
      if(closed)return;position+=read.bytesRead;c.enqueue(bytes.subarray(0,read.bytesRead));
      if(position>end){await close();c.close();}
     }catch{if(!closed){await close();try{c.error(unavailable());}catch{}}}
    },
    async cancel(){await close();},
   });
   return new Response(body,{status:partial?206:200,headers:head});
  },
  dispose(){if(disposed)return;disposed=true;for(const stop of [...streams])stop();caps.clear();versions.clear();},
 };
}
