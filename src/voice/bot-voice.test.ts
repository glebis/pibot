import { describe, expect, it, vi } from 'vitest';
import { CanonicalTurnGate } from './session-control.js';
// The unrelated cascade source currently has merge conflicts; these boundary tests inject it.
vi.mock('../core/cascade.js',()=>({classifyModelError:()=> 'transient',ModelCascade:class {},specProvider:()=> 'test'}));
import { PiBot } from '../core/bot.js';

function deferred() {let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function harness() {
 const pushed: string[]=[];const subscribers: Array<(e:any)=>void>=[];
 const t={name:'telegram',push:vi.fn(async (_chat:string,p:any)=>{pushed.push(p.text);}),notifyError:vi.fn(async()=>{}),setTyping:vi.fn(),onMessage:vi.fn(),onAction:vi.fn(),start:vi.fn(),stop:vi.fn()};
 const session={isStreaming:false,subscribe:vi.fn((f:any)=>{subscribers.push(f);}),setModel:vi.fn(async()=>{}),prompt:vi.fn(async()=>{subscribers.forEach(f=>f({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'Here is the answer.'}],stopReason:'stop'}]}));})};
 const agents={getAgent:vi.fn((id:string)=>id==='assistant'?{id,manifest:{name:id}}:undefined),getOrCreateSession:vi.fn(async()=>session)};
 const bot=new PiBot({config:{dataDir:'/tmp/voice-test-unused',allowedChats:['42']},transports:[t],agents,heartbeat:{noteUserMessage:vi.fn()},events:{log:vi.fn()},scheduler:{},secrets:{}} as any);
 const b=bot as any;b.chatAgent.set('telegram:42','assistant');b.agentChats.set('assistant',new Set(['telegram:42']));
 // No test writes to runtime state or invokes unrelated plugin services.
 b.persistState=vi.fn();b.flushCards=vi.fn(async()=>{});b.continueGoal=vi.fn(async()=>{});b.maybeEmitTaskAck=vi.fn();
 return {bot,b,t,pushed,session,agents,subscribers,input:{agentId:'assistant',chatKey:'telegram:42',text:'Hi',onOutput:vi.fn(async()=>{})}};
}
describe('canonical voice bridge',()=>{
 it('shares a cached canonical session, routes voice only, and does not create proactive recipients',async()=>{
  const h=harness();await h.bot.promptAgent(h.t as any,'42','assistant','Text first',{taskAckFrom:null});h.pushed.length=0;
  const before=JSON.stringify([...h.b.agentChats].map(([k,v]:any)=>[k,[...v]]));
  const result=await h.bot.voiceTurn(h.input);
  expect(result.status).toBe('completed');expect(h.input.onOutput).toHaveBeenCalledWith('Here is the answer.');expect(h.pushed).toEqual([]);
  expect(h.session.subscribe).toHaveBeenCalledTimes(1);expect(h.agents.getOrCreateSession.mock.calls.at(-1)?.slice(0,3)).toEqual(['assistant','telegram:42',{transport:'telegram',chatId:'42'}]);
  expect(JSON.stringify([...h.b.agentChats].map(([k,v]:any)=>[k,[...v]]))).toBe(before);
 });
 it('queues voice behind a canonical text turn and serializes incoming text behind voice',async()=>{
  const h=harness();const hold=deferred();h.session.prompt.mockImplementationOnce(()=>hold.promise);
  const text=h.bot.promptAgent(h.t as any,'42','assistant','text',{taskAckFrom:null});
  const queued=await h.bot.voiceTurn(h.input);
  expect(queued.status).toBe('completed');expect(queued.text).toContain('queued');
  hold.resolve();await text;await new Promise(r=>setTimeout(r,5));
  expect(String((h.session.prompt.mock.calls[1] as any[])[0])).toContain('said on the voice call while you were still busy');
  h.session.prompt.mockClear();
  const voiceHold=deferred();h.session.prompt.mockImplementationOnce(()=>voiceHold.promise);
  const voice=h.bot.voiceTurn(h.input);const next=h.bot.promptAgent(h.t as any,'42','assistant','next',{taskAckFrom:null});
  await new Promise(r=>setTimeout(r,1));expect(h.session.prompt).toHaveBeenCalledTimes(1);voiceHold.resolve();await voice;await next;expect(h.session.prompt).toHaveBeenCalledTimes(2);
 });
 it('denies unknown, group, foreign-owner, rebound, or pre-aborted attachments',async()=>{
  const h=harness();for(const change of [{chatKey:'telegram:-42'},{chatKey:'telegram:99'},{agentId:'other'},{signal:AbortSignal.abort()}])expect((await h.bot.voiceTurn({...h.input,...change})).status).toBe('denied');expect(h.session.prompt).not.toHaveBeenCalled();
 });
 it('detaches audio but delivers completed work back to the canonical chat',async()=>{
  const h=harness();const hold=deferred();const original=h.session.prompt.getMockImplementation()!;h.session.prompt.mockImplementationOnce(async()=>{await hold.promise;await original();});
  const controller=new AbortController();const running=h.bot.voiceTurn({...h.input,signal:controller.signal});await new Promise(r=>setTimeout(r,1));controller.abort();hold.resolve();
  expect((await running).status).toBe('detached');expect(h.input.onOutput).not.toHaveBeenCalled();expect(h.pushed).toEqual(['Here is the answer.']);
 });
 it('uses one prompt and returns no_reply or failed without goal continuation or recovery',async()=>{
  const h=harness();h.b.goals.set('telegram:42',{status:'active'});h.session.prompt.mockResolvedValueOnce(undefined);
  expect(await h.bot.voiceTurn(h.input)).toEqual({status:'no_reply'});expect(h.b.continueGoal).not.toHaveBeenCalled();expect(h.session.prompt).toHaveBeenCalledTimes(1);
  h.session.prompt.mockRejectedValueOnce(new Error('private provider details'));expect(await h.bot.voiceTurn(h.input)).toEqual({status:'failed'});expect(h.session.prompt).toHaveBeenCalledTimes(2);
 });
 it('uses encrypted owner settings only when config is empty and respects transport revocation',async()=>{
  const h=harness();h.b.deps.config.allowedChats=[];h.b.deps.secrets={get:()=>({telegram:{allowedChats:['42']}})};
  (h.t as any).allowedChats=()=>['42'];expect(h.bot.voiceBindings()).toEqual([{agentId:'assistant',chatKey:'telegram:42'}]);
  (h.t as any).allowedChats=()=>[];expect(h.bot.voiceBindings()).toEqual([]);
  (h.t as any).allowedChats=()=>['42'];h.b.deps.config.allowedChats=['99'];expect(h.bot.voiceBindings()).toEqual([]);
 });
 it('suppresses voice and canonical output after owner revocation or chat rebind',async()=>{
  for(const revoke of [(h:any)=>{h.b.deps.config.allowedChats=['99'];},(h:any)=>{h.b.chatAgent.set('telegram:42','other');}]) {
    const h=harness();const hold=deferred();const original=h.session.prompt.getMockImplementation()!;h.session.prompt.mockImplementationOnce(async()=>{await hold.promise;await original();});
    const running=h.bot.voiceTurn(h.input);await new Promise(r=>setTimeout(r,1));revoke(h);hold.resolve();
    expect((await running).status).toBe('detached');expect(h.input.onOutput).not.toHaveBeenCalled();expect(h.pushed).toEqual([]);
  }
 });
 it('never queues or retries a voice failure through the shared cascade',async()=>{
  const h=harness();const cascade={chainFor:vi.fn(()=>['test/model']),firstHealthy:vi.fn(()=>undefined),resolveModel:vi.fn(()=>({provider:'test',id:'model'})),queueDead:vi.fn(),isOpen:vi.fn(()=>false),noteFailure:vi.fn()};h.b.deps.cascade=cascade;
  expect(await h.bot.voiceTurn(h.input)).toEqual({status:'failed'});expect(cascade.queueDead).not.toHaveBeenCalled();expect(h.session.prompt).not.toHaveBeenCalled();
  cascade.firstHealthy.mockReturnValue('test/model' as never);h.session.prompt.mockRejectedValueOnce(new Error('ambiguous failure'));
  expect(await h.bot.voiceTurn(h.input)).toEqual({status:'failed'});expect(h.session.prompt).toHaveBeenCalledTimes(1);expect(cascade.queueDead).not.toHaveBeenCalled();expect(cascade.noteFailure).not.toHaveBeenCalled();
 });
 it('signals approval immediately but retains canonical turn ownership until the answer',async()=>{
  const h=harness();const hold=deferred();h.b.questions.ask=vi.fn(async()=>{await hold.promise;return null;});
  h.session.prompt.mockImplementationOnce(async()=>{const hook=(h.agents.getOrCreateSession.mock.calls[0] as any)[4];await hook({text:'Approve?',options:['Confirm','Cancel']});});
  const required=vi.fn();const controller=new AbortController();const running=h.bot.voiceTurn({...h.input,onApprovalRequired:required,signal:controller.signal});
  await new Promise(r=>setTimeout(r,1));expect(required).toHaveBeenCalledTimes(1);controller.abort();
  expect((await h.bot.voiceTurn(h.input)).text).toContain('queued');hold.resolve();expect((await running).status).toBe('detached');
 });
 it('narrows tools to the call\'s choice for the turn and restores the full set after',async()=>{
  const h=harness();let active=['read','bash','start_task'];const seen:string[][]=[];
  Object.assign(h.session,{getActiveToolNames:()=>[...active],setActiveToolsByName:vi.fn((n:string[])=>{active=[...n];}),getAllTools:()=>active.map(name=>({name,description:name+' tool'}))});
  h.session.prompt.mockImplementationOnce(async()=>{seen.push([...active]);});
  await h.bot.voiceTurn({...h.input,allowedTools:['read','start_task','not_an_agent_tool']});
  expect(seen[0]).toEqual(['read','start_task']);expect(active).toEqual(['read','bash','start_task']);
  const groups=await h.bot.voiceTools('assistant','telegram:42');
  expect(groups!.flatMap(g=>g.tools.map(t=>t.name)).sort()).toEqual(['bash','read','start_task']);
  expect(groups!.find(g=>g.id==='tasks')?.tools.map(t=>t.name)).toEqual(['start_task']);
  expect(await h.bot.voiceTools('assistant','telegram:99')).toBeUndefined();
 });
 it('lets a live voice turn ask clarifying questions out loud instead of blocking on buttons',async()=>{
  const h=harness();const ask=vi.fn();h.b.questions.ask=ask;let answer:any;
  h.session.prompt.mockImplementationOnce(async()=>{const hook=(h.agents.getOrCreateSession.mock.calls[0] as any)[4];answer=await hook({text:'For what?',options:['A','B'],kind:'question'});});
  await h.bot.voiceTurn(h.input);expect(answer).toMatchObject({spoken:true});expect(ask).not.toHaveBeenCalled();
 });
 it('tells the agent it is on a live call and caps utterances queued behind a busy chat',async()=>{
  const h=harness();await h.bot.voiceTurn(h.input);expect(String((h.session.prompt.mock.calls[0] as any[])[0])).toContain('Live voice call');
  const hold=deferred();h.session.prompt.mockImplementationOnce(()=>hold.promise);
  const text=h.bot.promptAgent(h.t as any,'42','assistant','long',{taskAckFrom:null});
  expect((await h.bot.voiceTurn(h.input)).status).toBe('completed');expect((await h.bot.voiceTurn(h.input)).status).toBe('completed');
  expect(await h.bot.voiceTurn(h.input)).toEqual({status:'busy'});hold.resolve();await text;
 });
 it('delivers what a live voice turn cannot speak to the Telegram chat the call started from',async()=>{
  const h=harness();const full='Speaking summary first. Then a link https://example.com/note. Plus a fallback sentence. One more sentence to speak. And a spare sentence. Last spare sentence.';
  h.session.prompt.mockImplementationOnce(async()=>{h.subscribers.forEach(f=>f({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:full}],stopReason:'stop'}]}));});
  expect((await h.bot.voiceTurn(h.input)).status).toBe('completed');
  const spoken=String((h.input.onOutput as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
  expect(spoken).toContain('Speaking summary first.');expect(spoken).not.toContain('https://');
  expect(h.pushed).toEqual([full]);
 });
 it('never mirrors a fully speakable voice reply into the chat',async()=>{
  const h=harness();h.session.prompt.mockImplementationOnce(async()=>{h.subscribers.forEach(f=>f({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'Short and speakable.'}],stopReason:'stop'}]}));});
  expect((await h.bot.voiceTurn(h.input)).status).toBe('completed');
  expect(h.pushed).toEqual([]);expect(h.input.onOutput).toHaveBeenCalledWith('Short and speakable.');
 });
 it('keeps confirmation hooks in the canonical chat and notifies the voice channel',async()=>{
  const h=harness();const ask=vi.fn(async()=>({choice:'Confirm',index:0,via:'button'}));h.b.questions.ask=ask;
  h.session.prompt.mockImplementationOnce(async()=>{const hook=(h.agents.getOrCreateSession.mock.calls[0] as any)[4];await hook({text:'Change a thing?',options:['Confirm','Cancel']});});
  await h.bot.voiceTurn(h.input);expect(ask).toHaveBeenCalledWith('assistant',{transport:'telegram',chatId:'42'},{text:'Change a thing?',options:['Confirm','Cancel']});expect(h.input.onOutput).toHaveBeenCalledWith(expect.stringContaining('existing chat'));
 });
});
describe('voice front in the bot',()=>{
 it('answers fast without the canonical session, then posts a summary and notes the call for the agent',async()=>{
  const h=harness();const complete=vi.fn(async()=>({role:'assistant',content:[{type:'text',text:'Sure, here.'}],stopReason:'stop',timestamp:1}));
  h.b.deps.modelRuntime={complete};(h.agents as any).resolveModel=vi.fn(()=>({provider:'openrouter',id:'fast'}));
  const custom=vi.fn(async()=>{});Object.assign(h.session,{sendCustomMessage:custom,agent:{state:{messages:[{role:'user',content:[{type:'text',text:'earlier question'}]}]}}});
  expect(h.bot.voiceFrontOpen('call-1','assistant','telegram:99')).toBe(false);
  expect(h.bot.voiceFrontOpen('call-1','assistant','telegram:42')).toBe(true);
  expect(await h.bot.voiceFrontTurn('call-1','Are you there?',new AbortController().signal)).toBe('Sure, here.');
  expect(h.session.prompt).not.toHaveBeenCalled();
  expect(String((complete.mock.calls[0] as any[])[1].systemPrompt)).toContain('earlier question');
  await h.bot.voiceFrontClose('call-1');
  expect(h.pushed.at(-1)).toContain('📞 Voice call');expect(h.pushed.at(-1)).toContain('You: Are you there?');
  expect(custom).toHaveBeenCalledWith(expect.objectContaining({customType:'voice-call'}),{deliverAs:'nextTurn'});
 });
});
describe('task steps for the page and the front',()=>{
 it('summarises a task session as readable steps: short paths, the command itself, notes as text',()=>{
  const h=harness();const home=process.env.HOME!;
  const messages=[{role:'assistant',content:[{type:'toolCall',name:'read',arguments:{path:`${home}/.local/share/pibot/agents/mentalhealthtech/drafts/character-ai.md`}},{type:'toolCall',name:'bash',arguments:{command:`cat ${home}/.local/share/pibot/agents/mentalhealthtech/drafts/character-ai.md | wc -l`}},{type:'text',text:'Reviewing the draft now.'}]}];
  (h.agents as any).sessions=new Map([['assistant::agent::assistant::task-t1',{agent:{state:{messages}}}]]);
  expect(h.bot.taskSteps('assistant','t1')).toEqual([{tool:'read',detail:'~/…/drafts/character-ai.md'},{tool:'bash',detail:'cat ~/…/drafts/character-ai.md | wc -l'},{detail:'Reviewing the draft now.'}]);
  expect(h.bot.taskActivity('assistant','t1')[0]).toBe('read ~/…/drafts/character-ai.md');
  expect(h.bot.taskSteps('assistant','missing')).toEqual([]);
 });
});
describe('cancelling a task from the page',()=>{
 it('cancels only this chat\'s own tasks',async()=>{
  const h=harness();const cancel=vi.fn(async()=>true);
  (h.agents as any).tasks={get:vi.fn(async(id:string)=>id==='mine'?{id,agentId:'assistant',chatKey:'telegram:42',status:'running'}:id==='other'?{id,agentId:'assistant',chatKey:'telegram:99',status:'running'}:undefined),cancel};
  expect(await h.bot.voiceCancelTask('assistant','telegram:99','mine')).toBeUndefined();
  expect(await h.bot.voiceCancelTask('assistant','telegram:42','other')).toBe(false);
  expect(await h.bot.voiceCancelTask('assistant','telegram:42','mine')).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
 });
});
describe('canonical turn gate',()=>{
 it('allows internal recursion without deadlock but rejects another voice turn',async()=>{const gate=new CanonicalTurnGate();await gate.run('a',async()=>{expect(gate.tryRun('a',async()=>1)).toBeUndefined();expect(await gate.run('a',async()=>2)).toBe(2);});expect(gate.busy('a')).toBe(false);});
});

