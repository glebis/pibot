import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {afterEach,describe,expect,it} from 'vitest';
import {ContractsVoiceAuthority} from './contracts-authority.js';
import type {CallDecision} from './escalation.js';
const now=Date.parse('2026-10-13T12:00:00Z'),hash='sha256:'+'a'.repeat(64);
const decision:CallDecision={id:'decision',questionVersion:1,sourceContractId:'contract',ownerId:'owner',agentId:'assistant',canonicalChatId:'telegram:42',urgent:true,state:'open',attention:'pending',deadline:now+60000};
const consent={kind:'owner_call',status:'active',id:'mandate',lineageId:'lineage',version:1,digest:hash,ownerId:'owner',coordinatorId:'coordinator',agentId:'assistant',canonicalChatId:'telegram:42',recipientRef:'owner-phone',notBefore:now-1000,expiresAt:now+60000,maxCallsPerDay:2,cooldownMs:1800000,messageGraceMs:120000,maxDurationSeconds:180,currency:'EUR',maxExposureMinor:100,maxSpendMinor:500,quietHours:{startMinute:1320,endMinute:480,timeZone:'Europe/Berlin'},boundedCostVerified:true,costScope:'telephone_speech_infrastructure',modelBudgetBound:false,costEvidenceDigest:hash};
const source={verified:true,checkedAt:now,expiresAt:now+30000,sourceContractId:'contract',ownerId:'owner',decisionId:'decision',questionVersion:1,revision:'revision',actionable:true,urgent:true,usefulUntil:decision.deadline};
const servers:net.Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
async function fixture(timeoutMs=2000){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync('/tmp'),'voice-authority-'));fs.chmodSync(directory,0o700);const tokenFile=path.join(directory,'token'),socketPath=path.join(directory,'rpc');fs.writeFileSync(tokenFile,'b'.repeat(64),{mode:0o600});
 const state:{result:any;envelope?:(r:any)=>any;requests:any[];raw?:string;silent?:boolean}={result:{schemaVersion:1,allowed:true,reason:'ok',checkedAt:now,consent:{...consent}},requests:[]};
 const server=net.createServer(client=>{let data='';client.on('error',()=>{});client.on('data',chunk=>{data+=chunk;if(!data.includes('\n'))return;const request=JSON.parse(data.split('\n')[0]);state.requests.push(request);if(state.silent)return;const envelope={schemaVersion:1,requestId:request.requestId,ok:true,result:state.result};client.end(state.raw??JSON.stringify(state.envelope?.(envelope)??envelope)+'\n');});});servers.push(server);
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));fs.chmodSync(socketPath,0o600);
 const authority=new ContractsVoiceAuthority({socketPath,tokenFile,ownerId:'owner',coordinatorId:'coordinator',mandateId:'mandate',agentId:'assistant',canonicalChatId:'telegram:42',recipientRef:'owner-phone',clock:()=>now,timeoutMs});
 return {authority,state,directory,tokenFile,socketPath};
}
describe('Contracts voice authority client',()=>{
 it('authenticates exact scoped operations and validates consent/projection',async()=>{
  const f=await fixture();expect((await f.authority.authority.check(decision,{version:1,digest:hash})).allowed).toBe(true);
  expect(f.state.requests[0]).toMatchObject({op:'callCheck',token:'b'.repeat(64),input:{mandateId:'mandate',ownerId:'owner',coordinatorId:'coordinator',agentId:'assistant',canonicalChatId:'telegram:42',recipientRef:'owner-phone',expectedVersion:1,expectedDigest:hash}});
  f.state.result=source;expect(await f.authority.sourceAuthority.check(decision)).toEqual(source);
  expect(f.state.requests[1].input).toMatchObject({sourceContractId:'contract',decisionId:'decision',questionVersion:1});expect(f.state.requests[1].input.expectedDigest).toBeUndefined();
 });
 it('rejects local mismatched decisions without connecting',async()=>{const f=await fixture();for(const patch of [{ownerId:'other'},{agentId:'other'},{canonicalChatId:'telegram:99'},{deadline:now},{questionVersion:0}]){expect((await f.authority.check({...decision,...patch})).allowed).toBe(false);expect((await f.authority.project({...decision,...patch})).verified).toBe(false);}expect(f.state.requests).toHaveLength(0);});
 it('fails closed on wrong authority identity, cost proof, constraints or CAS',async()=>{
  const f=await fixture();for(const patch of [{ownerId:'other'},{coordinatorId:'other'},{agentId:'other'},{canonicalChatId:'telegram:99'},{recipientRef:'other'},{id:'other'},{digest:'bad'},{boundedCostVerified:false},{costEvidenceDigest:undefined},{version:2},{maxDurationSeconds:181},{maxCallsPerDay:4},{maxSpendMinor:1},{quietHours:{startMinute:1,endMinute:2,timeZone:'UTC'}},{expiresAt:now}]){f.state.result={schemaVersion:1,allowed:true,checkedAt:now,consent:{...consent,...patch}};expect((await f.authority.check(decision,{version:1,digest:hash})).allowed,JSON.stringify(patch)).toBe(false);}
 });
 it('rejects stale and future checks and mismatched or stretched source projections',async()=>{
  const f=await fixture();for(const checkedAt of [now-30001,now+1]){f.state.result={schemaVersion:1,allowed:true,checkedAt,consent};expect((await f.authority.check(decision)).allowed).toBe(false);}
  for(const patch of [{checkedAt:now-30001},{checkedAt:now+1},{expiresAt:now},{expiresAt:now+30001},{ownerId:'other'},{sourceContractId:'other'},{decisionId:'other'},{questionVersion:2},{revision:''},{urgent:false},{actionable:false},{usefulUntil:decision.deadline+1}]){f.state.result={...source,...patch};expect((await f.authority.project(decision)).verified,JSON.stringify(patch)).toBe(false);}
 });
 it('rejects wrong envelopes, malformed data, oversized replies and timeout without leaking server errors',async()=>{
  const f=await fixture(80);for(const patch of [{requestId:'other'},{schemaVersion:2},{ok:false,result:{error:'SECRET'}}]){f.state.envelope=r=>({...r,...patch});expect(await f.authority.check(decision)).toEqual({allowed:false,checkedAt:now});}
  f.state.envelope=undefined;for(const raw of ['not-json\n','x'.repeat(65537)+'\n']){f.state.raw=raw;expect((await f.authority.check(decision)).allowed).toBe(false);}
  f.state.raw=undefined;f.state.silent=true;expect((await f.authority.check(decision)).allowed).toBe(false);
 });
 it('refuses unsafe credential/socket/directory permissions and symlinks before connecting',async()=>{
  const f=await fixture();fs.chmodSync(f.tokenFile,0o644);expect((await f.authority.check(decision)).allowed).toBe(false);fs.chmodSync(f.tokenFile,0o600);
  fs.chmodSync(f.socketPath,0o666);expect((await f.authority.check(decision)).allowed).toBe(false);fs.chmodSync(f.socketPath,0o600);
  fs.chmodSync(f.directory,0o755);expect((await f.authority.check(decision)).allowed).toBe(false);fs.chmodSync(f.directory,0o700);
  fs.renameSync(f.tokenFile,f.tokenFile+'.original');fs.symlinkSync(f.tokenFile+'.original',f.tokenFile);expect((await f.authority.check(decision)).allowed).toBe(false);expect(f.state.requests).toHaveLength(0);
 });
});

