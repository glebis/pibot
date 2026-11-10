import { createHash } from 'node:crypto';
import type { Card, ChatRef, Transport } from "./types.js";
import { uid } from "./util.js";
import { QuestionStore } from "./question-store.js";

export interface QuestionSpec {
  text: string;
  options: string[];
  /** ms to wait for an answer (default 10 min) */
  timeoutMs?: number;
  /** render as a Telegram poll instead of buttons */
  poll?: boolean;
  /** Agent-declared useful deadline, distinct from the question wait timeout. */
  usefulUntil?: number;
  deadlineReason?: string;
  /** "question" = clarifying ask_user (spoken on a live voice call); anything else blocks for an explicit tap */
  kind?: "question" | "approval";
  /**
   * For an approval question: the EXACT option label that authorizes the action. The host derives
   * approval structurally from the chosen option, never by matching English yes/no words. Absent
   * or unknown = fail closed (the answer can inform but never authorize).
   */
  approveOption?: string;
  /**
   * Stable caller-supplied identity for this question (bd pibot-jciq). A resumed
   * ask() with the same key returns the recorded answer instead of asking the
   * owner again after a restart.
   */
  questionKey?: string;
}

export interface QuestionAnswer {
  choice: string;
  index: number; // -1 for free text
  via: "button" | "text" | "poll";
  /** how the user answered: voice arrives as transcribed text (analytics modality) */
  source?: "text" | "voice";
  timedOut?: boolean;
  /** a newer question replaced this one */
  replaced?: boolean;
  /** the owner is on a live voice call: ask out loud instead; the next utterance answers */
  spoken?: boolean;
}

export interface QuestionSnapshot {
  qid:string;agentId:string;canonicalChatId:string;question:string;options:string[];
  revision:string;createdAt:number;pendingUntil:number;acceptedMessageAt?:number;
  usefulUntil?:number;deadlineReason?:string;provenance?:'agent_declared_deadline';
  status:'pending'|'answered'|'cancelled'|'expired'|'replaced';
}
interface PendingQuestion {
  qid: string;
  agentId: string;
  chatKey: string;
  spec: QuestionSpec;
  /** absent for a question restored from the journal after a restart: nobody is waiting in THIS process */
  resolve?: (a: QuestionAnswer) => void;
  timer?: NodeJS.Timeout;
  snapshot:QuestionSnapshot;
}

/**
 * Structured questions with tappable answers.
 * - ≤6 options → inline buttons under the message
 * - 7–10 → Telegram poll (if the transport supports it)
 * - a pending question intercepts the next text message in that chat
 *   (typed "1"/"2" or an option name answers; anything else is a free answer)
 */
export class QuestionBus {
  private pending = new Map<string, PendingQuestion>();
  private lifecycle=new Set<(snapshot:QuestionSnapshot)=>void>();
  subscribeLifecycle(listener:(snapshot:QuestionSnapshot)=>void):()=>void {this.lifecycle.add(listener);return ()=>{this.lifecycle.delete(listener);};}
  questionSnapshot(qid:string):QuestionSnapshot|undefined {const s=this.pending.get(qid)?.snapshot;return s?structuredClone(s):undefined;}
  pendingSnapshots():QuestionSnapshot[] {return [...this.pending.values()].map(p=>structuredClone(p.snapshot));}
  private emit(snapshot:QuestionSnapshot):void {for(const listener of this.lifecycle){try{listener(structuredClone(snapshot));}catch{/* source feed must fail closed independently, never block an owner answer */}}}
  private accepted(qid:string):void {const p=this.pending.get(qid);if(!p||p.snapshot.acceptedMessageAt!==undefined)return;p.snapshot.acceptedMessageAt=Date.now();this.deps.store?.update(qid, { acceptedMessageAt: p.snapshot.acceptedMessageAt });this.emit(p.snapshot);}
  private pollMap = new Map<string, string>(); // telegram poll_id → qid