it('sends contract reminders through the bound transport and acknowledges without replacing questions',async()=>{const h=harness();const acknowledge=vi.fn(()=>true);h.b.urgentSourceStores=new Set([{acknowledge}]);h.b.questions.ask=vi.fn();const input={agentId:'assistant',canonicalChatId:'telegram:42',text:'Renewal decision',decisionId:'d1',questionVersion:1,revision:'r1',deadline:Date.now()+600000};expect((await h.bot.sendUrgentSourceMessage(input)).status).toBe('accepted');const args=h.t.push.mock.calls.at(-1)!;expect(args[0]).toBe('42');const action=(args[1] as any).card.buttons[0].action;expect(await h.bot.handleAction(h.t as any,'99',action)).toContain('no longer');expect(acknowledge).not.toHaveBeenCalled();expect(await h.bot.handleAction(h.t as any,'42',action)).toContain('No call');expect(acknowledge).toHaveBeenCalledWith(action.slice(6),'telegram:42');expect(h.b.questions.ask).not.toHaveBeenCalled();h.b.chatAgent.set('telegram:42','other');expect((await h.bot.sendUrgentSourceMessage(input)).status).toBe('rejected');});

it('exposes only live accepted explicit-deadline questions for the exact bound voice agent',()=>{const h=harness();const now=Date.now();const q={qid:'q1',agentId:'assistant',canonicalChatId:'telegram:42',question:'Approve?',options:['Yes','No'],status:'pending',pendingUntil:now+60000,usefulUntil:now+60000,deadlineReason:'Deadline',provenance:'agent_declared_deadline',acceptedMessageAt:now};h.b.questions.pendingSnapshots=()=>[q];expect(h.bot.voicePendingDecision(h.input)).toEqual({decisionId:'q1',question:'Approve?',options:['Yes','No']});expect(h.bot.voicePendingDecision({...h.input,agentId:'other'})).toBeUndefined();for(const patch of [{status:'answered'},{acceptedMessageAt:undefined},{usefulUntil:undefined},{pendingUntil:now-1}]){h.b.questions.pendingSnapshots=()=>[{...q,...patch}];expect(h.bot.voicePendingDecision(h.input)).toBeUndefined();}});
