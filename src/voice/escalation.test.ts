import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UrgentCallEscalation, type CallDecision, type CallPolicy, type CallConsent, type CallDispatchResult, type CallDispatchInput, type EscalationDependencies } from './escalation.js';

function fixture(result:CallDispatchResult={status:'accepted',providerCallId:'call-1'}) {
  let now=Date.parse('2026-10-14T10:00:00Z');
  const policy:CallPolicy={enabled:true,ownerId:'owner',agentId:'agent',canonicalChatId:'telegram:42',recipientRef:'owner-phone',currency:'EUR',maxExposureMinor:100,maxSpendMinor:300};
  const consent:CallConsent={...policy,kind:'owner_call',status:'active',id:'consent',lineageId:'lineage',version:1,digest:'digest',notBefore:now-1000,expiresAt:now+10*86400000,maxCallsPerDay:2,cooldownMs:1800000,messageGraceMs:120000,maxDurationSeconds:180,quietHours:{startMinute:1320,endMinute:480,timeZone:'Europe/Berlin'},boundedCostVerified:true,costScope:'telephone_speech_infrastructure',modelBudgetBound:false};
  let decisions:CallDecision[]=[{id:'decision-1',questionVersion:1,sourceContractId:'contract-1',ownerId:'owner',agentId:'agent',canonicalChatId:'telegram:42',urgent:true,state:'open',attention:'pending',deadline:now+86400000,acceptedMessageAt:now-120001}];
  const dispatcher={dispatch:vi.fn(async(_input:CallDispatchInput)=>result)};
  const authority={check:vi.fn(async()=>({allowed:true,checkedAt:now,consent}))};
  const sourceAuthority={check:vi.fn(async(d:CallDecision)=>({verified:true,checkedAt:now,expiresAt:now+30000,sourceContractId:d.sourceContractId,ownerId:d.ownerId,decisionId:d.id,questionVersion:d.questionVersion,revision:'rev-1',actionable:true,urgent:true,usefulUntil:d.deadline}))};
  const deps:EscalationDependencies={databasePath:join(mkdtempSync(join(tmpdir(),'call-gate-')),'calls.sqlite'),policy,decisions:()=>decisions,dispatcher,authority,sourceAuthority,clock:()=>now};
  return {deps,policy,consent,dispatcher,authority,sourceAuthority,get decisions(){return decisions;},set decisions(v){decisions=v;},advance:(ms:number)=>{now+=ms;},setNow:(value:number)=>{now=value;},now:()=>now};
}

