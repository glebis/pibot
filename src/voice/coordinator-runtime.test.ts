import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { VoiceCoordinatorRuntime, localPhoneUsage, localPhoneDispatcher, type CoordinatorVoiceSnapshot, type VoiceCoordinatorOptions } from './coordinator-runtime.js';
import type { CallConsent, CallDispatchInput, CallPolicy } from './escalation.js';
function fixture(){
 let now=Date.parse('2026-10-14T12:00:00Z');
 const policy:CallPolicy={enabled:true,ownerId:'owner',agentId:'agent',canonicalChatId:'telegram:42',recipientRef:'owner-phone',currency:'EUR',maxExposureMinor:100,maxSpendMinor:200};
 const consent:CallConsent={...policy,kind:'owner_call',status:'active',id:'consent',lineageId:'lineage',version:1,digest:'digest',notBefore:now-1000,expiresAt:now+86400000,maxCallsPerDay:2,cooldownMs:1800000,messageGraceMs:120000,maxDurationSeconds:180,quietHours:{startMinute:1320,endMinute:480,timeZone:'Europe/Berlin'},boundedCostVerified:true,costScope:'telephone_speech_infrastructure',modelBudgetBound:false};
 const snapshot:CoordinatorVoiceSnapshot={paused:false,decisions:[{id:'decision',questionVersion:1,sourceContractId:'contract',ownerId:'owner',urgent:true,state:'open',attention:'pending',deadline:now+3600000,recipient:{botId:'123',chatId:'42',userId:'42'}}],attempts:[{decisionId:'decision',questionVersion:1,status:'accepted',dispatchedAt:now-130000,acceptedAt:now-130000}]};
 const http=vi.fn(async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));return new Response(JSON.stringify({attemptId:body.attemptId,state:'accepted',providerCallId:'CA'+'a'.repeat(32)}));});
 const authority={check:vi.fn(async()=>({allowed:true,checkedAt:now,consent}))};
 const opts:VoiceCoordinatorOptions={coordinator:{inspect:()=>snapshot},databasePath:join(mkdtempSync(join(tmpdir(),'voice-coordinator-')),'calls.sqlite'),policy,authority,sourceAuthority:{async check(d){return {verified:true,checkedAt:now,expiresAt:now+30000,sourceContractId:d.sourceContractId,ownerId:d.ownerId,decisionId:d.id,questionVersion:d.questionVersion,revision:'r1',actionable:true,urgent:true,usefulUntil:d.deadline};}},phoneURL:'http://127.0.0.1:8793',phoneToken:'a'.repeat(64),fetch:http as typeof fetch,clock:()=>now};
 return {opts,snapshot,http,authority,get now(){return now;},advance:(ms:number)=>{now+=ms;}};
}
describe('voice coordinator adapter',()=>{
 it('maps an accepted current-question message to one fixed owner call',async()=>{const f=fixture(),r=new VoiceCoordinatorRuntime(f.opts);try{await r.tick();expect(f.http).toHaveBeenCalledOnce();const [url,init]=f.http.mock.calls[0]!;expect(String(url)).toBe('http://127.0.0.1:8793/control/calls');expect(JSON.parse(String(init?.body))).toEqual({attemptId:expect.any(String),agentId:'agent',chatKey:'telegram:42',maxDurationSeconds:180,reason:'Urgent pending decision'});expect(r.inspect().attempts[0]?.status).toBe('accepted');expect(init?.redirect).toBe('error');await r.tick();expect(f.http).toHaveBeenCalledOnce();}finally{r.close();}});
 it.each(['paused','unhealthy','wrong-chat','wrong-user','answered','snoozed','not-urgent','old-version','unknown-message','recent-acceptance'])('suppresses %s',async(reason)=>{const f=fixture();if(reason==='paused')f.snapshot.paused=true;if(reason==='unhealthy')f.snapshot.workerHealthy=false;if(reason==='wrong-chat')f.snapshot.decisions[0]!.recipient.chatId='43';if(reason==='wrong-user')f.snapshot.decisions[0]!.recipient.userId='43';if(reason==='answered')f.snapshot.decisions[0]!.state='answered';if(reason==='snoozed')f.snapshot.decisions[0]!.attention='snoozed';if(reason==='not-urgent')f.snapshot.decisions[0]!.urgent=false;if(reason==='old-version')f.snapshot.attempts[0]!.questionVersion=2;if(reason==='unknown-message')f.snapshot.attempts[0]!.status='unknown';if(reason==='recent-acceptance')f.snapshot.attempts[0]!.acceptedAt=f.now;const r=new VoiceCoordinatorRuntime(f.opts);try{await r.tick();expect(f.http).not.toHaveBeenCalled();}finally{r.close();}});
 it('refreshes the coordinator after an awaited authority check',async()=>{const f=fixture();const originalConsent=(await f.authority.check()).consent;f.authority.check.mockImplementation(async()=>{f.snapshot.decisions[0]!.state='answered';return {allowed:true,checkedAt:f.now,consent:originalConsent};});const r=new VoiceCoordinatorRuntime(f.opts);try{await r.tick();expect(f.http).not.toHaveBeenCalled();}finally{r.close();}});
 it('retains unknown network outcomes and never resubmits on restart',async()=>{const f=fixture();f.http.mockRejectedValue(Error('network uncertain'));let r=new VoiceCoordinatorRuntime(f.opts);await r.tick();expect(r.inspect().attempts[0]?.status).toBe('unknown');r.close();r=new VoiceCoordinatorRuntime(f.opts);try{await r.tick();expect(f.http).toHaveBeenCalledOnce();}finally{r.close();}});
 it.each(['rejected','unknown','wrong-attempt','wrong-call-id'])('treats %s replies conservatively',async(reason)=>{const f=fixture();f.http.mockImplementation(async(_url,init)=>{const req=JSON.parse(String(init?.body));return new Response(JSON.stringify({attemptId:reason==='wrong-attempt'?'other':req.attemptId,state:reason==='rejected'||reason==='unknown'?reason:'accepted',providerCallId:reason==='wrong-call-id'?'bad':'CA'+'a'.repeat(32)}));});const r=new VoiceCoordinatorRuntime(f.opts);try{await r.tick();expect(r.inspect().attempts[0]?.status).toBe('unknown');}finally{r.close();}});
 it('persists first observation for legacy acceptance and waits a full grace period',async()=>{const f=fixture();delete f.snapshot.attempts[0]!.acceptedAt;let r=new VoiceCoordinatorRuntime(f.opts);await r.tick();expect(f.http).not.toHaveBeenCalled();r.close();f.advance(120001);r=new VoiceCoordinatorRuntime(f.opts);try{await r.tick();expect(f.http).toHaveBeenCalledOnce();}finally{r.close();}});
 it('stop prevents subsequent dispatch and closes cleanly',async()=>{const f=fixture(),r=new VoiceCoordinatorRuntime(f.opts);await r.stop();await r.tick();expect(f.http).not.toHaveBeenCalled();r.close();});
 it('rejects nonliteral, remote and credential-bearing control URLs',()=>{const f=fixture();for(const phoneURL of ['http://localhost:8793','http://127.0.0.1:80','https://127.0.0.1:8793','http://evil.example:8793','http://x:y@127.0.0.1:8793','http://127.0.0.1:8793/path'])expect(()=>localPhoneDispatcher({...f.opts,phoneURL})).toThrow();});
 it('rejects incorrect recipient binding before making a request',async()=>{const f=fixture();const sender=localPhoneDispatcher(f.opts);expect(await sender.dispatch({ownerId:'other',recipientRef:'owner-phone',attemptId:'x',maxDurationSeconds:180} as CallDispatchInput)).toEqual({status:'rejected_preflight'});expect(f.http).not.toHaveBeenCalled();});
});


