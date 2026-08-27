import { Bot, type Context } from "grammy";
import type { Card, PushOptions, Transport } from "../core/types.js";
import { truncate } from "../core/util.js";

const TG_LIMIT = 4000;

const BOT_COMMANDS = [
  { command: "help", description: "What pibot can do" },
  { command: "status", description: "Rhythm, snooze, next item" },
  { command: "agents", description: "List your agents" },
  { command: "agent", description: "Switch agent: /agent coach" },
  { command: "newagent", description: "Create an agent: /newagent coach <persona>" },
  { command: "schedules", description: "Pending scheduled items" },
  { command: "snooze", description: "Pause the rhythm: /snooze 2h" },
  { command: "wake", description: "Resume the rhythm" },
  { command: "skills", description: "Agent's skills" },
  { command: "evolve", description: "Run a skill-evolution cycle" },
  { command: "promises", description: "Open promises" },
];

function toTelegramHtml(text: string): string {
  // Minimal, safe markdown→HTML: **bold**, *italic*, `code`. Everything else escaped.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = esc(text);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return out;
}

function keyboard(card: Card | undefined) {
  if (!card?.buttons.length) return undefined;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < card.buttons.length; i += 2) {
    rows.push(card.buttons.slice(i, i + 2).map((b) => ({ text: b.label, callback_data: b.action.slice(0, 64) })));
  }
  return { inline_keyboard: rows };
}

/**
 * Telegram transport via grammY long polling.
 * Any chat that can see the bot can talk (optionally locked to
 * TELEGRAM_ALLOWED_CHATS). Each chat picks its agent with /agent.
 */
export class TelegramTransport implements Transport {
  readonly name = "telegram";
  private bot: Bot;
  private allowed: Set<string>;
  private me?: { id: number; username?: string; first_name: string };
  private onMessageCb: ((text: string, chatId: string) => Promise<void>) | null = null;
  private onActionCb: ((action: string, chatId: string) => Promise<void>) | null = null;
  private onPollAnswerCb: ((pollId: string, optionIndex: number, voterId: string) => Promise<void>) | null = null;

  constructor(token: string, allowedChats: string[]) {
    this.bot = new Bot(token);
    this.allowed = new Set(allowedChats);

    this.bot.on("message:text", (ctx: Context) => {
      if (!this.check(ctx)) return;
      const text = ctx.message?.text?.trim();
      if (!text || !this.onMessageCb) return;
      // fire-and-forget: agent turns can run long (ask_user blocks) — never stall polling
      void this.onMessageCb(text, String(ctx.chat?.id)).catch((e) => console.error("[telegram] message handler:", e));
    });

    this.bot.on("callback_query:data", async (ctx) => {
      if (!this.check(ctx)) { await ctx.answerCallbackQuery().catch(() => {}); return; }
      const action = ctx.callbackQuery?.data;
      if (!action || !this.onActionCb) { await ctx.answerCallbackQuery().catch(() => {}); return; }
      let feedback: string | void;
      try {
        feedback = await this.onActionCb(action, String(ctx.chat?.id ?? ctx.from?.id ?? ""));
      } catch (e) {
        feedback = `⚠︎ ${e instanceof Error ? e.message : String(e)}`;
      }
      await ctx
        .answerCallbackQuery({ text: feedback ? truncate(String(feedback), 190) : undefined })
        .then((ok) => {
          if (!feedback) return;
          console.log(`[telegram] cb answered (${feedback.slice(0, 40)}) ok=${ok}`);
        })
        .catch((e) => console.error("[telegram] answerCallbackQuery failed:", e.message ?? e));
    });

    this.bot.on("poll_answer", (ctx) => {
      const pa = ctx.pollAnswer;
      if (this.onPollAnswerCb) void this.onPollAnswerCb(pa.poll_id, pa.option_ids[0] ?? -1, String(pa.user?.id ?? "")).catch(() => {});
    });
  }

  private check(ctx: Context): boolean {
    if (!this.allowed.size) return true;
    return this.allowed.has(String(ctx.chat?.id ?? ""));
  }

  onMessage(cb: (text: string, chatId: string) => Promise<void>): void {
    this.onMessageCb = cb;
  }

  onAction(cb: (action: string, chatId: string) => Promise<void>): void {
    this.onActionCb = cb;
  }

  onPollAnswer(cb: (pollId: string, optionIndex: number, voterId: string) => Promise<void>): void {
    this.onPollAnswerCb = cb;
  }

  async sendPoll(chatId: string, question: string, options: string[]): Promise<{ pollId: string }> {
    const msg = await this.bot.api.sendPoll(chatId, question, options, { is_anonymous: false });
    return { pollId: msg.poll?.id ?? "" };
  }

  /** Validate the token against Telegram and cache the bot identity */
  async verify(): Promise<string> {
    const me = await this.bot.api.getMe();
    this.me = me;
    return me.username ? `@${me.username}` : me.first_name;
  }

  botUsername(): string | undefined {
    return this.me?.username;
  }

  async start(): Promise<void> {
    await this.bot.init();
    this.me = this.bot.botInfo;
    void this.bot.api
      .setMyCommands(BOT_COMMANDS)
      .then(() => console.log("[telegram] command menu registered"))
      .catch((e) => console.error("[telegram] setMyCommands failed:", e.message));
    void this.bot.start({
      onStart: (me) => console.log(`[telegram] polling as @${me.username} · allowed chats: ${this.allowed.size ? [...this.allowed].join(",") : "any"}`),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async push(chatId: string, opts: PushOptions): Promise<void> {
    const text = truncate(opts.text, TG_LIMIT) + (opts.text.length > TG_LIMIT ? "\n\n…(truncated)" : "");
    await this.bot.api.sendMessage(chatId, toTelegramHtml(text), {
      parse_mode: "HTML",
      reply_markup: keyboard(opts.card),
    });
  }

  async notifyError(chatId: string, message: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, `⚠︎ ${truncate(message, 500)}`).catch(() => {});
  }

  setTyping(chatId: string, on: boolean): void {
    if (on) void this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }
}