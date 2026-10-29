import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const COHORT = 'goal-driven-ai-01';
const SITE = 'https://agency-lab.glebkalinin.com';
const LIMIT = 2 * 1024 * 1024;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Public published posts become local, reviewable personal compositions. Never sends. */
export class LabPublicationSync {
  private root: string;
  private busy = false;
  constructor(root: string) { this.root = path.resolve(root); }
  private safe(relative: string): string {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(s => !s || s === '.' || s === '..')) throw new Error('Invalid path');
    const target = path.resolve(this.root, relative);
    if (!target.startsWith(this.root + path.sep)) throw new Error('Invalid path');
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error('Invalid root');
    let cursor = this.root;
    for (const segment of path.relative(this.root, target).split(path.sep)) {
      cursor = path.join(cursor, segment);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Invalid path'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return target;
  }
  private read(relative: string): string {
    const file = this.safe(relative); const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid source');
    return fs.readFileSync(file, 'utf8');
  }
  private write(relative: string, text: string): void {
    const file = this.safe(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.safe(relative);
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  }
  async sync(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.run(); } catch { /* Fail closed; never log private participant data or response bodies. */ }
    finally { this.busy = false; }
  }
  private async run(): Promise<void> {
    const response = await fetch(`${SITE}/api/curriculum/${COHORT}.json`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > LIMIT) return;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > LIMIT) { await reader.cancel(); return; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const feed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (feed.cohort !== COHORT || !Array.isArray(feed.meetings)) return;
    const registry = JSON.parse(this.read('participants.json'));
    if (!Array.isArray(registry.participants)) return;
    const profiles = registry.participants.filter((p: any) => p.identity_status === 'confirmed');
    if (!profiles.length || profiles.some((p: any) => typeof p.key !== 'string' || !KEY.test(p.key) || !/^[1-9]\d*$/.test(String(p.telegram_user_id)))) return;
    if (new Set(profiles.map((p: any) => p.key)).size !== profiles.length || new Set(profiles.map((p: any) => String(p.telegram_user_id))).size !== profiles.length) return;
    // Validate ALL curated sources before publishing any manifest.
    const tasks: Array<{ key: string; task: string }> = profiles.map((p: any) => {
      let task = this.read(`participants/${p.key}/homework.md`).replace(/\r\n/g, '\n');
      if (task.startsWith('---\n')) { const end = task.indexOf('\n---\n', 4); if (end < 0) throw new Error('Invalid source'); task = task.slice(end + 5); }
      task = task.trim(); if (!task) throw new Error('Invalid source');
      return { key: p.key as string, task };
    });
    for (const meeting of feed.meetings) {
      if (typeof meeting.number !== 'string' || !/^\d{2}$/.test(meeting.number) || meeting.publication_status !== 'published' || typeof meeting.published_at !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(meeting.published_at) || !Number.isFinite(Date.parse(meeting.published_at))) continue;
      if (meeting.has_content !== true || typeof meeting.summary_md !== 'string' || !meeting.summary_md.trim() || typeof meeting.title !== 'string' || !meeting.title.trim()) continue;
      const snapshot = meeting.summary_md;
      const digest = hash(snapshot);
      const id = `lesson-${meeting.number}-${digest.slice(0, 12)}`;
      const base = `lessons/${id}`;
      if (fs.existsSync(this.safe(`${base}/manifest.json`))) continue;
      const url = `${SITE}/${COHORT}/meetings/${meeting.number}`;
      const messages = tasks.map(({ key, task }) => ({ key, text: `Опубликованы материалы занятия ${meeting.number}: ${meeting.title.trim()}\n${url}\n\nВаша практика:\n\n${task}\n\nВыберите одну технику из материалов занятия и примените её к этой задаче. Сохраните результат и отметьте, что получилось и где нужна помощь.` }));
      if (messages.some(m => m.text.length > 4096)) continue;
      this.write(`${base}/transcript.md`, snapshot);
      const recipient_files: Record<string, string> = {};
      for (const message of messages) {
        const relative = `participants/${message.key}/recommendations.md`;
        this.write(`${base}/${relative}`, message.text);
        recipient_files[message.key] = relative;
      }
      this.write(`${base}/manifest.json`, JSON.stringify({ status: 'finalized', approved: true, approval_basis: 'owner-authorized deterministic composition from curated homework', source_kind: 'published-lesson-post', source_url: url, published_at: meeting.published_at, transcript_file: 'transcript.md', transcript_sha256: digest, recipient_files }, null, 2));
    }
  }
}
