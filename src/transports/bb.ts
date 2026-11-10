import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import type { PushOptions, Transport } from '../core/types.js';
import {ChatAttachmentError,chatAttachmentFingerprint,validateChatAttachments,type ChatAttachment} from '../core/chat-attachments.js';
import { writeJsonAtomic } from '../core/util.js';

export type BbChatInput={agentId:string;chatKey:string;text:string;requestId:string;allowTools:boolean;attachments?:ChatAttachment[]};
export type BbChatReply={text:string;pendingApproval?:boolean};
export class BbChatError extends Error {constructor(public status:400|404|409|503,message:string){super(message);}}
export const bbChatKey=(agentId:string)=>`bb:${agentId}:owner`;
export interface BbConversationControl {
 conversations(agentId:string):Array<{agentId:string;chatKey:string;canSend:true;kind:'bb'}>;
 send(input:BbChatInput):Promise<BbChatReply>;
}

/** An independent owner conversation. Only explicit authenticated HTTP ingress runs it. */
export class BbTransport implements Transport {
 readonly name:string;
 readonly boundAgentId:string;
 private output:string[]=[];
 private question:string|undefined;
 private attachmentFailure:ChatAttachmentError|undefined;
 private active:Promise<void>|undefined;
 private wake:(()=>void)|undefined;
 private exchanging=false;
 private working(){return Boolean(this.active);}
 constructor(agentId:string){this.boundAgentId=agentId;this.name=`bb:${agentId}`;}
 async start(){}
 async stop(){}
 onMessage(_cb:Parameters<Transport['onMessage']>[0]){}
 onAction(_cb:Parameters<Transport['onAction']>[0]){}
 async push(chatId:string,opts:PushOptions){
  if(chatId!=='owner')throw new BbChatError(400,'Invalid BB destination.');
  if(!this.exchanging)throw new BbChatError(409,'BB output requires an active explicit request.');
  this.output.push(opts.text.slice(0,16000));this.output=this.output.slice(-20);
  if(opts.dedupeKey?.startsWith('question:')){
   const choices=(opts.card?.buttons??[]).slice(0,10).map((b,i)=>`${i+1}. ${b.label.slice(0,100)}`).join('\n');
   this.question=[opts.text.slice(0,800),choices,'Reply here with your answer or option number.'].filter(Boolean).join('\n').slice(0,2000);
  }
  this.wake?.();
 }
 async notifyError(chatId:string,message:string){await this.push(chatId,{text:message});}
 async exchange(run:()=>Promise<void>,answer:()=>boolean,pending:()=>boolean):Promise<BbChatReply>{
  if(this.exchanging)throw new BbChatError(409,'This BB conversation is busy.');
  this.exchanging=true;
  try{
   if(this.active){
    if(!pending()||!answer())throw new BbChatError(409,'This BB conversation is still working.');
    this.question=undefined;
   }else if(pending()){
    if(!answer())throw new BbChatError(409,'This BB question is no longer available.');
    return {text:'Your answer was recorded here. The previous turn is no longer running; review history before asking the agent to continue.'};
   }else{
    this.question=undefined;this.attachmentFailure=undefined;
    this.active=Promise.resolve().then(run).catch(error=>{if(error instanceof ChatAttachmentError)this.attachmentFailure=error;else if(this.exchanging)this.output.push('The BB turn failed. Check agent health before sending another request.');}).finally(()=>{this.active=undefined;this.wake?.();});
   }
   // A question releases the HTTP request while its existing gated turn waits.
   // Subsequent ingress can answer it without starting a second model turn.
   while(this.working()&&!(this.question&&pending()))await new Promise<void>(resolve=>{this.wake=resolve;});
   this.wake=undefined;
   if(this.attachmentFailure){const error=this.attachmentFailure;this.attachmentFailure=undefined;this.output=[];throw new BbChatError(400,error.message);}
   const waiting=Boolean(this.question&&pending());
   const text=waiting?this.question!:this.output.join('\n').slice(0,2000)||'The turn completed without a visible reply.';
   this.output=[];
   return {text,...(waiting?{pendingApproval:true}:{})};
  }finally{this.exchanging=false;this.wake=undefined;}
 }
}

type Receipt={fingerprint:string;result?:BbChatReply};
/** Persist before execution. Unknown outcomes after a restart are never replayed. */
export class BbRequestReceipts {
 private records:Record<string,Receipt>|undefined;
 private running=new Map<string,Promise<BbChatReply>>();
 constructor(private file:string){}
 private load(){
  if(this.records)return this.records;
  if(!existsSync(this.file))return this.records=Object.create(null) as Record<string,Receipt>;
  const st=lstatSync(this.file);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>16*1024*1024)throw new BbChatError(503,'BB request receipts are unavailable.');
  let value:unknown;try{value=JSON.parse(readFileSync(this.file,'utf8'));}catch{throw new BbChatError(503,'BB request receipts are unavailable.');}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>4096)throw new BbChatError(503,'BB request receipts are unavailable.');
  for(const [key,rec] of Object.entries(value)){
   if(!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,128}$/.test(key)||!rec||typeof rec!=='object'||Array.isArray(rec)||Object.keys(rec).some(k=>!['fingerprint','result'].includes(k))||typeof rec.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(rec.fingerprint))throw new BbChatError(503,'BB request receipts are unavailable.');
   if(Object.hasOwn(rec,'result')){const result=rec.result;if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).some(k=>!['text','pendingApproval'].includes(k))||typeof result.text!=='string'||result.text.length>2000||(result.pendingApproval!==undefined&&typeof result.pendingApproval!=='boolean'))throw new BbChatError(503,'BB request receipts are unavailable.');}
  }
  this.records=Object.assign(Object.create(null),value) as Record<string,Receipt>;
  return this.records;
 }
 async send(input:BbChatInput,execute:()=>Promise<BbChatReply>):Promise<BbChatReply>{
  const records=this.load(),key=`${input.agentId}:${input.requestId}`;
  const attachmentHashes=chatAttachmentFingerprint(validateChatAttachments(input.attachments,input.allowTools));
  const fingerprint=createHash('sha256').update(JSON.stringify([input.agentId,input.chatKey,input.text,input.allowTools,...(attachmentHashes.length?[attachmentHashes]:[])])).digest('hex');
  const prior=records[key];
  if(prior){
   if(prior.fingerprint!==fingerprint)throw new BbChatError(409,'Request ID belongs to a different BB message.');
   const active=this.running.get(key);if(active)return active;
   if(prior.result)return structuredClone(prior.result);
   throw new BbChatError(409,'The previous request outcome is unknown. Review its saved history before sending another message.');
  }
  if(Object.keys(records).length>=4096)throw new BbChatError(503,'BB request receipt capacity reached. Review receipts before continuing.');
  records[key]={fingerprint};writeJsonAtomic(this.file,records,0o600);
  const running=Promise.resolve().then(execute).then(result=>{records[key]={fingerprint,result};writeJsonAtomic(this.file,records,0o600);return result;}).finally(()=>this.running.delete(key));
  this.running.set(key,running);return running;
 }
}
