import { describe, expect, it } from 'vitest';
import { Bot, type Transformer } from 'grammy';
import { captureBeforePollingCursor } from './telegram-ingress.js';

describe('real grammY polling cursor integration', () => {
  it('captures the received batch before stop acknowledges it, and captures the final stop batch', async () => {
    const bot = new Bot('123:test-token', { botInfo: { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } });
    const events: string[] = [];
    let receivedMiddleware!: () => void;
    const middlewareStarted = new Promise<void>(resolve => { receivedMiddleware = resolve; });
    let releaseMiddleware!: () => void;
    const middlewareBlocked = new Promise<void>(resolve => { releaseMiddleware = resolve; });
    let requests = 0;
    const transport = (async (_previous: unknown, method: string, payload: { offset?: number; limit?: number }) => {
      if (method === 'deleteWebhook') return { ok: true, result: true };
      if (method !== 'getUpdates') throw new Error('Unexpected API method; network is forbidden in this test');
      requests++;
      events.push(`request:${payload.offset}`);
      if (requests === 1) return { ok: true, result: [{ update_id: 9 }] };
      expect(payload).toEqual({ offset: 10, limit: 1 });
      expect(events).toContain('capture:9');
      return { ok: true, result: [{ update_id: 10 }] };
    }) as Transformer;
    bot.api.config.use(transport);
    bot.api.config.use(captureBeforePollingCursor({
      captureBatch(updates) { for (const update of updates) events.push(`capture:${(update as { update_id: number }).update_id}`); },
      handle: async () => false,
    }));
    bot.use(async ctx => { events.push(`middleware:${ctx.update.update_id}`); receivedMiddleware(); await middlewareBlocked; });
    const polling = bot.start();
    try {
      await middlewareStarted;
      await bot.stop();
      expect(events.indexOf('capture:9')).toBeLessThan(events.indexOf('middleware:9'));
      expect(events.indexOf('capture:9')).toBeLessThan(events.indexOf('request:10'));
      expect(events).toContain('capture:10');
      expect(requests).toBe(2);
      expect(events).not.toContain('middleware:10');
    } finally { releaseMiddleware(); await polling; }
  });
});
