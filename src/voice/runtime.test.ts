import { describe,it,expect,vi } from 'vitest';
import {createCanonicalVoiceBridge,type VoiceHost} from './runtime.js';
const token='a'.repeat(64),callSid='CA'+'b'.repeat(32);
function setup(clock?:()=>number){const host:VoiceHost={voiceBindings:()=>[{agentId:'assistant',chatKey:'telegram:42'}],voiceTurn:vi.fn(async()=>({status:'completed' as const,text:'A useful reply.'}))};const bridge=createCanonicalVoiceBridge(host,token,clock);const request=(path:string,body?:unknown,method=body?'POST':'GET')=>bridge.app.request(path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{host,bridge,request};}
async function session(r:ReturnType<typeof setup>){const x=await r.request('/voice/sessions',{callSid,agentId:'assistant',chatKey:'telegram:42'});return (await x.json() as {sessionId:string}).sessionId;}
describe('canonical voice bridge',()=>{
 it('rejects unauthenticated access',async()=>{const r=setup();try{expect((await r.bridge.app.request('/voice/bindings')).status).toBe(401);}finally{r.bridge.close();}});
 it('rejects nonowner or stale bindings',async()=>{const r=setup();try{expect((await r.request('/voice/sessions',{callSid,agentId:'assistant',chatKey:'telegram:-42'})).status).toBe(403);}finally{r.bridge.close();}});
 it('runs one canonical turn and deduplicates its request',async()=>{const r=setup();try{const id=await session(r),body={text:'Hello',requestId:'r1'};expect((await r.request(`/voice/sessions/${id}/turn`,body)).status).toBe(200);expect((await r.request(`/voice/sessions/${id}/turn`,body)).status).toBe(200);expect(r.host.voiceTurn).toHaveBeenCalledTimes(1);expect((await r.request(`/voice/sessions/${id}/turn`,{...body,text:'Other'})).status).toBe(409);}finally{r.bridge.close();}});
 it('revalidates binding before every turn',async()=>{const r=setup();try{const id=await session(r);r.host.voiceBindings=()=>[];expect((await r.request(`/voice/sessions/${id}/turn`,{text:'Hi',requestId:'r1'})).status).toBe(403);expect(r.host.voiceTurn).not.toHaveBeenCalled();}finally{r.bridge.close();}});
 it('never recreates a consumed call session',async()=>{const r=setup();try{const id=await session(r);await r.request(`/voice/sessions/${id}`,undefined,'DELETE');expect((await r.request('/voice/sessions',{callSid,agentId:'assistant',chatKey:'telegram:42'})).status).toBe(409);}finally{r.bridge.close();}});
 it('refuses another call while one is attached',async()=>{const r=setup();try{await session(r);expect((await r.request('/voice/sessions',{callSid:'CA'+'c'.repeat(32),agentId:'assistant',chatKey:'telegram:42'})).status).toBe(409);}finally{r.bridge.close();}});
 it('announces pending approval while detaching audio without replay',async()=>{const r=setup();try{r.host.voiceTurn=vi.fn(async input=>{input.onApprovalRequired?.();return new Promise<never>(()=>{});});const id=await session(r);const response=await r.request(`/voice/sessions/${id}/turn`,{text:'Needs approval',requestId:'approval'});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({pendingApproval:true});expect(r.host.voiceTurn).toHaveBeenCalledTimes(1);}finally{r.bridge.close();}});

 for(const circumstance of ['closed','expired','request_aborted','binding_revoked'] as const) it(`does not invoke tools when ${circumstance} while the request body is streaming`,async()=>{
  let now=0;const r=setup(()=>now);try{
   const id=await session(r);let stream!:ReadableStreamDefaultController<Uint8Array>;let reading!:()=>void;
   const bodyRead=new Promise<void>(resolve=>{reading=resolve;});const signal=new AbortController();
   const body=new ReadableStream<Uint8Array>({start(c){stream=c;c.enqueue(new TextEncoder().encode('{"text":"Hello",'));},pull(){reading();}});
   const request=new Request(`http://localhost/voice/sessions/${id}/turn`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body,duplex:'half',signal:signal.signal} as RequestInit);
   const response=r.bridge.app.request(request);await bodyRead;
   if(circumstance==='closed')await r.request(`/voice/sessions/${id}`,undefined,'DELETE');
   if(circumstance==='expired')now=180001;
   if(circumstance==='request_aborted')signal.abort();
   if(circumstance==='binding_revoked')r.host.voiceBindings=()=>[];
   stream.enqueue(new TextEncoder().encode('"requestId":"slow"}'));stream.close();
   expect((await response).status).toBe(circumstance==='binding_revoked'?403:409);expect(r.host.voiceTurn).not.toHaveBeenCalled();
  }finally{r.bridge.close();}
 });

 it('serves blocked sources only through authenticated exact owner and live binding scope',async()=>{
  const r=setup();try{
   r.host.blockedDecisionProjection=scope=>scope.ownerId==='owner'?{schemaVersion:1,checkedAt:1,expiresAt:30001,...scope,available:true,decisions:[]}:undefined;
   expect((await r.bridge.app.request('/voice/blocked-decisions?ownerId=owner&agentId=assistant&chatKey=telegram:42')).status).toBe(401);
   expect((await r.request('/voice/blocked-decisions?ownerId=owner&agentId=assistant&chatKey=telegram:42')).status).toBe(200);
   expect((await r.request('/voice/blocked-decisions?ownerId=other&agentId=assistant&chatKey=telegram:42')).status).toBe(503);
   r.host.voiceBindings=()=>[];expect((await r.request('/voice/blocked-decisions?ownerId=owner&agentId=assistant&chatKey=telegram:42')).status).toBe(403);
  }finally{r.bridge.close();}
 });

});

it('reads a pending blocked decision without entering its locked agent and resumes after the chat answer',async()=>{const r=setup();let pending=true;r.host.voicePendingDecision=()=>pending?{decisionId:'q1',question:'Choose the deadline action.',options:['Approve','Cancel']}:undefined;try{const response=await r.request('/voice/sessions',{callSid,agentId:'assistant',chatKey:'telegram:42'});const created=await response.json() as any;expect(created.greeting).toContain('Choose the deadline action');expect(created.greeting).toContain('authenticated chat');const result=await r.request(`/voice/sessions/${created.sessionId}/turn`,{requestId:'pending',text:'Approve'});expect(await result.json()).toMatchObject({readOnly:true,pendingApproval:true});expect(r.host.voiceTurn).not.toHaveBeenCalled();pending=false;expect((await r.request(`/voice/sessions/${created.sessionId}/turn`,{requestId:'after',text:'Continue'})).status).toBe(200);expect(r.host.voiceTurn).toHaveBeenCalledOnce();}finally{r.bridge.close();}});
