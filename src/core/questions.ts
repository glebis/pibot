import type { Card, ChatRef, Transport } from "./types.js";
import { uid } from "./util.js";

export interface QuestionSpec {
  text: string;
  options: string[];
  /** ms to wait for an answer (default 10 min) */
  timeoutMs?: number;
  /** render as a Telegram poll instead of buttons */
  poll?: boolean;
}

export interface QuestionAnswer {
  choice: string;
  index: number; // -1 for free text
  via: "button" | "text" | "poll";
  timedOut?: boolean;
  /** a newer question replaced this one */
  replaced?: boolean;
}

interface PendingQuestion {
  qid: string;
  agentId: string;
  chatKey: string;
  spec: QuestionSpec;
  resolve: (a: QuestionAnswer) => void;
  timer: NodeJS.Timeout;
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
  private pollMap = new Map<string, string>(); // telegram poll_id → qid

  constructor(
    private deps: {
      getTransport: (name: string) => Transport | undefined;
      /** small confirmation push for poll votes (buttons get a toast instead) */
      notify?: (chatKey: string, text: string) => void;
    }
  ) {}

  async ask(agentId: string, chat: ChatRef, spec: QuestionSpec): Promise<QuestionAnswer | null> {
    const chatKey = `${chat.transport}:${chat.chatId}`;
    // one pending question per chat — a new question REPLACES the old one
    const previous = [...this.pending.values()].find((p) => p.chatKey === chatKey);
    if (previous) this.cancel(previous.qid, true);

    const qid = uid("q", 6);
    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 600e3, 5e3), 23 * 3600e3);

    const answer = await new Promise<QuestionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(qid);
        resolve({ choice: "", index: -1, via: "button", timedOut: true });
      }, timeoutMs);
      this.pending.set(qid, { qid, agentId, chatKey, spec, resolve, timer });
    console.log(`[questions] registered ${qid} → ${chatKey} (${spec.options.length} options, poll=${Boolean(spec.poll)})`);

      const transport = this.deps.getTransport(chat.transport);
      if (!transport) {
        clearTimeout(timer);
        this.pending.delete(qid);
        resolve({ choice: "", index: -1, via: "button", timedOut: true });
        return;
      }

      if ((spec.poll || spec.options.length > 6) && transport.sendPoll) {
        void transport
          .sendPoll(chat.chatId, spec.text, spec.options)
          .then(({ pollId }) => {
            this.pollMap.set(pollId, qid);
          })
          .catch(() => {
            // poll failed — fall back to buttons
            void transport.push(chat.chatId, { text: spec.text, card: this.cardFor(qid, spec) });
          });
      } else {
        void transport.push(chat.chatId, { text: spec.text, card: this.cardFor(qid, spec) }).catch(() => {});
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
  resolveCallback(action: string): QuestionAnswer | null {
    if (!action.startsWith("q:")) return null;
    const [, qid, idxStr] = action.split(":");
    const p = this.pending.get(qid);
    if (!p) return null;
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
   */
  answerViaText(chatKey: string, text: string): boolean {
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
    this.finish(entry.qid, { choice: text.trim(), index: -1, via: "text" });
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
    this.pending.delete(qid);
    p.resolve(answer);
  }

  /** Drop a pending question (replaced/failed delivery); resolver gets timedOut */
  private cancel(qid: string, replaced = false): void {
    const p = this.pending.get(qid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(qid);
    p.resolve({ choice: "", index: -1, via: "button", timedOut: true, replaced });
  }
}