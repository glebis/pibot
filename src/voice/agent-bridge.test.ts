import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceBridge, readVoiceToken } from './agent-bridge.js';
const token='a'.repeat(64);
const model={provider:'test',id:'model'} as any;
const answer={role:'assistant',content:[{type:'text',text:'Hello.'}],stopReason:'stop',timestamp:1} as any;
function setup(extra: Record<string,unknown>={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-bridge-')); fs.mkdirSync(path.join(dir,'coach'));
 fs.writeFileSync(path.join(dir,'coach/agent.json'),JSON.stringify({name:'Coach',model:'test/model',providers:['test']}));
 fs.writeFileSync(path.join(dir,'coach/AGENTS.md'),'You are a friendly coach.');
 const runtime={completeSimple:vi.fn(async()=>answer),hasConfiguredAuth:vi.fn(()=>true)};
 const bridge=createVoiceBridge({agentsDir:dir,token,runtime,resolve:()=>model,...extra});
 const req=(url:string,method='GET',body?:unknown)=>bridge.app.request(url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 return {dir,runtime,bridge,req};
}
afterEach(()=>vi.restoreAllMocks());
describe('isolated voice agent bridge',()=>{
 it('requires scoped authentication including health',async()=>{const h=setup();expect((await h.bridge.app.request('/health')).status).toBe(401);expect((await h.req('/health')).status).toBe(200);});
 it('uses selected persona/model, no tools or old history, deduplicates turns',async()=>{
  const h=setup();const {sessionId}=await(await h.req('/v1/sessions','POST',{agentId:'coach'})).json() as any;
  const turn={requestId:'r1',text:'Hello'};
  expect(await(await h.req(`/v1/sessions/${sessionId}/turn`,'POST',turn)).json()).toEqual({text:'Hello.'});
  await h.req(`/v1/sessions/${sessionId}/turn`,'POST',turn);expect(h.runtime.completeSimple).toHaveBeenCalledTimes(1);
  const call=h.runtime.completeSimple.mock.calls[0] as unknown as any[];
  expect(call[0]).toBe(model);expect(call[1].systemPrompt).toContain('friendly coach');expect(call[1].messages).toHaveLength(1);expect(call[1].tools).toBeUndefined();expect(call[2].maxTokens).toBe(512);
  expect((await h.req(`/v1/sessions/${sessionId}/turn`,'POST',{...turn,text:'different'})).status).toBe(409);
 });
 it('rejects policy changes, traversal, and symlinked personas',async()=>{
  const h=setup();expect((await h.req('/v1/sessions','POST',{agentId:'../coach'})).status).toBe(400);
  const {sessionId}=await(await h.req('/v1/sessions','POST',{agentId:'coach'})).json() as any;
  fs.writeFileSync(path.join(h.dir,'coach/agent.json'),JSON.stringify({model:'test/model',providers:['other']}));
  expect((await h.req(`/v1/sessions/${sessionId}/turn`,'POST',{requestId:'r',text:'Hi'})).status).toBe(403);expect(h.runtime.completeSimple).not.toHaveBeenCalled();
  fs.mkdirSync(path.join(h.dir,'linked'));fs.writeFileSync(path.join(h.dir,'linked/agent.json'),JSON.stringify({model:'test/model'}));fs.symlinkSync(path.join(h.dir,'coach/AGENTS.md'),path.join(h.dir,'linked/AGENTS.md'));
  expect((await h.req('/v1/sessions','POST',{agentId:'linked'})).status).toBe(400);
 });
 it('bounds sessions and expires them',async()=>{
  let now=0;const h=setup({now:()=>now});for(let i=0;i<4;i++) expect((await h.req('/v1/sessions','POST',{agentId:'coach'})).status).toBe(200);
  expect((await h.req('/v1/sessions','POST',{agentId:'coach'})).status).toBe(429);now=900001;expect((await h.req('/v1/sessions','POST',{agentId:'coach'})).status).toBe(200);
 });
 it('aborts timeout without replay, rejects concurrency and redacts provider errors',async()=>{
  const h=setup({timeoutMs:10});h.runtime.completeSimple.mockImplementation(()=>new Promise(()=>{}));
  const {sessionId}=await(await h.req('/v1/sessions','POST',{agentId:'coach'})).json() as any;const url=`/v1/sessions/${sessionId}/turn`;
  const first=h.req(url,'POST',{requestId:'r1',text:'hi'});await new Promise(r=>setTimeout(r,2));
  expect((await h.req(url,'POST',{requestId:'r2',text:'hi'})).status).toBe(409);
  expect(await(await first).json()).toEqual({error:'turn_cancelled'});expect((await h.req(url,'POST',{requestId:'r1',text:'hi'})).status).toBe(404);
  h.runtime.completeSimple.mockRejectedValue(new Error('SECRET provider detail'));
  const fresh=await(await h.req('/v1/sessions','POST',{agentId:'coach'})).json() as any;
  expect(await(await h.req(`/v1/sessions/${fresh.sessionId}/turn`,'POST',{requestId:'r3',text:'hi'})).json()).toEqual({error:'model_unavailable'});
 });
 it('shortens paths and bounds spoken output while preserving original model history',async()=>{
  const h=setup();const original={...answer,content:[{type:'text',text:'Open /Users/gleb/private/config.json. '+ 'Long reply '.repeat(200)}]};
  h.runtime.completeSimple.mockResolvedValue(original);
  const {sessionId}=await(await h.req('/v1/sessions','POST',{agentId:'coach'})).json() as any;
  const response=await(await h.req(`/v1/sessions/${sessionId}/turn`,'POST',{requestId:'style',text:'Where?'})).json() as any;
  expect(response.text).not.toContain('/Users/');expect(response.text).toContain('config');expect(response.text.length).toBeLessThanOrEqual(900);
  await h.req(`/v1/sessions/${sessionId}/turn`,'POST',{requestId:'next',text:'Thanks'});
  const call=h.runtime.completeSimple.mock.calls[1] as unknown as any[];expect(call[1].messages[1]).toBe(original);
 });
 it('permits credentialless loopback Ollama using a local placeholder, never remote Ollama',async()=>{
  const local={provider:'ollama',id:'local',baseUrl:'http://127.0.0.1:11434/v1'} as any;
  const runtime={completeSimple:vi.fn(async()=>answer),hasConfiguredAuth:()=>false,getAuth:vi.fn(async()=>({auth:{baseUrl:local.baseUrl}}))};
  const h=setup({runtime,resolve:()=>local});fs.writeFileSync(path.join(h.dir,'coach/agent.json'),JSON.stringify({model:'ollama/local',providers:['ollama']}));
  const {sessionId}=await(await h.req('/v1/sessions','POST',{agentId:'coach'})).json() as any;
  expect((await h.req(`/v1/sessions/${sessionId}/turn`,'POST',{requestId:'local',text:'hi'})).status).toBe(200);
  expect((runtime.completeSimple.mock.calls[0] as unknown as any[])[2].apiKey).toBe('ollama');
  local.baseUrl='https://example.com/v1';expect((await h.req('/v1/sessions','POST',{agentId:'coach'})).status).toBe(400);
 });
 it('selects only explicitly allowed authenticated catalog fallbacks and reports actual model',async()=>{
  const fallback={provider:'allowed',id:'fallback'} as any;
  const denied={provider:'denied',id:'other'} as any;
  const runtime={completeSimple:vi.fn(async()=>answer),hasConfiguredAuth:()=>true,getModels:()=>[denied,fallback]};
  const h=setup({runtime,resolve:(spec:string)=>spec==='test/model'?model:spec==='allowed/fallback'?fallback:denied,modelAvailable:(m:any)=>m!==model});
  fs.writeFileSync(path.join(h.dir,'coach/agent.json'),JSON.stringify({model:'test/model',providers:['test','allowed']}));
  const data=await(await h.req('/v1/agents')).json() as any;expect(data.agents[0].model).toBe('allowed/fallback');
  const {sessionId}=await(await h.req('/v1/sessions','POST',{agentId:'coach'})).json() as any;
  await h.req(`/v1/sessions/${sessionId}/turn`,'POST',{requestId:'fallback',text:'Hi'});
  expect((runtime.completeSimple.mock.calls[0] as unknown as any[])[0]).toBe(fallback);
 });
 it('validates token file permissions and shape',()=>{const h=setup();const p=path.join(h.dir,'token');fs.writeFileSync(p,token,{mode:0o600});expect(readVoiceToken(p)).toBe(token);fs.chmodSync(p,0o644);expect(()=>readVoiceToken(p)).toThrow();});
});
