import * as fs from 'node:fs';
import * as path from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Authority, AuthorityCheck, AuthorityReply } from './types.js';

/** Dedicated local read-only channel; never carries browser cookies or frontend caller claims. */
export class ContractsAuthority implements Authority {
  constructor(private readonly opts: { socketPath: string; tokenFile: string; timeoutMs?: number }) {}
  async check(input: AuthorityCheck): Promise<AuthorityReply> {
    try { return await this.request('check', input) as AuthorityReply; }
    catch { return { schemaVersion: 1, allowed: false, reason: 'authority_unavailable', checkedAt: Date.now(), mandate: null }; }
  }
  async request(op: 'check', input: unknown): Promise<unknown> {
    const { socketPath, tokenFile } = this.opts;
    for (const directory of [path.dirname(socketPath), path.dirname(tokenFile)]) {
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('Unsafe authority directory');
    }
    const socket = fs.lstatSync(socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0) throw new Error('Unsafe authority socket');
    const fd = fs.openSync(tokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let token: string;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 4096) throw new Error('Unsafe authority credential');
      token = fs.readFileSync(fd, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid authority credential');
    } finally { fs.closeSync(fd); }
    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      const client = createConnection(socketPath);
      let bytes = 0; let data = ''; let settled = false;
      const finish = (error?: Error, result?: unknown) => { if (settled) return; settled = true; clearTimeout(deadline); client.destroy(); error ? reject(error) : resolve(result); };
      const deadline = setTimeout(() => finish(new Error('Authority timeout')), this.opts.timeoutMs ?? 3000);
      client.on('error', () => finish(new Error('Authority connection failed')));
      client.on('end', () => { if (!settled) finish(new Error('Incomplete authority reply')); });
      client.on('connect', () => client.write(JSON.stringify({ schemaVersion: 1, requestId, token, op, input }) + '\n'));
      client.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) return finish(new Error('Authority reply too large'));
        data += chunk.toString('utf8');
        if (!data.includes('\n')) return;
        try {
          const reply = JSON.parse(data.slice(0, data.indexOf('\n')));
          if (reply.schemaVersion !== 1 || reply.requestId !== requestId || reply.ok !== true || !reply.result) throw new Error('Rejected authority reply');
          if (op === 'check' && (reply.result.schemaVersion !== 1 || typeof reply.result.allowed !== 'boolean' || !Number.isSafeInteger(reply.result.checkedAt))) throw new Error('Invalid authority check');
          finish(undefined, reply.result);
        } catch { finish(new Error('Invalid authority reply')); }
      });
    });
  }
}
