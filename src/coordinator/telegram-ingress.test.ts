import { describe, expect, it, vi } from 'vitest';
import { captureBeforePollingCursor } from './telegram-ingress.js';
describe('capture before polling acknowledgement', () => {
  it('never exposes a batch when durable capture fails', async () => {
    const batch = { ok: true, result: [{ update_id: 9, callback_query: { data: 'pc:a' } }] };
    const captureBatch = vi.fn(() => { throw new Error('disk full'); });
    const transform = captureBeforePollingCursor({ captureBatch, handle: async () => true });
    await expect((transform as any)(async () => batch, 'getUpdates', { offset: 5 })).rejects.toThrow('disk full');
    expect(captureBatch).toHaveBeenCalledWith(batch.result);
  });
  it('also captures the final getUpdates used during stop', async () => {
    const captureBatch = vi.fn(); const transform = captureBeforePollingCursor({ captureBatch, handle: async () => true });
    const batch = { ok: true, result: [{ update_id: 10 }] };
    expect(await (transform as any)(async () => batch, 'getUpdates', { offset: 10, limit: 1 })).toBe(batch);
    expect(captureBatch).toHaveBeenCalledTimes(1);
  });
});
