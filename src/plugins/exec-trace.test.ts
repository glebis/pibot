import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendExecTrace, searchExecTrace, readExecArtifact, readExecArtifactExtract, ARTIFACT_MAX_PAGE_BYTES } from './exec-trace.js';

const dirs: string[] = [];
function temp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-trace-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
describe('private exec trace and artifact boundary', () => {
  it('finds a refusal by video URL or task without storing arguments or URL secrets', () => {
    const d = temp();
    appendExecTrace(d, { callId: 'call-1', taskId: 'task-1', argv: ['python', 'https://youtube.com/shorts/N8mV_E3IcZU?token=PRIVATE', 'PASSWORD'], outcome: 'refused', reason: 'not allowlisted' });
    const rows = searchExecTrace(d, 'https://www.youtube.com/watch?v=N8mV_E3IcZU');
    expect(rows).toHaveLength(1);
    expect(searchExecTrace(d, 'task-1')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ callId: 'call-1', taskId: 'task-1', outcome: 'refused', reason: 'not allowlisted' });
    const raw = fs.readFileSync(path.join(d, 'runtime', 'exec-audit.jsonl'), 'utf8');
    expect(raw).not.toContain('PRIVATE'); expect(raw).not.toContain('PASSWORD');
    expect(fs.statSync(path.join(d, 'runtime', 'exec-audit.jsonl')).mode & 0o777).toBe(0o600);
  });
  it('reads only small UTF-8 text artifacts, never traversal or symlink escapes', () => {
    const d = temp(), other = temp();
    fs.mkdirSync(path.join(d, 'runtime', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(d, 'runtime', 'artifacts', 'captions.vtt'), 'WEBVTT\nverified');
    fs.writeFileSync(path.join(other, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(other, 'secret.txt'), path.join(d, 'runtime', 'artifacts', 'link.txt'));
    expect(readExecArtifact(d, 'captions.vtt')).toContain('verified');
    expect(() => readExecArtifact(d, '../../agent.json')).toThrow();
    expect(() => readExecArtifact(d, 'link.txt')).toThrow();
    fs.writeFileSync(path.join(d, 'runtime', 'artifacts', 'large.txt'), 'x'.repeat(65537));
    expect(() => readExecArtifact(d, 'large.txt')).toThrow();
    fs.writeFileSync(path.join(d, 'runtime', 'artifacts', 'bad.txt'), Buffer.from([0, 1, 2]));
    expect(() => readExecArtifact(d, 'bad.txt')).toThrow();
  });
  it('returns confined extracts whose cursor reconstructs a long multi-byte transcript', () => {
    const d = temp();
    fs.mkdirSync(path.join(d, 'runtime', 'artifacts'), { recursive: true });
    const text = 'Ж'.repeat(5000) + '\nконец';
    fs.writeFileSync(path.join(d, 'runtime', 'artifacts', 'long.txt'), text);
    let offset = 0;
    let rebuilt = '';
    let pages = 0;
    for (;;) {
      const page = readExecArtifactExtract(d, 'long.txt', { offset, limit: 4096 });
      expect(page.path).toBe('long.txt');
      expect(page.totalBytes).toBe(Buffer.byteLength(text));
      expect(page.offset).toBe(offset);
      expect(page.bytes).toBeGreaterThan(0);
      expect(page.content).not.toContain('\uFFFD');
      rebuilt += page.content;
      pages++;
      if (page.nextOffset === null) { expect(page.truncated).toBe(false); break; }
      expect(page.truncated).toBe(true);
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(rebuilt).toBe(text);
    expect(pages).toBeGreaterThan(1);
  });

  it('pages artifacts larger than the former whole-file cap and refuses unsafe ranges', () => {
    const d = temp();
    fs.mkdirSync(path.join(d, 'runtime', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(d, 'runtime', 'artifacts', 'big.txt'), 'a'.repeat(70_000));
    const tail = readExecArtifactExtract(d, 'big.txt', { offset: 65536 });
    expect(tail.totalBytes).toBe(70_000);
    expect(tail.bytes).toBe(4464);
    expect(tail.nextOffset).toBeNull();
    expect(() => readExecArtifactExtract(d, 'big.txt', { offset: 70_001 })).toThrow();
    expect(() => readExecArtifactExtract(d, 'big.txt', { offset: -1 })).toThrow();
    expect(() => readExecArtifactExtract(d, 'big.txt', { limit: ARTIFACT_MAX_PAGE_BYTES + 1 })).toThrow();
    expect(() => readExecArtifactExtract(d, '../outside.txt')).toThrow();
  });

  it('rejects a symlinked runtime and ignores corrupt audit lines', () => {
    const d = temp(), other = temp(); fs.symlinkSync(other, path.join(d, 'runtime'));
    expect(() => appendExecTrace(d, { callId: 'x', argv: [], outcome: 'refused' })).toThrow();
    expect(fs.readdirSync(other)).toEqual([]);
    const clean = temp(); fs.mkdirSync(path.join(clean, 'runtime'));
    fs.writeFileSync(path.join(clean, 'runtime', 'exec-audit.jsonl'), 'broken\n');
    expect(searchExecTrace(clean, 'task-1')).toEqual([]);
  });
});
