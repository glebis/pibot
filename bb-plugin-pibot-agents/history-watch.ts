import {watch,type FSWatcher} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {createHmac,randomBytes} from 'node:crypto';
import {basename,dirname} from 'node:path';
import {resolveHistorySource} from './history';

type Target={watchers:FSWatcher[];files:string;watchFiles:string[];signatures:string[];checking:boolean;expires:number;timer?:ReturnType<typeof setTimeout>;rearm:boolean};
/** Ephemeral invalidations only. Never broadcast paths, chat keys or message contents. */
export function createHistoryWatch(emit:(key:string)=>void,options:{ttlMs?:number;maxTargets?:number;debounceMs?:number;pollMs?:number}={}){
 const ttl=options.ttlMs??15*60_000,max=options.maxTargets??32,delay=options.debounceMs??50;
 const salt=randomBytes(32),targets=new Map<string,Target>();let disposed=false;
 function close(target:Target){if(target.timer)clearTimeout(target.timer);for(const w of target.watchers)w.close();}
 function expire(){for(const [key,t] of targets)if(t.expires<=Date.now()){close(t);targets.delete(key);}}
 async function signatures(files:string[]){return Promise.all(files.map(async file=>{try{const s=await lstat(file,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.uid].join(':')}catch{return 'unavailable'}}));}
 async function reconcile(key:string,target:Target){if(target.checking||disposed)return;target.checking=true;try{const next=await signatures(target.watchFiles);if(targets.get(key)===target&&JSON.stringify(next)!==JSON.stringify(target.signatures)){target.signatures=next;notify(key,target)}}finally{target.checking=false}}
 // Exact metadata checks also cover exhausted/missed native filesystem watches.
 const sweep=setInterval(()=>{expire();for(const [key,target] of targets)void reconcile(key,target)},Math.min(ttl,options.pollMs??500));sweep.unref();
 function notify(key:string,target:Target){if(disposed||target.timer)return;target.timer=setTimeout(()=>{target.timer=undefined;if(!disposed&&targets.get(key)===target)emit(key)},delay);target.timer.unref();}
 async function install(key:string,source:Awaited<ReturnType<typeof resolveHistorySource>>){
  const initial=await signatures(source.watchFiles);
  if(disposed)throw new Error('History observation stopped. Reload the plugin.');
  expire();const current=targets.get(key),files=JSON.stringify(source.watchFiles);
  // All awaits precede this lookup/install section: a concurrent observer is
  // always either reused or closed, never silently overwritten.
  if(current&&current.files===files&&!current.rearm){current.expires=Date.now()+ttl;targets.delete(key);targets.set(key,current);return;}
  if(current){close(current);targets.delete(key);}
  while(targets.size>=max){const first=targets.entries().next().value;if(!first)break;close(first[1]);targets.delete(first[0]);}
  const target:Target={watchers:[],files,watchFiles:source.watchFiles,signatures:initial,checking:false,expires:Date.now()+ttl,rearm:false};targets.set(key,target);
  const directories=new Map<string,Set<string>>();
  for(const file of source.watchFiles){const dir=dirname(file);const names=directories.get(dir)??new Set<string>();names.add(basename(file));directories.set(dir,names);}
  for(const [dir,names] of directories){
   try{const observer=watch(dir,{persistent:false},(_event,name)=>{if(name===null||names.has(name.toString()))void reconcile(key,target)});observer.on('error',()=>{target.rearm=true;void reconcile(key,target)});target.watchers.push(observer);}
   catch{target.rearm=true;void reconcile(key,target);}
  }
 }
 const pending=new Map<string,Promise<string>>();
 async function track(key:string,root:string,agentId:string,chatKey:string,checkoutRoot?:string){
  let source=await resolveHistorySource(root,agentId,chatKey,checkoutRoot);
  for(let pass=0;pass<3;pass++){
   await install(key,source);
   // Verify after observation starts. Index rotation between source resolution
   // and baseline metadata must not silently leave the old session observed.
   const verified=await resolveHistorySource(root,agentId,chatKey,checkoutRoot);
   if(disposed)throw new Error('History observation stopped. Reload the plugin.');
   if(JSON.stringify(verified.watchFiles)===JSON.stringify(source.watchFiles))return key;
   source=verified;
  }
  const target=targets.get(key);if(target)notify(key,target);
  throw new Error('The saved session is changing. Reload its latest messages.');
 }
 return {
  async track(root:string,agentId:string,chatKey:string,checkoutRoot?:string):Promise<string>{
   if(disposed)throw new Error('History observation stopped. Reload the plugin.');
   const key=createHmac('sha256',salt).update(JSON.stringify([root,agentId,chatKey,checkoutRoot])).digest('hex');
   const existing=pending.get(key);if(existing)return existing;
   const operation=track(key,root,agentId,chatKey,checkoutRoot);pending.set(key,operation);
   try{return await operation}finally{if(pending.get(key)===operation)pending.delete(key);}
  },
  dispose(){disposed=true;clearInterval(sweep);for(const target of targets.values())close(target);targets.clear();},
 };
}
