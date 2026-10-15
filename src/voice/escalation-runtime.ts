import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {UrgentSourceStore,type AdmittedSourceFeed} from './urgent-sources.js';
import type {PiBot} from '../core/bot.js';
import path from 'node:path';
import { decryptJsonWithSops } from '../core/secrets.js';
import type { CoordinatorConfig } from '../coordinator/runtime.js';
import type { VoiceHost } from './runtime.js';
import { VoiceCoordinatorRuntime, type CoordinatorVoiceSnapshot, type VoiceCoordinatorOptions } from './coordinator-runtime.js';
import type { CallPolicy, EscalationDependencies } from './escalation.js';

export interface EscalationAgentBinding {agentId:string;canonicalChatId:string;botId:string;chatId:string;userId:string}
export interface EscalationConfig {
  agentBindings?:EscalationAgentBinding[];
  ownerId:string; coordinatorId:string; mandateId?:string; mandateIdFile?:string;
  agentId:string; canonicalChatId:string; recipientRef:string;
  botId:string; chatId:string; userId:string;
  socketPath:string; tokenFile?:string; authoritySecretsFile?:string; secretsFile:string; databasePath:string; sourceDatabasePath?:string;urgencyLeadMs?:number;
  policy:Required<Pick<CallPolicy,'currency'|'maxExposureMinor'|'maxSpendMinor'|'maxCallsPerDay'|'cooldownMs'|'messageGraceMs'|'maxDurationSeconds'|'quietHours'>>;
}
export interface MessageCoordinator {
  config:Pick<CoordinatorConfig,'ownerId'|'coordinatorId'|'botId'|'chatId'|'userId'>;
  inspect():CoordinatorVoiceSnapshot;
}
function privateFile(file:string,max:number):string {
  if(!path.isAbsolute(file))throw new Error('Absolute private configuration path required');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>max)throw new Error('Private owner configuration required');return fs.readFileSync(fd,'utf8');}
  finally{fs.closeSync(fd);}
}
export function loadEscalationConfig(file:string):EscalationConfig {
  const c=JSON.parse(privateFile(file,16384)) as EscalationConfig;
  const fields=['ownerId','coordinatorId','mandateId','agentId','canonicalChatId','recipientRef','botId','chatId','userId','socketPath','tokenFile','secretsFile','databasePath','policy','mandateIdFile','authoritySecretsFile','sourceDatabasePath','urgencyLeadMs','agentBindings'];
  if(!c||Object.keys(c).some(k=>!fields.includes(k))||fields.filter(k=>!['mandateId','mandateIdFile','tokenFile','authoritySecretsFile','sourceDatabasePath','urgencyLeadMs','agentBindings'].includes(k)).some(k=>!(k in c)))throw new Error('Complete voice escalation configuration required');
  for(const k of fields.filter(k=>k!=='policy'&&k!=='urgencyLeadMs'&&k!=='agentBindings'&&(c as any)[k]!==undefined))if(typeof (c as any)[k]!=='string'||!(c as any)[k]||(c as any)[k].length>1000)throw new Error('Invalid voice identity or path');
  if(Boolean(c.tokenFile)===Boolean(c.authoritySecretsFile)||Boolean(c.mandateId)===Boolean(c.mandateIdFile)||c.sourceDatabasePath!==undefined&&(!c.authoritySecretsFile||!path.isAbsolute(c.sourceDatabasePath)||c.urgencyLeadMs!==3600000)||!c.sourceDatabasePath&&c.urgencyLeadMs!==undefined)throw new Error('Explicit source mode and exclusive authority configuration required');
  if(![c.socketPath,c.tokenFile,c.authoritySecretsFile,c.mandateIdFile,c.secretsFile,c.databasePath].filter((x):x is string=>x!==undefined).every(path.isAbsolute)||![c.botId,c.chatId,c.userId].every(v=>/^[1-9]\d{0,19}$/.test(v))||c.chatId!==c.userId||!/^telegram(?::[A-Za-z0-9_-]+)?:[1-9]\d{0,19}$/.test(c.canonicalChatId)||c.canonicalChatId.split(':').at(-1)!==c.chatId)throw new Error('Exact private recipient and absolute paths required');
  if(c.agentBindings!==undefined){
    if(!c.sourceDatabasePath||!Array.isArray(c.agentBindings)||c.agentBindings.length<1||c.agentBindings.length>30)throw new Error('Explicit agent bindings required');
    const keys=new Set<string>();
    for(const b of c.agentBindings){if(!b||Object.keys(b).sort().join(',')!=='agentId,botId,canonicalChatId,chatId,userId'||typeof b.agentId!=='string'||! /^[a-zA-Z0-9_-]{1,160}$/.test(b.agentId)||![b.botId,b.chatId,b.userId].every(v=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v))||b.userId!==c.userId||b.chatId!==c.chatId||!/^telegram(?::[A-Za-z0-9_-]+)?:[1-9]\d{0,19}$/.test(b.canonicalChatId)||b.canonicalChatId.split(':').at(-1)!==b.chatId||keys.has(b.canonicalChatId))throw new Error('Invalid distinct private agent binding');keys.add(b.canonicalChatId);}
    if(!c.agentBindings.some(b=>b.agentId===c.agentId&&b.canonicalChatId===c.canonicalChatId&&b.botId===c.botId))throw new Error('Primary binding must be reviewed');
  }
  const p=c.policy;
  const policyFields=['currency','maxExposureMinor','maxSpendMinor','maxCallsPerDay','cooldownMs','messageGraceMs','maxDurationSeconds','quietHours'];
  if(!p||Object.keys(p).some(k=>!policyFields.includes(k))||policyFields.some(k=>!(k in p)))throw new Error('Explicit bounded call policy required');
  if(!/^[A-Z]{3}$/.test(p.currency)||![p.maxExposureMinor,p.maxSpendMinor,p.maxCallsPerDay,p.cooldownMs,p.messageGraceMs,p.maxDurationSeconds].every(n=>Number.isSafeInteger(n)&&n>0)||p.maxExposureMinor>p.maxSpendMinor||p.maxCallsPerDay>3||p.cooldownMs<1_800_000||p.messageGraceMs<120_000||p.maxDurationSeconds>180||p.quietHours?.startMinute!==1320||p.quietHours?.endMinute!==480||p.quietHours?.timeZone!=='Europe/Berlin')throw new Error('Call policy exceeds owner interruption limits');
  return c;
}
export interface EscalationBootDependencies {
  decrypt?:(file:string)=>Promise<Record<string,string>>;
  authorityFactory?:(config:EscalationConfig)=>{authority:EscalationDependencies['authority'];sourceAuthority:EscalationDependencies['sourceAuthority'];sources?:()=>Promise<AdmittedSourceFeed>};
  runtimeFactory?:(options:VoiceCoordinatorOptions)=>Pick<VoiceCoordinatorRuntime,'start'|'stop'|'close'|'inspect'>;
}
/** Optional adapter wiring, never consent issuance, source classification or price verification. */
type BootOptions={host:Pick<VoiceHost,'voiceBindings'>&Partial<Pick<PiBot,'urgentQuestionSnapshot'|'attachUrgentSources'|'sendUrgentSourceMessage'>>;coordinator:MessageCoordinator|undefined;configFile?:string;dependencies?:EscalationBootDependencies};
export async function createVoiceEscalationRuntime(options:BootOptions) {
  const file=options.configFile??process.env.PIBOT_VOICE_ESCALATION_CONFIG;
  if(!file)return undefined;
  const c=loadEscalationConfig(file);
  if(!c.agentBindings)return createBoundRuntime(c,options);
  const children:Array<Awaited<ReturnType<typeof createBoundRuntime>>>=[];
  try{for(const b of c.agentBindings){const suffix=createHash('sha256').update(`${b.agentId}:${b.canonicalChatId}`).digest('hex').slice(0,16);children.push(await createBoundRuntime({...c,...b,agentBindings:undefined,sourceDatabasePath:c.sourceDatabasePath+'.'+suffix},options));}}
  catch(error){await Promise.all(children.map(c=>c.close()));throw error;}
  return {async start(){try{await Promise.all(children.map(c=>c.start()));}catch(error){await Promise.all(children.map(c=>c.close()));throw error;}},inspect:()=>{const states=children.map(c=>c.inspect());return {...states[0],running:states.every(s=>s.running),workerHealthy:states.every(s=>s.workerHealthy)};},async close(){await Promise.all(children.map(c=>c.close()));}};
}
async function createBoundRuntime(c:EscalationConfig,options:BootOptions) {
  const coordinator=options.coordinator;
  if(!coordinator&&!c.sourceDatabasePath)throw new Error('Message coordinator is required before voice escalation');
  const matches=()=>Boolean(c.sourceDatabasePath||coordinator&&['ownerId','coordinatorId','botId','chatId','userId'].every(k=>(coordinator.config as any)[k]===(c as any)[k]))&&options.host.voiceBindings().some(b=>b.agentId===c.agentId&&b.chatKey===c.canonicalChatId);
  if(!matches())throw new Error('Voice escalation must match the canonical owner agent and message coordinator');
  // Encrypted payload stays in memory; the runtime retains only its dedicated control token.
  privateFile(c.secretsFile,65536);
  const secrets=await (options.dependencies?.decrypt??decryptJsonWithSops<Record<string,string>>)(c.secretsFile);
  if(!/^[a-f0-9]{64}$/.test(secrets.PHONE_CONTROL_TOKEN??''))throw new Error('Dedicated phone control credential required');
  const adapters=options.dependencies?.authorityFactory?.(c)??await defaultAuthority(c,options.dependencies?.decrypt);
  let store:UrgentSourceStore|undefined,detach:(()=>void)|undefined;
  if(c.sourceDatabasePath){
    if(!options.host.urgentQuestionSnapshot||!options.host.attachUrgentSources||!options.host.sendUrgentSourceMessage||!adapters.sources)throw new Error('Observed source host and authority required');
    store=new UrgentSourceStore({...c,databasePath:c.sourceDatabasePath,urgencyLeadMs:c.urgencyLeadMs!,recipient:{botId:c.botId,chatId:c.chatId,userId:c.userId},liveQuestion:qid=>options.host.urgentQuestionSnapshot!(qid),bindingAllowed:matches});
    try{detach=options.host.attachUrgentSources(store);}catch(error){store.close();throw error;}
  }
  let runtime:Pick<VoiceCoordinatorRuntime,'start'|'stop'|'close'|'inspect'>;
  try{runtime=(options.dependencies?.runtimeFactory??(o=>new VoiceCoordinatorRuntime(o)))({
    coordinator:{inspect(){const snapshot=store?store.inspect():coordinator!.inspect();return {...snapshot,paused:snapshot.paused||!matches()};}},
    databasePath:c.databasePath,policy:{...c.policy,enabled:true,ownerId:c.ownerId,agentId:c.agentId,canonicalChatId:c.canonicalChatId,recipientRef:c.recipientRef},
    authority:adapters.authority,sourceAuthority:adapters.sourceAuthority,phoneURL:'http://127.0.0.1:8793',phoneToken:secrets.PHONE_CONTROL_TOKEN,reconcileUsage:true,
  });}catch(error){detach?.();store?.close();throw error;}
  let timer:NodeJS.Timeout|undefined,pending:Promise<void>|undefined,closed=false,started=false;
  const poll=()=>{if(closed||pending||!store)return;pending=(async()=>{let feed:AdmittedSourceFeed;try{feed=await adapters.sources!();}catch{feed={schemaVersion:1,checkedAt:Date.now(),expiresAt:Date.now(),available:false,sources:[],blockers:['unavailable']};}if(closed)return;await store!.syncContracts(feed,source=>options.host.sendUrgentSourceMessage!({agentId:c.agentId,canonicalChatId:c.canonicalChatId,text:source.title,decisionId:source.decisionId,questionVersion:source.questionVersion,revision:source.revision,deadline:source.deadline}));})().catch(()=>{}).finally(()=>{pending=undefined;});};
  return {async start(){if(closed||started)return;started=true;poll();if(store){timer=setInterval(poll,5000);timer.unref();}await runtime.start();},inspect:()=>runtime.inspect(),async close(){if(closed)return;closed=true;if(timer)clearInterval(timer);await runtime.stop();await pending;detach?.();store?.close();runtime.close();}};
}
async function defaultAuthority(config:EscalationConfig,decrypt:EscalationBootDependencies['decrypt']) {
  const {ContractsVoiceAuthority}=await import('./contracts-authority.js');
  let cachedToken:Promise<string>|undefined;
  const token=config.authoritySecretsFile?async()=>{privateFile(config.authoritySecretsFile!,65536);cachedToken??=(async()=>{const secrets=await (decrypt??decryptJsonWithSops<Record<string,string>>)(config.authoritySecretsFile!);const value=secrets.CONTACT_BRIDGE_TOKEN;if(!/^[a-f0-9]{64}$/.test(value??''))throw new Error('Authority credential unavailable');return value;})().catch(error=>{cachedToken=undefined;throw error;});return cachedToken;}:undefined;
  const adapter=new ContractsVoiceAuthority({...config,token});
  return {authority:adapter.authority,sourceAuthority:adapter.sourceAuthority,sources:()=>adapter.sources()};
}
