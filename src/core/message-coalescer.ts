import type { ReplyContext } from "./types.js";

/** One ready-to-run agent turn assembled from a rapid-fire burst. */
export interface CoalescedTurn {
  /** chat key (`transport:chatId`) the burst belongs to */
  key: string;
  agentId: string;
  /** all burst texts joined with "\n" (Verity message_buffer semantics) */
  text: string;
  /** reply context of the FIRST message — it anchors the burst */
  reply?: ReplyContext;
  /** message id of the LAST message — acks/reactions thread there */
  messageId?: number;
  /** how many messages were combined (for logging) */
  parts: number;
}

/**
 * Combine texts arriving with very little delay (forwarded selections,
 * rapid-fire typing, split messages) into a single agent turn instead of
 * queueing each as its own turn. Modeled on Verity's message_buffer.py
 * (bead pibot-2dh): wait `windowMs` after the LAST arrival per chat, then
 * hand over everything joined with "\n".
 *
 * The dispatcher feeds only free-form texts here: slash commands, quick
 * actions, pending-question answers and media turns are handled or flagged
 * earlier, so they bypass the buffer by construction. Each buffered
 * message is still captured to the inbox/history individually by the
 * transport wiring — only the agent turn is combined.
 */
export class MessageCoalescer {
  static readonly DEFAULT_MAX_PARTS = 12;

  private buffers = new Map<
    string,
    {
      agentId: string;
      parts: string[];
      reply?: ReplyContext;
      messageId?: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    /** wait this long after the last arrival before flushing */
    private readonly windowMs: number,
    /** force-flush guard: never hold more than this many parts */
    private readonly maxParts: number = MessageCoalescer.DEFAULT_MAX_PARTS,
    /** delivers one joined turn; may be called synchronously from admit */
    private readonly flush: (turn: CoalescedTurn) => void,
  ) {}

  /**
   * Offer one free-form text. Everything is buffered (Verity parity); the
   * buffer flushes `windowMs` after the last arrival, or immediately when
   * `maxParts` is reached.
   */
  admit(args: { key: string; agentId: string; text: string; reply?: ReplyContext; messageId?: number }): void {
    const existing = this.buffers.get(args.key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.parts.push(args.text);
      if (existing.reply === undefined) existing.reply = args.reply;
      existing.messageId = args.messageId ?? existing.messageId;
      existing.timer = this.schedule(args.key);
      if (existing.parts.length >= this.maxParts) this.flushKey(args.key);
      return;
    }
    const timer = this.schedule(args.key);
    this.buffers.set(args.key, {
      agentId: args.agentId,
      parts: [args.text],
      reply: args.reply,
      messageId: args.messageId,
      timer,
    });
    if (this.maxParts <= 1) this.flushKey(args.key);
  }

  /** Cancel every pending flush (tests, shutdown). Delivered turns stay delivered. */
  dispose(): void {
    for (const entry of this.buffers.values()) clearTimeout(entry.timer);
    this.buffers.clear();
  }

  private schedule(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.flushKey(key), this.windowMs);
  }

  private flushKey(key: string): void {
    const entry = this.buffers.get(key);
    if (!entry) return;
    this.buffers.delete(key);
    clearTimeout(entry.timer);
    this.flush({
      key,
      agentId: entry.agentId,
      text: entry.parts.join("\n"),
      reply: entry.reply,
      messageId: entry.messageId,
      parts: entry.parts.length,
    });
  }
}