  constructor(
    private deps: {
      getTransport: (name: string) => Transport | undefined;
      /** small confirmation push for poll votes (buttons get a toast instead) */
      notify?: (chatKey: string, text: string) => void;
      /**
       * Durable journal (bd pibot-jciq). Omitted = in-memory only, which is what
       * tests and owner-less agents get.
       */
      store?: QuestionStore;
    }
  ) { this.restore(); }

  /**
   * Re-materialise questions a previous process had already shown the owner, so a
   * tap, poll vote or typed answer that arrives after this restart is still
   * recorded instead of reported stale (bd pibot-jciq). Restored entries have no
   * resolver: their asking turn died with the old process, and the answer is kept
   * in the journal for the resumed turn to read via `answerFor`.
   */
  private restore(): void {
    for (const rec of this.deps.store?.listPending() ?? []) {
      if (this.pending.has(rec.snapshot.qid)) continue;
      this.pending.set(rec.snapshot.qid, {
        qid: rec.snapshot.qid,
        agentId: rec.snapshot.agentId,
        chatKey: rec.snapshot.canonicalChatId,
        spec: rec.spec,
        snapshot: rec.snapshot,
      });
    }
  }

  /** The durable answer for a question, whoever recorded it (used by a resumed turn). */
  answerFor(questionKey: string): QuestionAnswer | undefined {
    const rec = this.deps.store?.findByKey(questionKey);
    return rec?.answer ? { ...rec.answer } : undefined;
  }

  /** Canonical question id for a logical key, so a decision can cite the owner's actual answer. */
  qidFor(questionKey: string): string | undefined {
    return this.deps.store?.findByKey(questionKey)?.snapshot.qid;
  }

  /** Questions whose owner answered while this process was down. */
  answersRecordedOffline(): Array<{ qid: string; agentId: string; chatKey: string; questionKey?: string; answer: QuestionAnswer }> {
    return (this.deps.store?.listAnsweredOffline() ?? []).map((rec) => ({
      qid: rec.snapshot.qid,
      agentId: rec.snapshot.agentId,
      chatKey: rec.snapshot.canonicalChatId,
      ...(rec.questionKey !== undefined ? { questionKey: rec.questionKey } : {}),
      answer: { ...rec.answer! },
    }));
  }

