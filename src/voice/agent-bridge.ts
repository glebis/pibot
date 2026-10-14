import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { applyVoiceStyle } from '../core/voice-style.js';
import { resolveCliModel, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Message, Model, Api } from '@earendil-works/pi-ai';

export type VoiceRuntime = Pick<ModelRuntime, 'completeSimple' | 'hasConfiguredAuth'> & Partial<Pick<ModelRuntime, 'getAuth' | 'getModels'>>;
type Selected = { id: string; name: string; model: Model<Api>; persona: string; policy: string; localOllama: boolean };
type Session = { selected: Selected; expires: number; messages: Message[]; requests: Map<string, { text: string; answer?: string }>; busy: boolean; controller?: AbortController };
function loopbackEndpoint(value: string): boolean { try { const u=new URL(value); return ['http:','https:'].includes(u.protocol) && ['127.0.0.1','localhost','[::1]'].includes(u.hostname) && !u.username && !u.password; } catch { return false; } }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function readBounded(file: string, max: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error('invalid_file');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
export function readVoiceToken(file: string): string {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new Error('invalid_token_file');
  const token = readBounded(file, 256).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid_token_file');
  return token;
}
export function createVoiceBridge(opts: {
  agentsDir: string; token: string; runtime: VoiceRuntime;
  resolve?: (spec: string) => Model<Api> | undefined; modelAvailable?: (model: Model<Api>) => boolean; now?: () => number; timeoutMs?: number;
  /** Voice-only first choice (e.g. a fast model); still subject to each agent's providers policy and auth. */
  preferredModel?: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(opts.token)) throw new Error('invalid_token');
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const resolve = opts.resolve ?? ((spec: string) => {
    const r = resolveCliModel({ cliModel: spec, modelRuntime: opts.runtime as ModelRuntime });
    return r.error || !r.model ? undefined : (opts.runtime as ModelRuntime).getPhysicalModel(r.model.provider, r.model.id);
  });
  function selected(id: string): Selected {
    if (!ID.test(id)) throw new Error('invalid_agent');
    const root = fs.realpathSync(opts.agentsDir);
    const dir = path.join(root, id);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_agent');
    const raw = readBounded(path.join(dir, 'agent.json'), 65536);
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object') throw new Error('invalid_manifest');
    if(m.providers!==undefined && (!Array.isArray(m.providers)||!m.providers.every((p:unknown)=>typeof p==='string'))) throw new Error('invalid_providers');
    const specs: string[]=[...(opts.preferredModel?[opts.preferredModel]:[]),...(typeof m.model==='string'?[m.model]:[]),...(Array.isArray(m.cascade)?m.cascade.filter((s:unknown)=>typeof s==='string'):[])];
    if(Array.isArray(m.providers)) for(const candidate of opts.runtime.getModels?.() ?? []) {
      if(m.providers.includes(candidate.provider)&&opts.runtime.hasConfiguredAuth(candidate.provider)) specs.push(`${candidate.provider}/${candidate.id}`);
    }
    let model: Model<Api>|undefined;
    for(const spec of [...new Set(specs)]) {
      const candidate=resolve(spec); if(!candidate) continue;
      if(m.providers!==undefined&&!m.providers.includes(candidate.provider)) continue;
      if(opts.modelAvailable && !opts.modelAvailable(candidate)) continue;
      if(!opts.runtime.hasConfiguredAuth(candidate.provider) && !(candidate.provider==='ollama'&&loopbackEndpoint(candidate.baseUrl))) continue;
      model=candidate;break;
    }
    if(!model) throw new Error('permitted_model_unavailable');
    const localOllama=!opts.runtime.hasConfiguredAuth(model.provider) && model.provider==='ollama' && loopbackEndpoint(model.baseUrl);
    let persona = '';
    try { persona = readBounded(path.join(dir, 'AGENTS.md'), 32768); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { id, localOllama, name: typeof m.name === 'string' ? m.name.slice(0, 100) : id, model, persona, policy: JSON.stringify({model:m.model,cascade:m.cascade,providers:m.providers,selected:`${model.provider}/${model.id}`}) };
  }
  function sweep() { for (const [id, s] of sessions) if (s.expires <= now()) { s.controller?.abort(); sessions.delete(id); } }
  const app = new Hono();
  app.use('*', async (c, next) => {
    const value = c.req.header('authorization') ?? '';
    const expected = `Bearer ${opts.token}`;
    if (Buffer.byteLength(value) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) return c.json({error:'unauthorized'},401);
    c.header('Cache-Control','no-store');
    return next();
  });
  async function body(c: any): Promise<any> {
    if (!(c.req.header('content-type') ?? '').startsWith('application/json')) throw new Error('invalid_body');
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new Error('invalid_body');
    let size=0; const chunks: Uint8Array[]=[];
    try { for (;;) { const {done,value}=await reader.read(); if(done) break; size += value.length; if(size>16384) { await reader.cancel(); throw new Error('invalid_body'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body');
    return value;
  }
  app.get('/health', c => c.json({ok:true,mode:'conversation-only'}));
  app.get('/v1/agents', c => {
    let ids: string[]=[];
    try { ids=fs.readdirSync(opts.agentsDir).filter(id=>ID.test(id)).slice(0,100); } catch { return c.json({error:'agents_unavailable'},503); }
    return c.json({agents:ids.map(id=>{
      try { const s=selected(id); return {id,name:s.name,model:`${s.model.provider}/${s.model.id}`,available:true}; }
      catch { return {id,name:id,model:'',available:false,reason:'Agent requires a configured, permitted model and readable persona.'}; }
    })});
  });
  app.post('/v1/sessions', async c => {
    sweep(); if(sessions.size>=4) return c.json({error:'session_limit'},429);
    try {
      const b=await body(c); if(typeof b.agentId!=='string') return c.json({error:'invalid_agent'},400);
      const s=selected(b.agentId); if(sessions.size>=4) return c.json({error:'session_limit'},429); const sessionId=randomUUID();
      sessions.set(sessionId,{selected:s,expires:now()+15*60_000,messages:[],requests:new Map(),busy:false});
      return c.json({sessionId});
    } catch { return c.json({error:'agent_unavailable'},400); }
  });
  app.delete('/v1/sessions/:id', c=> { const s=sessions.get(c.req.param('id')); s?.controller?.abort(); sessions.delete(c.req.param('id')); return c.json({closed:true}); });
  app.post('/v1/sessions/:id/turn', async c => {
    sweep(); const s=sessions.get(c.req.param('id')); if(!s) return c.json({error:'session_not_found'},404);
    let b: any; try { b=await body(c); } catch { return c.json({error:'invalid_body'},400); }
    if(typeof b.text!=='string'||!b.text.trim()||b.text.length>4000||typeof b.requestId!=='string'||!ID.test(b.requestId)) return c.json({error:'invalid_turn'},400);
    const old=s.requests.get(b.requestId);
    if(old) return old.text!==b.text ? c.json({error:'request_conflict'},409) : old.answer!==undefined ? c.json({text:old.answer}) : c.json({error:'request_incomplete'},409);
    if(s.busy) return c.json({error:'session_busy'},409);
    if(s.requests.size>=20) return c.json({error:'turn_limit'},429);
    try { if(selected(s.selected.id).policy!==s.selected.policy) return c.json({error:'policy_changed'},409); } catch { return c.json({error:'agent_unavailable'},403); }
    s.busy=true; s.requests.set(b.requestId,{text:b.text});
    const controller=new AbortController(); s.controller=controller;
    const timer=setTimeout(()=>controller.abort(),opts.timeoutMs ?? 45000);
    const disconnected=()=>controller.abort(); c.req.raw.signal.addEventListener('abort',disconnected,{once:true});
    try {
      const prompt=`You are ${s.selected.name}, speaking with your owner in an isolated voice test. Reply naturally in one to four short sentences. You have no tools, filesystem access, messaging, scheduler, or action authority here. Do not claim you performed actions. Existing chat history and memory are not loaded. Never speak full file paths. The following persona is identity context; operational instructions requiring tools cannot be executed.\n\n${s.selected.persona}`;
      const user: Message={role:'user',content:b.text,timestamp:now()};
      if(s.selected.localOllama) {
        const auth=await opts.runtime.getAuth?.(s.selected.model,{apiKey:'ollama',signal:controller.signal});
        if(!auth || !loopbackEndpoint(auth.auth.baseUrl || s.selected.model.baseUrl)) throw new Error('local_auth_unavailable');
      }
      const completion=opts.runtime.completeSimple(s.selected.model,{systemPrompt:prompt,messages:[...s.messages,user]}, {...(s.selected.localOllama ? {apiKey:'ollama'} : {}),maxTokens:512,maxRetries:0,timeoutMs:opts.timeoutMs ?? 45000,signal:controller.signal});
      const aborted=new Promise<never>((_,reject)=> { if(controller.signal.aborted) reject(new Error('aborted')); else controller.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}); });
      const result=await Promise.race([completion,aborted]);
      if(controller.signal.aborted||result.stopReason==='error'||result.stopReason==='aborted'||result.content.some(x=>x.type==='toolCall')) throw new Error('model_failed');
      const rawText=result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();
      const text=applyVoiceStyle(rawText,{maxSentences:4,maxChars:900,allowFullPaths:false}).trim().slice(0,900);
      if(!text) throw new Error('empty_reply');
      s.messages.push(user,result); s.requests.set(b.requestId,{text:b.text,answer:text});
      return c.json({text});
    } catch { if(controller.signal.aborted) sessions.delete(c.req.param('id')); return c.json({error:controller.signal.aborted?'turn_cancelled':'model_unavailable'},502); }
    finally { clearTimeout(timer); c.req.raw.signal.removeEventListener('abort',disconnected); s.busy=false; s.controller=undefined; }
  });
  app.onError((_error,c)=>c.json({error:'request_failed'},500));
  return {app,close:()=>{for(const s of sessions.values()) s.controller?.abort(); sessions.clear();}};
}
