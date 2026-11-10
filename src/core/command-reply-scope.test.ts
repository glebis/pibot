import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import type {PushOptions,Transport} from './types.js';
import {commandReplyScope} from './command-reply-scope.js';
import {PiBot} from './bot.js';
import {DeliveryLedger} from './delivery-ledger.js';

class PrivateTransport implements Transport {
 readonly name='telegram';
 #value='original receiver';
 readonly sent:Array<{chatId:string;opts:PushOptions}>=[];
 async push(chatId:string,opts:PushOptions){expect(this.#value).toBe('original receiver');this.sent.push({chatId,opts});}
 async start(){expect(this.#value).toBe('original receiver');}
 async stop(){}
 async notifyError(_chatId:string,_message:string){}
 onMessage(_cb:Parameters<Transport['onMessage']>[0]){}
 onAction(_cb:Parameters<Transport['onAction']>[0]){}
}
describe('incoming command reply identity',()=>{
 it('lets identical new command answers pass the real durable ledger while retaining retry/proactive suppression',async()=>{const t=new PrivateTransport(),ledger=new DeliveryLedger(),actions:string[]=[];t.push=async(chatId,opts)=>{const claim=ledger.claim({transport:t.name,chatId,dedupeKey:opts.dedupeKey??JSON.stringify({text:opts.text,card:opts.card??null}),text:opts.text});actions.push(claim.action);if(claim.action==='send')ledger.markDelivered(claim.id);};for(const id of [101,102,101])await commandReplyScope(t,'42',id).transport.push('42',{text:'unchanged status'});await t.push('42',{text:'unchanged proactive'});await t.push('42',{text:'unchanged proactive'});expect(actions).toEqual(['send','send','suppress','send','suppress']);});
 it('distinguishes identical replies to new messages and reuses identity for the same incoming retry',async()=>{
  const t=new PrivateTransport(),original=t.push;
  for(const id of [101,102,101]){const scope=commandReplyScope(t,'42',id).transport;await scope.push('42',{text:'same answer'});await scope.push('42',{text:'second answer'});}
  expect(t.sent.map(s=>s.opts.dedupeKey)).toEqual(['command:telegram:42:101:0','command:telegram:42:101:1','command:telegram:42:102:0','command:telegram:42:102:1','command:telegram:42:101:0','command:telegram:42:101:1']);expect(t.push).toBe(original);
 });
 it('preserves explicit keys, other destinations and unscoped proactive output',async()=>{
  const t=new PrivateTransport(),scope=commandReplyScope(t,'42',101).transport;
  await scope.push('42',{text:'explicit',dedupeKey:'already-owned'});await scope.push('42',{text:'reply'});await scope.push('99',{text:'other destination'});await t.push('42',{text:'unchanged proactive'});
  expect(t.sent.map(s=>s.opts.dedupeKey)).toEqual(['already-owned','command:telegram:42:101:1',undefined,undefined]);
 });
 it('keeps concurrent invocations isolated, preserves prototype and binds other methods to the original',async()=>{
  const t=new PrivateTransport(),a=commandReplyScope(t,'42',201).transport,b=commandReplyScope(t,'42',202).transport;
  expect(a).toBeInstanceOf(PrivateTransport);expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(t));await a.start();
  await Promise.all([a.push('42',{text:'a1'}),b.push('42',{text:'b1'}),a.push('42',{text:'a2'}),b.push('42',{text:'b2'})]);
  expect(t.sent.map(s=>s.opts.dedupeKey)).toEqual(['command:telegram:42:201:0','command:telegram:42:202:0','command:telegram:42:201:1','command:telegram:42:202:1']);
 });
 it('retains existing behavior for commands without an incoming message ID',async()=>{const t=new PrivateTransport();expect(commandReplyScope(t,'42').transport).toBe(t);await commandReplyScope(t,'42').transport.push('42',{text:'same'});expect(t.sent[0].opts.dedupeKey).toBeUndefined();});
 it('expires the identity scope so callbacks captured by a session cannot tag later proactive output',async()=>{const t=new PrivateTransport(),scope=commandReplyScope(t,'42',601);await scope.transport.push('42',{text:'reply'});scope.close();await scope.transport.push('42',{text:'later proactive output'});expect(t.sent.map(s=>s.opts.dedupeKey)).toEqual(['command:telegram:42:601:0',undefined]);});
});

describe('bot command ingress',()=>{
 function bot(){const dir=mkdtempSync(join(tmpdir(),'pibot-command-scope-')),t=new PrivateTransport();const b=new PiBot({config:{dataDir:dir,allowedChats:['42'],defaultAgentId:'helper'},transports:[t],agents:{getAgent:()=>({id:'helper',manifest:{name:'helper'}}),defaultAgentId:()=> 'helper'},scheduler:{snoozeState:()=>undefined,list:()=>[]},heartbeat:{},events:{log:vi.fn()},secrets:{get:()=>({})}} as never);return {b,t};}
 it('threads slash-message IDs into generic unknown replies',async()=>{const {b,t}=bot();await b.handleIncoming(t,'42','/not_a_command',undefined,301);await b.handleIncoming(t,'42','/not_a_command',undefined,302);expect(t.sent.map(s=>s.opts.dedupeKey)).toEqual(['command:telegram:42:301:0','command:telegram:42:302:0']);expect(t.sent[0].opts.text).toBe(t.sent[1].opts.text);});
 it('covers direct special command branches before the shared command dispatcher',async()=>{const {b,t}=bot();await b.handleIncoming(t,'42','/minimal',undefined,401);await b.handleIncoming(t,'42','/minimal',undefined,402);expect(t.sent.map(s=>s.opts.dedupeKey)).toEqual(['command:telegram:42:401:0','command:telegram:42:402:0']);expect(t.sent[0].opts.text).toBe(t.sent[1].opts.text);});
 it('threads quick-action message IDs into the same command scope',async()=>{const {b,t}=bot();await b.handleIncoming(t,'42','📋 status',undefined,501);expect(t.sent[0].opts.dedupeKey).toBe('command:telegram:42:501:0');});
 it('keeps scope through awaited command work and closes it before any later captured callback',async()=>{const {b,t}=bot();let captured!:Transport;(b as unknown as {commandHandler:(t:Transport,chat:string,text:string)=>Promise<void>}).commandHandler=async(scoped,chat)=>{captured=scoped;await Promise.resolve();await scoped.push(chat,{text:'async command answer'});};await b.handleIncoming(t,'42','/async_fixture',undefined,701);await captured.push('42',{text:'late unsolicited fixture'});expect(t.sent.map(s=>s.opts.dedupeKey)).toEqual(['command:telegram:42:701:0',undefined]);});
});
