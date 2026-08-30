import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Bot, type Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { Card, IncomingMedia, PushOptions, ReplyContext, Transport } from "../core/types.js";
import { truncate } from "../core/util.js";

const TG_LIMIT = 4000;
const DUPLICATE_WINDOW_MS = 30_000;
const MIN_CHAT_SEND_GAP_MS = 1_000;

export function telegramRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { error_code?: unknown; parameters?: { retry_after?: unknown } };
  if (value.error_code !== 429 || typeof value.parameters?.retry_after !== "number") return null;
  return Math.max(0, Math.min(60_000, value.parameters.retry_after * 1000));
}

/** Final transport-level backstop against accidental repeat sends. */
export class TelegramDuplicateGuard {
  private recent = new Map<string, number>();

  constructor(private readonly windowMs = DUPLICATE_WINDOW_MS, private readonly maxEntries = 512) {}

  shouldSend(chatId: string, payload: string, now = Date.now()): boolean {
    for (const [key, sentAt] of this.recent) {
      if (now - sentAt > this.windowMs) this.recent.delete(key);
    }
    const key = `${chatId}\u0000${payload}`;
    const sentAt = this.recent.get(key);
    return sentAt === undefined || now - sentAt > this.windowMs;
  }

  markSent(chatId: string, payload: string, now = Date.now()): void {
    const key = `${chatId}\u0000${payload}`;
    this.recent.delete(key);
    this.recent.set(key, now);
    while (this.recent.size > this.maxEntries) {
      const oldest = this.recent.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }
}

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

const QUOTE_MAX = 400;
const VOICE_MAX_SECONDS = 300;
const AUDIO_MAX_SECONDS = 1800;
const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024; // getFile hard limit
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Pure reply-context extraction from a raw Telegram `reply_to_message`
 * (shaped input so it's unit-testable without a live bot). Undefined when
 * the quoted message carries no text/caption worth re-anchoring to.
 */
export function replyContextFrom(
  rt: { message_id?: number; text?: string; caption?: string; from?: { id?: number; first_name?: string } } | undefined,
  selfId?: number,
): ReplyContext | undefined {
  if (!rt) return undefined;
  const quoted = (rt.text ?? rt.caption ?? "").trim();
  if (!quoted) return undefined;
  const fromSelf = selfId !== undefined && rt.from?.id === selfId;
  const sender = fromSelf ? "you" : (rt.from?.first_name?.trim() || "someone");
  return { messageId: rt.message_id ?? 0, sender, quoted: truncate(quoted, QUOTE_MAX) };
}

/** Map a media mime type to a sensible file extension (undefined if unknown). */
export function extFromMime(mime: string | undefined): string | undefined {
  const map: Record<string, string> = {
    "audio/ogg": ".ogg", "audio/opus": ".ogg", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
    "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/flac": ".flac",
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic",
    "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md",
  };
  return mime ? map[mime.toLowerCase().split(";")[0].trim()] : undefined;
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
  private onMessageCb: ((text: string, chatId: string, reply?: ReplyContext) => Promise<void>) | null = null;
  private onActionCb: ((action: string, chatId: string) => Promise<void>) | null = null;
  private onPollAnswerCb: ((pollId: string, optionIndex: number, voterId: string) => Promise<void>) | null = null;
  private duplicateGuard = new TelegramDuplicateGuard();
  private outboxByChat = new Map<string, Promise<void>>();
  private lastSentAtByChat = new Map<string, number>();

  private onMediaCb: ((media: IncomingMedia) => Promise<void>) | null = null;
  private mediaDir: string;

  constructor(token: string, allowedChats: string[], opts: { nameSuffix?: string; boundAgentId?: string; openWhenEmpty?: boolean; mediaDir?: string } = {}) {
    this.bot = new Bot(token);
    this.allowed = new Set(allowedChats);
    this.openWhenEmpty = opts.openWhenEmpty ?? false;
    this.name = opts.nameSuffix ? `telegram:${opts.nameSuffix}` : "telegram";
    this.boundAgentId = opts.boundAgentId;
    this.mediaDir = opts.mediaDir ?? "";

    this.bot.on("message:text", (ctx: Context) => {
      if (!this.check(ctx)) { void this.handleDenied(ctx); return; }
      const msg = ctx.message;
      if (!msg || !this.onMessageCb) return;
      const text = msg.text?.trim();
      if (!text) return;
      const reply = replyContextFrom(msg.reply_to_message, this.me?.id);
      // fire-and-forget: agent turns can run long (ask_user blocks) — never stall polling
      void this.onMessageCb(text, String(ctx.chat?.id), reply).catch((e) => console.error("[telegram] message handler:", e));
    });

    this.bot.on("message:voice", (ctx) => void this.handleMediaMessage(ctx, "voice").catch((e) => console.error("[telegram] voice handler:", e)));
    this.bot.on("message:audio", (ctx) => void this.handleMediaMessage(ctx, "audio").catch((e) => console.error("[telegram] audio handler:", e)));
    this.bot.on("message:photo", (ctx) => void this.handleMediaMessage(ctx, "photo").catch((e) => console.error("[telegram] photo handler:", e)));
    this.bot.on("message:document", (ctx) => void this.handleMediaMessage(ctx, "document").catch((e) => console.error("[telegram] document handler:", e)));
    // everything else the bot can't process — say so instead of dropping silently
    this.bot.on("message", async (ctx) => {
      if (!this.check(ctx)) { void this.handleDenied(ctx); return; }
      const m = ctx.message;
      const kind = m?.sticker ? "stickers" : m?.video ? "videos" : m?.video_note ? "video notes" : m?.animation ? "animations" : "this media type";
      void this.push(String(ctx.chat?.id ?? ""), { text: `I can't process ${kind} yet — send text, a voice note, a photo, or a document.` }).catch(() => {});
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
    const payload = `denied:${help}`;
    if (!this.duplicateGuard.shouldSend(chatId, payload)) return;
    try {
      const target = ctx.chat?.id ?? ctx.from?.id;
      if (target) {
        await this.sendTelegram(chatId, () => this.bot.api.sendMessage(target, help, { parse_mode: "Markdown" }));
        this.duplicateGuard.markSent(chatId, payload);
      }
    } catch {
      /* ignore */
    }
  }

  onMessage(cb: (text: string, chatId: string, reply?: ReplyContext) => Promise<void>): void {
    this.onMessageCb = cb;
  }

  onMedia(cb: (media: IncomingMedia) => Promise<void>): void {
    this.onMediaCb = cb;
  }

  /**
   * Shared media path: validate + download to mediaDir, then hand to the bot.
   */
  private async handleMediaMessage(ctx: Context, kind: IncomingMedia["kind"]): Promise<void> {
    if (!this.check(ctx)) { void this.handleDenied(ctx); return; }
    if (!this.onMediaCb) return; // bot not wired for media — ignore
    const m = ctx.message;
    if (!m) return;
    const chatId = String(ctx.chat?.id ?? "");
    if (!this.mediaDir) return; // no media dir configured — degrade to old silent behavior

    let fileId: string | undefined;
    let durationSec: number | undefined;
    let mimeType: string | undefined;
    let fileSize: number | undefined;
    let ext = ".bin";
    let resolvedKind: IncomingMedia["kind"] = kind;

    if (m.voice) {
      if (m.voice.duration > VOICE_MAX_SECONDS) {
        await ctx.reply(`Voice note is ${m.voice.duration}s — limit is ${VOICE_MAX_SECONDS}s. Split it or type it out.`);
        return;
      }
      fileId = m.voice.file_id; durationSec = m.voice.duration; mimeType = m.voice.mime_type; ext = ".ogg";
    } else if (m.audio) {
      if (m.audio.duration > AUDIO_MAX_SECONDS) {
        await ctx.reply(`Audio is ${m.audio.duration}s — limit is ${AUDIO_MAX_SECONDS}s.`);
        return;
      }
      fileId = m.audio.file_id; durationSec = m.audio.duration; mimeType = m.audio.mime_type; ext = extFromMime(m.audio.mime_type) ?? ".mp3";
    } else if (m.photo?.length) {
      fileId = m.photo.at(-1)?.file_id;
      ext = ".jpg"; // largest size is last
    } else if (m.document) {
      const mime = m.document.mime_type ?? "";
      if ((m.document.file_size ?? 0) > DOCUMENT_MAX_BYTES) {
        await ctx.reply("Document is too large (limit 20MB).");
        return;
      }
      fileId = m.document.file_id; mimeType = m.document.mime_type; fileSize = m.document.file_size;
      resolvedKind = IMAGE_MIME.has(mime) ? "photo" : "document";
      ext = extFromMime(mime)
        ?? (m.document.file_name?.includes(".") ? m.document.file_name.slice(m.document.file_name.lastIndexOf(".")) : ".bin");
    }
    if (!fileId) return;

    const reply = replyContextFrom(m.reply_to_message, this.me?.id);
    try {
      const filePath = await this.downloadTelegramFile(fileId, `${chatId}-${m.message_id}-${resolvedKind}${ext}`);
      await this.onMediaCb({ kind: resolvedKind, chatId, filePath, fileId, caption: m.caption, durationSec, mimeType, fileSize });
    } catch (e) {
      console.error("[telegram] media download failed:", e);
      await ctx.reply("Couldn't download that file — try again.").catch(() => {});
    }
  }

  /** Download a Telegram file by id into mediaDir (Telegram getFile API). */
  private async downloadTelegramFile(fileId: string, destName: string): Promise<string> {
    fs.mkdirSync(this.mediaDir, { recursive: true });
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error(`getFile returned no path for ${fileId}`);
    const url = `https://api.telegram.org/file/bot${(this.bot as unknown as { token: string }).token}/${file.file_path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
    const destPath = path.join(this.mediaDir, destName.replace(/[^\w.-]/g, "_"));
    await fsp.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return destPath;
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
    return this.enqueue(chatId, async () => {
      const text = truncate(opts.text, TG_LIMIT) + (opts.text.length > TG_LIMIT ? "\n\n…(truncated)" : "");
      const payload = JSON.stringify({ text, card: opts.card ?? null });
      if (!this.duplicateGuard.shouldSend(chatId, payload)) {
        console.warn(`[telegram] suppressed duplicate send to chat ${chatId}`);
        return;
      }
      // first plain message in a chat attaches the persistent quick-action keyboard
      if (!this.keyboardSent.has(chatId) && !opts.card) {
        await this.sendTelegram(chatId, () => this.bot.api.sendMessage(chatId, toTelegramHtml(text), {
          parse_mode: "HTML",
          reply_markup: TelegramTransport.QUICK_KEYBOARD,
        }));
        this.keyboardSent.add(chatId);
      } else {
        await this.sendTelegram(chatId, () => this.bot.api.sendMessage(chatId, toTelegramHtml(text), {
          parse_mode: "HTML",
          reply_markup: keyboard(opts.card),
        }));
      }
      this.duplicateGuard.markSent(chatId, payload);
    });
  }

  async notifyError(chatId: string, message: string): Promise<void> {
    return this.enqueue(chatId, async () => {
      const text = `⚠︎ ${truncate(message, 500)}`;
      if (!this.duplicateGuard.shouldSend(chatId, text)) return;
      try {
        await this.sendTelegram(chatId, () => this.bot.api.sendMessage(chatId, text));
        this.duplicateGuard.markSent(chatId, text);
      } catch {
        // Error notices are best effort; a failed attempt remains eligible for retry.
      }
    });
  }

  private enqueue(chatId: string, send: () => Promise<void>): Promise<void> {
    const previous = this.outboxByChat.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(send);
    this.outboxByChat.set(chatId, current);
    void current.finally(() => {
      if (this.outboxByChat.get(chatId) === current) this.outboxByChat.delete(chatId);
    }).catch(() => {});
    return current;
  }

  private async sendTelegram(chatId: string, send: () => Promise<unknown>): Promise<void> {
    const waitMs = MIN_CHAT_SEND_GAP_MS - (Date.now() - (this.lastSentAtByChat.get(chatId) ?? 0));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      await send();
    } catch (error) {
      const retryAfterMs = telegramRetryAfterMs(error);
      if (retryAfterMs == null) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      await send();
    }
    this.lastSentAtByChat.set(chatId, Date.now());
  }

  setTyping(chatId: string, on: boolean): void {
    if (on) void this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }
}
