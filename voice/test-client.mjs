import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const script = fs.readFileSync(new URL('./client.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const token = 'a'.repeat(64);
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function setup({ hash = '#token=' + token, audioReady = true, realtimeReady = false, available = true, storage, hermes = false } = {}) {
  class Element {
    constructor(id = '') { this.id = id; this.children = []; this.value = ''; this.disabled = ['start','stop','refresh','agent'].includes(id); this.hidden = id === 'play'; this.handlers = {}; this.textContent = ''; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    setAttribute(name, value) { (this.attrs ??= {})[name] = value; }
    append(...children) { this.children.push(...children); if (this.id === 'agent' && !this.value) this.value = children[0].value; }
    replaceChildren() { this.children = []; this.value = ''; }
    get childElementCount() { return this.children.length; }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const elements = Object.fromEntries(['agent','start','stop','refresh','audio','status','agent-detail','play','transcript','mic','levels','mic-level','agent-level','device','scope-note','tools','tool-count','tools-none','tools-all','tools-toggle','tools-body','tools-presets','tools-head','live-agent','mute','modes','mode-front','mode-agent','mode-realtime','mode-note','mode-box','live-caption','mic-wrap','tasks-card','tasks','info'].map(id => [id,new Element(id)]));
  const requests = [], replaced = [], timers = new Map();
  let microphoneCalls = 0, tracksStopped = 0, rtcClosed = 0; const channels = []; const intervals = new Set();
  const track = {stop() { tracksStopped++; }};
  const sender = {track:{kind:'audio'},replaced:[],async replaceTrack(t) { this.replaced.push(t); }};
  const track2 = {label:'USB mic',enabled:true,stop() {}};
  class RTC {
    iceGatheringState = 'complete';
    createDataChannel() { const channel = {}; channels.push(channel); return channel; }
    addTrack() {}
    getSenders() { return [sender]; }
    createOffer() { return Promise.resolve({type:'offer',sdp:'local-sdp'}); }
    setLocalDescription(description) { this.localDescription = description; return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    addEventListener() {}
    removeEventListener() {}
    close() { rtcClosed++; }
  }
  const window = {RTCPeerConnection:RTC,addEventListener(name,fn) { this[name] = fn; }};
  const context = {
    document:{getElementById:id => elements[id],createElement:() => new Element()},
    location:{hash,pathname:'/',search:''},history:{replaceState(...args) { replaced.push(args); }},
    ...(storage ? {sessionStorage:storage,localStorage:storage} : {}),URLSearchParams,AbortController,AbortSignal,RTCPeerConnection:RTC,window,
    navigator:{mediaDevices:{async getUserMedia() { microphoneCalls++; const t = microphoneCalls > 1 ? track2 : track; return {getTracks:() => [t],getAudioTracks:() => [t]}; }}},
    setTimeout(fn,ms) { const id = timers.size + 1; timers.set(id,{fn,ms}); return id; },clearTimeout(id) { timers.delete(id); },
    setInterval(fn,ms) { intervals.add(ms); return 'i' + ms; },clearInterval() { intervals.clear(); },
    async fetch(path,opts) {
      requests.push({path,opts});
      return {ok:true,async json() { return path.startsWith('/api/tasks') ? {tasks:[{id:'t1',title:'Sources',status:'done',result:'Five found.',createdAt:Date.now()}]} : path.startsWith('/api/tools') ? {groups:[{id:'core',tools:[{name:'read',description:'Read'},{name:'bash',description:'Shell'}]}]} : path === '/api/agents' ? {agents:[{id:'one',name:'One',model:'test-model',...(hermes ? {backend:'hermes',modes:['agent','realtime'],toolSelection:false,nativeApprovals:true} : {}),available,reason:available ? undefined : 'Model unavailable'}],audioReady,realtimeReady,speechProvider:'Deepgram'} : {sdp:'remote-sdp',type:'answer',pc_id:'test'}; }};
    },
  };
  vm.runInNewContext(script,context);
  return {elements,requests,replaced,window,timers,intervals,track,sender,track2,channels,counts:() => ({microphoneCalls,tracksStopped,rtcClosed})};
}

test('Hermes falls back to Agent without Realtime, hides false tool restrictions, and submits no tool override',async () => {
  const map = new Map([['pibot-voice-mode','realtime'],['pibot-voice-tools-open','1']]);
  const storage = {getItem:k => map.get(k) ?? null,setItem:(k,v) => map.set(k,v),removeItem:k => map.delete(k)};
  const ui = setup({hermes:true,storage}); await settle();
  assert.equal(ui.elements['mode-front'].hidden,true);
  assert.equal(ui.elements['mode-realtime'].hidden,true);
  assert.equal(ui.elements['mode-agent'].attrs['aria-pressed'],'true');
  assert.equal(ui.elements['tools-presets'].hidden,true);
  assert.equal(ui.elements['tools-none'].disabled,true);
  assert.match(ui.elements.tools.children[0].textContent,/native policy/);
  assert.match(ui.elements['scope-note'].textContent,/selected Hermes session/);
  assert.ok(!ui.requests.some(r => r.path.startsWith('/api/tools')));
  ui.elements.start.handlers.click(); await settle();
  const offer = ui.requests.find(request => request.path === '/api/offer');
  assert.deepEqual(JSON.parse(offer.opts.body),{agentId:'one',sdp:'local-sdp',type:'offer',mode:'agent'});
});

test('Hermes Realtime uses selected mode without tool overrides and names the real audio provider',async () => {
  const map = new Map([['pibot-voice-mode','realtime']]);
  const storage = {getItem:k => map.get(k) ?? null,setItem:(k,v) => map.set(k,v)};
  const ui = setup({hermes:true,realtimeReady:true,storage}); await settle();
  assert.equal(ui.elements['mode-front'].hidden,true);
  assert.equal(ui.elements['mode-realtime'].hidden,false);
  assert.equal(ui.elements['mode-realtime'].attrs['aria-pressed'],'true');
  assert.match(ui.elements['scope-note'].textContent,/selected Hermes session.*OpenAI/);
  assert.match(ui.elements['mode-note'].textContent,/native.*Hermes/i);
  assert.doesNotMatch(ui.elements['mode-note'].textContent,/background tasks/i);
  assert.ok(!ui.requests.some(r => r.path.startsWith('/api/tools')));
  ui.elements.start.handlers.click(); await settle();
  const offer = ui.requests.find(r => r.path === '/api/offer');
  assert.deepEqual(JSON.parse(offer.opts.body),{agentId:'one',sdp:'local-sdp',type:'offer',mode:'realtime'});
  assert.match(ui.elements['live-caption'].textContent,/^Realtime ·/);
  ui.elements.stop.handlers.click(); await settle();
  ui.elements['mode-agent'].handlers.click();
  assert.match(ui.elements['scope-note'].textContent,/Deepgram/);
  ui.elements.start.handlers.click(); await settle();
  assert.equal(JSON.parse(ui.requests.filter(r => r.path === '/api/offer').at(-1).opts.body).mode,'agent');
});

test('Realtime can start without Deepgram, while switching to Agent fails closed',async () => {
  const map = new Map([['pibot-voice-mode','realtime']]);
  const storage = {getItem:k => map.get(k) ?? null,setItem:(k,v) => map.set(k,v)};
  const ui = setup({hermes:true,realtimeReady:true,audioReady:false,storage}); await settle();
  assert.equal(ui.elements.start.disabled,false);
  assert.doesNotMatch(ui.elements.status.textContent,/Speech isn’t set up/);
  ui.elements.start.handlers.click(); await settle();
  assert.equal(JSON.parse(ui.requests.find(r => r.path === '/api/offer').opts.body).mode,'realtime');
  ui.elements.stop.handlers.click(); await settle();
  ui.elements['mode-agent'].handlers.click();
  assert.equal(ui.elements.start.disabled,true);
  const before = ui.counts().microphoneCalls;
  ui.elements.start.handlers.click(); await settle();
  assert.equal(ui.counts().microphoneCalls,before);
  ui.elements['mode-realtime'].handlers.click();
  assert.equal(ui.elements.start.disabled,false);
});

test('Pi Realtime keeps the selected tool set and does not force Agent mode',async () => {
  const ui = setup({realtimeReady:true}); await settle();
  assert.equal(ui.elements['mode-front'].hidden,false);
  assert.equal(ui.elements['mode-realtime'].hidden,false);
  ui.elements['mode-realtime'].handlers.click();
  ui.elements['tools-none'].handlers.click();
  ui.elements.start.handlers.click(); await settle();
  assert.deepEqual(JSON.parse(ui.requests.find(r => r.path === '/api/offer').opts.body),
    {agentId:'one',sdp:'local-sdp',type:'offer',mode:'realtime',tools:[]});
});

test('missing token fails closed, strips fragment and makes no request',async () => {
  const ui = setup({hash:''}); await settle();
  assert.equal(ui.elements.start.disabled,true);
  assert.match(ui.elements.status.textContent,/open the link once/);
  assert.equal(ui.requests.length,0);
  assert.equal(ui.replaced[0][2],'/');
});
test('the bare address reuses the key remembered from the first link',async () => {
  const map = new Map(), storage = {getItem:k => map.get(k) ?? null,setItem:(k,v) => map.set(k,v),removeItem:k => map.delete(k)};
  setup({storage}); await settle();
  const reloaded = setup({hash:'',storage}); await settle();
  assert.equal(reloaded.requests[0].opts.headers.Authorization,'Bearer ' + token);
  assert.equal(reloaded.elements.start.disabled,false);
});
test('missing Deepgram credential disables Start with actionable status',async () => {
  const ui = setup({audioReady:false}); await settle();
  assert.equal(ui.elements.start.disabled,true);
  assert.match(ui.elements.status.textContent,/Speech isn’t set up/);
  ui.elements.start.handlers.click(); await settle();
  assert.equal(ui.counts().microphoneCalls,0);
});
test('unavailable agent disables Start and explains why',async () => {
  const ui = setup({available:false}); await settle();
  assert.equal(ui.elements.start.disabled,true);
  assert.equal(ui.elements['agent-detail'].textContent,'Model unavailable');
  ui.elements.start.handlers.click(); await settle();
  assert.equal(ui.counts().microphoneCalls,0);
});
test('Start uses selected agent and bearer auth; Stop closes microphone and RTC',async () => {
  const ui = setup(); await settle();
  assert.equal(ui.elements.start.disabled,false);
  assert.equal(ui.counts().microphoneCalls,0);
  ui.elements.start.handlers.click(); await settle();
  assert.equal(ui.counts().microphoneCalls,1);
  const offer = ui.requests.find(request => request.path === '/api/offer');
  assert.deepEqual(JSON.parse(offer.opts.body),{agentId:'one',sdp:'local-sdp',type:'offer',mode:'front',tools:['read','bash']});
  for (const request of ui.requests) {
    assert.equal(request.opts.headers.Authorization,'Bearer ' + token);
    assert.equal(request.opts.credentials,'omit');
    assert.equal(request.path.includes(token),false);
  }
  assert.equal(ui.elements.stop.disabled,false);
  assert.ok([...ui.timers.values()].some(timer => timer.ms === 15 * 60 * 1000));
  ui.elements.stop.handlers.click();
  assert.equal(ui.counts().tracksStopped,1);
  assert.equal(ui.counts().rtcClosed,1);
  await settle();
  assert.equal(ui.requests.at(-1).path,'/api/session');
  assert.equal(ui.requests.at(-1).opts.method,'DELETE');
  assert.equal(ui.elements.start.disabled,false);
  assert.equal(ui.elements.stop.disabled,true);
  // the call's timers are gone; only the task panel's refresh keeps running
  assert.ok(![...ui.timers.values()].some(timer => timer.ms === 15 * 60 * 1000));
  assert.ok([...ui.timers.values()].every(timer => timer.ms === 5000));
});

test('the call carries the owner\'s tool choice: every tool by default, none after the preset',async () => {
  const ui = setup(); await settle();
  ui.elements.start.handlers.click(); await settle();
  let offer = ui.requests.find(request => request.path === '/api/offer');
  assert.deepEqual(JSON.parse(offer.opts.body).tools,['read','bash']);
  ui.elements.stop.handlers.click(); await settle();
  ui.elements['tools-none'].handlers.click();
  ui.elements.start.handlers.click(); await settle();
  offer = ui.requests.filter(request => request.path === '/api/offer').at(-1);
  assert.deepEqual(JSON.parse(offer.opts.body).tools,[]);
});

test('mute disables the microphone track for the call and resets when it ends',async () => {
  const ui = setup(); await settle();
  assert.equal(ui.elements.mute.hidden,true);
  ui.elements.start.handlers.click(); await settle();
  assert.equal(ui.elements.mute.hidden,false);
  ui.elements.mute.handlers.click();
  assert.equal(ui.track.enabled,false);
  assert.equal(ui.elements.mute.textContent,'Unmute');
  ui.elements.mute.handlers.click();
  assert.equal(ui.track.enabled,true);
  ui.elements.mute.handlers.click();
  ui.elements.stop.handlers.click(); await settle();
  assert.equal(ui.elements.mute.hidden,true);
  assert.equal(ui.elements.mute.textContent,'Mute');
});

test('the call uses the chosen voice mode, and the task panel lists background tasks',async () => {
  const ui = setup(); await settle();
  assert.equal(ui.elements['tasks-card'].hidden,false);
  assert.equal(ui.elements.tasks.children.length,1);
  ui.elements['mode-agent'].handlers.click();
  ui.elements.start.handlers.click(); await settle();
  const offer = ui.requests.find(request => request.path === '/api/offer');
  assert.equal(JSON.parse(offer.opts.body).mode,'agent');
  assert.equal(ui.elements['mode-front'].disabled,true);
});

test('an end message from the agent ends the call like pressing End',async () => {
  const ui = setup(); await settle();
  ui.elements.start.handlers.click(); await settle();
  assert.equal(ui.elements.stop.disabled,false);
  ui.channels.at(-1).onmessage({data:JSON.stringify({type:'end',text:'Call ended.'})}); await settle();
  assert.equal(ui.elements.stop.disabled,true);
  assert.equal(ui.counts().tracksStopped,1);
  assert.equal(ui.requests.at(-1).opts.method,'DELETE');
  assert.equal(ui.elements.status.textContent,'Call ended');
});

test('switching the microphone during a call swaps the sent track and keeps mute',async () => {
  const ui = setup(); await settle();
  ui.elements.start.handlers.click(); await settle();
  assert.equal(ui.elements.mic.disabled,false);
  ui.elements.mute.handlers.click();
  ui.elements.mic.value = 'usb'; ui.elements.mic.handlers.change(); await settle();
  assert.deepEqual(ui.sender.replaced,[ui.track2]);
  assert.equal(ui.counts().tracksStopped,1);
  assert.equal(ui.track2.enabled,false);
  assert.equal(ui.counts().microphoneCalls,2);
});

test('the call bar shows the mode and a running clock that stops with the call',async () => {
  const ui = setup(); await settle();
  assert.match(ui.elements['mode-note'].textContent,/background tasks/);
  assert.match(ui.elements['mode-front'].attrs['data-tip'],/background tasks/);
  assert.equal(ui.elements['mode-realtime'].hidden,true); // no realtime key reported
  ui.elements.start.handlers.click(); await settle();
  assert.match(ui.elements['live-caption'].textContent,/^Fast · 0:00( · connecting…)?$/);
  assert.ok(ui.intervals.has(1000));
  ui.elements.stop.handlers.click(); await settle();
  assert.equal(ui.intervals.size,0);
});
