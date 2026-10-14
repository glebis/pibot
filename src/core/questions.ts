import { createHash } from 'node:crypto';
import type { Card, ChatRef, Transport } from "./types.js";
import { uid } from "./util.js";

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
  resolve: (a: QuestionAnswer) => void;
  timer: NodeJS.Timeout;
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
  private accepted(qid:string):void {const p=this.pending.get(qid);if(!p||p.snapshot.acceptedMessageAt!==undefined)return;p.snapshot.acceptedMessageAt=Date.now();this.emit(p.snapshot);}
  private pollMap = new Map<string, string>(); // telegram poll_id → qid

  constructor(
    private deps: {
      getTransport: (name: string) => Transport | undefined;
      /** small confirmation push for poll votes (buttons get a toast instead) */
      notify?: (chatKey: string, text: string) => void;
    }
  ) {}

  async ask(agentId: string, chat: ChatRef, spec: QuestionSpec): Promise<QuestionAnswer | null> {
    if(spec.usefulUntil!==undefined && (!Number.isSafeInteger(spec.usefulUntil)||spec.usefulUntil<=Date.now()||typeof spec.deadlineReason!=='string'||!spec.deadlineReason.trim()||spec.deadlineReason.length>500)) throw new Error('Explicit useful deadline requires a future timestamp and reason');
    const chatKey = `${chat.transport}:${chat.chatId}`;
    // one pending question per chat — a new question REPLACES the old one
    const previous = [...this.pending.values()].find((p) => p.chatKey === chatKey);
    if (previous) this.cancel(previous.qid, true);

    const qid = uid("q", 6);
    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 600e3, 5e3), 23 * 3600e3);

    const createdAt=Date.now();
    const snapshot:QuestionSnapshot={qid,agentId,canonicalChatId:chatKey,question:spec.text,options:[...spec.options],createdAt,pendingUntil:createdAt+timeoutMs,status:'pending',revision:'sha256:'+createHash('sha256').update(JSON.stringify({qid,agentId,chatKey,text:spec.text,options:spec.options,usefulUntil:spec.usefulUntil,deadlineReason:spec.deadlineReason})).digest('hex'),...(spec.usefulUntil!==undefined?{usefulUntil:spec.usefulUntil,deadlineReason:spec.deadlineReason!.trim(),provenance:'agent_declared_deadline' as const}:{})};
    const answer = await new Promise<QuestionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(qid);snapshot.status='expired';this.emit(snapshot);
        resolve({ choice: "", index: -1, via: "button", timedOut: true });
      }, timeoutMs);
      this.pending.set(qid, { qid, agentId, chatKey, spec, resolve, timer, snapshot });this.emit(snapshot);
    console.log(`[questions] registered ${qid} → ${chatKey} (${spec.options.length} options, poll=${Boolean(spec.poll)})`);

      const transport = this.deps.getTransport(chat.transport);
      if (!transport) {
        clearTimeout(timer);
        this.pending.delete(qid);snapshot.status='cancelled';this.emit(snapshot);
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
    const idx = parseInt(idxStr, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.spec.options.length) return null;
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
    clearTimeout(p.timer);
    this.pending.delete(qid);p.snapshot.status='answered';this.emit(p.snapshot);
    p.resolve(answer);
  }

  /** Drop a pending question (replaced/failed delivery); resolver gets timedOut */
  private cancel(qid: string, replaced = false): void {
    const p = this.pending.get(qid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(qid);p.snapshot.status=replaced?'replaced':'cancelled';this.emit(p.snapshot);
    p.resolve({ choice: "", index: -1, via: "button", timedOut: true, replaced });
  }
}