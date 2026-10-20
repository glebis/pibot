import { describe,it,expect } from 'vitest';
import { createServer,type Socket } from 'node:net';
import { chmodSync,mkdtempSync,realpathSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractsAuthority } from './authority.js';
import type { AuthorityCheck } from './types.js';
const input:AuthorityCheck={mandateId:'mandate',ownerId:'owner',coordinatorId:'coordinator',botId:'123',chatId:'456',userId:'456',purpose:'contract_decision',expectedVersion:7,expectedDigest:'sha256:expected'};
async function fixture(handler:(socket:Socket,data:string)=>void, timeoutMs=2000) {
  // Short path keeps AF_UNIX names below macOS's socket path limit.
  const dir=mkdtempSync(join(realpathSync('/tmp'),'pca-'));chmodSync(dir,0o700);
  const socketPath=join(dir,'s');const tokenFile=join(dir,'token');const token='ab'.repeat(32);writeFileSync(tokenFile,token,{mode:0o600});
  const sockets=new Set<Socket>();let connections=0;
  const server=createServer(socket=>{connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',chunk=>{buffer+=chunk.toString('utf8');if(buffer.includes('\n'))handler(socket,buffer.slice(0,buffer.indexOf('\n')));});});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});chmodSync(socketPath,0o600);
  return {client:new ContractsAuthority({socketPath,tokenFile,timeoutMs}),token,tokenFile,connections:()=>connections,async close(){for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
describe('ContractsAuthority private Unix bridge',()=>{
 it('sends pinned identities and expected version/digest in exact authenticated envelope',async()=>{let request:any;const f=await fixture((socket,data)=>{request=JSON.parse(data);socket.end(JSON.stringify({schemaVersion:1,requestId:request.requestId,ok:true,result:{schemaVersion:1,allowed:false,reason:'revoked',checkedAt:Date.now(),mandate:null}})+'\n');});try{const result=await f.client.check(input);expect(request).toEqual({schemaVersion:1,requestId:expect.any(String),token:f.token,op:'check',input});expect(result.allowed).toBe(false);expect(result.reason).toBe('revoked');}finally{await f.close();}});
 it.each(['wrong-id','wrong-schema','wrong-result'])('denies %s envelope',async(kind)=>{const f=await fixture((socket,data)=>{const r=JSON.parse(data);socket.end(JSON.stringify({schemaVersion:kind==='wrong-schema'?2:1,requestId:kind==='wrong-id'?'other':r.requestId,ok:true,result:{schemaVersion:1,allowed:kind==='wrong-result'?'yes':true,checkedAt:Date.now(),mandate:null}})+'\n');});try{expect(await f.client.check(input)).toMatchObject({allowed:false,reason:'authority_unavailable',mandate:null});}finally{await f.close();}});
 it('fails closed on a silent authority timeout',async()=>{const f=await fixture(()=>{},80);try{expect(await f.client.check(input)).toMatchObject({allowed:false,reason:'authority_unavailable'});expect(f.connections()).toBe(1);}finally{await f.close();}});
 it('uses an absolute deadline even when a peer keeps sending partial bytes',async()=>{const f=await fixture(socket=>{const timer=setInterval(()=>socket.write(' '),10);socket.once('close',()=>clearInterval(timer));},80);try{expect(await f.client.check(input)).toMatchObject({allowed:false,reason:'authority_unavailable'});}finally{await f.close();}},1000);
 it('refuses world-readable token before making a connection',async()=>{const f=await fixture(()=>{});try{chmodSync(f.tokenFile,0o644);expect(await f.client.check(input)).toMatchObject({allowed:false,reason:'authority_unavailable'});expect(f.connections()).toBe(0);}finally{await f.close();}});
});
