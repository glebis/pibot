import { UrgentCallEscalation, type CallDecision, type CallDispatchInput, type CallDispatcher, type CallPolicy, type EscalationDependencies } from './escalation.js';

export interface CoordinatorVoiceSnapshot {
  paused: boolean; workerHealthy?: boolean;
  decisions: Array<{id:string;questionVersion:number;sourceContractId:string;ownerId:string;urgent?:boolean;state:string;attention:string;deadline:number;recipient:{botId:string;chatId:string;userId:string}}>;
  attempts: Array<{id?:string;decisionId:string;questionVersion:number;status:string;dispatchedAt?:number;acceptedAt?:number}>;
}
export interface VoiceCoordinatorOptions {
  coordinator:{inspect():CoordinatorVoiceSnapshot}; databasePath:string; policy:CallPolicy;
  authority:EscalationDependencies['authority']; sourceAuthority:EscalationDependencies['sourceAuthority'];
  phoneURL:string; phoneToken:string; fetch?:typeof fetch; clock?:()=>number; timeoutMs?:number;
}

/** One local request; any uncertainty remains charged and cannot initiate a retry. */
export function localPhoneDispatcher(options:Pick<VoiceCoordinatorOptions,'policy'|'phoneURL'|'phoneToken'|'fetch'|'timeoutMs'>):CallDispatcher {
  const url=new URL(options.phoneURL);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.port!=='8793'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('Phone control must use http://127.0.0.1:8793');
  if(!/^[a-f0-9]{64}$/.test(options.phoneToken))throw new Error('Invalid private phone control credential');
  const request=options.fetch??fetch, policy={...options.policy};
  return {async dispatch(input:CallDispatchInput){
    if(input.ownerId!==policy.ownerId||input.recipientRef!==policy.recipientRef||!input.attemptId||!Number.isSafeInteger(input.maxDurationSeconds)||input.maxDurationSeconds<1||input.maxDurationSeconds>180)return {status:'rejected_preflight'};
    try{
      const response=await request(new URL('/control/calls',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??10000),headers:{authorization:`Bearer ${options.phoneToken}`,'content-type':'application/json'},body:JSON.stringify({attemptId:input.attemptId,agentId:policy.agentId,chatKey:policy.canonicalChatId,maxDurationSeconds:input.maxDurationSeconds,reason:'Urgent pending decision'})});
      if(!response.ok)return {status:'unknown'};
      const reader=response.body?.getReader();if(!reader)return {status:'unknown'};
      const chunks:Uint8Array[]=[];let size=0;
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();return {status:'unknown'};}chunks.push(value);}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(result.attemptId===input.attemptId&&['accepted','authenticated','streaming','completed'].includes(result.state)&&typeof result.providerCallId==='string'&&/^CA[a-fA-F0-9]{32}$/.test(result.providerCallId))return {status:'accepted',providerCallId:result.providerCallId};
      return {status:'unknown'};
    }catch{return {status:'unknown'};}
  }};
}

/** Adapter only: consent and source authority are supplied by their trusted owners. */
export class VoiceCoordinatorRuntime {
  private gate:UrgentCallEscalation;
  private timer?:ReturnType<typeof setInterval>;
  private pending?:Promise<void>;
  private stopped=false;
  private healthy=true;
  private policy:CallPolicy;
  constructor(private options:VoiceCoordinatorOptions){
    this.policy={...options.policy};
    if(!/^telegram(?::[a-zA-Z0-9_-]+)?:[1-9]\d{0,19}$/.test(this.policy.canonicalChatId))throw new Error('Voice coordinator requires a canonical private Telegram chat');
    this.gate=new UrgentCallEscalation({databasePath:options.databasePath,policy:this.policy,authority:options.authority,sourceAuthority:options.sourceAuthority,dispatcher:localPhoneDispatcher({...options,policy:this.policy}),clock:options.clock,decisions:()=>this.decisions()});
  }
  private decisions():CallDecision[]{
    const snapshot=this.options.coordinator.inspect();
    if(snapshot.paused||snapshot.workerHealthy===false)return [];
    const tail=this.policy.canonicalChatId.split(':').at(-1)!;
    return snapshot.decisions.filter(d=>d.recipient.chatId===tail&&d.recipient.userId===tail&&/^[1-9]\d{0,19}$/.test(d.recipient.botId)).map(d=>{
      const times=snapshot.attempts.filter(a=>a.decisionId===d.id&&a.questionVersion===d.questionVersion&&a.status==='accepted').map(a=>a.acceptedAt??this.gate.observeAcceptedMessage(d.id,d.questionVersion,a.id??`legacy:${a.dispatchedAt??'unknown'}`)).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
      return {id:d.id,questionVersion:d.questionVersion,sourceContractId:d.sourceContractId,ownerId:d.ownerId,agentId:this.policy.agentId,canonicalChatId:this.policy.canonicalChatId,urgent:d.urgent===true,state:d.state,attention:d.attention,deadline:d.deadline,acceptedMessageAt:times.length?Math.max(...times):undefined};
    });
  }
  tick():Promise<void>{
    if(this.stopped)return Promise.resolve();
    if(this.pending)return this.pending;
    this.pending=this.gate.tick().then(()=>{this.healthy=true;},()=>{this.healthy=false;}).finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  async start():Promise<void>{if(this.stopped||this.timer)return;await this.tick();if(!this.stopped){this.timer=setInterval(()=>{void this.tick();},1000);this.timer.unref();}}
  async stop():Promise<void>{this.stopped=true;this.gate.stop();if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.pending;}
  close():void{if(this.pending)throw new Error('Await stop before closing voice coordinator');this.stopped=true;if(this.timer)clearInterval(this.timer);this.gate.close();}
  inspect(){return {enabled:this.policy.enabled,running:!!this.timer&&!this.stopped,workerHealthy:this.healthy,authorityMode:'fresh-call-consent-and-source-projection-required' as const,attempts:this.gate.history()};}
}
