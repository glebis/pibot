import { Bot, type Context } from "grammy";
import type { Card, PushOptions, Transport } from "../core/types.js";
import { truncate } from "../core/util.js";

const TG_LIMIT = 4000;

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
  private onMessageCb: ((text: string, chatId: string) => Promise<void>) | null = null;
  private onActionCb: ((action: string, chatId: string) => Promise<void>) | null = null;

  constructor(token: string, allowedChats: string[]) {
    this.bot = new Bot(token);
    this.allowed = new Set(allowedChats);

    this.bot.on("message:text", async (ctx: Context) => {
      if (!this.check(ctx)) return;
      const text = ctx.message?.text?.trim();
      if (!text || !this.onMessageCb) return;
      await this.onMessageCb(text, String(ctx.chat?.id));
    });

    this.bot.on("callback_query:data", async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      if (!this.check(ctx)) return;
      const action = ctx.callbackQuery?.data;
      if (action && this.onActionCb) await this.onActionCb(action, String(ctx.chat?.id ?? ctx.from?.id ?? ""));
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

  async start(): Promise<void> {
    await this.bot.init();
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