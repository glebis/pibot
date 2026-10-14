import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Attempt, Decision } from './types.js';

/** Single-host exclusive owner. A stale PID is reclaimed; a live process is never displaced. */
export class CoordinatorStore {
  readonly db: DatabaseSync;
  readonly epoch: string;
  readonly restoreMarker: string;
  private lock: string;
  private lockValue: string;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Coordinator directory cannot be a symlink');
    fs.chmodSync(directory, 0o700);
    this.lock = path.join(directory, 'writer.lock');
    this.restoreMarker = path.join(directory, 'restore-in-progress');
    this.lockValue = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    try { fs.writeFileSync(this.lock, this.lockValue, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = JSON.parse(fs.readFileSync(this.lock, 'utf8')) as { pid: number };
      if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0) throw new Error('Invalid coordinator lock; operator inspection required');
      try { process.kill(existing.pid, 0); throw new Error('Coordinator writer already active'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      // Atomic rename claim avoids two reclaimers both unlinking a new owner's lock.
      const stale = `${this.lock}.stale`;
      fs.linkSync(this.lock, stale);
      if (fs.readFileSync(this.lock, 'utf8') !== fs.readFileSync(stale, 'utf8')) throw new Error('Coordinator lock changed');
      fs.unlinkSync(this.lock);
      try { fs.writeFileSync(this.lock, this.lockValue, { flag: 'wx', mode: 0o600 }); } finally { fs.unlinkSync(stale); }
    }
    const file = path.join(directory, 'coordinator.sqlite');
    try {
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Database cannot be a symlink');
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600); fs.closeSync(fd); fs.chmodSync(file, 0o600);
      this.db = new DatabaseSync(file);
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS controls(token TEXT PRIMARY KEY,decisionId TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL,value TEXT);
        CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,result TEXT);
        CREATE TABLE IF NOT EXISTS updates(account TEXT NOT NULL,id INTEGER NOT NULL,body TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,id));
        CREATE TABLE IF NOT EXISTS timers(id TEXT PRIMARY KEY,decisionId TEXT NOT NULL,version INTEGER NOT NULL,seq INTEGER NOT NULL,due INTEGER NOT NULL,kind TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS policies(id TEXT PRIMARY KEY,body TEXT NOT NULL);`);
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('epoch', randomUUID());
      this.epoch = String((this.db.prepare('SELECT value FROM meta WHERE key=?').get('epoch') as { value: string }).value);
      this.transaction(() => { for (const a of this.attempts()) if (a.status === 'dispatching') this.saveAttempt({ ...a, status: 'unknown', reason: 'Process interrupted; acceptance cannot be established' }); });
    } catch (e) { this.releaseLock(); throw e; }
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(id: string): Decision | undefined { const row = this.db.prepare('SELECT body FROM decisions WHERE id=?').get(id) as { body: string } | undefined; return row ? JSON.parse(row.body) : undefined; }
  decisions(): Decision[] { return this.db.prepare('SELECT body FROM decisions').all().map(r => JSON.parse(String(r.body))); }
  save(d: Decision): void { this.db.prepare('INSERT OR REPLACE INTO decisions VALUES(?,?)').run(d.id, JSON.stringify(d)); }
  attempts(): Attempt[] { return this.db.prepare('SELECT body FROM attempts').all().map(r => JSON.parse(String(r.body))); }
  saveAttempt(a: Attempt): void { this.db.prepare('INSERT OR REPLACE INTO attempts VALUES(?,?)').run(a.id, JSON.stringify(a)); }
  captureUpdates(botId: string, updates: { update_id: number; [key: string]: unknown }[]): void {
    this.transaction(() => { for (const update of updates) { if (!Number.isSafeInteger(update.update_id)) throw new Error('Invalid update id'); this.db.prepare('INSERT OR IGNORE INTO updates(account,id,body) VALUES(?,?,?)').run(botId, update.update_id, JSON.stringify(update)); } });
  }
  pendingUpdates(botId: string): { update_id: number; [key: string]: unknown }[] { return this.db.prepare('SELECT body FROM updates WHERE account=? AND processed=0 ORDER BY id').all(botId).map(r => JSON.parse(String(r.body))); }
  markUpdateProcessed(botId: string, updateId: number): void { this.db.prepare('UPDATE updates SET processed=1 WHERE account=? AND id=?').run(botId, updateId); }
  resolveControl(token: string): { decisionId: string; questionVersion: number; action: string; value?: string } | undefined { const r = this.db.prepare('SELECT * FROM controls WHERE token=?').get(token); return r ? { decisionId: String(r.decisionId), questionVersion: Number(r.version), action: String(r.action), value: r.value == null ? undefined : String(r.value) } : undefined; }
  dispatchPaused(): boolean { return fs.existsSync(this.restoreMarker); }
  beginRestore(): void { fs.writeFileSync(this.restoreMarker, 'Outbound paused. Authenticated managed recovery required.\n', { flag: 'wx', mode: 0o600 }); }
  close(): void { this.db.close(); this.releaseLock(); }
  private releaseLock(): void { if (fs.existsSync(this.lock) && fs.readFileSync(this.lock, 'utf8') === this.lockValue) fs.unlinkSync(this.lock); }
}
