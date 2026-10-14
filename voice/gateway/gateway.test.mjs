import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './gateway.mjs';
const HOST='voice-host.example-tailnet.ts.net';
const env={VOICE_ORIGIN:`https://${HOST}:8443`};
const signed=()=>new Request('https://voice.example/status',{method:'POST',headers:{'x-twilio-signature':'test'}});
test('only voice webhooks and media routes are public',async()=>{
 for(const path of ['/','/control/calls','/voice/bindings','/health']) assert.equal((await gateway.fetch(new Request('https://voice.example'+path),env)).status,404);
 assert.equal((await gateway.fetch(new Request('https://voice.example/answer',{method:'POST'}),env)).status,403);
});
test('forwards the original signed query and body without redirects',async()=>{
 const previous=globalThis.fetch;
 globalThis.fetch=async(request,options)=>{
  assert.equal(request.url,`https://${HOST}:8443/answer?attempt=abc`);
  assert.equal(request.headers.get('x-twilio-signature'),'test');
  assert.equal(await request.text(),'CallSid=example');
  assert.equal(options.redirect,'manual');return new Response('ok');
 };
 try{assert.equal((await gateway.fetch(new Request('https://voice.example/answer?attempt=abc',{method:'POST',headers:{'x-twilio-signature':'test'},body:'CallSid=example'}),env)).status,200);}finally{globalThis.fetch=previous;}
});
test('refuses a non-Tailscale or incorrectly scoped origin',async()=>{
 for(const origin of [undefined,'','not a url','https://example.com:8443',`http://${HOST}:8443`,`https://${HOST}`,`https://${HOST}:8443/private`,
  `https://${HOST}:8443/?q=1`,`https://user:pw@${HOST}:8443`,`https://extra.${HOST}:8443`,`https://${HOST}.evil.example:8443`,'https://ts.net:8443'])
  assert.equal((await gateway.fetch(signed(),{VOICE_ORIGIN:origin})).status,503,String(origin));
});
