import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const script = fs.readFileSync(new URL('./client.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const token = 'a'.repeat(64);
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function setup({ hash = '#token=' + token, audioReady = true, available = true } = {}) {
  class Element {
    constructor(id = '') { this.id = id; this.children = []; this.value = ''; this.disabled = ['start','stop','refresh','agent'].includes(id); this.hidden = id === 'play'; this.handlers = {}; this.textContent = ''; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    append(...children) { this.children.push(...children); if (this.id === 'agent' && !this.value) this.value = children[0].value; }
    replaceChildren() { this.children = []; this.value = ''; }
    get childElementCount() { return this.children.length; }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const elements = Object.fromEntries(['agent','start','stop','refresh','audio','status','agent-detail','play','transcript'].map(id => [id,new Element(id)]));
  const requests = [], replaced = [], timers = new Map();
  let microphoneCalls = 0, tracksStopped = 0, rtcClosed = 0;
  const track = {stop() { tracksStopped++; }};
  class RTC {
    iceGatheringState = 'complete';
    createDataChannel() { return {}; }
    addTrack() {}
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
    URLSearchParams,AbortController,AbortSignal,RTCPeerConnection:RTC,window,
    navigator:{mediaDevices:{async getUserMedia() { microphoneCalls++; return {getTracks:() => [track]}; }}},
    setTimeout(fn,ms) { const id = timers.size + 1; timers.set(id,{fn,ms}); return id; },clearTimeout(id) { timers.delete(id); },
    async fetch(path,opts) {
      requests.push({path,opts});
      return {ok:true,async json() { return path === '/api/agents' ? {agents:[{id:'one',name:'One',model:'test-model',available,reason:available ? undefined : 'Model unavailable'}],audioReady,speechProvider:'Deepgram'} : {sdp:'remote-sdp',type:'answer',pc_id:'test'}; }};
    },
  };
  vm.runInNewContext(script,context);
  return {elements,requests,replaced,window,timers,counts:() => ({microphoneCalls,tracksStopped,rtcClosed})};
}

test('missing token fails closed, strips fragment and makes no request',async () => {
  const ui = setup({hash:''}); await settle();
  assert.equal(ui.elements.start.disabled,true);
  assert.match(ui.elements.status.textContent,/private launch link/);
  assert.equal(ui.requests.length,0);
  assert.equal(ui.replaced[0][2],'/');
});
test('missing Deepgram credential disables Start with actionable status',async () => {
  const ui = setup({audioReady:false}); await settle();
  assert.equal(ui.elements.start.disabled,true);
  assert.match(ui.elements.status.textContent,/Deepgram credential/);
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
  assert.deepEqual(JSON.parse(offer.opts.body),{agentId:'one',sdp:'local-sdp',type:'offer'});
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
  assert.equal(ui.timers.size,0);
});