  async ask(agentId: string, chat: ChatRef, spec: QuestionSpec): Promise<QuestionAnswer | null> {
    if(spec.usefulUntil!==undefined && (!Number.isSafeInteger(spec.usefulUntil)||spec.usefulUntil<=Date.now()||typeof spec.deadlineReason!=='string'||!spec.deadlineReason.trim()||spec.deadlineReason.length>500)) throw new Error('Explicit useful deadline requires a future timestamp and reason');
    const chatKey = `${chat.transport}:${chat.chatId}`;
    // A prior attempt of the same logical question already has an answer: after a
    // restart the asking turn resumes here, not at the owner's chat (bd pibot-jciq).
    const key = spec.questionKey?.trim();
    if (key) {
      const prior = this.deps.store?.findByKey(key);
      if (prior?.answer) return { ...prior.answer };
      const live = prior ? this.pending.get(prior.snapshot.qid) : undefined;
      // The message is already on the owner's screen and its window is still open:
      // re-attach to it rather than asking a second time. Re-attaching is what makes
      // a resumed task inherit the owner's pending decision (bd pibot-jciq).
      if (live && live.snapshot.status === "pending" && live.snapshot.pendingUntil > Date.now() && !live.resolve) {
        return await new Promise<QuestionAnswer>((resolve) => {
          live.resolve = resolve;
          live.timer = setTimeout(() => this.expire(live.snapshot.qid), Math.max(0, live.snapshot.pendingUntil - Date.now()));
        });
      }
      // The same logical question was already settled without an answer (it expired
      // while the process was down, or the owner dismissed/replaced it). Reporting the
      // timeout is the honest outcome; re-asking would buzz the owner again about a
      // question they already resolved one way or the other.
      if (prior) return { choice: "", index: -1, via: "button", timedOut: true };
    }
    // one pending question per chat — a new question REPLACES the old one
    const previous = [...this.pending.values()].find((p) => p.chatKey === chatKey);
    if (previous) this.cancel(previous.qid, true);

    const qid = uid("q", 6);
    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 600e3, 5e3), 23 * 3600e3);

    const createdAt=Date.now();
    const snapshot:QuestionSnapshot={qid,agentId,canonicalChatId:chatKey,question:spec.text,options:[...spec.options],createdAt,pendingUntil:createdAt+timeoutMs,status:'pending',revision:'sha256:'+createHash('sha256').update(JSON.stringify({qid,agentId,chatKey,text:spec.text,options:spec.options,usefulUntil:spec.usefulUntil,deadlineReason:spec.deadlineReason})).digest('hex'),...(spec.usefulUntil!==undefined?{usefulUntil:spec.usefulUntil,deadlineReason:spec.deadlineReason!.trim(),provenance:'agent_declared_deadline' as const}:{})};
    const answer = await new Promise<QuestionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.expire(qid);
        resolve({ choice: "", index: -1, via: "button", timedOut: true });
      }, timeoutMs);
      this.pending.set(qid, { qid, agentId, chatKey, spec, resolve, timer, snapshot });
      // Durable BEFORE the owner is asked: a crash between here and the push
      // leaves a recorded question, not a silently lost one.
      this.deps.store?.save({ snapshot: structuredClone(snapshot), spec: structuredClone(spec), questionKey: key, recordedAt: createdAt });
      this.emit(snapshot);
    console.log(`[questions] registered ${qid} → ${chatKey} (${spec.options.length} options, poll=${Boolean(spec.poll)})`);

      const transport = this.deps.getTransport(chat.transport);
      if (!transport) {
        clearTimeout(timer);
        this.pending.delete(qid);snapshot.status='cancelled';this.deps.store?.update(qid, { status: 'cancelled' });this.emit(snapshot);
        resolve({ choice: "", index: -1, via: "button", timedOut: true });
        return;
      }

      if ((spec.poll || spec.options.length > 6) && transport.sendPoll) {
        void transport
          .sendPoll(chat.chatId, spec.text, spec.options)
          .then(({ pollId }) => {
            if(this.pending.has(qid)){this.pollMap.set(pollId, qid);this.accepted(qid);}
          })
          .catch(() => {
            // poll failed — fall back only while this question is still live
            if(!this.pending.has(qid))return;
            void transport.push(chat.chatId, { text: spec.text, card: this.cardFor(qid, spec),dedupeKey:`question:${qid}` }).then(()=>this.accepted(qid)).catch(()=>{});
          });
      } else {
        void transport.push(chat.chatId, { text: spec.text, card: this.cardFor(qid, spec),dedupeKey:`question:${qid}` }).then(()=>this.accepted(qid)).catch(() => {});
      }
    });

    return answer;
  }

  private cardFor(qid: string, spec: QuestionSpec): Card {
    return {
      text: "",
      buttons: spec.options.map((label, i) => ({ label, action: `q:${qid}:${i}` })),
    };
  }

  /** Inline-keyboard tap — returns the recorded answer, or null if stale/unknown */
  resolveCallback(action: string, expectedChatKey?: string): QuestionAnswer | null {
    if (!action.startsWith("q:")) return null;
    const [, qid, idxStr] = action.split(":");
    const p = this.pending.get(qid);
    if (!p || (expectedChatKey !== undefined && p.chatKey !== expectedChatKey)) return null;
    // A question whose wait window closed is never answered late, even if its
    // message is still on the owner's screen.
    if (p.snapshot.status === "pending" && p.snapshot.pendingUntil <= Date.now()) {
      this.expire(qid);
      return null;
    }
    const idx = parseInt(idxStr, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.spec.options.length) return null;
    // First answer wins: a tap replayed from a previous process cannot overwrite
    // an answer already on record.
    const prior = this.deps.store?.get(qid)?.answer;
    if (prior) return { ...prior };
    const answer: QuestionAnswer = { choice: p.spec.options[idx], index: idx, via: "button" };
    console.log(`[questions] tap ${action} → resolved: ${answer.choice}`);
    this.finish(qid, answer);
    return answer;
  }

  /** Telegram poll vote */
  resolvePoll(pollId: string, optionIndex: number): QuestionAnswer | null {
    const qid = this.pollMap.get(pollId);
    if (!qid) return null;
    this.pollMap.delete(pollId);
    const p = this.pending.get(qid);
    if (!p || optionIndex < 0 || optionIndex >= p.spec.options.length) return null;
    if (p.snapshot.status === "pending" && p.snapshot.pendingUntil <= Date.now()) {
      this.expire(qid);
      return null;
    }
    const prior = this.deps.store?.get(qid)?.answer;
    if (prior) return { ...prior };
    const answer: QuestionAnswer = { choice: p.spec.options[optionIndex], index: optionIndex, via: "poll" };
    this.finish(qid, answer);
    // polls have no callback toast — push a tiny confirmation instead
    this.deps.notify?.(p.chatKey, `🗳 Noted: ${answer.choice}`);
    return answer;
  }

  /**
   * Next text message in a chat with a pending question becomes the answer.
   * "1"/"2"/… maps to options; an option name maps too; anything else is free text.
   * source marks how the answer arrived (voice arrives as transcribed text).
   */
  answerViaText(chatKey: string, text: string, source: "text" | "voice" = "text"): boolean {
    const entry = [...this.pending.values()].find((p) => p.chatKey === chatKey);
    if (!entry) return false;
    const numeric = text.trim().match(/^(\d+)$/);
    if (numeric) {
      const idx = parseInt(numeric[1], 10) - 1;
      if (idx >= 0 && idx < entry.spec.options.length) {
        this.finish(entry.qid, { choice: entry.spec.options[idx], index: idx, via: "text" });
        return true;
      }
    }
    const lower = text.trim().toLowerCase();
    const matchIdx = entry.spec.options.findIndex((o) => o.toLowerCase() === lower || lower.startsWith(o.toLowerCase()));
    if (matchIdx >= 0) {
      this.finish(entry.qid, { choice: entry.spec.options[matchIdx], index: matchIdx, via: "text" });
      return true;
    }
    // free-text answer
    this.finish(entry.qid, { choice: text.trim(), index: -1, via: "text", source });
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Abort the pending question for a chat (its resolver gets replaced:true) */
  cancelPending(chatKey: string): boolean {
    const entry = [...this.pending.values()].find((p) => p.chatKey === chatKey);
    if (!entry) return false;
    this.cancel(entry.qid, true);
    return true;
  }

  private finish(qid: string, answer: QuestionAnswer): void {
    const p = this.pending.get(qid);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    // Durable BEFORE the asking turn is woken: a crash right after the owner's tap
    // still leaves the answer on record for the resumed turn.
    this.deps.store?.recordAnswer(qid, answer, { offline: p.resolve === undefined });
    this.pending.delete(qid);p.snapshot.status='answered';this.emit(p.snapshot);
    p.resolve?.({ ...answer });
  }

  /** Mark a question expired and record it durably. */
  private expire(qid: string): void {
    const p = this.pending.get(qid);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(qid);
    p.snapshot.status = 'expired';
    this.deps.store?.update(qid, { status: 'expired' });
    this.emit(p.snapshot);
    p.resolve?.({ choice: "", index: -1, via: "button", timedOut: true });
  }

  /** Drop a pending question (replaced/failed delivery); resolver gets timedOut */
  private cancel(qid: string, replaced = false): void {
    const p = this.pending.get(qid);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(qid);p.snapshot.status=replaced?'replaced':'cancelled';
    this.deps.store?.update(qid, { status: p.snapshot.status });
    this.emit(p.snapshot);
    p.resolve?.({ choice: "", index: -1, via: "button", timedOut: true, replaced });
  }
}