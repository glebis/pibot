import { describe,it,expect,vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorRuntime,loadCoordinatorConfig,type CoordinatorConfig } from './runtime.js';
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-runtime-'));
const config=(dataDir:string):CoordinatorConfig=>({ownerId:'owner',coordinatorId:'primary',mandateId:'grant',botId:'123',chatId:'456',userId:'456',socketPath:'/tmp/private/bridge.sock',tokenFile:'/tmp/private/token',dataDir});
const deps=()=>({authority:{check:vi.fn(async()=>({schemaVersion:1 as const,allowed:false,reason:'test',checkedAt:Date.now(),mandate:null}))},sender:{send:vi.fn(async()=>({status:'accepted' as const,messageId:'7'}))}});
describe('coordinator runtime',()=>{
 it('is disabled without a config and rejects public config files',()=>{
  expect(loadCoordinatorConfig(undefined)).toBeUndefined();const file=path.join(dir(),'config.json');fs.writeFileSync(file,JSON.stringify(config(dir())));fs.chmodSync(file,0o644);expect(()=>loadCoordinatorConfig(file)).toThrow('private owner file');fs.chmodSync(file,0o600);expect(loadCoordinatorConfig(file)?.botId).toBe('123');
 });
 it('captures only coordinator controls and replays persisted updates before outbound work',async()=>{
  const c=config(dir()),d=deps();let r=new CoordinatorRuntime(c,'123:test',d);
  r.captureBatch([{update_id:1,message:{text:'private unrelated text'}},{update_id:2,callback_query:{data:'pc:unknown',from:{id:456},message:{chat:{id:456,type:'private'}}}}]);
  expect(r.store.pendingUpdates('123')).toHaveLength(1);r.close();r=new CoordinatorRuntime(c,'123:test',d);await r.start();await r.stopDispatch();expect(r.store.pendingUpdates('123')).toHaveLength(0);expect(d.sender.send).not.toHaveBeenCalled();r.close();
 });
 it('records a manual reference with pinned authority and rejects duplicate open sources',()=>{
  const r=new CoordinatorRuntime(config(dir()),'123:test',deps());const input={sourceContractId:'manual-ref',question:'Continue?',choices:['Yes','No'],deadline:Date.now()+60000};const record=r.create(input);expect(record.recipient).toEqual({botId:'123',chatId:'456',userId:'456'});expect(record.mandateId).toBe('grant');expect(()=>r.create(input)).toThrow('open decision');r.close();
 });
 it('consumes foreign coordinator controls without changing a decision or invoking legacy chat',async()=>{
  const r=new CoordinatorRuntime(config(dir()),'123:test',deps());expect(await r.handle({update_id:3,callback_query:{data:'pc:bad',from:{id:789},message:{chat:{id:789,type:'private'}}}})).toBe(true);expect(await r.handle({update_id:4,message:{text:'hello'}})).toBe(false);expect(r.inspect().decisions).toHaveLength(0);r.close();
 });
});
