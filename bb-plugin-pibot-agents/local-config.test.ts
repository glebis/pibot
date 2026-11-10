import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,chmod,symlink,realpath,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const mocked=vi.hoisted(()=>({exec:vi.fn()}));
vi.mock('node:child_process',()=>({execFile:mocked.exec}));
import {readLocalConfig,readLocalDashboardConfig,readLocalAudioStartConfig,readLocalAudioToken} from './local-config';
let root:string;let key:string;
const web='fixture-dashboard-token',bridge='ab'.repeat(32);
async function file(path:string,text:string,mode=0o600){await writeFile(path,text,{mode});}
beforeEach(async()=>{
 root=await realpath(await mkdtemp(join(tmpdir(),'pibot-local-config-')));await mkdir(join(root,'data','voice'),{recursive:true,mode:0o700});
 key=join(root,'age-key');await file(key,'fixture');vi.stubEnv('SOPS_AGE_KEY_FILE',key);
 await file(join(root,'data','settings.enc.json'),'encrypted-dashboard-fixture');await file(join(root,'data','bridge.enc.json'),'encrypted-bridge-fixture');
 await file(join(root,'data','voice','bridge.json'),JSON.stringify({bridgePort:8792,secretsFile:join(root,'data','bridge.enc.json')}));
 mocked.exec.mockReset().mockImplementation((_binary,args,_options,cb)=>{queueMicrotask(()=>cb(null,args.includes('["web"]["token"]')?JSON.stringify(web):bridge));return {stdin:{on:vi.fn(),end:vi.fn()}};});
});
afterEach(()=>vi.unstubAllEnvs());
describe('explicit local configuration reader',()=>{
 it('loads only canonical bridge and encrypted speech credentials for explicit audio startup',async()=>{await file(join(root,'data','voice-speech.enc.json'),'encrypted-speech-fixture');mocked.exec.mockImplementation((_binary,args,_options,cb)=>{queueMicrotask(()=>cb(null,args.includes('["DEEPGRAM_API_KEY"]')?'fixture-speech-token':bridge));return {stdin:{on:vi.fn(),end:vi.fn()}};});expect(await readLocalAudioStartConfig(root)).toEqual({bridgePort:8792,bridgeToken:bridge,speechKey:'fixture-speech-token'});expect(mocked.exec).toHaveBeenCalledTimes(2);expect(mocked.exec.mock.calls.every(call=>!call[1].includes('["web"]["token"]'))).toBe(true);});
 it('reads existing browser credentials without rotation or accepting unsafe permissions',async()=>{const source=join(root,'data','voice','page-token');await file(source,bridge);expect(await readLocalAudioToken(root)).toBe(bridge);await chmod(source,0o644);await expect(readLocalAudioToken(root)).rejects.toThrow('unsafe');expect(mocked.exec).not.toHaveBeenCalled();});
 it('extracts only required keys and leaves missing audio unconfigured',async()=>{
 expect(await readLocalConfig(root)).toEqual({dashboardUrl:'http://127.0.0.1:7860',dashboardToken:web,bridgeUrl:'http://127.0.0.1:8792',bridgeToken:bridge});
 expect(mocked.exec).toHaveBeenCalledTimes(2);for(const call of mocked.exec.mock.calls){expect(call[1]).toContain('--extract');expect(call[1].at(-1)).toBe('/dev/stdin');expect(JSON.stringify(call[1])).not.toContain(web);expect(call[2].env.SOPS_AGE_KEY_FILE).toBe(key);}
 });
 it('discovers dashboard without any bridge configuration or unrelated extraction',async()=>{
 await rename(join(root,'data','voice','bridge.json'),join(root,'data','voice','unused-fixture'));
 expect(await readLocalDashboardConfig(root)).toEqual({dashboardUrl:'http://127.0.0.1:7860',dashboardToken:web});
 expect(mocked.exec).toHaveBeenCalledTimes(1);expect(mocked.exec.mock.calls[0][1]).toContain('["web"]["token"]');
 });
 it('applies private-file checks to dashboard discovery',async()=>{
 await chmod(join(root,'data','settings.enc.json'),0o644);await expect(readLocalDashboardConfig(root)).rejects.toThrow('unsafe');expect(mocked.exec).not.toHaveBeenCalled();
 });
 it('does not infer or import browser audio configuration',async()=>{await file(join(root,'data','voice','page-token'),'invalid',0o644);const result=await readLocalConfig(root);expect(result).not.toHaveProperty('audioToken');expect(result).not.toHaveProperty('audioUrl');});
 it('rejects relative roots and unsafe config modes before decryption',async()=>{await expect(readLocalConfig('relative')).rejects.toThrow('unsafe');await chmod(join(root,'data','voice','bridge.json'),0o644);await expect(readLocalConfig(root)).rejects.toThrow('unsafe');expect(mocked.exec).not.toHaveBeenCalled();});
 it('rejects oversized configuration and invalid ports',async()=>{const config=join(root,'data','voice','bridge.json');await file(config,'x'.repeat(16385));await expect(readLocalConfig(root)).rejects.toThrow('unsafe');await file(config,JSON.stringify({bridgePort:80,secretsFile:join(root,'data','bridge.enc.json')}));await expect(readLocalConfig(root)).rejects.toThrow('unsafe');expect(mocked.exec).not.toHaveBeenCalled();});
 it('rejects sources outside data and symlinks',async()=>{const config=join(root,'data','voice','bridge.json');await file(config,JSON.stringify({bridgePort:8792,secretsFile:key}));await expect(readLocalConfig(root)).rejects.toThrow('unsafe');await symlink(key,join(root,'data','link.enc.json'));await file(config,JSON.stringify({bridgePort:8792,secretsFile:join(root,'data','link.enc.json')}));await expect(readLocalConfig(root)).rejects.toThrow('unsafe');expect(mocked.exec).not.toHaveBeenCalled();});

 it('sanitizes decryption failures and validates extracted credentials',async()=>{mocked.exec.mockImplementationOnce((_binary,_args,_options,cb)=>{queueMicrotask(()=>cb(new Error('fixture-private-error'),'','private stderr'));return {stdin:{on:vi.fn(),end:vi.fn()}};});await expect(readLocalConfig(root)).rejects.toThrow(/^Local PiBot configuration is unavailable or unsafe/);mocked.exec.mockImplementationOnce((_binary,_args,_options,cb)=>{queueMicrotask(()=>cb(null,'bad'));return {stdin:{on:vi.fn(),end:vi.fn()}};});await expect(readLocalConfig(root)).rejects.toThrow('unsafe');});
});
