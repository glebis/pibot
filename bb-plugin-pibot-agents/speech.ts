import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {accessSync,statSync,constants} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
type Status='speaking'|'finished'|'stopped'|'failed';
/** Prefer cached local Kokoro; discovery never installs or downloads anything. */
export function localSpeechCommand(){
 const fallback={command:'/usr/bin/say',args:['-f','-']};
 try{
  const python=process.env.PIBOT_VOICE_PYTHON||join(homedir(),'Library/Application Support/uv/tools/pipecat-ai-mcp-server/bin/python');accessSync(python,constants.X_OK);
  const here=dirname(fileURLToPath(import.meta.url));
  const script=[join(here,'kokoro-read-aloud.py'),join(here,'..','kokoro-read-aloud.py')].find(file=>{try{return statSync(file).isFile()}catch{return false}});
  if(!script)return fallback;
  for(const name of ['kokoro-v1.0.onnx','voices-v1.0.bin']){const st=statSync(join(homedir(),'.cache/kokoro-onnx',name));if(!st.isFile()||st.size===0)return fallback;}
  return {command:python,args:[script]};
 }catch{return fallback;}
}
/** Owned local speech only. Text travels over stdin, never shell or argv. */
export function createMacSpeech(){
 let current:{id:string;child:ChildProcess;timer:ReturnType<typeof setTimeout>}|undefined;
 const states=new Map<string,Status>();let disposed=false;
 function stop(id:string){
  if(current?.id!==id)return false;
  const owned=current;current=undefined;clearTimeout(owned.timer);states.set(id,'stopped');owned.child.kill('SIGTERM');return true;
 }
 function speak(text:string){
  if(disposed)throw new Error('Speech is unavailable while the plugin is stopping.');
  if(process.platform!=='darwin')throw new Error('Read aloud requires macOS on the machine running bb.');
  if(current)stop(current.id);
  const spoken=text.replace(/(?:\/[\w.~-]+){2,}/g,'the referenced file');
  const id=randomUUID();const selected=localSpeechCommand();const child=spawn(selected.command,selected.args,{stdio:['pipe','ignore','ignore'],shell:false});
  states.set(id,'speaking');while(states.size>32)states.delete(states.keys().next().value!);
  const timer=setTimeout(()=>stop(id),10*60*1000);timer.unref();current={id,child,timer};
  const finish=(status:Status)=>{if(states.get(id)==='speaking')states.set(id,status);if(current?.id===id){clearTimeout(current.timer);current=undefined;}};
  child.on('error',()=>finish('failed'));child.on('exit',code=>finish(code===0?'finished':'failed'));
  child.stdin?.on('error',()=>{child.kill('SIGTERM');finish('failed');});child.stdin?.end(spoken+'\n');
  return {playbackId:id};
 }
 return {speak,status:(id:string)=>({status:states.get(id)??'stopped' as Status}),stop:(id:string)=>({stopped:stop(id)}),dispose:()=>{disposed=true;if(current)stop(current.id);states.clear();}};
}
