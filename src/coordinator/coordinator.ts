import { randomBytes, randomUUID } from 'node:crypto';
import type { Authority, AuthorityCheck, Decision, DecisionInput, Mandate, ResponseInput, Sender, Attempt } from './types.js';
import { CoordinatorStore } from './store.js';
export function inQuietHours(now: number, mandate: Mandate): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  const { startMinute: start, endMinute: end } = mandate.quietHours;
  return start === end ? true : start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
export class Coordinator {
  private running = false;
  private stopped = false;
  stop(): void { this.stopped = true; }
  private clock: () => number;
  constructor(private deps: { store: CoordinatorStore; authority: Authority; sender: Sender; clock?: () => number }) { this.clock = deps.clock ?? Date.now; }
  create(input: DecisionInput): Decision {
    if (!input.sourceContractId || !input.question.trim() || input.question.length > 2500 || input.choices.length < 1 || input.choices.length > 5 || input.choices.some(c => !c.trim() || c.length > 50) || new Set(input.choices).size !== input.choices.length || !Number.isFinite(input.deadline) || input.deadline <= this.clock() || Object.values(input.recipient).some(v => !v)) throw new Error('Invalid bounded decision');
    return this.deps.store.transaction(() => {
      const id = input.id ?? randomUUID(); if (this.deps.store.get(id)) throw new Error('Decision already exists');
      if (this.deps.store.decisions().some(d => d.sourceContractId === input.sourceContractId && d.state === 'open')) throw new Error('Source already has an open decision');
      const d: Decision = { ...input, id, questionVersion: 1, stateSeq: 1, answerRevision: 0, state: 'open', attention: 'pending', attentionUntil: 0 };
      this.deps.store.save(d); this.plan(d, false); return d;
    });
  }
  inspect(): { decisions: Decision[]; attempts: Attempt[]; paused: boolean } { return { decisions: this.deps.store.decisions(), attempts: this.deps.store.attempts(), paused: this.deps.store.dispatchPaused() }; }
  private plan(d: Decision, retry: boolean): void { this.deps.store.saveAttempt({ id: `${this.deps.store.epoch}:${randomUUID()}`, decisionId: d.id, questionVersion: d.questionVersion, status: 'planned', retry, ownerId: d.ownerId, createdAt: this.clock() }); }
  respond(input: ResponseInput): { status: 'applied' | 'duplicate' | 'stale' | 'denied' | 'ambiguous'; decision?: Decision } {
    return this.deps.store.transaction(() => {
      const db = this.deps.store.db;
      if (db.prepare('SELECT id FROM inbox WHERE id=?').get(input.eventId)) return { status: 'duplicate' };
      const control = this.deps.store.resolveControl(input.token); const d = control && this.deps.store.get(control.decisionId);
      let status: 'applied' | 'stale' | 'denied' | 'ambiguous' = 'ambiguous';
      if (d && control) {
        if (this.deps.store.dispatchPaused()) status = 'denied';
        else if (Object.keys(d.recipient).some(k => d.recipient[k as keyof typeof d.recipient] !== input.recipient[k as keyof typeof input.recipient])) status = 'denied';
        else if (control.questionVersion !== d.questionVersion || d.state !== 'open' || d.deadline <= this.clock()) status = 'stale';
        else {
          const policy = db.prepare('SELECT body FROM policies WHERE id=?').get(d.mandateId); const m = policy ? JSON.parse(String(policy.body)) as Mandate : undefined;
          status = 'applied'; d.stateSeq++;
          if (control.action === 'answer') { d.state = 'answered'; d.answer = control.value; d.answerRevision++; }
          else if (control.action === 'dismiss') d.state = 'dismissed';
          else if (control.action === 'ack') { d.attention = 'acknowledged'; d.attentionUntil = Math.min(d.deadline, this.clock() + (m?.acknowledgeMs ?? 300000)); }
          else if (control.action === 'snooze') { const until = input.snoozeUntil ?? this.clock() + 900000; if (!Number.isFinite(until) || until <= this.clock() || until >= d.deadline) { status = 'denied'; d.stateSeq--; } else { d.attention = 'snoozed'; d.attentionUntil = until; } }
          if (status === 'applied') {
            d.retrySuppressed = true;
            this.deps.store.save(d); db.prepare('DELETE FROM timers WHERE decisionId=?').run(d.id);
            if (d.state === 'open') db.prepare('INSERT INTO timers VALUES(?,?,?,?,?,?)').run(randomUUID(), d.id, d.questionVersion, d.stateSeq, d.attentionUntil, 'reassess');
            for (const a of this.deps.store.attempts()) if (a.decisionId === d.id && a.status === 'planned') this.deps.store.saveAttempt({ ...a, status: 'cancelled', reason: 'Response superseded pending attention' });
          }
        }
      }
      db.prepare('INSERT INTO inbox VALUES(?,?,?)').run(input.eventId, JSON.stringify(input), status); return { status, decision: d };
    });
  }
  /** Trusted explicit correction creates a new question; stale controls cannot mutate it. */
  correct(id: string, question: string, choices: string[]): Decision {
    if (!question.trim() || question.length > 2500 || !choices.length || choices.length > 5 || choices.some(c => !c.trim() || c.length > 50)) throw new Error('Invalid correction');
    return this.deps.store.transaction(() => { const d = this.deps.store.get(id); if (!d || d.state !== 'answered' || d.deadline <= this.clock()) throw new Error('Only current answered questions can be corrected'); d.question = question; d.choices = choices; d.questionVersion++; d.stateSeq++; d.state = 'open'; d.retrySuppressed = false; delete d.answer; d.attention = 'pending'; d.attentionUntil = 0; this.deps.store.save(d); this.plan(d, false); return d; });
  }
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    if (this.deps.store.dispatchPaused()) { for (const a of this.deps.store.attempts()) if (a.status === 'planned') this.blocked(a, 'managed_restore_paused'); return; }
    this.running = true;
    try {
      this.deps.store.transaction(() => {
        const db = this.deps.store.db;
        for (const d of this.deps.store.decisions()) {
          if (d.state !== 'open' || d.deadline > this.clock()) continue;
          d.state = 'expired'; d.stateSeq++; this.deps.store.save(d);
          db.prepare('DELETE FROM timers WHERE decisionId=?').run(d.id);
          for (const a of this.deps.store.attempts()) if (a.decisionId === d.id && a.status === 'planned') this.deps.store.saveAttempt({ ...a, status: 'cancelled', reason: 'question_expired' });
        }
        for (const t of db.prepare('SELECT * FROM timers WHERE due<=?').all(this.clock())) {
          db.prepare('DELETE FROM timers WHERE id=?').run(String(t.id)); const d = this.deps.store.get(String(t.decisionId));
          if (d && d.state === 'open' && d.questionVersion === t.version && d.stateSeq === t.seq && d.deadline > this.clock()) { d.attention = 'pending'; d.stateSeq++; this.deps.store.save(d); /* Reassessment is visible; no automatic reminder burst. */ }
        }
      });
      for (const attempt of this.deps.store.attempts()) if (attempt.status === 'planned') await this.dispatch(attempt);
      // At most one explicitly approved possible duplicate per question version.
      for (const a of this.deps.store.attempts()) if (a.status === 'unknown' && !a.retry) {
        const d = this.deps.store.get(a.decisionId); const row = d && this.deps.store.db.prepare('SELECT body FROM policies WHERE id=?').get(d.mandateId); const m = row && JSON.parse(String(row.body)) as Mandate;
        if (d && a.questionVersion === d.questionVersion && !d.retrySuppressed && m && d.urgent && d.state === 'open' && d.attention === 'pending' && d.deadline > this.clock() && m.maxResends === 1 && m.retryDelayMs > 0 && this.clock() >= (a.dispatchedAt ?? a.createdAt) + m.retryDelayMs && !this.deps.store.attempts().some(x => x.decisionId === d.id && x.questionVersion === d.questionVersion && x.retry)) this.deps.store.transaction(() => this.plan(d, true));
      }
    } finally { this.running = false; }
  }
  private blocked(a: Attempt, reason: string): false {
    const current = this.deps.store.attempts().find(x => x.id === a.id);
    // A response can cancel an attempt while authority I/O is in flight.
    if (current?.status === 'planned' && current.reason !== reason) this.deps.store.saveAttempt({ ...current, reason });
    return false;
  }
  private async dispatch(a: Attempt): Promise<void> {
    let d = this.deps.store.get(a.decisionId)!;
    if (!d || d.state !== 'open' || d.questionVersion !== a.questionVersion || d.deadline <= this.clock()) { this.deps.store.saveAttempt({ ...a, status: 'cancelled', reason: 'Question no longer actionable' }); return; }
    if (d.attention !== 'pending') { this.blocked(a, 'attention_deferred'); return; }
    if (this.deps.store.dispatchPaused()) { this.blocked(a, 'managed_restore_paused'); return; }
    const check: AuthorityCheck = { mandateId: d.mandateId, ownerId: d.ownerId, coordinatorId: d.coordinatorId, ...d.recipient, purpose: 'contract_decision' };
    let reply; try { reply = await this.deps.authority.check(check); } catch { this.blocked(a, 'authority_unavailable'); return; }
    if (!reply?.allowed) { this.blocked(a, reply?.reason === 'authority_unavailable' ? 'authority_unavailable' : 'authority_denied'); return; }
    const m = reply?.mandate;
    if (!reply || reply.schemaVersion !== 1 || !reply.allowed || !m || !m.recipient || !m.quietHours || m.status !== 'active' || !Number.isFinite(m.notBefore) || !Number.isFinite(m.expiresAt) || !Number.isSafeInteger(m.version) || m.version < 1 || !Number.isSafeInteger(m.ownerCapsVersion) || m.ownerCapsVersion < 1 || !Number.isFinite(m.acknowledgeMs) || m.acknowledgeMs <= 0 || m.id !== d.mandateId || m.ownerId !== d.ownerId || m.coordinatorId !== d.coordinatorId || m.purpose !== 'contract_decision' || Object.keys(d.recipient).some(k => d.recipient[k as keyof typeof d.recipient] !== m.recipient[k as keyof typeof m.recipient]) || !Number.isSafeInteger(m.windowMs) || m.windowMs <= 0 || !Number.isSafeInteger(m.ownerWindowMs) || m.ownerWindowMs <= 0 || !Number.isSafeInteger(m.maxMessages) || m.maxMessages <= 0 || !Number.isSafeInteger(m.ownerMaxMessages) || m.ownerMaxMessages <= 0 || !m.digest || !m.lineageId || m.quietHours.timeZone !== 'Europe/Berlin' || [m.quietHours.startMinute,m.quietHours.endMinute].some(v => !Number.isInteger(v) || v < 0 || v >= 1440)) { this.blocked(a, 'authority_scope_invalid'); return; }
    try { const final = await this.deps.authority.check({ ...check, expectedVersion: m.version, expectedDigest: m.digest }); if (!final || final.schemaVersion !== 1 || !final.allowed || final.mandate?.digest !== m.digest || final.mandate.version !== m.version) { this.blocked(a, 'authority_changed_or_denied'); return; } } catch { this.blocked(a, 'authority_unavailable'); return; }
    const controls: { label: string; token: string }[] = [];
    const claimed = this.deps.store.transaction(() => {
      d = this.deps.store.get(a.decisionId)!; const now = this.clock();
      if (this.stopped) return this.blocked(a, 'dispatcher_stopped');
      if (this.deps.store.dispatchPaused()) return this.blocked(a, 'managed_restore_paused');
      if (!d || d.state !== 'open' || d.attention !== 'pending' || d.questionVersion !== a.questionVersion || d.deadline <= now) return this.blocked(a, 'question_no_longer_actionable');
      if (now < m.notBefore || now >= m.expiresAt) return this.blocked(a, 'mandate_outside_validity');
      if (inQuietHours(now,m)) return this.blocked(a, 'quiet_hours');
      if (a.retry && (d.retrySuppressed || !d.urgent || m.maxResends !== 1 || m.retryDelayMs <= 0)) return this.blocked(a, 'retry_not_authorized');
      const used = this.deps.store.attempts().filter(x => x.dispatchedAt != null);
      if (used.filter(x => x.lineageId === m.lineageId && x.dispatchedAt! > now-m.windowMs).length >= m.maxMessages) return this.blocked(a, 'lineage_rate_limit');
      if (used.filter(x => x.ownerId === m.ownerId && x.dispatchedAt! > now-m.ownerWindowMs).length >= m.ownerMaxMessages) return this.blocked(a, 'owner_rate_limit');
      this.deps.store.db.prepare('INSERT OR REPLACE INTO policies VALUES(?,?)').run(m.id,JSON.stringify(m));
      for (const [action,value,label] of [...d.choices.map(c => ['answer',c,c]), ['ack','','Seen'], ['snooze','','Snooze 15 min'], ['dismiss','','Dismiss']]) {
        const token = randomBytes(12).toString('hex'); this.deps.store.db.prepare('INSERT INTO controls VALUES(?,?,?,?,?)').run(token,d.id,d.questionVersion,action!,value!); controls.push({ token,label:label! });
      }
      a = { ...a,reason:undefined,status:'dispatching',dispatchedAt:now,lineageId:m.lineageId }; this.deps.store.saveAttempt(a); return true;
    });
    if (!claimed) return;
    let outcome; try { outcome = await this.deps.sender.send({ attemptId:a.id,recipient:d.recipient,text:`${a.retry ? 'Possible duplicate.\n' : ''}${d.question}`,controls }); } catch { outcome = { status:'unknown' as const,reason:'Sender threw; acceptance uncertain' }; }
    this.deps.store.transaction(() => this.deps.store.saveAttempt({ ...a,...outcome }));
  }
}
