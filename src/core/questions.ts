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
    }
  ) {}

  async ask(agentId: string, chat: ChatRef, spec: QuestionSpec): Promise<QuestionAnswer | null> {
    const chatKey = `${chat.transport}:${chat.chatId}`;
    // one pending question per chat
    if ([...this.pending.values()].some((p) => p.chatKey === chatKey)) return null;

    const qid = uid("q", 6);
    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 600e3, 5e3), 23 * 3600e3);

    const answer = await new Promise<QuestionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(qid);
        resolve({ choice: "", index: -1, via: "button", timedOut: true });
      }, timeoutMs);
      this.pending.set(qid, { qid, agentId, chatKey, spec, resolve, timer });

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

  /** Inline-keyboard tap */
  resolveCallback(action: string): boolean {
    if (!action.startsWith("q:")) return false;
    const [, qid, idxStr] = action.split(":");
    const p = this.pending.get(qid);
    if (!p) return false;
    const idx = parseInt(idxStr, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.spec.options.length) return false;
    this.finish(qid, { choice: p.spec.options[idx], index: idx, via: "button" });
    return true;
  }

  /** Telegram poll vote */
  resolvePoll(pollId: string, optionIndex: number): boolean {
    const qid = this.pollMap.get(pollId);
    if (!qid) return false;
    this.pollMap.delete(pollId);
    const p = this.pending.get(qid);
    if (!p || optionIndex < 0 || optionIndex >= p.spec.options.length) return false;
    this.finish(qid, { choice: p.spec.options[optionIndex], index: optionIndex, via: "poll" });
    return true;
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

  private finish(qid: string, answer: QuestionAnswer): void {
    const p = this.pending.get(qid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(qid);
    p.resolve(answer);
  }
}