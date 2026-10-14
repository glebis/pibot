import path from 'node:path';
import os from 'node:os';
import { serve } from '@hono/node-server';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createVoiceBridge, readVoiceToken } from '../src/voice/agent-bridge.js';

async function main() {
  const tokenFile=process.env.PIBOT_VOICE_BRIDGE_TOKEN_FILE;
  if(!tokenFile) throw new Error('token_required');
  const token=readVoiceToken(tokenFile);
  const port=Number(process.env.PIBOT_VOICE_BRIDGE_PORT ?? 8789);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('invalid_port');
  const runtime=await ModelRuntime.create({allowModelNetwork:false});
  // Local model discovery is metadata-only. Never start a generation or pull a model.
  // Owner-supplied exclusions can only narrow the existing agent policy.
  const unavailableLocalModels=new Set((process.env.PIBOT_VOICE_EXCLUDED_MODELS ?? '').split(',').map(s=>s.trim()).filter(Boolean));
  if(unavailableLocalModels.size>128 || [...unavailableLocalModels].some(s=>!/^[-a-zA-Z0-9_]+\/[^\s]{1,200}$/.test(s))) throw new Error('invalid_model_exclusions');
  const localTags=new Map<string,Set<string>|null>();
  for(const model of runtime.getModels('ollama')) {
    const auth=await runtime.getAuth(model).catch(()=>undefined);
    const endpoint=auth?.auth.baseUrl||model.baseUrl;
    let url: URL; try {url=new URL(endpoint);} catch {continue;}
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) continue;
    const origin=url.origin;
    if(!localTags.has(origin)) {
      try {
        const response=await fetch(new URL('/api/tags',origin),{signal:AbortSignal.timeout(2000),redirect:'error'});
        if(!response.ok) throw new Error('local_models_unavailable');
        const data=await response.json() as {models?:Array<{name?:string}>};
        localTags.set(origin,new Set((data.models??[]).flatMap(m=>typeof m.name==='string'?[m.name]:[])));
      } catch {localTags.set(origin,null);}
    }
    if(!localTags.get(origin)?.has(model.id)) unavailableLocalModels.add(`${model.provider}/${model.id}`);
  }
  // Voice wants a fast replier; agents whose providers policy forbids it fall back to their own model.
  const preferredModel=(process.env.PIBOT_VOICE_MODEL ?? 'openrouter/deepseek/deepseek-v4.1-flash').trim()||undefined;
  if(preferredModel && !/^[-a-zA-Z0-9_]+\/[^\s]{1,200}$/.test(preferredModel)) throw new Error('invalid_voice_model');
  const bridge=createVoiceBridge({token,runtime,preferredModel,modelAvailable:model=>!unavailableLocalModels.has(`${model.provider}/${model.id}`),agentsDir:path.resolve(process.env.PIBOT_AGENTS_DIR || path.join(os.homedir(),'.local/share/pibot/agents'))});
  const server=serve({fetch:bridge.app.fetch,hostname:'127.0.0.1',port});
  server.on('listening',()=>console.log(`Voice agent bridge ready on 127.0.0.1:${port}; isolated conversations, no tools.`));
  server.on('error',()=>{console.error('Voice agent bridge could not bind its local port.');bridge.close();process.exitCode=1;});
  const stop=()=>{bridge.close();server.close();}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
main().catch(()=>{console.error('Voice bridge startup failed. Check its owner-only token file, port, and local model configuration.');process.exitCode=1;});
