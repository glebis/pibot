import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export type HistoryMessage={id:string;role:'user'|'assistant';text:string;timestamp?:string};
export type HistoryPage={sessionId:string|null;messages:HistoryMessage[];before:string|null;hasMore:boolean;truncated?:boolean};
export function agentsRoot(override=''){return override.trim()||process.env.PIBOT_AGENTS_DIR||join(homedir(),'.local/share/pibot/agents');}
const unavailable=()=>new Error('Saved session history is unavailable or unsafe. Check local agent storage and private-file permissions.');
const inside=(root:string,file:string)=>{const r=relative(root,file);return !!r&&r!=='..'&&!r.startsWith(`..${sep}`)&&!isAbsolute(r);};
async function readPrivate(file:string,max:number,sessionFile=false){
 const forbiddenMode=sessionFile?0o022:0o077;
 const initial=await lstat(file);if(initial.isSymbolicLink()||!initial.isFile()||initial.uid!==process.getuid?.()||(initial.mode&forbiddenMode)||initial.size>max)throw unavailable();
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=await fd.stat();if(st.ino!==initial.ino||st.dev!==initial.dev||st.uid!==process.getuid?.()||(st.mode&forbiddenMode)||st.size>max)throw unavailable();
 const buffer=Buffer.alloc(st.size);let pos=0;while(pos<buffer.length){const r=await fd.read(buffer,pos,buffer.length-pos,pos);if(!r.bytesRead)break;pos+=r.bytesRead;}return buffer.subarray(0,pos).toString('utf8');
 }finally{await fd.close();}
}
type Entry={id:string;parentId:string|null;type:string;timestamp?:string;message?:{role?:unknown;content?:unknown}};
function textOf(content:unknown):string{
 if(typeof content==='string')return content.slice(0,16000);
 if(!Array.isArray(content))return '';
 return content.filter(c=>c&&typeof c==='object'&&c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n').slice(0,16000);
}
/** Resolve only the exact indexed source; shared by the reader and invalidation watcher. */
export async function resolveHistorySource(root:string,agentId:string,chatKey:string,checkoutRoot?:string):Promise<{file?:string;watchFiles:string[]}>{
 try{
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)||!isAbsolute(root))throw unavailable();
 const base=await realpath(root);const agent=join(base,agentId);if(await realpath(agent)!==agent)throw unavailable();
 const agentStat=await lstat(agent);if(!agentStat.isDirectory()||agentStat.uid!==process.getuid?.()||(agentStat.mode&0o022))throw unavailable();
 const sessions=join(agent,'sessions');
 try{if(await realpath(sessions)!==sessions)throw unavailable();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {watchFiles:[join(agent,'sessions')]};throw e;}
 const sessionsStat=await lstat(sessions);if(!sessionsStat.isDirectory()||sessionsStat.uid!==process.getuid?.()||(sessionsStat.mode&0o022))throw unavailable();
 let indexText:string;try{indexText=await readPrivate(join(sessions,'index.json'),1048576);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {watchFiles:[join(sessions,'index.json')]};throw e;}
 const index=JSON.parse(indexText);if(!index||typeof index!=='object'||Array.isArray(index))throw unavailable();
 const file=Object.hasOwn(index,chatKey)?index[chatKey]:undefined;
 if(file===undefined)return {watchFiles:[join(sessions,'index.json')]};
 if(typeof file!=='string'||!isAbsolute(file)||!file.endsWith('.jsonl')||await realpath(file)!==file)throw unavailable();
 let confined=inside(sessions,file);
 if(!confined&&checkoutRoot&&isAbsolute(checkoutRoot)){
   const checkout=await realpath(checkoutRoot);const legacyAgent=join(checkout,'agents',agentId);const legacySessions=join(legacyAgent,'sessions');
   if(inside(legacySessions,file)){
     for(const dir of [join(checkout,'agents'),legacyAgent,legacySessions]){const st=await lstat(dir);if(st.isSymbolicLink()||!st.isDirectory()||st.uid!==process.getuid?.()||(st.mode&0o022)||await realpath(dir)!==dir)throw unavailable();}
     confined=true;
   }
 }
 if(!confined)throw unavailable();
 const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022)||st.size>64*1024*1024)throw unavailable();
 return {file,watchFiles:[join(sessions,'index.json'),file]};
 }catch{throw unavailable();}
}
/** Read the persisted active branch only. Never open/migrate/write a Pi session. */
export async function loadHistory(root:string,agentId:string,chatKey:string,before?:string,checkoutRoot?:string):Promise<HistoryPage>{
 try{
 const {file}=await resolveHistorySource(root,agentId,chatKey,checkoutRoot);
 if(!file)return {sessionId:null,messages:[],before:null,hasMore:false};
 // Pi SDK historically created 0644 JSONL files. Exact indexed owner-owned
 // files may be read, never modified; group/other-writable files are refused.
 const raw=await readPrivate(file,64*1024*1024,true);const lines=raw.split('\n');
 const entries=new Map<string,Entry>();let header:{id:string}|undefined;let leaf:string|null=null;
 for(let i=0;i<lines.length;i++){
  const line=lines[i].trim();if(!line)continue;
  let value:any;try{value=JSON.parse(line);}catch{if(i===lines.length-1&&!raw.endsWith('\n'))break;throw unavailable();}
  if(!header){if(value?.type!=='session'||typeof value.id!=='string'||value.id.length>128||![3].includes(value.version))throw unavailable();header={id:value.id};continue;}
  if(typeof value?.id!=='string'||!value.id||value.id.length>128||entries.has(value.id)||!(value.parentId===null||typeof value.parentId==='string')||typeof value.type!=='string')throw unavailable();
  entries.set(value.id,value);leaf=value.id;
 }
 if(!header)throw unavailable();
 // Pi's getBranch() stops at an absent ancestor; getTree() treats that
 // entry as an orphan root. Show only this connected active branch, never
 // stitch earlier physical lines or siblings into it. Retain cycle rejection.
 const branch:Entry[]=[];let truncated=false;const seen=new Set<string>();
 while(leaf!==null){if(seen.has(leaf))throw unavailable();seen.add(leaf);const entry=entries.get(leaf);if(!entry){truncated=true;break;}branch.push(entry);leaf=entry.parentId;}
 const messages:HistoryMessage[]=branch.reverse().filter(e=>e.type==='message'&&(e.message?.role==='user'||e.message?.role==='assistant')).flatMap(e=>{const text=textOf(e.message?.content);return text?[{id:e.id,role:e.message!.role as HistoryMessage['role'],text,...(typeof e.timestamp==='string'?{timestamp:e.timestamp.slice(0,64)}:{})}]:[];});
 let end=messages.length;
 if(before){let cursor:any;try{cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));}catch{throw unavailable();}if(cursor.session!==header.id)throw new Error('The saved session changed. Reload its latest messages.');end=messages.findIndex(m=>m.id===cursor.entry);if(end<0)throw unavailable();}
 const start=Math.max(0,end-50);const page=messages.slice(start,end);return {sessionId:header.id,messages:page,...(truncated?{truncated:true}:{}),hasMore:start>0,before:start>0?Buffer.from(JSON.stringify({session:header.id,entry:page[0].id})).toString('base64url'):null};
 }catch(e){if(e instanceof Error&&e.message==='The saved session changed. Reload its latest messages.')throw e;throw unavailable();}
}