describe('durable urgent-call gate',()=>{
  it('dispatches only the fixed recipient under a separate verified consent and persists the reserve first',async()=>{
    const f=fixture();const gate=new UrgentCallEscalation(f.deps);
    f.dispatcher.dispatch.mockImplementation(async()=>{expect(gate.history()[0]).toMatchObject({status:'unknown',maxExposureMinor:100});return {status:'accepted',providerCallId:'call-1'};});
    try{await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledOnce();expect(f.dispatcher.dispatch.mock.calls[0]?.[0]).toMatchObject({recipientRef:'owner-phone',maxDurationSeconds:180,sourceRevision:'rev-1',consentDigest:'digest'});expect(gate.history()[0]?.status).toBe('accepted');expect(f.authority.check).toHaveBeenCalledTimes(2);await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledOnce();}finally{gate.close();}
  });
  it.each(['disabled','not-urgent','answered','snoozed','wrong-owner','wrong-agent','wrong-chat','no-message','recent-message','expired'])('blocks %s',async(reason)=>{
    const f=fixture();if(reason==='disabled')f.policy.enabled=false;else{const d=f.decisions[0]!;if(reason==='not-urgent')d.urgent=false;if(reason==='answered')d.state='answered';if(reason==='snoozed')d.attention='snoozed';if(reason==='wrong-owner')d.ownerId='other';if(reason==='wrong-agent')d.agentId='other';if(reason==='wrong-chat')d.canonicalChatId='other';if(reason==='no-message')delete d.acceptedMessageAt;if(reason==='recent-message')d.acceptedMessageAt=f.now();if(reason==='expired')d.deadline=f.now();}
    const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();expect(f.dispatcher.dispatch).not.toHaveBeenCalled();expect(gate.history()).toEqual([]);}finally{gate.close();}
  });
  it.each(['message-consent','unverified-cost','source-unverified','source-stale','source-wrong-owner','source-not-urgent','authority-stale'])('fails closed for %s',async(reason)=>{
    const f=fixture();if(reason==='message-consent')(f.consent as unknown as {kind:string}).kind='message';if(reason==='unverified-cost')(f.consent as unknown as {boundedCostVerified:boolean}).boundedCostVerified=false;
    if(reason.startsWith('source-'))f.sourceAuthority.check.mockImplementation(async(d)=>({verified:reason!=='source-unverified',checkedAt:f.now()-(reason==='source-stale'?31000:0),expiresAt:f.now()+30000,sourceContractId:d.sourceContractId,ownerId:reason==='source-wrong-owner'?'other':d.ownerId,decisionId:d.id,questionVersion:d.questionVersion,revision:'r',actionable:true,urgent:reason!=='source-not-urgent',usefulUntil:d.deadline}));
    if(reason==='authority-stale')f.authority.check.mockImplementation(async()=>({allowed:true,checkedAt:f.now()-31000,consent:f.consent}));
    const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();expect(f.dispatcher.dispatch).not.toHaveBeenCalled();}finally{gate.close();}
  });
  it('rechecks decision state after async authority and source work',async()=>{
    const f=fixture();f.sourceAuthority.check.mockImplementation(async(d)=>{f.decisions[0]!.state='answered';return {verified:true,checkedAt:f.now(),expiresAt:f.now()+30000,sourceContractId:d.sourceContractId,ownerId:d.ownerId,decisionId:d.id,questionVersion:d.questionVersion,revision:'r',actionable:true,urgent:true,usefulUntil:d.deadline};});
    const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();expect(f.dispatcher.dispatch).not.toHaveBeenCalled();}finally{gate.close();}
  });
  it('revocation during the final check prevents dispatch',async()=>{const f=fixture();f.authority.check.mockResolvedValueOnce({allowed:true,checkedAt:f.now(),consent:f.consent}).mockResolvedValueOnce({allowed:false,checkedAt:f.now(),consent:f.consent});const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();expect(f.dispatcher.dispatch).not.toHaveBeenCalled();}finally{gate.close();}});
  it('unknown acceptance and thrown adapter outcomes never retry after reopening',async()=>{
    const f=fixture();f.dispatcher.dispatch.mockRejectedValue(Error('uncertain'));let gate=new UrgentCallEscalation(f.deps);await gate.tick();expect(gate.history()[0]?.status).toBe('unknown');gate.close();gate=new UrgentCallEscalation(f.deps);try{await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledOnce();expect(gate.history()[0]?.maxExposureMinor).toBe(100);}finally{gate.close();}
  });
  it('persists cooldown, rolling day budget and cumulative spend through consent renewal',async()=>{
    const f=fixture({status:'unknown'});f.policy.maxSpendMinor=200;const gate=new UrgentCallEscalation(f.deps);
    try{await gate.tick();f.decisions=[{...f.decisions[0]!,id:'decision-2'}];await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledTimes(1);f.advance(1800001);await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledTimes(2);f.decisions=[{...f.decisions[0]!,id:'decision-3',deadline:f.now()+3*86400000}];f.consent.version++;f.consent.lineageId='new-line';f.advance(1800001);await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledTimes(2);f.advance(86400000);await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledTimes(2);}finally{gate.close();}
  });
  it.each(['2026-07-01T20:00:00Z','2026-12-01T21:00:00Z'])('blocks Berlin quiet hours across DST at %s',async(instant)=>{const f=fixture();f.setNow(Date.parse(instant));f.consent.notBefore=f.now()-1000;f.consent.expiresAt=f.now()+86400000;f.decisions[0]!.deadline=f.now()+3600000;f.decisions[0]!.acceptedMessageAt=f.now()-120001;const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();expect(f.dispatcher.dispatch).not.toHaveBeenCalled();}finally{gate.close();}});
  it('never shrinks verified exposure to fit local budget',async()=>{const f=fixture();f.consent.maxExposureMinor=101;const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();expect(f.dispatcher.dispatch).not.toHaveBeenCalled();}finally{gate.close();}});
  it('preflight rejection cannot retry the same question',async()=>{const f=fixture({status:'rejected_preflight'});const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledOnce();expect(gate.history()[0]?.status).toBe('rejected_preflight');}finally{gate.close();}});
  it('two gate instances cannot claim the same question twice',async()=>{
    const f=fixture();const first=new UrgentCallEscalation(f.deps),second=new UrgentCallEscalation(f.deps);
    try{await Promise.all([first.tick(),second.tick()]);expect(f.dispatcher.dispatch).toHaveBeenCalledOnce();expect(first.history()).toHaveLength(1);}finally{first.close();second.close();}
  });
  it('changing the question version during authorization invalidates the original candidate',async()=>{
    const f=fixture();f.authority.check.mockImplementation(async()=>{f.decisions[0]!.questionVersion=2;return {allowed:true,checkedAt:f.now(),consent:f.consent};});
    const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();expect(f.dispatcher.dispatch).not.toHaveBeenCalled();}finally{gate.close();}
  });
  it('rejects policies which weaken fixed duration/grace/cooldown bounds',()=>{for(const change of [{maxDurationSeconds:181},{messageGraceMs:1},{cooldownMs:1}]){const f=fixture();Object.assign(f.policy,change);expect(()=>new UrgentCallEscalation(f.deps)).toThrow();}});
});