describe('read-only phone usage client',()=>{
 it('reads usage from the exact private origin without a call request',async()=>{
  const f=fixture();f.http.mockImplementation(async()=>new Response(JSON.stringify({schemaVersion:1,attemptId:'attempt',providerCallId:'CA'+'a'.repeat(32),currency:'EUR',checkedAt:f.now,terminal:true,confirmedTwilioMinor:0,remainingExposureMinor:0})));
  const result=await localPhoneUsage(f.opts).check({attemptId:'attempt'} as any);
  expect(result?.confirmedTwilioMinor).toBe(0);
  const [url,init]=f.http.mock.calls[0]!;expect(String(url)).toBe('http://127.0.0.1:8793/control/calls/attempt/usage');expect(init?.method).toBe('GET');expect(init?.body).toBeUndefined();expect(init?.redirect).toBe('error');
 });
 it('retains unknown usage on unavailable or oversized replies',async()=>{
  const f=fixture(),reader=localPhoneUsage(f.opts);f.http.mockImplementation(async()=>new Response('',{status:503}));expect(await reader.check({attemptId:'attempt'} as any)).toBeNull();
  f.http.mockImplementation(async()=>new Response('x'.repeat(17000)));expect(await reader.check({attemptId:'attempt'} as any)).toBeNull();
 });
});
