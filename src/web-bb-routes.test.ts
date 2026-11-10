import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerBbRoutes } from "./web-bb-routes.js";
import type { WebDeps } from "./web.js";
import { createAgentFromSpec } from "./core/agent-factory.js";
import {BbChatError} from './transports/bb.js';
vi.mock("./core/agent-factory.js", async original => ({ ...await original<typeof import('./core/agent-factory.js')>(), createAgentFromSpec: vi.fn() }));
function setup(token: string | undefined = "secret") {
  const cancelTask = vi.fn(async () => true);
  const snapshot = vi.fn(async () => ({ takenAt: 1, daemon: {pid: 1, uptimeSec: 2, rssKb: 3, secret: 'hidden'}, turns: [{id: 2, kind: 'chat', label: 'private', chatKey: 'private', startedAt: 1}], tasks: {active: [{id: 'tk_1', title: 'a'.repeat(300), instructions: 'private', result: 'private', error: 'private', inputLocations: 'private', status: 'running', createdAt: 1}], recent: []}, goals: [{objective: 'private', chatKey:'private', turnsUsed: 1}], voiceCalls: [{agentId:'helper',chatKey:'private'}], children: [{pid:2, command:'/private/tool secret argv'}], childrenError: 'private path' }));
  const deps = { agents: { list: () => [{id:'helper', dir:'private', manifest:{description:'Helper', telegram:{token:'private'}, envPassthrough:['private']}}] }, scheduler: {snoozeState: () => null}, processes: {snapshot, cancelTask} } as unknown as WebDeps;
  const app = new Hono(); registerBbRoutes(app, deps, token);
  const request = (url: string, method = 'GET', body?: string, auth = 'Bearer secret') => app.request(url, {method, headers: {Authorization:auth, 'Content-Type':'application/json'}, body});
  return {app,deps,request,cancelTask,snapshot};
}
describe('BB API', () => {
  it('authenticates independent conversation discovery and message ingress before touching controls',async()=>{const {request,deps}=setup();const conversations=vi.fn(()=>[]),send=vi.fn(async()=>({text:'reply'}));deps.bbConversations={conversations,send};expect((await request('/api/bb/conversations?agentId=helper','GET',undefined,'Bearer wrong')).status).toBe(401);expect((await request('/api/bb/chat','POST','{}','Bearer wrong')).status).toBe(401);expect(conversations).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();});
  it('lists only the requested independent agent conversation without sending or creating a session',async()=>{const {request,deps}=setup();const conversations=vi.fn((id:string)=>{if(id!=='helper')throw new BbChatError(404,'Agent unavailable.');return [{agentId:id,chatKey:`bb:${id}:owner`,canSend:true as const,kind:'bb' as const}]}),send=vi.fn();deps.bbConversations={conversations,send};expect(await (await request('/api/bb/conversations?agentId=helper')).json()).toEqual({conversations:[{agentId:'helper',chatKey:'bb:helper:owner',canSend:true,kind:'bb'}]});expect((await request('/api/bb/conversations?agentId=missing')).status).toBe(404);expect((await request('/api/bb/conversations?agentId=../helper')).status).toBe(400);expect(send).not.toHaveBeenCalled();});
  it('accepts strict owner BB messages and refuses cross-agent or Telegram destinations',async()=>{const {request,deps}=setup();const send=vi.fn(async()=>({text:'reply',pendingApproval:true}));deps.bbConversations={conversations:()=>[],send};const valid={agentId:'helper',chatKey:'bb:helper:owner',text:'hello',requestId:'req-1',allowTools:false};expect(await (await request('/api/bb/chat','POST',JSON.stringify(valid))).json()).toEqual({text:'reply',pendingApproval:true});expect(send).toHaveBeenCalledWith(valid);for(const body of [{...valid,chatKey:'bb:other:owner'},{...valid,chatKey:'telegram:42'},{...valid,allowTools:'true'},{...valid,text:''},{...valid,requestId:'../id'},{...valid,provider:'external'},{...valid,text:'x'.repeat(4001)}])expect((await request('/api/bb/chat','POST',JSON.stringify(body))).status).toBe(400);expect(send).toHaveBeenCalledTimes(1);});
  it('preserves busy/idempotency conflicts and sanitizes backend failures',async()=>{const {request,deps}=setup();const send=vi.fn(async()=>({text:'reply'}));deps.bbConversations={conversations:()=>[],send};const body=JSON.stringify({agentId:'helper',chatKey:'bb:helper:owner',text:'hello',requestId:'req-1',allowTools:true});send.mockRejectedValueOnce(new BbChatError(409,'This BB conversation is busy.'));expect((await request('/api/bb/chat','POST',body)).status).toBe(409);send.mockRejectedValueOnce(new Error('secret path'));const response=await request('/api/bb/chat','POST',body);expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain('secret path');});
  it('requires bearer on reads and writes, rejecting cookies and query credentials', async () => {
    const {app,request,cancelTask,snapshot}=setup();
    for (const [url,method] of [['/api/bb/agents','GET'],['/api/bb/processes','GET'],['/api/bb/agents','POST'],['/api/bb/tasks/tk_1/cancel','POST']]) expect((await request(url,method,undefined,'Bearer wrong')).status).toBe(401);
    expect((await app.request('/api/bb/agents?token=secret',{headers:{Cookie:'pibot_session=secret'}})).status).toBe(401);
    expect(cancelTask).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
  });
  it('fails closed without a configured token', async () => {
    const {app,deps}=setup(); const unavailable=new Hono(); registerBbRoutes(unavailable,deps,undefined);
    expect((await unavailable.request('/api/bb/agents')).status).toBe(503); expect(app).toBeDefined();
  });
  it('projects metadata without secrets or paths', async () => {
    const res=await setup().request('/api/bb/agents');
    expect(await res.json()).toEqual({agents:[{id:'helper',description:'Helper',model:'',providers:[],capabilities:[],snoozed:false}]}); expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects malformed, oversized, and non-strict creation input', async () => {
    const {request}=setup();
    for(const b of ['{','null','[]',JSON.stringify({id:'Bad',description:'ok'}),JSON.stringify({id:'ok',description:''}),JSON.stringify({id:'ok',description:'ok',capabilities:[]}),JSON.stringify({id:'ok',description:'ok',proactivity:'balanced'}),JSON.stringify({id:'ok',description:'x'.repeat(9000)})]) expect((await request('/api/bb/agents','POST',b)).status).toBe(400);
  });
  it('creates reactive capability-free agents without scheduler or transport wiring', async () => {
    vi.mocked(createAgentFromSpec).mockResolvedValueOnce({ok:true,id:'helper',dir:'private',manifest:{name:'helper'}});
    const {request,deps}=setup(); expect((await request('/api/bb/agents','POST',JSON.stringify({id:'helper',description:'Helper'}))).status).toBe(201);
    expect(createAgentFromSpec).toHaveBeenLastCalledWith({agents:deps.agents},{id:'helper',description:'Helper',proactivity:'off',capabilities:[]});
    vi.mocked(createAgentFromSpec).mockResolvedValueOnce({ok:false,error:'private'});
    expect((await request('/api/bb/agents','POST','{"id":"helper","description":"Helper"}')).status).toBe(400);
    vi.mocked(createAgentFromSpec).mockRejectedValueOnce(new Error('secret path'));
    expect(await (await request('/api/bb/agents','POST','{"id":"helper","description":"Helper"}')).json()).toEqual({error:'Agent creation unavailable'});
  });
  it('bounds and explicitly projects process data', async () => {
    const json=await (await setup().request('/api/bb/processes')).json() as {tasks:{active:Array<{title:string}>},turns:Array<{id:string}>,childrenUnavailable:boolean};
    expect(JSON.stringify(json)).not.toMatch(/private|secret|argv|instructions|chatKey|objective/);
    expect(json.tasks.active[0].title).toHaveLength(160); expect(json.turns[0].id).toBe('2'); expect(json.childrenUnavailable).toBe(true); expect((json as unknown as {children:Array<{command:string}>}).children[0].command).toBe('tool');
  });
  it('cancels only the named task and handles missing/unavailable controls', async () => {
    const {request,cancelTask,snapshot,deps}=setup(); expect(await (await request('/api/bb/tasks/tk_1/cancel','POST')).json()).toEqual({cancelled:true}); expect(cancelTask).toHaveBeenCalledWith('tk_1');
    cancelTask.mockResolvedValueOnce(false); expect((await request('/api/bb/tasks/missing/cancel','POST')).status).toBe(200);
    cancelTask.mockRejectedValueOnce(new Error('private')); expect((await request('/api/bb/tasks/tk_1/cancel','POST')).status).toBe(503);
    snapshot.mockRejectedValueOnce(new Error('private')); expect((await request('/api/bb/processes')).status).toBe(503);
    deps.processes=undefined; expect((await request('/api/bb/processes')).status).toBe(503); expect((await request('/api/bb/tasks/tk_1/cancel','POST')).status).toBe(503);
  });
  it('accepts attachment-only messages with bounded binary bytes and retains small limits on other routes',async()=>{const {request,deps}=setup();const send=vi.fn(async()=>({text:'reply'}));deps.bbConversations={conversations:()=>[],send};const attachment={name:'shot.png',mimeType:'image/png',dataBase64:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(9000)]).toString('base64')};const valid={agentId:'helper',chatKey:'bb:helper:owner',text:'',requestId:'image-only',allowTools:false,attachments:[attachment]};expect((await request('/api/bb/chat','POST',JSON.stringify(valid))).status).toBe(200);expect(send).toHaveBeenCalledWith(valid);for(const attachments of [[{...attachment,name:'../shot.png'}],[{...attachment,mimeType:'image/jpeg'}],[{name:'file.txt',mimeType:'text/plain',dataBase64:'eA=='}]])expect((await request('/api/bb/chat','POST',JSON.stringify({...valid,attachments}))).status).toBe(400);expect(send).toHaveBeenCalledTimes(1);expect((await request('/api/bb/agents','POST',JSON.stringify({id:'helper',description:'x'.repeat(9000)}))).status).toBe(400);expect((await request('/api/bb/chat','POST',' '.repeat(12*1024*1024+1))).status).toBe(400);});

});
