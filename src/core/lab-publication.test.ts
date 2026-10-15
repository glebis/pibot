import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LabPublicationSync } from './lab-publication.js';

describe('published lab posts', () => {
  let root: string; let sync: LabPublicationSync;
  const write = (file: string, value: unknown) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); };
  const meeting = (extra = {}) => ({ number: '01', title: 'Занятие', summary_md: 'Public source summary', has_content: true, publication_status: 'published', published_at: '2026-10-10T12:00:00Z', ...extra });
  const feed = (meetings: unknown[] = [meeting()], extra = {}) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ cohort: 'goal-driven-ai-01', meetings, ...extra }))));
  const lessons = () => fs.existsSync(path.join(root, 'lessons')) ? fs.readdirSync(path.join(root, 'lessons')) : [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-publication-')); sync = new LabPublicationSync(root);
    write('participants.json', { participants: [{ key: 'alice', identity_status: 'confirmed', telegram_user_id: '42' }, { key: 'bob', identity_status: 'confirmed', telegram_user_id: '43' }] });
    write('participants/alice/homework.md', 'Alice unique task'); write('participants/bob/homework.md', 'Bob unique task');
  });
  afterEach(() => vi.unstubAllGlobals());
  it('publishes isolated complete files and is idempotent', async () => {
    feed(); await sync.sync(); expect(lessons()).toHaveLength(1);
    const base = path.join(root, 'lessons', lessons()[0]);
    const alice = fs.readFileSync(path.join(base, 'participants/alice/recommendations.md'), 'utf8');
    const bob = fs.readFileSync(path.join(base, 'participants/bob/recommendations.md'), 'utf8');
    expect(alice).toContain('Alice unique task'); expect(alice).not.toContain('Bob unique task'); expect(alice).not.toContain('Public source summary');
    expect(bob).toContain('Bob unique task'); expect(bob).not.toContain('Alice unique task');
    expect(fs.readFileSync(path.join(base, 'transcript.md'), 'utf8')).toBe('Public source summary');
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ status: 'finalized', approved: true, source_kind: 'published-lesson-post', recipient_files: { alice: 'participants/alice/recommendations.md', bob: 'participants/bob/recommendations.md' } });
    const modified = fs.statSync(path.join(base, 'manifest.json')).mtimeMs; await sync.sync(); expect(fs.statSync(path.join(base, 'manifest.json')).mtimeMs).toBe(modified);
  });
  it('does not infer publication from plans or videos', async () => {
    feed([meeting({ publication_status: 'draft', video_url: 'https://youtu.be/abc', summary_md: 'План занятия' }), meeting({ number: '02', publication_status: undefined })]);
    await sync.sync(); expect(lessons()).toEqual([]);
  });
  it('rejects wrong cohort, invalid dates and empty source', async () => {
    feed(undefined, { cohort: 'other' }); await sync.sync(); expect(lessons()).toEqual([]);
    feed([meeting({ published_at: 'tomorrow' }), meeting({ summary_md: '' }), meeting({ number: '../' })]); await sync.sync(); expect(lessons()).toEqual([]);
  });
  it('missing homework leaves no manifest', async () => {
    feed(); fs.renameSync(path.join(root, 'participants/bob/homework.md'), path.join(root, 'participants/bob/removed.md')); await sync.sync(); expect(lessons()).toEqual([]);
  });
  it('never truncates a long personal task', async () => {
    feed(); write('participants/alice/homework.md', 'x'.repeat(4090)); await sync.sync(); expect(lessons()).toEqual([]);
  });
  it('rejects traversal identities and duplicate Telegram identities', async () => {
    feed(); write('participants.json', { participants: [{ key: '../bob', identity_status: 'confirmed', telegram_user_id: '42' }] }); await sync.sync(); expect(lessons()).toEqual([]);
    write('participants.json', { participants: [{ key: 'alice', identity_status: 'confirmed', telegram_user_id: '42' }, { key: 'bob', identity_status: 'confirmed', telegram_user_id: 42 }] }); await sync.sync(); expect(lessons()).toEqual([]);
  });
  it('rejects symlink sources', async () => {
    feed(); fs.renameSync(path.join(root, 'participants/alice/homework.md'), path.join(root, 'alice-real.md')); fs.symlinkSync(path.join(root, 'alice-real.md'), path.join(root, 'participants/alice/homework.md')); await sync.sync(); expect(lessons()).toEqual([]);
  });
  it('quietly skips HTTP failure and oversize responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 }))); await expect(sync.sync()).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)))); await sync.sync(); expect(lessons()).toEqual([]);
  });
});
