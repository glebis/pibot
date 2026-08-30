import { Bot, type Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
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

export function assertCallbackData(action: string): string {
  if (action.length <= 64) return action;
  if (process.env.NODE_ENV !== "production") {
    throw new Error(`callback_data exceeds 64 bytes: ${action.length} chars — "${action.slice(0, 40)}…" (Telegram limit is 64 bytes; collisions on truncate)`);
  }
  console.warn(`[telegram] callback_data truncated: ${action.length} → 64 bytes — "${action.slice(0, 40)}…"`);
  return action.slice(0, 64);
}

function keyboard(card: Card | undefined) {
  if (!card?.buttons.length) return undefined;
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < card.buttons.length; i += 2) {
    rows.push(
      card.buttons.slice(i, i + 2).map((b): InlineKeyboardButton =>
        b.url
          ? { text: b.label, url: b.url }
          : { text: b.label, callback_data: assertCallbackData(b.action) }
      )
    );
  }
  return { inline_keyboard: rows };
}

/**
 * Telegram transport via grammY long polling.
 * Closed by default: empty allowlist denies all (pairing help);
 * set PIBOT_TELEGRAM_OPEN=1 to restore open behavior (opt-in).
 * Each chat picks its agent with /agent.
 */
export class TelegramTransport implements Transport {
  readonly name: string;
  readonly boundAgentId?: string;
  private bot: Bot;
  private allowed: Set<string>;
  private openWhenEmpty: boolean;
  private me?: { id: number; username?: string; first_name: string; can_manage_bots?: boolean };
  private lastCallbackQuery?: { id: string; data?: string };
  private onMessageCb: ((text: string, chatId: string) => Promise<void>) | null = null;
  private onActionCb: ((action: string, chatId: string) => Promise<void>) | null = null;
  private onPollAnswerCb: ((pollId: string, optionIndex: number, voterId: string) => Promise<void>) | null = null;

  constructor(token: string, allowedChats: string[], opts: { nameSuffix?: string; boundAgentId?: string; openWhenEmpty?: boolean } = {}) {
    this.bot = new Bot(token);
    this.allowed = new Set(allowedChats);
    this.openWhenEmpty = opts.openWhenEmpty ?? false;
    this.name = opts.nameSuffix ? `telegram:${opts.nameSuffix}` : "telegram";
    this.boundAgentId = opts.boundAgentId;

    this.bot.on("message:text", (ctx: Context) => {
      if (!this.check(ctx)) { void this.handleDenied(ctx); return; }
      const text = ctx.message?.text?.trim();
      if (!text || !this.onMessageCb) return;
      // fire-and-forget: agent turns can run long (ask_user blocks) — never stall polling
      void this.onMessageCb(text, String(ctx.chat?.id)).catch((e) => console.error("[telegram] message handler:", e));
    });

    this.bot.on("callback_query:data", async (ctx) => {
      console.log(`[telegram] callback received: ${ctx.callbackQuery?.data?.slice(0, 40)} at ${new Date().toISOString().slice(11, 19)}`);
      this.lastCallbackQuery = ctx.callbackQuery ?? undefined;
      if (!this.check(ctx)) { void this.handleDenied(ctx); await ctx.answerCallbackQuery().catch(() => {}); return; }
      const action = ctx.callbackQuery?.data;
      if (!action || !this.onActionCb) { await ctx.answerCallbackQuery().catch(() => {}); return; }
      // remove the buttons from the tapped message first — no double-taps, no stale clicks
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      let feedback: string | void;
      try {
        feedback = await this.onActionCb(action, String(ctx.chat?.id ?? ctx.from?.id ?? ""));
      } catch (e) {
        feedback = `⚠︎ ${e instanceof Error ? e.message : String(e)}`;
      }
      console.log(`[telegram] answering cb with feedback: ${feedback ? truncate(String(feedback), 40) : "(none)"}`);
      try {
        const ok = await ctx.answerCallbackQuery({ text: feedback ? truncate(String(feedback), 190) : undefined });
        console.log(`[telegram] cb answered (${feedback ? truncate(String(feedback), 40) : "silent"}) ok=${ok} at ${new Date().toISOString().slice(11, 19)}`);
      } catch (e) {
        console.error(`[telegram] answerCallbackQuery failed at ${new Date().toISOString().slice(11, 19)}:`, (e as Error).message ?? e);
      }
    });

    // managed-bot lifecycle (Bot API 9.6): creation / token rotation by the manager
    this.bot.use((ctx, next) => {
      const u = ctx.update as { managed_bot?: { user?: { id: number }; bot?: { id: number; username?: string; first_name?: string } } };
      if (u.managed_bot && this.onManagedBotCb) {
        const mb = u.managed_bot;
        void this.onManagedBotCb({ creatorId: String(u.managed_bot.user?.id ?? ""), botId: u.managed_bot.bot?.id ?? 0, botUsername: u.managed_bot.bot?.username, firstName: u.managed_bot.bot?.first_name }).catch(() => {});
      }
      return next();
    });

    this.bot.on("poll_answer", (ctx) => {
      const pa = ctx.pollAnswer;
      if (this.onPollAnswerCb) void this.onPollAnswerCb(pa.poll_id, pa.option_ids[0] ?? -1, String(pa.user?.id ?? "")).catch(() => {});
    });
  }

  private onManagedBotCb: ((info: { creatorId: string; botId: number; botUsername?: string; firstName?: string }) => Promise<void>) | null = null;

