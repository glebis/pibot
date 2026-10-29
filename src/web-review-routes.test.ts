import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AgentManager } from './core/agent-manager.js';
import { EvolutionEngine } from './core/evolution.js';
import { EventLog } from './core/events.js';
import { Scheduler } from './core/scheduler.js';
import { createWebApp } from './web.js';
import { reviewContentHash } from './web-review-routes.js';

describe('authenticated evolution review',()=>{
 let dir:string, app:ReturnType<typeof createWebApp>, scheduler:Scheduler;
 let staging:string, current:string;
 beforeEach(()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'pibot-review-'));
 const agents=new AgentManager(dir,{getModels:()=>[]} as unknown as ModelRuntime);
 agents.createAgent('assistant','Test agent');
 const events=new EventLog(dir); scheduler=new Scheduler(path.join(dir,'data'),()=>{});
 const evolution=new EvolutionEngine({agents,events,modelRuntime:{} as ModelRuntime,dataDir:dir,host:{announce:async()=>{}},io:{propose:async()=>{throw new Error('Not used');},runProbe:async()=>'',judge:async()=>1}});
 app=createWebApp({agents,events,evolution,scheduler,dataDir:dir,webToken:'test-review-token',secrets:{get:()=>({}),save:async()=>{}}});
 staging=path.join(dir,'assistant','skills','.staging','safe-skill','SKILL.md');
 current=path.join(dir,'assistant','skills','safe-skill','SKILL.md');
 fs.mkdirSync(path.dirname(staging),{recursive:true});fs.writeFileSync(staging,'# Proposed\nCheck destination first.');
 fs.mkdirSync(path.dirname(current),{recursive:true});fs.writeFileSync(current,'# Installed\nSend immediately.');
 });
 afterEach(()=>{scheduler.stop();(app as any)._authStore.stop();fs.rmSync(dir,{recursive:true,force:true});});
 function request(url:string,init:RequestInit={}){return app.request(url,{...init,headers:{Authorization:'Bearer test-review-token',...init.headers}});}
 function form(fields:Record<string,string>={}){const body=new FormData();body.set('_csrf',(app as any)._csrf);for(const[k,v]of Object.entries(fields))body.set(k,v);return body;}
 it('requires authentication and renders both comparison sources escaped',async()=>{
 expect((await app.request('/review')).status).toBe(302);
 fs.writeFileSync(staging,'# Proposed\n<script>alert(1)</script>');
 const res=await request('/review?id=assistant%2Fsafe-skill');const html=await res.text();
 expect(res.headers.get('cache-control')).toBe('no-store');
 expect(html).toContain('Installed');expect(html).toContain('Proposed');
 expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>alert(1)</script>');
 });
 it('blocks CSRF, foreign origin and stale current/proposed content',async()=>{
 const url='/review/assistant/safe-skill/apply';
 expect((await request(url,{method:'POST',body:new FormData()})).status).toBe(403);
 expect((await request(url,{method:'POST',body:form(),headers:{Origin:'https://foreign.test'}})).status).toBe(403);
 const hash=reviewContentHash(fs.readFileSync(current,'utf8'),fs.readFileSync(staging,'utf8'));
 fs.appendFileSync(current,'\nChanged after review.');
 expect((await request(url,{method:'POST',body:form({contentHash:hash})})).status).toBe(409);
 expect(fs.readFileSync(current,'utf8')).toContain('Changed after review.');
 expect(fs.existsSync(staging)).toBe(true);
 });
 it('archives, lists and restores without overwriting a newer proposal',async()=>{
 const archived=await request('/review/assistant/safe-skill/archive',{method:'POST',body:form()});expect(archived.status).toBe(303);
 expect(fs.existsSync(staging)).toBe(false);
 const html=await(await request(archived.headers.get('location')!)).text();expect(html).toContain('Restore');
 const archiveId=fs.readdirSync(path.join(dir,'assistant','skills','.archive','safe-skill'))[0];
 fs.mkdirSync(path.dirname(staging),{recursive:true});fs.writeFileSync(staging,'newer');
 await request('/review/assistant/safe-skill/restore',{method:'POST',body:form({archiveId})});
 expect(fs.readFileSync(staging,'utf8')).toBe('newer');
 fs.renameSync(path.dirname(staging),path.join(dir,'newer-proposal'));
 await request('/review/assistant/safe-skill/restore',{method:'POST',body:form({archiveId})});
 expect(fs.readFileSync(staging,'utf8')).toContain('Proposed');
 });
 it('applies the exact reviewed content to only the named skill',async()=>{
 const proposed=fs.readFileSync(staging,'utf8');
 const hash=reviewContentHash(fs.readFileSync(current,'utf8'),proposed);
 const res=await request('/review/assistant/safe-skill/apply',{method:'POST',body:form({contentHash:hash})});
 expect(res.status).toBe(303);expect(fs.readFileSync(current,'utf8')).toBe(proposed);
 expect(fs.existsSync(staging)).toBe(false);
 });
 it('legacy bookmark redirects to review and overview removes immediate actions',async()=>{
 const res=await request('/agents/assistant/staged/safe-skill');expect(res.status).toBe(302);expect(res.headers.get('location')).toContain('/review?');
 const html=await(await request('/')).text();expect(html).toContain('Review 1 proposed changes');expect(html).not.toContain('staged/safe-skill/promote');
 });
});
