import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CallDecision {
  id: string; questionVersion: number; sourceContractId: string; ownerId: string;
  agentId: string; canonicalChatId: string; urgent: boolean;
  state: string; attention: string; deadline: number; acceptedMessageAt?: number;
}
export interface CallPolicy {
  enabled: boolean; ownerId: string; agentId: string; canonicalChatId: string; recipientRef: string;
  currency: string; maxExposureMinor: number; maxSpendMinor: number;
  maxCallsPerDay?: number; cooldownMs?: number; messageGraceMs?: number; maxDurationSeconds?: number;
  quietHours?: { startMinute: number; endMinute: number; timeZone: 'Europe/Berlin' };
}
/** This is separately approved CALL consent, never a message mandate cast into another shape. */
export interface CallConsent {
  kind: 'owner_call'; status: 'active'; id: string; lineageId: string; version: number; digest: string;
  ownerId: string; agentId: string; canonicalChatId: string; recipientRef: string;
  notBefore: number; expiresAt: number; maxCallsPerDay: number; cooldownMs: number;
  messageGraceMs: number; maxDurationSeconds: number; currency: string; maxExposureMinor: number; maxSpendMinor: number;
  quietHours: { startMinute: number; endMinute: number; timeZone: 'Europe/Berlin' };
  /** Trusted authority has verified the rate upper bound AND provider-side duration enforcement. */
  boundedCostVerified: true;
  costScope: 'telephone_speech_infrastructure';
  modelBudgetBound: false;
}
export interface CallAuthorityResult { allowed: boolean; checkedAt: number; consent?: CallConsent }
export interface SourceAuthorityResult {
  verified: boolean; checkedAt: number; expiresAt: number; sourceContractId: string; ownerId: string;
  decisionId: string; questionVersion: number; revision: string; actionable: boolean; urgent: boolean; usefulUntil: number;
}
export interface CallDispatchInput {
  attemptId: string; decisionId: string; questionVersion: number; sourceContractId: string; sourceRevision: string;
  ownerId: string; recipientRef: string; maxDurationSeconds: number; maxExposureMinor: number; currency: string;
  consentId: string; consentVersion: number; consentDigest: string;
  costScope?: 'telephone_speech_infrastructure'; modelBudgetBound?: false;
}
export type CallDispatchResult = { status: 'accepted'; providerCallId: string } | { status: 'unknown' } |
  { status: 'rejected_preflight' }; // Only when the adapter guarantees no provider call was attempted.
export interface CallDispatcher { dispatch(input: CallDispatchInput): Promise<CallDispatchResult> }
export interface CallUsageEvidence {
  schemaVersion: 1; attemptId: string; providerCallId: string; currency: string;
  checkedAt: number; terminal: true; confirmedTwilioMinor: number; remainingExposureMinor: number | null;
}
export interface CallUsageSettlement extends CallUsageEvidence { state: 'partial' | 'settled' }
export interface CallAttempt extends CallDispatchInput { status: 'accepted' | 'unknown' | 'rejected_preflight'; reservedAt: number; day: string; lineageId: string; providerCallId?: string; usageSettlement?: CallUsageSettlement }
export interface EscalationDependencies {
  databasePath: string; policy: CallPolicy; decisions(): CallDecision[];
  authority: { check(decision: CallDecision, expected?: { version: number; digest: string }): Promise<CallAuthorityResult> };
  sourceAuthority: { check(decision: CallDecision): Promise<SourceAuthorityResult> };
  usageReconciler?: { check(attempt: CallAttempt): Promise<CallUsageEvidence | null> };
  dispatcher: CallDispatcher; clock?: () => number;
}
const DAY = 86_400_000;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
function quietValid(q: CallConsent['quietHours']): boolean { return !!q && q.timeZone === 'Europe/Berlin' && [q.startMinute,q.endMinute].every(v => Number.isInteger(v) && v >= 0 && v < 1440); }
function quiet(now: number, q: CallConsent['quietHours']): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: q.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  return q.startMinute === q.endMinute || (q.startMinute < q.endMinute ? minute >= q.startMinute && minute < q.endMinute : minute >= q.startMinute || minute < q.endMinute);
}
const dayKey = (now: number): string => new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);

