import fs from 'node:fs';
import type {AdmittedSourceFeed,AdmittedCallSource} from './urgent-sources.js';
import path from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { CallAuthorityResult, CallConsent, CallDecision, EscalationDependencies, SourceAuthorityResult } from './escalation.js';

export interface ContractsVoiceAuthorityOptions {
  socketPath:string;tokenFile?:string;token?:()=>Promise<string>;ownerId:string;coordinatorId:string;mandateId?:string;mandateIdFile?:string;
  agentId:string;canonicalChatId:string;recipientRef:string;timeoutMs?:number;clock?:()=>number;
}
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const id=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=160&&x===x.trim()&&!/[\u0000-\u001f]/.test(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
const digest=(x:unknown):x is string=>typeof x==='string'&&/^sha256:[a-f0-9]{64}$/.test(x);

/** Read-only local authority. Neither client input nor transport success constitutes consent. */
export class ContractsVoiceAuthority {
  readonly authority:EscalationDependencies['authority'];
  readonly sourceAuthority:EscalationDependencies['sourceAuthority'];
  private now:()=>number;
  private checkedMandates=new Map<string,string>();
  constructor(private opts:ContractsVoiceAuthorityOptions) {
    if(!path.isAbsolute(opts.socketPath)||Boolean(opts.tokenFile)===Boolean(opts.token)||opts.tokenFile!==undefined&&!path.isAbsolute(opts.tokenFile)||Boolean(opts.mandateId)===Boolean(opts.mandateIdFile)||opts.mandateId!==undefined&&!id(opts.mandateId)||opts.mandateIdFile!==undefined&&!path.isAbsolute(opts.mandateIdFile)||![opts.ownerId,opts.coordinatorId,opts.agentId,opts.recipientRef].every(id)||!/^telegram(?::[a-zA-Z0-9_-]+)?:[1-9]\d{0,19}$/.test(opts.canonicalChatId)||opts.timeoutMs!==undefined&&(!integer(opts.timeoutMs)||opts.timeoutMs>10000))throw new Error('Invalid Contracts voice authority configuration');
    this.opts={...opts};this.now=opts.clock??Date.now;
    this.authority={check:(decision,expected)=>this.check(decision,expected)};
    this.sourceAuthority={check:decision=>this.project(decision)};
  }
  private bound(d:CallDecision):boolean {
    return object(d)&&id(d.id)&&integer(d.questionVersion)&&id(d.sourceContractId)&&d.ownerId===this.opts.ownerId&&d.agentId===this.opts.agentId&&d.canonicalChatId===this.opts.canonicalChatId&&integer(d.deadline)&&d.deadline>this.now();
  }
  private input(expected?:{version:number;digest:string}) {
    const {ownerId,coordinatorId,agentId,canonicalChatId,recipientRef}=this.opts;
    let mandateId=this.opts.mandateId;
    if(this.opts.mandateIdFile){const fd=fs.openSync(this.opts.mandateIdFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.size>512)throw new Error('Invalid mandate reference');const data=JSON.parse(fs.readFileSync(fd,'utf8'));if(!object(data)||Object.keys(data).length!==1||!id(data.mandateId))throw new Error('Invalid mandate reference');mandateId=data.mandateId;}finally{fs.closeSync(fd);}}
    if(!id(mandateId))throw new Error('Mandate approval pending');
    if(expected&&this.checkedMandates.has(`${expected.version}:${expected.digest}`)&&this.checkedMandates.get(`${expected.version}:${expected.digest}`)!==mandateId)throw new Error('Mandate changed');
    return {mandateId,ownerId,coordinatorId,agentId,canonicalChatId,recipientRef,...(expected?{expectedVersion:expected.version,expectedDigest:expected.digest}:{})};
  }
  private fresh(value:unknown,now:number):boolean {return integer(value)&&value<=now&&value>=now-30000;}
  async check(d:CallDecision,expected?:{version:number;digest:string}):Promise<CallAuthorityResult> {
    const deny=():CallAuthorityResult=>({allowed:false,checkedAt:this.now()});
    try {
      if(!this.bound(d)||expected&&(!integer(expected.version)||!digest(expected.digest)))return deny();
      const input=this.input(expected);const r=await this.request('callCheck',input);const now=this.now();
      if(!object(r)||r.schemaVersion!==1||r.allowed!==true||!this.fresh(r.checkedAt,now)||!object(r.consent))return deny();
      const c=r.consent;
      if(c.kind!=='owner_call'||c.status!=='active'||c.id!==input.mandateId||!id(c.lineageId)||!integer(c.version)||!digest(c.digest)||c.ownerId!==this.opts.ownerId||c.coordinatorId!==this.opts.coordinatorId||c.agentId!==this.opts.agentId||c.canonicalChatId!==this.opts.canonicalChatId||c.recipientRef!==this.opts.recipientRef||c.boundedCostVerified!==true||c.costScope!=='telephone_speech_infrastructure'||c.modelBudgetBound!==false||!digest(c.costEvidenceDigest))return deny();
      if(expected&&(c.version!==expected.version||c.digest!==expected.digest))return deny();
      if(!integer(c.notBefore)||c.notBefore>now||!integer(c.expiresAt)||c.expiresAt<=now||c.expiresAt-c.notBefore>2592000000)return deny();
      if(![c.maxCallsPerDay,c.cooldownMs,c.messageGraceMs,c.maxDurationSeconds,c.maxExposureMinor,c.maxSpendMinor].every(integer)||c.maxCallsPerDay>3||c.cooldownMs<1800000||c.messageGraceMs<120000||c.maxDurationSeconds>180||c.maxExposureMinor>c.maxSpendMinor||typeof c.currency!=='string'||!/^([A-Z]{3})$/.test(c.currency))return deny();
      if(!object(c.quietHours)||c.quietHours.timeZone!=='Europe/Berlin'||c.quietHours.startMinute!==1320||c.quietHours.endMinute!==480)return deny();
      // Return only the gate's defined fields; never pass a server object through as authority.
      const consent:CallConsent={kind:'owner_call',status:'active',id:c.id,lineageId:c.lineageId,version:c.version,digest:c.digest,ownerId:c.ownerId,agentId:c.agentId,canonicalChatId:c.canonicalChatId,recipientRef:c.recipientRef,notBefore:c.notBefore,expiresAt:c.expiresAt,maxCallsPerDay:c.maxCallsPerDay,cooldownMs:c.cooldownMs,messageGraceMs:c.messageGraceMs,maxDurationSeconds:c.maxDurationSeconds,currency:c.currency,maxExposureMinor:c.maxExposureMinor,maxSpendMinor:c.maxSpendMinor,quietHours:{startMinute:1320,endMinute:480,timeZone:'Europe/Berlin'},boundedCostVerified:true,costScope:'telephone_speech_infrastructure',modelBudgetBound:false};
      this.checkedMandates.set(`${c.version}:${c.digest}`,c.id);
      return {allowed:true,checkedAt:r.checkedAt,consent};
    }catch{return deny();}
  }
  async project(d:CallDecision):Promise<SourceAuthorityResult> {
    const deny=():SourceAuthorityResult=>({verified:false,checkedAt:this.now(),expiresAt:this.now(),sourceContractId:typeof d?.sourceContractId==='string'?d.sourceContractId:'',ownerId:this.opts.ownerId,decisionId:typeof d?.id==='string'?d.id:'',questionVersion:Number.isSafeInteger(d?.questionVersion)?d.questionVersion:0,revision:'',actionable:false,urgent:false,usefulUntil:this.now()});
    try {
      if(!this.bound(d))return deny();
      const r=await this.request('projectCallSource',{...this.input(),decisionId:d.id,questionVersion:d.questionVersion,sourceContractId:d.sourceContractId});const now=this.now();
      if(!object(r)||r.verified!==true||r.actionable!==true||r.urgent!==true||!this.fresh(r.checkedAt,now)||!integer(r.expiresAt)||r.expiresAt<=now||r.expiresAt>r.checkedAt+30000||r.sourceContractId!==d.sourceContractId||r.ownerId!==this.opts.ownerId||r.decisionId!==d.id||r.questionVersion!==d.questionVersion||!id(r.revision)||!integer(r.usefulUntil)||r.usefulUntil!==d.deadline||r.usefulUntil<=now||r.expiresAt>r.usefulUntil)return deny();
      return {verified:true,checkedAt:r.checkedAt,expiresAt:r.expiresAt,sourceContractId:r.sourceContractId,ownerId:r.ownerId,decisionId:r.decisionId,questionVersion:r.questionVersion,revision:r.revision,actionable:true,urgent:true,usefulUntil:r.usefulUntil};
    }catch{return deny();}
  }
  async sources():Promise<AdmittedSourceFeed> {
    const deny=():AdmittedSourceFeed=>({schemaVersion:1,checkedAt:this.now(),expiresAt:this.now(),available:false,sources:[],blockers:['authority_unavailable']});
    try{const r=await this.request('callSources',this.input()),now=this.now();
      if(!object(r)||r.schemaVersion!==1||r.available!==true||!this.fresh(r.checkedAt,now)||!integer(r.expiresAt)||r.expiresAt<=now||r.expiresAt>r.checkedAt+30000||!Array.isArray(r.sources)||r.sources.length>200||!Array.isArray(r.blockers)||!r.blockers.every(id))return deny();
      const sources:AdmittedCallSource[]=[];
      for(const s of r.sources){if(!object(s)||!['agent_blocked_decision','reviewed_contract_deadline'].includes(s.sourceClass)||![s.sourceContractId,s.decisionId,s.revision].every(id)||!integer(s.questionVersion)||!integer(s.deadline)||s.deadline<=now||!integer(s.urgentFrom)||s.urgentFrom>=s.deadline||s.urgent!==(now>=s.urgentFrom)||s.actionable!==true||typeof s.title!=='string'||!s.title.trim()||s.title.length>2500||!(s.sourceClass==='agent_blocked_decision'?s.provenance==='agent_declared_deadline':['reviewed_active_contract','reviewed_pending_proposal'].includes(s.provenance))||s.acceptedMessageAt!==undefined&&(!integer(s.acceptedMessageAt)||s.acceptedMessageAt>now))return deny();sources.push({...s} as AdmittedCallSource);}
      return {schemaVersion:1,checkedAt:r.checkedAt,expiresAt:r.expiresAt,available:true,sources,blockers:[...r.blockers]};
    }catch{return deny();}
  }
  private async request(op:'callCheck'|'projectCallSource'|'callSources' ,input:unknown):Promise<unknown> {
    const {socketPath,tokenFile}=this.opts;
    for(const dir of new Set([path.dirname(socketPath),...(tokenFile?[path.dirname(tokenFile)]:[])])) {
      const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw new Error('Private authority directory required');
    }
    const socket=fs.lstatSync(socketPath);if(!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==process.getuid?.()||(socket.mode&0o077)!==0)throw new Error('Private authority socket required');
    let token:string;
    if(this.opts.token){token=await this.opts.token();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid authority credential');}
    else {const fd=fs.openSync(tokenFile!,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>256)throw new Error('Private authority credential required');token=fs.readFileSync(fd,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid authority credential');}finally{fs.closeSync(fd);}}
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const client=createConnection(socketPath);let bytes=Buffer.alloc(0),settled=false;
      const finish=(error?:Error,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);client.destroy();error?reject(error):resolve(result);};
      const timer=setTimeout(()=>finish(new Error('Authority timeout')),this.opts.timeoutMs??3000);
      client.on('error',()=>finish(new Error('Authority unavailable')));client.on('end',()=>finish(new Error('Incomplete authority response')));
      client.on('connect',()=>client.write(JSON.stringify({schemaVersion:1,requestId,token,op,input})+'\n'));
      client.on('data',(chunk:Buffer)=>{
        if(bytes.length+chunk.length>65536)return finish(new Error('Oversized authority response'));
        bytes=Buffer.concat([bytes,chunk]);const newline=bytes.indexOf(10);if(newline<0)return;
        try{const reply=JSON.parse(bytes.subarray(0,newline).toString('utf8'));if(!object(reply)||reply.schemaVersion!==1||reply.requestId!==requestId||reply.ok!==true||!object(reply.result))throw new Error('Invalid envelope');finish(undefined,reply.result);}catch{finish(new Error('Invalid authority response'));}
      });
    });
  }
}