describe('call usage reconciliation',()=>{
  function usage(f:ReturnType<typeof fixture>, charge:number, residual:number|null=0) {
    return vi.fn(async(a:import('./escalation.js').CallAttempt)=>({schemaVersion:1 as const,terminal:true as const,attemptId:a.attemptId,providerCallId:a.providerCallId!,currency:a.currency,checkedAt:f.now(),confirmedTwilioMinor:charge,remainingExposureMinor:residual}));
  }
  it.each([[0,0,0],[12,23,35],[12,null,100],[400,0,400]])('accounts confirmed charge %s and residual %s without changing reservation',async(charge,residual,total)=>{
    const f=fixture();f.policy.maxSpendMinor=100;f.deps.usageReconciler={check:usage(f,charge!,residual!)};
    let gate=new UrgentCallEscalation(f.deps);await gate.tick();await gate.tick();
    expect(gate.history()[0]).toMatchObject({maxExposureMinor:100,status:'accepted',usageSettlement:{confirmedTwilioMinor:charge,remainingExposureMinor:residual,state:residual===0?'settled':'partial'}});
    gate.close();gate=new UrgentCallEscalation(f.deps);
    try {f.advance(1800001);f.decisions=[{...f.decisions[0]!,id:'next'}];await gate.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledTimes(total===0?2:1);expect(f.deps.usageReconciler.check).toHaveBeenCalledTimes(1);}finally{gate.close();}
  });
  it.each(['null','wrong-id','wrong-call','currency','stale','future','negative','fraction','nonterminal'])('keeps full reservation for %s evidence with durable polling backoff',async(kind)=>{
    const f=fixture();const check=usage(f,0);f.deps.usageReconciler={check:vi.fn(async(a)=>{const e=await check(a);if(kind==='null')return null;if(kind==='wrong-id')e.attemptId='other';if(kind==='wrong-call')e.providerCallId='other';if(kind==='currency')e.currency='USD';if(kind==='stale')e.checkedAt-=30001;if(kind==='future')e.checkedAt++;if(kind==='negative')e.confirmedTwilioMinor=-1;if(kind==='fraction')e.confirmedTwilioMinor=0.1;if(kind==='nonterminal')(e as any).terminal=false;return e;})};
    let gate=new UrgentCallEscalation(f.deps);await gate.tick();await gate.tick();expect(gate.history()[0]?.usageSettlement).toBeUndefined();gate.close();gate=new UrgentCallEscalation(f.deps);
    try{await gate.tick();expect(f.deps.usageReconciler.check).toHaveBeenCalledTimes(1);f.advance(60000);await gate.tick();expect(f.deps.usageReconciler.check).toHaveBeenCalledTimes(2);}finally{gate.close();}
  });
  it('shared instances reconcile once and preserve cooldown and daily frequency after zero settlement',async()=>{
    const f=fixture();f.deps.usageReconciler={check:usage(f,0)};const a=new UrgentCallEscalation(f.deps),b=new UrgentCallEscalation(f.deps);
    try{await a.tick();await Promise.all([a.tick(),b.tick()]);expect(f.deps.usageReconciler.check).toHaveBeenCalledTimes(1);f.decisions=[{...f.decisions[0]!,id:'two'}];await a.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledTimes(1);f.advance(1800001);await a.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledTimes(2);f.decisions=[{...f.decisions[0]!,id:'three'}];f.advance(1800001);await a.tick();expect(f.dispatcher.dispatch).toHaveBeenCalledTimes(2);}finally{a.close();b.close();}
  });
  it('never queries unknown dispatches without a provider identifier',async()=>{
    const f=fixture({status:'unknown'});f.deps.usageReconciler={check:usage(f,0)};const gate=new UrgentCallEscalation(f.deps);try{await gate.tick();await gate.tick();expect(f.deps.usageReconciler.check).not.toHaveBeenCalled();}finally{gate.close();}
  });
});