it('reads a late approval reference, refuses changed mandate during CAS, validates source freshness',async()=>{const f=await fixture();const mandateIdFile=path.join(f.directory,'mandate.json');const a=new ContractsVoiceAuthority({socketPath:f.socketPath,token:async()=>'b'.repeat(64),mandateIdFile,ownerId:'owner',coordinatorId:'coordinator',agentId:'assistant',canonicalChatId:'telegram:42',recipientRef:'owner-phone',clock:()=>now});expect((await a.sources()).available).toBe(false);expect(f.state.requests).toHaveLength(0);fs.writeFileSync(mandateIdFile,JSON.stringify({mandateId:'mandate'}),{mode:0o600});expect((await a.check(decision)).allowed).toBe(true);fs.writeFileSync(mandateIdFile,JSON.stringify({mandateId:'other'}));expect((await a.check(decision,{version:1,digest:hash})).allowed).toBe(false);fs.writeFileSync(mandateIdFile,JSON.stringify({mandateId:'mandate'}));const good={schemaVersion:1,checkedAt:now,expiresAt:now+30000,available:true,sources:[{sourceClass:'reviewed_contract_deadline',sourceContractId:'contract',decisionId:'decision',questionVersion:1,revision:'rev',deadline:now+60000,urgentFrom:now-1000,urgent:true,actionable:true,title:'Deadline',provenance:'reviewed_active_contract'}],blockers:[]};f.state.result=good;expect((await a.sources()).sources).toHaveLength(1);for(const patch of [{available:false},{checkedAt:now+1},{expiresAt:now+30001},{sources:[{...good.sources[0],provenance:'agent_declared_deadline'}]}]){f.state.result={...good,...patch};expect((await a.sources()).available).toBe(false);}});
