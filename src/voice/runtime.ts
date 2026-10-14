import type { SourceScope, BlockedDecisionProjection } from './urgent-sources.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { decryptJsonWithSops } from '../core/secrets.js';
import { applyVoiceStyle } from '../core/voice-style.js';
import type { BotVoiceInput, BotVoiceResult } from './session-control.js';
import { httpPhoneControl, type PhoneControl } from './owner-commands.js';

export interface VoiceHost {
  voiceBindings(): Array<{agentId:string;chatKey:string}>;
  voicePendingDecision?(input:{agentId:string;chatKey:string}):{decisionId:string;question:string;options:string[]}|undefined;
  voiceTurn(input:BotVoiceInput):Promise<BotVoiceResult>;
  blockedDecisionProjection?(scope:SourceScope):BlockedDecisionProjection|undefined;
}
interface Session { agentId:string;chatKey:string;callSid:string;expires:number;controller:AbortController;requests:Map<string,{text:string;reply?:string}>;busy:boolean }
export function createCanonicalVoiceBridge(host:VoiceHost,token:string,clock=Date.now) {
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid voice bridge credential');
  const sessions=new Map<string,Session>();
  const consumedCalls=new Set<string>();
  const app=new Hono();
  function sweep(){for(const [id,s] of sessions)if(s.expires<=clock()){s.controller.abort();sessions.delete(id);}}
  app.use('*',async(c,next)=>{
    const got=c.req.header('authorization')??'',expected=`Bearer ${token}`;
    if(Buffer.byteLength(got)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(got),Buffer.from(expected)))return c.json({error:'unauthorized'},401);
    c.header('Cache-Control','no-store');sweep();return next();
  });
  async function body(c:any){
    if(!(c.req.header('content-type')??'').startsWith('application/json'))throw new Error('invalid_body');
    const reader=c.req.raw.body?.getReader();if(!reader)throw new Error('invalid_body');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();throw new Error('invalid_body');}chunks.push(value);}}finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const allowed=(s:{agentId:string;chatKey:string})=>host.voiceBindings().some(b=>b.agentId===s.agentId&&b.chatKey===s.chatKey);
  const pendingSummary=(binding:{agentId:string;chatKey:string})=>{
    const q=host.voicePendingDecision?.(binding);if(!q)return undefined;
    const question=applyVoiceStyle(q.question,{maxSentences:4,maxChars:650,allowFullPaths:false}).slice(0,650);
    const choices=q.options.slice(0,10).map((choice,i)=>`${i+1}: ${applyVoiceStyle(choice,{maxSentences:1,maxChars:55,allowFullPaths:false}).slice(0,55)}`).join('. ');
    return `A decision is waiting: ${question}${choices?` Options: ${choices}.`:''} Please answer in your authenticated chat; approvals are kept there.`;
  };
  app.get('/voice/bindings' ,c=>c.json({bindings:host.voiceBindings()}));
  app.get('/health',c=>c.json({ok:true,mode:'canonical-agent'}));
  app.get('/voice/blocked-decisions',c=>{
    const ownerId=c.req.query('ownerId'),agentId=c.req.query('agentId'),canonicalChatId=c.req.query('chatKey');
    if(!ownerId||!agentId||!canonicalChatId||[ownerId,agentId,canonicalChatId].some(x=>x.length>160)||!allowed({agentId,chatKey:canonicalChatId}))return c.json({error:'source_scope_denied'},403);
    const projection=host.blockedDecisionProjection?.({ownerId,agentId,canonicalChatId});
    if(!projection||!projection.available||projection.ownerId!==ownerId||projection.agentId!==agentId||projection.canonicalChatId!==canonicalChatId)return c.json({error:'source_unavailable'},503);
    return c.json(projection);
  });
  app.post('/voice/sessions',async c=>{
    let b:any;try{b=await body(c);}catch{return c.json({error:'invalid_body'},400);}
    if(!b||typeof b.agentId!=='string'||typeof b.chatKey!=='string'||!/^CA[a-f0-9]{32}$/i.test(b.callSid??'')||!allowed(b))return c.json({error:'binding_denied'},403);
    if(sessions.size||consumedCalls.has(b.callSid)||consumedCalls.size>=10000)return c.json({error:'session_unavailable'},409);
    const sessionId=randomUUID();consumedCalls.add(b.callSid);
    sessions.set(sessionId,{agentId:b.agentId,chatKey:b.chatKey,callSid:b.callSid,expires:clock()+180000,controller:new AbortController(),requests:new Map(),busy:false});
    const greeting=pendingSummary(b);return c.json({sessionId,...(greeting?{greeting}: {})});
  });
  app.delete('/voice/sessions/:id',c=>{const id=c.req.param('id'),s=sessions.get(id);s?.controller.abort();sessions.delete(id);return c.json({closed:true});});
  app.post('/voice/sessions/:id/turn',async c=>{
    const sessionId=c.req.param('id'),s=sessions.get(sessionId);if(!s)return c.json({error:'session_expired'},404);
    const attached=()=>sessions.get(sessionId)===s&&!s.controller.signal.aborted&&!c.req.raw.signal.aborted&&s.expires>clock();
    if(!allowed(s)){s.controller.abort();return c.json({error:'binding_changed'},403);}
    let b:any;try{b=await body(c);}catch{return c.json({error:'invalid_body'},400);}
    if(!attached())return c.json({error:'turn_detached'},409);
    if(!allowed(s)){s.controller.abort();return c.json({error:'binding_changed'},403);}
    if(!b||typeof b.text!=='string'||!b.text.trim()||b.text.length>4000||typeof b.requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(b.requestId))return c.json({error:'invalid_turn'},400);
    const previous=s.requests.get(b.requestId);
    if(previous)return previous.text!==b.text?c.json({error:'request_conflict'},409):previous.reply!==undefined?c.json({text:previous.reply}):c.json({error:'request_outcome_unknown'},409);
    if(s.busy||s.requests.size>=20)return c.json({error:'session_busy_or_limit'},409);
    s.busy=true;s.requests.set(b.requestId,{text:b.text});
    const controller=new AbortController();
    const detach=()=>controller.abort();s.controller.signal.addEventListener('abort',detach,{once:true});c.req.raw.signal.addEventListener('abort',detach,{once:true});
    if(!attached())detach();
    const timer=setTimeout(detach,Math.min(40000,Math.max(1,s.expires-clock())));
    try{
      let approval!:()=>void;
      const approvalNotice=new Promise<BotVoiceResult>(resolve=>{approval=()=>resolve({status:'completed',text:'An approval is waiting in your authenticated chat. Please respond there. The result will remain in that conversation.'});});
      const detached=new Promise<BotVoiceResult>(resolve=>{if(controller.signal.aborted)resolve({status:'detached'});else controller.signal.addEventListener('abort',()=>resolve({status:'detached'}),{once:true});});
      let approvalPending=false;
      if(!attached()||controller.signal.aborted)return c.json({error:'turn_detached'},409);
      if(!allowed(s)){controller.abort();return c.json({error:'binding_changed'},403);}
      if(!attached()||controller.signal.aborted)return c.json({error:'turn_detached'},409);
      const pending=pendingSummary(s);
      if(pending){s.requests.set(b.requestId,{text:b.text,reply:pending});return c.json({text:pending,pendingApproval:true,readOnly:true});}
      const turn=host.voiceTurn({agentId:s.agentId,chatKey:s.chatKey,text:b.text,signal:controller.signal,onApprovalRequired:()=>{approvalPending=true;approval();}});
      const result=await Promise.race([turn,approvalNotice,detached]);
      if(approvalPending){controller.abort();const reply=result.text!;s.requests.set(b.requestId,{text:b.text,reply});return c.json({text:reply,pendingApproval:true});}
      if(controller.signal.aborted||result.status==='detached')return c.json({error:'turn_detached'},409);
      if(result.status==='busy')return c.json({error:'agent_busy'},409);
      if(result.status!=='completed'||!result.text)return c.json({error:'agent_reply_unavailable'},502);
      const reply=applyVoiceStyle(result.text,{maxSentences:6,maxChars:1600,allowFullPaths:false}).trim().slice(0,1600);
      if(!reply)return c.json({error:'empty_reply'},502);
      s.requests.set(b.requestId,{text:b.text,reply});return c.json({text:reply});
    }finally{clearTimeout(timer);s.controller.signal.removeEventListener('abort',detach);c.req.raw.signal.removeEventListener('abort',detach);s.busy=false;}
  });
  app.onError((_e,c)=>c.json({error:'voice_request_failed'},500));
  const expiry=setInterval(sweep,1000);expiry.unref();
  return {app,close(){clearInterval(expiry);for(const s of sessions.values())s.controller.abort();sessions.clear();}};
}
export async function startCanonicalVoiceRuntime(host:VoiceHost,file:string){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let config:any;
  try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.size>16384)throw new Error('Private voice config required');config=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
  if(!path.isAbsolute(config.secretsFile)||!Number.isInteger(config.bridgePort)||config.bridgePort<1024||config.bridgePort>65535)throw new Error('Invalid voice config');
  const secrets=await decryptJsonWithSops<Record<string,string>>(config.secretsFile);
  const bridge=createCanonicalVoiceBridge(host,secrets.VOICE_BRIDGE_TOKEN);
  const server=serve({fetch:bridge.app.fetch,hostname:'127.0.0.1',port:config.bridgePort});
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  // Owner /call reuses the operator call path (scripts/voice-call.py); absent token = calls unavailable.
  const controlToken=secrets.PHONE_CONTROL_TOKEN;
  const phone:PhoneControl|undefined=typeof controlToken==='string'&&/^[0-9a-f]{64}$/.test(controlToken)
    ?httpPhoneControl({controlUrl:typeof config.phoneControlUrl==='string'?config.phoneControlUrl:'http://127.0.0.1:8793',token:controlToken,bindings:()=>host.voiceBindings()})
    :undefined;
  return {phone,close:async()=>{bridge.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
