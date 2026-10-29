import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { TelegramTransport } from './telegram.js';

describe('public enrollment media keeps the agent gate closed', () => {
  it('hands a bounded denied-user screenshot only to the fixed public flow', async () => {
    const t = new TelegramTransport('123:test', ['1'], { nameSuffix: 'lab', boundAgentId: 'lab', memberGroups: ['-1001'], mediaDir: '/private/media' });
    const callback = vi.fn(async () => {}); t.onPublicRequest(callback); t.onPublicMediaAllowed(() => true);
    const download = vi.fn(async () => '/private/media/screenshot.jpg'); (t as any).downloadTelegramFile = download;
    const ctx = { chat: { id: 42, type: 'private' }, from: { id: 42 }, message: { photo: [{ file_id: 'photo', file_size: 4000 }], caption: 'proof' } } as unknown as Context;
    await (t as any).handleDenied(ctx);
    expect(download).toHaveBeenCalledWith('photo', '.jpg');
    expect(callback).toHaveBeenCalledWith('42', 'proof', expect.objectContaining({ kind: 'photo', chatId: '42', filePath: '/private/media/screenshot.jpg' }));
    expect((t as any).allowed.has('42')).toBe(false);
  });
  it('does not download unsolicited nonmember media before enrollment begins', async () => {
    const t = new TelegramTransport('123:test', ['1'], { nameSuffix: 'lab', boundAgentId: 'lab', memberGroups: ['-1001'], mediaDir: '/private/media' });
    const callback = vi.fn(async () => {}); t.onPublicRequest(callback); t.onPublicMediaAllowed(() => false);
    const download = vi.fn(); (t as any).downloadTelegramFile = download; (t as any).push = vi.fn(async () => {});
    await (t as any).handleDenied({ chat: { id: 42, type: 'private' }, from: { id: 42 }, message: { voice: { file_id: 'unsolicited', duration: 10, file_size: 10000 } } });
    expect(download).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  });
  it('blocks oversized public media before download and never routes a group screenshot', async () => {
    const t = new TelegramTransport('123:test', ['1'], { nameSuffix: 'lab', boundAgentId: 'lab', memberGroups: ['-1001'], mediaDir: '/private/media' });
    const callback = vi.fn(async () => {}); t.onPublicRequest(callback);
    const download = vi.fn(); (t as any).downloadTelegramFile = download; (t as any).push = vi.fn(async () => {});
    await (t as any).handleDenied({ chat: { id: 42, type: 'private' }, from: { id: 42 }, message: { photo: [{ file_id: 'huge', file_size: 21 * 1024 * 1024 }] } });
    await (t as any).handleDenied({ chat: { id: -42, type: 'supergroup' }, from: { id: 42 }, message: { photo: [{ file_id: 'photo' }] } });
    expect(download).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  });
});
