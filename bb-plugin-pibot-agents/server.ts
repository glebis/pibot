import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { rpcContract, agentSchema, processesSchema, bindingsSchema } from './contract';
import { endpoint, request, type Endpoint } from './client';
import { readLocalConfig, readLocalDashboardConfig } from './local-config';
import { agentsRoot, loadHistory } from './history';
import {createHistoryWatch} from './history-watch';
import { createMacSpeech } from './speech';
import {createLocalAudioRuntime,localAudioStartable} from './audio-runtime';
export { rpcContract } from './contract';
export type { Overview } from './contract';

function inferredPibotRoot(){
  const here=dirname(fileURLToPath(import.meta.url));
  for(const root of [resolve(here,'..'),resolve(here,'../..')]){
    try{if(JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).name==='pibot')return root;}catch{}
  }
  return '';
}

export default function plugin(bb:BbPluginApi) {
  const settings=bb.settings.define({
    autoDiscoverDashboard:{type:'boolean',label:'Discover local dashboard token automatically',default:true},
    localAgentsDir:{type:'string',label:'Local agent storage override (empty discovers default)',default:''},
    localPibotRoot:{type:'string',label:'Local PiBot checkout (empty uses plugin location)',default:''},
    dashboardUrl:{type:'string',label:'PiBot dashboard origin',default:'http://127.0.0.1:7860'},
    dashboardToken:{type:'string',label:'PiBot dashboard bearer token',secret:true},
    bridgeUrl:{type:'string',label:'Canonical voice bridge origin',default:'http://127.0.0.1:8789'},
    bridgeToken:{type:'string',label:'Canonical voice bridge bearer token',secret:true},
    audioUrl:{type:'string',label:'PiBot voice audio origin',default:'http://127.0.0.1:8788'},
    audioToken:{type:'string',label:'PiBot voice audio bearer token',secret:true},
  });
  let discoveryAttempt='',discoveryError='';
  let discoveryPending:Promise<void>|undefined;
  async function discoverDashboard(){
    const s=await settings.get();
    if(s.dashboardToken||!s.autoDiscoverDashboard)return;
    const root=s.localPibotRoot.trim()||inferredPibotRoot();
    const fingerprint=JSON.stringify([root,s.dashboardUrl]);
    if(discoveryPending)return discoveryPending;
    if(discoveryAttempt===fingerprint)return;
    discoveryAttempt=fingerprint;discoveryError='';
    discoveryPending=(async()=>{
      try{
        const url=new URL(s.dashboardUrl);
        if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!root)throw new Error();
        const found=await readLocalDashboardConfig(root);
        const latest=await settings.get();
        if(!latest.dashboardToken&&latest.autoDiscoverDashboard&&latest.dashboardUrl===s.dashboardUrl&&latest.localPibotRoot===s.localPibotRoot)await settings.experimental_set({dashboardToken:found.dashboardToken});
      }catch{discoveryError='Could not discover the local dashboard token. Set the PiBot checkout path and check SOPS access, or enter a token manually.';}
      finally{discoveryPending=undefined;}
    })();
    return discoveryPending;
  }
  const historyWatch=createHistoryWatch(key=>bb.realtime.publish('history-changed',{key}));
  const speech=createMacSpeech();
  const audioRuntime=createLocalAudioRuntime();
  const lifecycle=new AbortController();
  const call=(target:Endpoint,path:string,method?:string,body?:unknown)=>request(target,path,method,body,lifecycle.signal);
  async function service(which:'dashboard'|'bridge'|'audio'){
    if(which==='dashboard')await discoverDashboard();
    const s=await settings.get();
    if(which==='audio'){const target=await audioRuntime.ensure(s.audioUrl,s.audioToken,s.localPibotRoot.trim()||inferredPibotRoot());if(target.token!==s.audioToken)await settings.experimental_set({audioToken:target.token});return target;}
    return endpoint(s[`${which}Url`],s[`${which}Token`]);
  }
  type Lease={kind:'chat'|'audio';id:string;target:Endpoint;remoteId?:string;expires:number};
  let lease:Lease|undefined;let opening=false;let stopping=false;let disposed=false;
  async function release(current:Lease){
    // An uncertain outcome keeps ownership locked for explicit review/retry.
    if(stopping)throw new Error('Session close is already in progress.');
    stopping=true;
    try{
      if(current.kind==='chat')await request(current.target,`/voice/sessions/${encodeURIComponent(current.remoteId!)}`,'DELETE',undefined,undefined,4000);
      else await request(current.target,`/api/session?sessionId=${encodeURIComponent(current.remoteId!)}`,'DELETE',undefined,undefined,4000);
      if(lease===current)lease=undefined;
    }finally{stopping=false;}
  }
  function own(id:string,kind:Lease['kind']){
    if(!lease||lease.id!==id||lease.kind!==kind)throw new Error('This window does not own an active session. Reconnect explicitly.');
    return lease;
  }
  function reserve(){if(disposed||opening||lease)throw new Error('A PiBot chat or voice call is already open. Close it before starting another.');opening=true;}
  async function prepareAudio(){
    reserve();
    try{const info=z.object({mode:z.literal('shared'),audioReady:z.literal(true)}).safeParse(await call(await service('audio'),'/api/agents'));if(!info.success)throw new Error('Canonical audio is unavailable. Check the voice service and speech provider.');return {ready:true};}
    finally{opening=false;}
  }
  bb.rpc.register(rpcContract,{
    config:async()=>{await discoverDashboard();const s=await settings.get();const ready=(url:string,token?:string)=>{try{endpoint(url,token);return true;}catch{return false;}};
      return {dashboardConfigured:ready(s.dashboardUrl,s.dashboardToken),bridgeConfigured:ready(s.bridgeUrl,s.bridgeToken),audioConfigured:ready(s.audioUrl,s.audioToken),audioStartable:localAudioStartable(s.audioUrl,s.localPibotRoot.trim()||inferredPibotRoot()),dashboardUrl:s.dashboardUrl,bridgeUrl:s.bridgeUrl,audioUrl:s.audioUrl,autoDiscoverDashboard:s.autoDiscoverDashboard,localPibotRoot:s.localPibotRoot,detectedPibotRoot:inferredPibotRoot(),localAgentsDir:s.localAgentsDir,detectedAgentsDir:agentsRoot(s.localAgentsDir),...(discoveryError&&!s.dashboardToken?{dashboardDiscoveryError:discoveryError}:{})};},
    discoverLocal:async()=>{
      if(lease||opening)throw new Error('Close the active chat or call before changing connections.');
      const s=await settings.get();const root=s.localPibotRoot.trim()||inferredPibotRoot();
      const values=await readLocalConfig(root);await settings.experimental_set(values);discoveryAttempt='';discoveryError='';return {connected:true};
    },
    configure:async(input)=>{
      if(lease||opening)throw new Error('Close the active chat or call before changing connections.');
      for(const value of [input.dashboardUrl,input.bridgeUrl,input.audioUrl])endpoint(value,'validation-only');
      if(input.localAgentsDir&&!input.localAgentsDir.startsWith('/'))throw new Error('The agent storage override must be an absolute path. Leave it empty to discover automatically.');
      if(input.localPibotRoot&&!input.localPibotRoot.startsWith('/'))throw new Error('The checkout override must be an absolute path. Leave it empty to discover automatically.');
      const patch:Record<string,string|boolean|null>={dashboardUrl:input.dashboardUrl,bridgeUrl:input.bridgeUrl,audioUrl:input.audioUrl,autoDiscoverDashboard:input.autoDiscoverDashboard,localPibotRoot:input.localPibotRoot.trim(),...(input.localAgentsDir===undefined?{}:{localAgentsDir:input.localAgentsDir.trim()})};
      for(const prefix of ['dashboard','bridge','audio'] as const){
        const key=`${prefix}Token` as const; const clear=input[`clear${prefix[0].toUpperCase()+prefix.slice(1)}Token` as 'clearDashboardToken'|'clearBridgeToken'|'clearAudioToken'];
        if(clear)patch[key]=null;else if(input[key]?.trim()){if(/[\r\n]/.test(input[key]!))throw new Error('Tokens must not contain newlines.');patch[key]=input[key]!.trim();}
      }
      await settings.experimental_set(patch);discoveryAttempt='';discoveryError='';return {saved:true};
    },
    overview:async()=>{
      const target=await service('dashboard');
      const [agents,processes]=await Promise.all([call(target,'/api/bb/agents'),call(target,'/api/bb/processes')]);
      return {agents:z.object({agents:z.array(agentSchema).max(200)}).parse(agents).agents,processes:processesSchema.parse(processes)};
    },
    bindings:async()=>bindingsSchema.parse(await call(await service('bridge'),'/voice/bindings')),
    createAgent:async(input)=>z.object({id:z.string()}).parse(await call(await service('dashboard'),'/api/bb/agents','POST',input)),
    cancelTask:async({id})=>z.object({cancelled:z.boolean()}).parse(await call(await service('dashboard'),`/api/bb/tasks/${encodeURIComponent(id)}/cancel`,'POST',{})),
    speak:({text})=>speech.speak(text),
    speechStatus:({playbackId})=>speech.status(playbackId),
    stopSpeech:({playbackId})=>speech.stop(playbackId),
    history:async({agentId,chatKey,before})=>{
      const target=await service('bridge');const dashboard=await service('dashboard');
      if(![target,dashboard].every(t=>['localhost','127.0.0.1','[::1]'].includes(new URL(t.url).hostname)))throw new Error('Local session history requires PiBot services on the bb server machine.');
      const bindings=bindingsSchema.parse(await call(target,'/voice/bindings'));
      if(!bindings.bindings.some(b=>b.agentId===agentId&&b.chatKey===chatKey))throw new Error('This agent/chat binding is unavailable.');
      const s=await settings.get(),root=agentsRoot(s.localAgentsDir),checkout=s.localPibotRoot.trim()||inferredPibotRoot();
      const watchKey=await historyWatch.track(root,agentId,chatKey,checkout);
      return {...await loadHistory(root,agentId,chatKey,before,checkout),watchKey};
    },
    openChat:async({agentId,chatKey,allowTools})=>{
      reserve();const target=await service('bridge').catch(e=>{opening=false;throw e;});
      try{
        const bindings=bindingsSchema.parse(await call(target,'/voice/bindings'));
        if(!bindings.bindings.some(b=>b.agentId===agentId&&b.chatKey===chatKey))throw new Error('The selected agent/chat binding is no longer available.');
        const result=z.object({sessionId:z.string().uuid(),greeting:z.string().optional()}).parse(await call(target,'/voice/browser-sessions','POST',{agentId,chatKey,mode:'agent',...(allowTools?{}:{tools:[]})}));
        const current:Lease={kind:'chat',id:randomUUID(),remoteId:result.sessionId,target,expires:Date.now()+15*60_000};lease=current;
        if(disposed){await release(current);throw new Error('Plugin stopped while opening the session.');}
        return {sessionId:current.id,...(result.greeting?{greeting:result.greeting}:{})};
      }finally{opening=false;}
    },
    send:async({sessionId,text,requestId})=>{
      const current=own(sessionId,'chat');
      if(stopping||Date.now()>=current.expires)throw new Error('This chat is closing or expired. Close it and reconnect.');
      return z.object({text:z.string().max(2000),pendingApproval:z.boolean().optional()}).parse(await call(current.target,`/voice/sessions/${current.remoteId}/turn`,'POST',{text,requestId}));
    },
    closeChat:async({sessionId})=>{await release(own(sessionId,'chat'));return {closed:true};},
    prepareAudio,
    audioOffer:async({agentId,sdp,type,allowTools})=>{
      reserve();const target=await service('audio').catch(e=>{opening=false;throw e;});
      try{
        // Canonical mode is required: never silently use an isolated identity copy.
        const info=z.object({mode:z.literal('shared'),audioReady:z.literal(true),agents:z.array(z.object({id:z.string(),available:z.boolean()}))}).safeParse(await call(target,'/api/agents'));
        if(!info.success||!(info.data.agents.filter(a=>a.id===agentId&&a.available).length===1))throw new Error('Canonical audio is unavailable for this agent. Configure the voice service and its speech provider.');
        const answer=z.object({sdp:z.string(),type:z.literal('answer'),pc_id:z.string().optional(),sessionId:z.string().uuid()}).parse(await call(target,'/api/offer','POST',{agentId,sdp,type,mode:'agent',...(allowTools?{}:{tools:[]})}));
        const current:Lease={kind:'audio',id:randomUUID(),remoteId:answer.sessionId,target,expires:Date.now()+15*60_000};lease=current;
        if(disposed){await release(current);throw new Error('Plugin stopped while starting the call.');}
        return {sdp:answer.sdp,type:answer.type,...(answer.pc_id?{pc_id:answer.pc_id}:{}),callId:current.id};
      }finally{opening=false;}
    },
    audioEnd:async({callId})=>{await release(own(callId,'audio'));return {closed:true};},
  });
  // No private transcript persistence, autonomous probes, or mutation retries.
  bb.cli.register({name:'pibot-agents',summary:'Connect to local PiBot and inspect agents',commands:[{name:'prepare-audio',summary:'Start or check canonical audio without opening a call',usage:'bb pibot-agents prepare-audio'},{name:'connect-local',summary:'Import existing local credentials into secret plugin settings',usage:'bb pibot-agents connect-local <absolute-pibot-root>'},{name:'list',summary:'List PiBot agents',usage:'bb pibot-agents list'},{name:'processes',summary:'Show bounded process metadata',usage:'bb pibot-agents processes'}],
    async run(argv){
      if(argv.length===1&&argv[0]==='prepare-audio'){try{return {exitCode:0,stdout:JSON.stringify(await prepareAudio())};}catch(e){return {exitCode:1,stderr:e instanceof Error?e.message:'Local voice unavailable'};}}
      if(argv[0]==='connect-local'&&argv.length===2){
        if(lease||opening) return {exitCode:1,stderr:'Close the active chat or call before changing credentials.'};
        try{const values=await readLocalConfig(argv[1]);await settings.experimental_set(values);return {exitCode:0,stdout:'Imported dashboard and canonical bridge settings securely. Audio requires its confirmed service URL and credential. No services were restarted.'};}
        catch {return {exitCode:1,stderr:'Could not import private local PiBot configuration. Check source permissions and SOPS access. No credential values were printed.'};}
      }
      if(argv.length!==1||!['list','processes'].includes(argv[0]))return {exitCode:1,stderr:'Usage: bb pibot-agents list | processes'};
      try{const result=await call(await service('dashboard'),argv[0]==='list'?'/api/bb/agents':'/api/bb/processes');return {exitCode:0,stdout:JSON.stringify(result).slice(0,60000)};}
      catch(e){return {exitCode:1,stderr:e instanceof Error?e.message:'PiBot unavailable'};}
    }});
  // Expired canonical sessions sweep themselves; retain uncertain audio ownership until explicit close.
  const timer=setInterval(()=>{if(lease?.kind==='chat'&&Date.now()>lease.expires&&!stopping)lease=undefined;},10_000);timer.unref();
  bb.onDispose(async()=>{disposed=true;historyWatch.dispose();speech.dispose();clearInterval(timer);lifecycle.abort();if(lease)await release(lease).catch(()=>bb.log.warn('Session close could not be confirmed. Check PiBot before reconnecting.'));await audioRuntime.dispose();});
}
