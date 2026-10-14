import { describe,it,expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Coordinator } from './coordinator.js';
import { mkdtempSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorStore } from './store.js';
describe('CoordinatorStore',()=>{
 it('real process dies after provider acceptance; restart preserves unknown and never sends again',async()=>{const dir=mkdtempSync(join(tmpdir(),'coord-crash-'));const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/crash.ts',import.meta.url)),dir],{timeout:10000});expect(child.status,child.stderr.toString()).toBe(73);expect(readFileSync(join(dir,'provider-accepted'),'utf8')).toBe('42');const store=new CoordinatorStore(dir);try{expect(store.attempts()[0]?.status).toBe('unknown');let sends=0;const coordinator=new Coordinator({store,clock:()=>Date.parse('2026-10-13T12:00:00Z'),authority:{async check(){throw Error('must not dispatch');}},sender:{async send(){sends++;return {status:'accepted',messageId:'43'};}}});await coordinator.tick();expect(sends).toBe(0);expect(store.attempts()).toHaveLength(1);}finally{store.close();}});

 it('rejects concurrent writers and persists deduplicated inbound capture',()=>{const dir=mkdtempSync(join(tmpdir(),'coord-store-'));const s=new CoordinatorStore(dir);expect(()=>new CoordinatorStore(dir)).toThrow('already active');s.captureUpdates('b',[{update_id:1,message:{text:'answer'}}]);s.captureUpdates('b',[{update_id:1,message:{text:'different'}}]);expect(s.pendingUpdates('b')).toHaveLength(1);expect(statSync(join(dir,'coordinator.sqlite')).mode&0o777).toBe(0o600);s.close();const reopened=new CoordinatorStore(dir);expect(reopened.pendingUpdates('b')[0]?.message).toEqual({text:'answer'});reopened.markUpdateProcessed('b',1);expect(reopened.pendingUpdates('b')).toEqual([]);reopened.close();});
 it('transaction rolls back and dispatching recovers as unknown',()=>{const s=new CoordinatorStore(mkdtempSync(join(tmpdir(),'coord-rollback-')));expect(()=>s.transaction(()=>{s.db.prepare('INSERT INTO meta VALUES(?,?)').run('rollback','yes');throw Error('stop');})).toThrow();expect(s.db.prepare('SELECT * FROM meta WHERE key=?').get('rollback')).toBeUndefined();s.saveAttempt({id:'a',decisionId:'d',questionVersion:1,status:'dispatching',ownerId:'owner',createdAt:1,retry:false});const dir=s.directory;s.close();const r=new CoordinatorStore(dir);expect(r.attempts()[0]?.status).toBe('unknown');r.close();});
});
