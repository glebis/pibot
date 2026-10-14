import { describe, expect, it, vi } from 'vitest';
import { CoordinatorTelegramSender } from './telegram-sender.js';
const message = { attemptId: 'attempt-1', recipient: { botId: '123', chatId: '456', userId: '456' }, text: 'A decision is ready.', controls: [{ label: 'Seen', token: 'abc' }] };
describe('coordinator direct Telegram sender', () => {
  it('returns provider identity and binds opaque controls', async () => {
    const http = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 456 } } })));
    expect(await new CoordinatorTelegramSender('123:test-token', '123', http).send(message)).toEqual({ status: 'accepted', messageId: '42' });
    expect(JSON.parse((http.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).reply_markup.inline_keyboard[0][0].callback_data).toBe('pc:abc');
  });
  it('does not retry rejected, malformed or uncertain sends', async () => {
    for (const result of [new Response(JSON.stringify({ ok: false }), { status: 429 }), new Response('bad', { status: 502 }), new Error('private credential should never escape')]) {
      const http = vi.fn(async () => { if (result instanceof Error) throw result; return result; });
      const outcome = await new CoordinatorTelegramSender('123:test-token', '123', http).send(message);
      expect(outcome.status).toBe(result instanceof Response && result.status === 429 ? 'rejected' : 'unknown');
      expect(http).toHaveBeenCalledTimes(1); expect(JSON.stringify(outcome)).not.toContain('credential');
    }
  });
  it('rejects account or recipient mismatch without network access', async () => {
    const http = vi.fn();
    expect((await new CoordinatorTelegramSender('123:test-token', '123', http).send({ ...message, recipient: { ...message.recipient, botId: '999' } })).status).toBe('rejected');
    expect(http).not.toHaveBeenCalled();
  });
});
