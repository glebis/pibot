import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {QuestionSnapshot} from '../core/questions.js';
import type {Recipient} from '../coordinator/types.js';
import type {CoordinatorVoiceSnapshot} from './coordinator-runtime.js';

export interface SourceScope {ownerId:string;agentId:string;canonicalChatId:string}
export interface BlockedDecisionProjection extends SourceScope {
 schemaVersion:1;checkedAt:number;expiresAt:number;available:boolean;
 decisions:Array<{sourceContractId:string;decisionId:string;questionVersion:number;revision:string;deadline:number;state:'blocked_awaiting_owner';acceptedMessageAt:number;title:string;deadlineReason:string;provenance:'agent_declared_deadline'}>;
}
export interface AdmittedCallSource {
 sourceClass:'agent_blocked_decision'|'reviewed_contract_deadline';sourceContractId:string;decisionId:string;questionVersion:number;revision:string;
 deadline:number;urgentFrom:number;urgent:boolean;actionable:true;title:string;
 provenance:'agent_declared_deadline'|'reviewed_active_contract'|'reviewed_pending_proposal';acceptedMessageAt?:number;
}
export interface AdmittedSourceFeed {schemaVersion:1;checkedAt:number;expiresAt:number;available:boolean;sources:AdmittedCallSource[];blockers:string[]}
export interface UrgentSourceOptions extends SourceScope {
 databasePath:string;recipient:Recipient;urgencyLeadMs:number;clock?:()=>number;
 liveQuestion:(qid:string)=>QuestionSnapshot|undefined;
 bindingAllowed:()=>boolean;
}
type Stored={sourceContractId:string;decisionId:string;questionVersion:number;revision:string;deadline:number;title:string;status:string;kind:'question'|'contract';acceptedMessageAt?:number;messageId?:string;qid?:string;deadlineReason?:string};
export type SourceMessageSender=(source:AdmittedCallSource,recipient:Recipient)=>Promise<{status:'accepted';messageId:string}|{status:'rejected'|'unknown'}>;
export function urgentSourceReceipt(source:{decisionId:string;questionVersion:number;revision:string}):string {return createHash('sha256').update(JSON.stringify([source.decisionId,source.questionVersion,source.revision])).digest('hex').slice(0,40);}
/** Persistent observed receipts; current authority/liveness is always re-read, never restored as fact. */
export class UrgentSourceStore {
 private db:DatabaseSync;private now:()=>number;private freshFeed?:AdmittedSourceFeed;private syncing=false;
 constructor(private opts:UrgentSourceOptions){
  this.now=opts.clock??Date.now;
  if(!path.isAbsolute(opts.databasePath)||![opts.ownerId,opts.agentId,opts.canonicalChatId].every(x=>typeof x==='string'&&x.length>0)||!Number.isSafeInteger(opts.urgencyLeadMs)||opts.urgencyLeadMs<=0||!Object.values(opts.recipient).every(x=>/^[1-9]\d{0,19}$/.test(x))||opts.recipient.chatId!==opts.recipient.userId||opts.canonicalChatId.split(':').at(-1)!==opts.recipient.chatId)throw new Error('Invalid urgent source scope');
  this.opts={...opts,recipient:{...opts.recipient}};
  fs.mkdirSync(path.dirname(opts.databasePath),{recursive:true,mode:0o700});const dir=fs.lstatSync(path.dirname(opts.databasePath));
  if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o077)!==0)throw new Error('Private source directory required');
  const fd=fs.openSync(opts.databasePath,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw new Error('Private source ledger required');}finally{fs.closeSync(fd);}
  this.db=new DatabaseSync(opts.databasePath);this.db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS urgent_sources(id TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,revision));CREATE TABLE IF NOT EXISTS urgent_source_meta(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  const scope=JSON.stringify({ownerId:opts.ownerId,agentId:opts.agentId,canonicalChatId:opts.canonicalChatId,recipient:opts.recipient});
  const saved=this.db.prepare("SELECT body FROM urgent_source_meta WHERE id='scope'").get();
  if(saved&&saved.body!==scope){this.db.close();throw new Error('Source ledger belongs to another owner binding');}
  if(!saved)this.db.prepare("INSERT INTO urgent_source_meta VALUES('scope',?)").run(scope);
  // A crash after sending cannot justify another message. Live pending questions must reappear in the current bus.
  for(const record of this.rows())if(record.status==='dispatching'){record.status='unknown';this.save(record);}
 }
 private rows():Stored[]{return this.db.prepare('SELECT body FROM urgent_sources').all().map(r=>JSON.parse(String(r.body)));}
 private save(r:Stored){this.db.prepare('INSERT INTO urgent_sources VALUES(?,?,?) ON CONFLICT(id,revision) DO UPDATE SET body=excluded.body').run(r.decisionId,r.revision,JSON.stringify(r));}
 observeQuestion(q:QuestionSnapshot):void{
  if(q.agentId!==this.opts.agentId||q.canonicalChatId!==this.opts.canonicalChatId||q.provenance!=='agent_declared_deadline'||!Number.isSafeInteger(q.usefulUntil)||!q.deadlineReason?.trim()||!/^sha256:[a-f0-9]{64}$/.test(q.revision))return;
  const old=this.rows().find(r=>r.decisionId===q.qid&&r.revision===q.revision);
  const receipt=old?.acceptedMessageAt??(Number.isSafeInteger(q.acceptedMessageAt)&&q.acceptedMessageAt!>=q.createdAt&&q.acceptedMessageAt!<=this.now()?q.acceptedMessageAt:undefined);
  this.save({sourceContractId:`pibot-question:${q.qid}`,decisionId:q.qid,questionVersion:1,revision:q.revision,deadline:q.usefulUntil!,title:q.question,kind:'question',qid:q.qid,status:q.status,...(receipt!==undefined?{acceptedMessageAt:receipt}:{}),deadlineReason:q.deadlineReason});
 }
 projection(scope:SourceScope):BlockedDecisionProjection{
  const now=this.now();const available=scope.ownerId===this.opts.ownerId&&scope.agentId===this.opts.agentId&&scope.canonicalChatId===this.opts.canonicalChatId&&this.opts.bindingAllowed();
  const decisions:BlockedDecisionProjection['decisions']=[];
  if(available)for(const r of this.rows()){
   if(r.kind!=='question'||r.status!=='pending'||r.acceptedMessageAt===undefined||r.acceptedMessageAt>now||r.deadline<=now)continue;
   const q=this.opts.liveQuestion(r.qid!);
   if(!q||q.status!=='pending'||q.agentId!==this.opts.agentId||q.canonicalChatId!==this.opts.canonicalChatId||q.revision!==r.revision||q.usefulUntil!==r.deadline||q.pendingUntil<=now||q.acceptedMessageAt!==r.acceptedMessageAt||q.provenance!=='agent_declared_deadline')continue;
   decisions.push({sourceContractId:r.sourceContractId,decisionId:r.decisionId,questionVersion:r.questionVersion,revision:r.revision,deadline:r.deadline,state:'blocked_awaiting_owner',acceptedMessageAt:r.acceptedMessageAt,title:r.title.slice(0,2500),deadlineReason:r.deadlineReason!,provenance:'agent_declared_deadline'});
  }
  return {schemaVersion:1,checkedAt:now,expiresAt:now+30000,ownerId:this.opts.ownerId,agentId:this.opts.agentId,canonicalChatId:this.opts.canonicalChatId,available,decisions};
 }
 acknowledge(receipt:string,canonicalChatId:string):boolean {
  if(canonicalChatId!==this.opts.canonicalChatId||!this.opts.bindingAllowed()||! /^[a-f0-9]{40}$/.test(receipt))return false;
  const r=this.rows().find(r=>r.kind==='contract'&&urgentSourceReceipt(r)===receipt);
  if(!r||!['dispatching','accepted','acknowledged'].includes(r.status))return false;
  r.status='acknowledged';this.save(r);return true;
 }
 private feedFresh(feed:AdmittedSourceFeed):boolean {const now=this.now();return feed?.schemaVersion===1&&feed.available===true&&Number.isSafeInteger(feed.checkedAt)&&feed.checkedAt<=now&&feed.checkedAt>=now-30000&&Number.isSafeInteger(feed.expiresAt)&&feed.expiresAt>now&&feed.expiresAt<=feed.checkedAt+30000&&Array.isArray(feed.sources)&&feed.sources.length<=200;}
 private sourceValid(s:AdmittedCallSource):boolean {return !!s&&s.sourceClass==='reviewed_contract_deadline'&&['reviewed_active_contract','reviewed_pending_proposal'].includes(s.provenance)&&s.actionable===true&&[s.sourceContractId,s.decisionId,s.revision,s.title].every(x=>typeof x==='string'&&x.trim().length>0)&&s.title.length<=2500&&Number.isSafeInteger(s.questionVersion)&&s.questionVersion>0&&Number.isSafeInteger(s.deadline)&&s.deadline>this.now()&&Number.isSafeInteger(s.urgentFrom)&&s.urgentFrom<s.deadline;}
 async syncContracts(feed:AdmittedSourceFeed,send:SourceMessageSender):Promise<void>{
  if(this.syncing)return;this.syncing=true;
  try{
   this.freshFeed=undefined;
   if(!this.opts.bindingAllowed()||!this.feedFresh(feed))return;
   this.freshFeed=structuredClone(feed);
   for(const source of feed.sources){
    if(!this.sourceValid(source)||source.urgent!==true||this.now()<source.urgentFrom||!this.feedFresh(feed)||!this.opts.bindingAllowed())continue;
    const existing=this.rows().find(r=>r.decisionId===source.decisionId&&r.revision===source.revision);if(existing)continue;
    const record:Stored={sourceContractId:source.sourceContractId,decisionId:source.decisionId,questionVersion:source.questionVersion,revision:source.revision,deadline:source.deadline,title:source.title,kind:'contract',status:'dispatching'};
    this.save(record);
    let result:Awaited<ReturnType<SourceMessageSender>>;try{result=await send(source,{...this.opts.recipient});}catch{result={status:'unknown'};}
    if(result?.status==='accepted'&&typeof result.messageId==='string'&&result.messageId.length>0){record.status='accepted';record.acceptedMessageAt=this.now();record.messageId=result.messageId;}
    else record.status=result?.status==='rejected'?'rejected':'unknown';
    if(this.rows().some(r=>r.decisionId===record.decisionId&&r.revision===record.revision&&r.status==='acknowledged'))record.status='acknowledged';
    this.save(record);
   }
  }finally{this.syncing=false;}
 }
 inspect():CoordinatorVoiceSnapshot{
  const now=this.now();const scope={ownerId:this.opts.ownerId,agentId:this.opts.agentId,canonicalChatId:this.opts.canonicalChatId};
  const questions=this.projection(scope);const admitted: Array<{id:string;version:number;source:string;deadline:number;urgent:boolean;acceptedAt:number;revision:string}>=questions.decisions.map(s=>({id:s.decisionId,version:s.questionVersion,source:s.sourceContractId,deadline:s.deadline,urgent:now>=s.deadline-this.opts.urgencyLeadMs,acceptedAt:s.acceptedMessageAt,revision:s.revision}));
  if(this.opts.bindingAllowed()&&this.freshFeed&&this.feedFresh(this.freshFeed))for(const s of this.freshFeed.sources){
   if(!this.sourceValid(s))continue;const r=this.rows().find(r=>r.kind==='contract'&&r.decisionId===s.decisionId&&r.revision===s.revision&&r.questionVersion===s.questionVersion&&r.deadline===s.deadline&&r.status==='accepted');
   if(r?.acceptedMessageAt!==undefined)admitted.push({id:r.decisionId,version:r.questionVersion,source:r.sourceContractId,deadline:r.deadline,urgent:now>=s.urgentFrom,acceptedAt:r.acceptedMessageAt,revision:r.revision});
  }
  return {paused:!this.opts.bindingAllowed(),workerHealthy:true,decisions:admitted.map(s=>({id:s.id,questionVersion:s.version,sourceContractId:s.source,ownerId:this.opts.ownerId,urgent:s.urgent,state:'open',attention:'pending',deadline:s.deadline,recipient:{...this.opts.recipient}})),attempts:admitted.map(s=>({id:`observed:${s.id}:${s.revision}`,decisionId:s.id,questionVersion:s.version,status:'accepted',acceptedAt:s.acceptedAt}))};
 }
 close(){if(this.syncing)throw new Error('Wait for source message before closing');this.db.close();}
}
