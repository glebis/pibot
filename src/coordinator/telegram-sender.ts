import type { Sender, SendInput, SendOutcome } from './types.js';

/** Exactly one HTTP invocation per attempt. No SDK retries, formatting fallback or send queue. */
export class CoordinatorTelegramSender implements Sender {
  constructor(private readonly token: string, private readonly botId: string, private readonly http: typeof fetch = fetch, private readonly timeoutMs = 10000) {
    if (!/^\d+:[^\s]+$/.test(token) || token.split(':')[0] !== botId) throw new Error('Coordinator Telegram account mismatch');
  }
  async send(input: SendInput): Promise<SendOutcome> {
    if (input.recipient.botId !== this.botId || !/^\d+$/.test(input.recipient.chatId) || input.recipient.chatId !== input.recipient.userId || !input.text.trim() || input.text.length > 3500 || input.controls.length > 10 || input.controls.some(c => !/^[A-Za-z0-9_-]{1,60}$/.test(c.token) || c.label.length > 50)) return { status: 'rejected', reason: 'invalid_message_scope' };
    try {
      const response = await this.http(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ chat_id: input.recipient.chatId, text: input.text, protect_content: true,
          reply_markup: { inline_keyboard: input.controls.map(c => [{ text: c.label, callback_data: `pc:${c.token}` }]) } }),
      });
      const data = await response.json() as { ok?: unknown; result?: { message_id?: unknown; chat?: { id?: unknown } } };
      if (data.ok === false) return { status: 'rejected', reason: 'provider_rejected' };
      if (response.ok && data.ok === true && Number.isSafeInteger(data.result?.message_id) && String(data.result?.chat?.id) === input.recipient.chatId) return { status: 'accepted', messageId: String(data.result!.message_id) };
      return { status: 'unknown', reason: 'unconfirmed_provider_response' };
    } catch { return { status: 'unknown', reason: 'transport_uncertain' }; }
  }
}