/** Durable, fail-closed owner-call gate. It never infers urgency or telephone permission. */
export class UrgentCallEscalation {
  private db: DatabaseSync;
  private running = false;
  private stopped = false;
  private clock: () => number;
  private policy: Required<CallPolicy>;
  constructor(private deps: EscalationDependencies) {
    this.clock = deps.clock ?? Date.now;
    this.policy = { ...deps.policy, maxCallsPerDay: deps.policy.maxCallsPerDay ?? 2, cooldownMs: deps.policy.cooldownMs ?? 1_800_000, messageGraceMs: deps.policy.messageGraceMs ?? 120_000, maxDurationSeconds: deps.policy.maxDurationSeconds ?? 180, quietHours: deps.policy.quietHours ?? {startMinute:1320,endMinute:480,timeZone:'Europe/Berlin'} };
    const p = this.policy;
    if (![p.ownerId,p.agentId,p.canonicalChatId,p.recipientRef].every(v => typeof v === 'string' && v.length > 0) || !/^[A-Z]{3}$/.test(p.currency) || ![p.maxExposureMinor,p.maxSpendMinor,p.maxCallsPerDay,p.cooldownMs,p.messageGraceMs,p.maxDurationSeconds].every(positive) || p.cooldownMs < 1_800_000 || p.messageGraceMs < 120_000 || p.maxDurationSeconds > 180 || p.maxExposureMinor > p.maxSpendMinor || !quietValid(p.quietHours)) throw new Error('Invalid bounded call policy');
    if (!path.isAbsolute(deps.databasePath)) throw new Error('Call ledger requires an absolute path');
    fs.mkdirSync(path.dirname(deps.databasePath),{recursive:true,mode:0o700});
    const parent = fs.lstatSync(path.dirname(deps.databasePath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error('Call ledger requires a private owner directory');
    const fd = fs.openSync(deps.databasePath,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
    try { const st=fs.fstatSync(fd); if (!st.isFile() || st.uid!==process.getuid?.() || (st.mode&0o077)!==0) throw new Error('Unsafe call ledger'); } finally {fs.closeSync(fd);}
    this.db = new DatabaseSync(deps.databasePath);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS call_attempts(decision_id TEXT NOT NULL, question_version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(decision_id,question_version)); CREATE TABLE IF NOT EXISTS accepted_message_observations(decision_id TEXT NOT NULL,question_version INTEGER NOT NULL,message_key TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(decision_id,question_version,message_key));');
    this.db.exec('CREATE TABLE IF NOT EXISTS call_usage_settlements(attempt_id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS call_usage_events(id INTEGER PRIMARY KEY,attempt_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS call_usage_polls(attempt_id TEXT PRIMARY KEY,checked_at INTEGER NOT NULL);');
  }
  /** Conservative grace origin for older message receipts without an acceptance timestamp. */
  observeAcceptedMessage(decisionId:string,questionVersion:number,messageKey:string):number {
    const now=this.clock();
    if(!decisionId||!positive(questionVersion)||!messageKey||!Number.isSafeInteger(now))throw new Error('Invalid accepted message observation');
    this.db.prepare('INSERT OR IGNORE INTO accepted_message_observations VALUES(?,?,?,?)').run(decisionId,questionVersion,messageKey,now);
    return Number(this.db.prepare('SELECT observed_at FROM accepted_message_observations WHERE decision_id=? AND question_version=? AND message_key=?').get(decisionId,questionVersion,messageKey)!.observed_at);
  }
  history(): CallAttempt[] { return this.db.prepare("SELECT a.body, u.body AS usage_body FROM call_attempts a LEFT JOIN call_usage_settlements u ON u.attempt_id=json_extract(a.body,'$.attemptId')").all().map(r=>({...JSON.parse(String(r.body)), ...(r.usage_body ? {usageSettlement:JSON.parse(String(r.usage_body))} : {})})); }
  private validUsage(e: CallUsageEvidence | null, a: CallAttempt, now: number): e is CallUsageEvidence {
    return !!e && e.schemaVersion===1 && e.terminal===true && e.attemptId===a.attemptId && e.providerCallId===a.providerCallId && e.currency===a.currency && Number.isSafeInteger(e.checkedAt) && e.checkedAt<=now && e.checkedAt>=now-30000 && Number.isSafeInteger(e.confirmedTwilioMinor) && e.confirmedTwilioMinor>=0 && (e.remainingExposureMinor===null || (Number.isSafeInteger(e.remainingExposureMinor) && e.remainingExposureMinor>=0 && Number.isSafeInteger(e.confirmedTwilioMinor+e.remainingExposureMinor)));
  }
  private async reconcile(): Promise<void> {
    if(!this.deps.usageReconciler)return;
    for(const a of this.history().filter(a=>a.ownerId===this.policy.ownerId && a.status==='accepted' && !!a.providerCallId && !a.usageSettlement)) {
      if(this.stopped)return;
      const now=this.clock(); let claimed=false;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const last=this.db.prepare('SELECT checked_at FROM call_usage_polls WHERE attempt_id=?').get(a.attemptId);
        const settled=this.db.prepare('SELECT 1 FROM call_usage_settlements WHERE attempt_id=?').get(a.attemptId);
        if(!settled && (!last || Number(last.checked_at)<=now-60000)) {
          this.db.prepare('INSERT INTO call_usage_polls VALUES(?,?) ON CONFLICT(attempt_id) DO UPDATE SET checked_at=excluded.checked_at').run(a.attemptId,now); claimed=true;
        }
        this.db.exec('COMMIT');
      } catch(e) {this.db.exec('ROLLBACK');throw e;}
      if(!claimed)continue;
      let evidence:CallUsageEvidence|null;
      try {evidence=await this.deps.usageReconciler.check(a);} catch {continue;}
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const latest=this.history().find(v=>v.attemptId===a.attemptId);
        if(latest && latest.status==='accepted' && !latest.usageSettlement && this.validUsage(evidence,latest,this.clock())) {
          const settlement:CallUsageSettlement={...evidence,state:evidence.remainingExposureMinor===0?'settled':'partial'};
          const body=JSON.stringify(settlement);
          this.db.prepare('INSERT OR IGNORE INTO call_usage_settlements VALUES(?,?)').run(a.attemptId,body);
          this.db.prepare('INSERT INTO call_usage_events(attempt_id,body) VALUES(?,?)').run(a.attemptId,body);
        }
        this.db.exec('COMMIT');
      } catch(e) {this.db.exec('ROLLBACK');throw e;}
    }
  }
  stop(): void { this.stopped=true; }
  close(): void { if(this.running)throw new Error('Stop and await tick before closing call ledger');this.stopped=true;this.db.close(); }
  private eligible(d: CallDecision, now: number, grace: number): boolean {
    const p=this.policy;
    return d.ownerId===p.ownerId && d.agentId===p.agentId && d.canonicalChatId===p.canonicalChatId && !!d.id && !!d.sourceContractId && positive(d.questionVersion) && d.urgent===true && d.state==='open' && d.attention==='pending' && Number.isFinite(d.deadline) && d.deadline>now && Number.isFinite(d.acceptedMessageAt) && d.acceptedMessageAt!<=now-grace;
  }
  private validConsent(r: CallAuthorityResult, now: number): r is CallAuthorityResult & {consent:CallConsent} {
    const c=r?.consent,p=this.policy;
    return r?.allowed===true && Number.isFinite(r.checkedAt) && r.checkedAt<=now && r.checkedAt>=now-30000 && !!c && c.kind==='owner_call' && c.status==='active' && c.boundedCostVerified===true && c.costScope==='telephone_speech_infrastructure' && c.modelBudgetBound===false && !!c.id && !!c.lineageId && !!c.digest && positive(c.version) && c.ownerId===p.ownerId && c.agentId===p.agentId && c.canonicalChatId===p.canonicalChatId && c.recipientRef===p.recipientRef && c.currency===p.currency && Number.isFinite(c.notBefore) && c.notBefore<=now && Number.isFinite(c.expiresAt) && c.expiresAt>now && [c.maxCallsPerDay,c.cooldownMs,c.messageGraceMs,c.maxDurationSeconds,c.maxExposureMinor,c.maxSpendMinor].every(positive) && quietValid(c.quietHours);
  }
  async tick(): Promise<void> {
    if(this.stopped||this.running||!this.policy.enabled)return;
    this.running=true;
    try { await this.reconcile(); for(const initial of this.deps.decisions().map(d=>({...d}))) { if(this.stopped)break; try { await this.consider(initial); } catch { /* Authority/source/ledger failures never dispatch. Retry evaluation, not calls. */ } } }
    finally{this.running=false;}
  }
  private async consider(initial:CallDecision):Promise<void>{
    const p=this.policy;
    if(!this.eligible(initial,this.clock(),p.messageGraceMs)||this.history().some(a=>a.decisionId===initial.id&&a.questionVersion===initial.questionVersion))return;
    const first=await this.deps.authority.check(initial);
    if(!this.validConsent(first,this.clock()))return;
    const source=await this.deps.sourceAuthority.check(initial);
    const final=await this.deps.authority.check(initial,{version:first.consent.version,digest:first.consent.digest});
    const now=this.clock();
    if(!this.validConsent(final,now)||final.consent.id!==first.consent.id||final.consent.version!==first.consent.version||final.consent.digest!==first.consent.digest)return;
    const c=final.consent;
    if(!source||source.verified!==true||source.actionable!==true||source.urgent!==true||source.sourceContractId!==initial.sourceContractId||source.ownerId!==p.ownerId||source.decisionId!==initial.id||source.questionVersion!==initial.questionVersion||!source.revision||!Number.isFinite(source.checkedAt)||source.checkedAt>now||source.checkedAt<now-30000||!Number.isFinite(source.expiresAt)||source.expiresAt<=now||!Number.isFinite(source.usefulUntil)||source.usefulUntil<=now)return;
    const duration=Math.min(p.maxDurationSeconds,c.maxDurationSeconds);
    const exposure=c.maxExposureMinor; // Verified bound from authority; never shrink it to fit local funds.
    if(exposure>p.maxExposureMinor||quiet(now,p.quietHours)||quiet(now,c.quietHours))return;
    let attempt:CallAttempt|undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current=this.deps.decisions().find(d=>d.id===initial.id);
      const history=this.history(),used=history.filter(a=>a.status!=='rejected_preflight'&&a.ownerId===p.ownerId);
      const cooldown=Math.max(p.cooldownMs,c.cooldownMs),limit=Math.min(p.maxCallsPerDay,c.maxCallsPerDay),ceiling=Math.min(p.maxSpendMinor,c.maxSpendMinor);
      if(!this.stopped&&p.enabled&&current&&current.questionVersion===initial.questionVersion&&current.sourceContractId===initial.sourceContractId&&this.eligible(current,now,Math.max(p.messageGraceMs,c.messageGraceMs))&&source.usefulUntil>=current.deadline&&!history.some(a=>a.decisionId===current.id&&a.questionVersion===current.questionVersion)&&!used.some(a=>a.currency!==p.currency)&&used.filter(a=>a.reservedAt>now-DAY).length<limit&&!used.some(a=>a.reservedAt>now-cooldown)&&used.reduce((sum,a)=>sum+(a.usageSettlement ? (a.usageSettlement.remainingExposureMinor===null ? Math.max(a.maxExposureMinor,a.usageSettlement.confirmedTwilioMinor) : a.usageSettlement.confirmedTwilioMinor+a.usageSettlement.remainingExposureMinor) : a.maxExposureMinor),0)+exposure<=ceiling) {
        attempt={attemptId:randomUUID(),decisionId:current.id,questionVersion:current.questionVersion,sourceContractId:current.sourceContractId,sourceRevision:source.revision,ownerId:p.ownerId,recipientRef:p.recipientRef,maxDurationSeconds:duration,maxExposureMinor:exposure,currency:p.currency,consentId:c.id,consentVersion:c.version,consentDigest:c.digest,costScope:'telephone_speech_infrastructure',modelBudgetBound:false,lineageId:c.lineageId,status:'unknown',reservedAt:now,day:dayKey(now)};
        // Unknown from the instant of reservation: a crash cannot make this eligible again.
        this.db.prepare('INSERT INTO call_attempts VALUES(?,?,?)').run(current.id,current.questionVersion,JSON.stringify(attempt));
      }
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
    if(!attempt)return;
    let result:CallDispatchResult;
    try{result=await this.deps.dispatcher.dispatch(attempt);}catch{return;}
    if(result?.status==='accepted'&&typeof result.providerCallId==='string'&&result.providerCallId){attempt.status='accepted';attempt.providerCallId=result.providerCallId;}
    else if(result?.status==='rejected_preflight')attempt.status='rejected_preflight';
    this.db.prepare('UPDATE call_attempts SET body=? WHERE decision_id=? AND question_version=?').run(JSON.stringify(attempt),attempt.decisionId,attempt.questionVersion);
  }
}
