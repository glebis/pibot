import * as fs from 'node:fs';
import * as path from 'node:path';

const LIMIT = 65536;
const AUDIT_LIMIT = 2 * 1024 * 1024;
export interface ExecTraceInput {
  callId: string; taskId?: string; argv: string[];
  outcome: 'refused' | 'started' | 'succeeded' | 'failed' | 'timed-out';
  reason?: string; exitCode?: number | null;
}
interface ExecTraceRow {
  at: string; agent: string; callId: string; taskId?: string; videoIds: string[];
  outcome: ExecTraceInput['outcome']; reason?: string; exitCode?: number | null;
}
function safeId(value: string): string { return /^[\w:.-]{1,160}$/.test(value) ? value : '[invalid-id]'; }
function videoIds(values: string[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password) continue;
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      let id: string | null = null;
      if (host === 'youtu.be') id = u.pathname.split('/')[1];
      if (['youtube.com', 'm.youtube.com'].includes(host)) id = u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : u.searchParams.get('v');
      if (id && /^[\w-]{11}$/.test(id)) ids.add(id);
    } catch { /* arguments are not necessarily URLs */ }
  }
  return [...ids];
}
function runtimeDir(agentDir: string): string {
  const root = fs.realpathSync(agentDir);
  const dir = path.join(root, 'runtime');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new Error('Unsafe runtime directory');
  return dir;
}
/** Store metadata only. Never persist argv, URL query strings, stdout, stderr or arbitrary refusal arguments. */
export function appendExecTrace(agentDir: string, input: ExecTraceInput): void {
  const file = path.join(runtimeDir(agentDir), 'exec-audit.jsonl');
  const reasons = ['not allowlisted', 'command missing', 'shell syntax denied', 'argument denied', 'constraint denied', 'resolution failed', 'execution failed'];
  const row: ExecTraceRow = {
    at: new Date().toISOString(), agent: path.basename(agentDir), callId: safeId(input.callId),
    ...(input.taskId ? { taskId: safeId(input.taskId) } : {}), videoIds: videoIds(input.argv), outcome: input.outcome,
    ...(input.reason ? { reason: reasons.includes(input.reason) ? input.reason : 'constraint denied' } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
  };
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, JSON.stringify(row) + '\n'); } finally { fs.closeSync(fd); }
}
export function searchExecTrace(agentDir: string, query: string): ExecTraceRow[] {
  const file = path.join(runtimeDir(agentDir), 'exec-audit.jsonl');
  if (!fs.existsSync(file)) return [];
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text: string;
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - AUDIT_LIMIT);
    const buf = Buffer.alloc(Math.min(size, AUDIT_LIMIT)); fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8'); if (start) text = text.slice(text.indexOf('\n') + 1);
  } finally { fs.closeSync(fd); }
  const ids = videoIds([query]);
  return text.split('\n').flatMap((line): ExecTraceRow[] => {
    try {
      const row = JSON.parse(line) as ExecTraceRow;
      if (!row || !Array.isArray(row.videoIds)) return [];
      return row.taskId === query || row.callId === query || ids.some((id) => row.videoIds.includes(id)) ? [row] : [];
    } catch { return []; }
  }).slice(-20);
}
/** This intentionally does not read arbitrary workspace files: only text outputs under runtime/artifacts. */
export function readExecArtifact(agentDir: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Artifact path must be relative without traversal');
  const base = path.join(runtimeDir(agentDir), 'artifacts');
  if (!fs.existsSync(base) || fs.lstatSync(base).isSymbolicLink() || fs.realpathSync(base) !== base) throw new Error('Unsafe or missing artifact directory');
  const file = path.join(base, relative);
  const canonical = fs.realpathSync(file);
  if (!canonical.startsWith(base + path.sep) || canonical !== file) throw new Error('Artifact symlinks are not allowed');
  if (!/\.(txt|md|json|vtt|srt|csv)$/i.test(file)) throw new Error('Only text artifact formats are supported');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('Artifact must be a regular text file no larger than 64 KiB');
    const buf = Buffer.alloc(LIMIT + 1); const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > LIMIT || buf.subarray(0, n).includes(0)) throw new Error('Artifact is oversized or binary');
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
}