  /** Manager-mode flag from the last getMe */
  isManager(): boolean {
    return Boolean(this.me?.can_manage_bots);
  }

  /** Fetch a managed bot's token (manager bots only; Bot API 9.6).
   *  Telegram can 400 with "invalid user_id" for a few seconds right after a bot
   *  is created (eventual consistency) — retry transient-looking failures. */
  async getManagedBotToken(botUserId: number): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000 * attempt));
      const r = await this.bot.api.getManagedBotToken({ user_id: botUserId } as never).catch((e: unknown) => {
        lastErr = e;
        return null;
      });
      if (r) return String(r);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Restrict a managed bot to its owner (Bot API 9.6) */
  async setManagedBotAccessSettings(botUserId: number, restricted: boolean): Promise<void> {
    await fetch(`https://api.telegram.org/bot${(this.bot as unknown as { token: string }).token}/setManagedBotAccessSettings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: botUserId, is_access_restricted: restricted }),
    }).then((r) => r.json());
  }


  private check(ctx: Context): boolean {
    if (!this.allowed.size) return this.openWhenEmpty;
    return this.allowed.has(String(ctx.chat?.id ?? ""));
  }

  private async handleDenied(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? "unknown");
    if (this.boundAgentId) {
      console.warn(`[telegram:${this.boundAgentId}] blocked chat ${chatId} — sub-bot allowlist empty/closed (pairing mode). Sub-bots inherit the main bot's allowlist unless a per-agent allowedChats is set.`);
    } else {
      console.warn(`[telegram] blocked chat ${chatId} — not in allowlist (closed by default). Add TELEGRAM_ALLOWED_CHATS=${chatId} or set PIBOT_TELEGRAM_OPEN=1 to allow all.`);
    }
    const help = `⛔️ Bot not paired. Your chat id is \`${chatId}\`\n\nAdd \`TELEGRAM_ALLOWED_CHATS=${chatId}\` to your env (or set allowed chats in the dashboard) and restart.\n\nTo allow all chats (not recommended) set \`PIBOT_TELEGRAM_OPEN=1\`.`;
    try {
      const target = ctx.chat?.id ?? ctx.from?.id;
      if (target) await this.bot.api.sendMessage(target, help, { parse_mode: "Markdown" }).catch(() => {});
    } catch {
      /* ignore */
    }
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

  /** Manually answer a callback query (used by tests); toast shows when text given */
  async answerCallback(action: string, feedback: string): Promise<boolean> {
    const q = this.pendingCallbackQuery(action);
    if (!q) return false;
    try {
      const ok = await this.bot.api.answerCallbackQuery(q.id, { text: truncate(feedback, 190) });
      return ok === true;
    } catch (e) {
      console.error("[telegram] answerCallbackQuery failed:", (e as Error).message);
      return false;
    }
  }

  private pendingCallbackQuery(action: string): { id: string } | null {
    return this.lastCallbackQuery?.data === action ? this.lastCallbackQuery : null;
  }

  onManagedBot(cb: (info: { creatorId: string; botId: number; botUsername?: string; firstName?: string }) => Promise<void>): void {
    this.onManagedBotCb = cb;
  }

  async sendPoll(chatId: string, question: string, options: string[]): Promise<{ pollId: string }> {
    const msg = await this.bot.api.sendPoll(chatId, question, options, { is_anonymous: false });
    return { pollId: msg.poll?.id ?? "" };
  }

  /** Validate the token against Telegram and cache the bot identity */
  async verify(): Promise<string> {
    const me = await this.bot.api.getMe();
    this.me = me as typeof this.me;
    return me.username ? `@${me.username}` : me.first_name;
  }

  managerMode(): boolean {
    return Boolean(this.me && (this.me as { can_manage_bots?: boolean }).can_manage_bots);
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
    if (!this.allowed.size && !this.openWhenEmpty) {
      console.warn(`[telegram] no allowlist configured — closed by default (pairing mode). Set TELEGRAM_ALLOWED_CHATS=<chatId> or PIBOT_TELEGRAM_OPEN=1 to allow all.`);
    }
    void this.bot.start({
      onStart: (me) => {
        const allowInfo = this.allowed.size ? [...this.allowed].join(",") : this.openWhenEmpty ? "any (open)" : "none (pairing mode — closed)";
        console.log(`[telegram] polling as @${me.username} · allowed chats: ${allowInfo}`);
      },
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private keyboardSent = new Set<string>();

  private static QUICK_KEYBOARD = {
    keyboard: [
      [{ text: "😴 Snooze 1h" }, { text: "😴 Until morning" }],
      [{ text: "☀️ Wake" }, { text: "📋 Status" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };

  async push(chatId: string, opts: PushOptions): Promise<void> {
    const text = truncate(opts.text, TG_LIMIT) + (opts.text.length > TG_LIMIT ? "\n\n…(truncated)" : "");
    // first message in a chat attaches the persistent quick-action keyboard
    if (!this.keyboardSent.has(chatId) && !opts.card) {
      this.keyboardSent.add(chatId);
      await this.bot.api.sendMessage(chatId, toTelegramHtml(text), {
        parse_mode: "HTML",
        reply_markup: TelegramTransport.QUICK_KEYBOARD,
      });
      return;
    }
    if (!this.keyboardSent.has(chatId)) this.keyboardSent.add(chatId); // card already carried markup; keyboard next time
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