import * as fs from 'node:fs';
import * as path from 'node:path';

const LIMIT = 65536;
const AUDIT_LIMIT = 2 * 1024 * 1024;
export interface ExecTraceInput {
  callId: string; taskId?: string; argv: string[];
  outcome: 'refused' | 'started' | 'succeeded' | 'failed' | 'timed-out';
  reason?: string; exitCode?: number | null;
  /** bd pibot-wcp0: authority provenance for this row — who actually requested it,
   *  under which cited owner authority, executed by which session. Sibling narration
   *  never relabels authority; absent fields stay absent. */
  authority?: ExecAuthority;
}
/** bd pibot-wcp0: when things HAPPENED vs when they were captured vs observed —
 *  three separate facts. File mtime is a capture-side hint at best; it can never
 *  prove event creation, delivery time, or backdating on its own. */
export interface ExecTimes {
  /** when the underlying event occurred (from the event itself, not metadata) */
  eventAt?: string;
  /** when this row/artifact was captured */
  capturedAt?: string;
  /** when the consumer/verifier observed it */
  observedAt?: string;
}
export interface ExecAuthority {
  /** canonical task/session that requested the action */
  requestedByTaskId?: string;
  requestedBySessionId?: string;
  /** the cited owner convention/approval, verbatim reference (e.g. bead id) */
  citedOwnerAuthority?: string;
  /** executing agent/session identity */
  executor?: string;
}
interface ExecTraceRow {
  at: string; agent: string; callId: string; taskId?: string; videoIds: string[];
  outcome: ExecTraceInput['outcome']; reason?: string; exitCode?: number | null;
  times?: ExecTimes; authority?: ExecAuthority;
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
    times: { capturedAt: new Date().toISOString() },
    ...(input.taskId ? { taskId: safeId(input.taskId) } : {}), videoIds: videoIds(input.argv), outcome: input.outcome,
    ...(input.reason ? { reason: reasons.includes(input.reason) ? input.reason : 'constraint denied' } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.authority ? { authority: {
      ...(input.authority.requestedByTaskId ? { requestedByTaskId: safeId(input.authority.requestedByTaskId) } : {}),
      ...(input.authority.requestedBySessionId ? { requestedBySessionId: safeId(input.authority.requestedBySessionId) } : {}),
      ...(input.authority.citedOwnerAuthority ? { citedOwnerAuthority: safeId(input.authority.citedOwnerAuthority) } : {}),
      ...(input.authority.executor ? { executor: safeId(input.authority.executor) } : {}),
    } } : {}),
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
/** Default bytes per paged read; a caller must use the returned cursor for the rest. */
export const ARTIFACT_PAGE_BYTES = 16384;
/** Hard per-call ceiling, so one call cannot dump an unbounded transcript. */
export const ARTIFACT_MAX_PAGE_BYTES = 65536;
/** Files above this are refused outright rather than paged. */
const ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Confine and validate an artifact path. Reads only under own runtime/artifacts. */
function artifactPath(agentDir: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Artifact path must be relative without traversal');
  const base = path.join(runtimeDir(agentDir), 'artifacts');
  if (!fs.existsSync(base) || fs.lstatSync(base).isSymbolicLink() || fs.realpathSync(base) !== base) throw new Error('Unsafe or missing artifact directory');
  const file = path.join(base, relative);
  const canonical = fs.realpathSync(file);
  if (!canonical.startsWith(base + path.sep) || canonical !== file) throw new Error('Artifact symlinks are not allowed');
  if (!/\.(txt|md|json|vtt|srt|csv)$/i.test(file)) throw new Error('Only text artifact formats are supported');
  return file;
}

/** Largest index <= max that does not split a UTF-8 sequence. */
function utf8Boundary(buf: Buffer, max: number): number {
  const end = Math.min(max, buf.length);
  if (end <= 0) return 0;
  let i = end - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (buf[i] & 0xc0) === 0x80) { i--; back++; }
  if (i < 0) return end;
  const lead = buf[i];
  const len = (lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return i + len > end ? i : end;
}

export interface ArtifactExtract {
  path: string;
  totalBytes: number;
  offset: number;
  bytes: number;
  truncated: boolean;
  /** Byte offset to request next; null when this extract reaches the end. */
  nextOffset: number | null;
  content: string;
  /** bd pibot-wcp0: snapshot identity for THIS read — byte length + mtime at capture.
   *  mtime is a capture hint only, never backdating proof; a conflicting receipt
   *  between two reads is flagged, not laundered into 'verified'. */
  snapshot: { totalBytes: number; mtimeMs: number; capturedAt: string };
}

/**
 * Confined, paged read of one text artifact. Every extract carries its identity, byte
 * range, truncation state and continuation cursor so a consumer can prove coverage of a
 * long transcript instead of asking for ad hoc prose slices (bd pibot-wcp0).
 */
/** bd pibot-wcp0: reconcile two extract receipts of the same artifact.
 *  'consistent' = one snapshot; 'conflict' = differing byte length/mtime between
 *  reads — explicit mismatch, never folded into 'verified'. mtime-only differences
 *  (same length, same content window) are reported as 'mtime-drift' — a touched or
 *  synced file can have later metadata without any backdating having occurred. */
export type SnapshotReconciliation =
  | { verdict: 'consistent' }
  | { verdict: 'mtime-drift'; note: string }
  | { verdict: 'conflict'; note: string };

export function reconcileSnapshots(a: ArtifactExtract['snapshot'], b: ArtifactExtract['snapshot']): SnapshotReconciliation {
  if (a.totalBytes === b.totalBytes && a.mtimeMs === b.mtimeMs) return { verdict: 'consistent' };
  if (a.totalBytes === b.totalBytes && a.mtimeMs !== b.mtimeMs) {
    return { verdict: 'mtime-drift', note: `same byte length (${a.totalBytes}) but mtime ${a.mtimeMs} → ${b.mtimeMs}; mtime alone cannot prove backdating` };
  }
  return { verdict: 'conflict', note: `byte length differs ${a.totalBytes} → ${b.totalBytes} (mtime ${a.mtimeMs} → ${b.mtimeMs}); not one consistent snapshot — re-read before closure` };
}

export function readExecArtifactExtract(agentDir: string, relative: string, opts: { offset?: number; limit?: number } = {}): ArtifactExtract {
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? ARTIFACT_PAGE_BYTES;
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_MAX_PAGE_BYTES) throw new Error(`limit must be an integer between 1 and ${ARTIFACT_MAX_PAGE_BYTES}`);
  const file = artifactPath(agentDir, relative);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Artifact must be a regular text file');
    if (stat.size > ARTIFACT_MAX_FILE_BYTES) throw new Error('Artifact is too large to read');
    if (offset > stat.size) throw new Error('offset is past the end of the artifact');
    const want = Math.min(limit, stat.size - offset);
    const buf = Buffer.alloc(want + 4); // +4 so a multi-byte sequence at the edge can complete
    const n = want ? fs.readSync(fd, buf, 0, buf.length, offset) : 0;
    const window = buf.subarray(0, n);
    if (window.includes(0)) throw new Error('Artifact is oversized or binary');
    let take = utf8Boundary(window, Math.min(want, n));
    if (take === 0 && n > 0) {
      take = utf8Boundary(window, n); // one character is wider than the requested limit: return it whole
      if (take === 0) throw new Error('Artifact does not contain valid UTF-8 text');
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(window.subarray(0, take));
    const next = offset + take;
    return { path: relative, totalBytes: stat.size, offset, bytes: take, truncated: next < stat.size, nextOffset: next < stat.size ? next : null, content,
      snapshot: { totalBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs), capturedAt: new Date().toISOString() } };
  } finally { fs.closeSync(fd); }
}

/** This intentionally does not read arbitrary workspace files: only text outputs under runtime/artifacts. */
export function readExecArtifact(agentDir: string, relative: string): string {
  const file = artifactPath(agentDir, relative);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('Artifact must be a regular text file no larger than 64 KiB');
    const buf = Buffer.alloc(LIMIT + 1); const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > LIMIT || buf.subarray(0, n).includes(0)) throw new Error('Artifact is oversized or binary');
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
}
