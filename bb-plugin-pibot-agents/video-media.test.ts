import {chmod,mkdir,mkdtemp,open,readFile,realpath,rename,stat,symlink,truncate,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('node:fs/promises',async original=>{const actual=await original<typeof import('node:fs/promises')>();return {...actual,open:vi.fn(actual.open)};});
import {createVideoMedia} from './video-media';
const name='12345678-1234-1234-1234-123456789abc.mp4';
async function fixture(contents=Buffer.from('0123456789')){
 const checkout=await realpath(await mkdtemp(join(tmpdir(),'pibot-video-')));await chmod(checkout,0o700);await mkdir(join(checkout,'data'),{mode:0o700});const media=join(checkout,'data','media');await mkdir(media,{mode:0o700});
 const file=join(media,name);await writeFile(file,contents,{mode:0o600});await chmod(file,0o600);return {checkout,media,file,contents};
}
const request=(url:string,init?:RequestInit)=>new Request(`http://localhost${url}`,init);
const fdForLastOpen=async()=>await vi.mocked(open).mock.results.at(-1)!.value;
const managers:Array<ReturnType<typeof createVideoMedia>>=[];
const manager=(options?:Parameters<typeof createVideoMedia>[0])=>{const m=createVideoMedia(options);managers.push(m);return m;};
afterEach(()=>{for(const m of managers)m.dispose();managers.length=0;});
describe('private saved video capabilities',()=>{
 it('issues stable opaque paths, streams bytes and preserves private file contents and permissions',async()=>{
  const f=await fixture(),m=manager(),before=await stat(f.file),url=await m.issue(f.file,f.checkout);
  expect(url).toMatch(/^\/api\/v1\/plugins\/pibot-agents\/http\/video\?id=[a-f0-9]{48}$/);expect(url).not.toContain(name);expect(url).not.toContain(f.checkout);expect((await fdForLastOpen()).fd).toBe(-1);
  expect(await m.issue(f.file,f.checkout)).toBe(url);const response=await m.handle(request(url!));const fd=await fdForLastOpen();
  expect(response.status).toBe(200);expect(response.headers.get('Content-Type')).toBe('video/mp4');expect(response.headers.get('Content-Disposition')).toBe('inline');expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(response.headers.get('Accept-Ranges')).toBe('bytes');expect(response.headers.get('Content-Length')).toBe('10');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.contents);expect(fd.fd).toBe(-1);expect(await readFile(f.file)).toEqual(f.contents);expect((await stat(f.file)).mode).toBe(before.mode);
 });
 it('supports generated digest filenames but rejects traversal, noncanonical paths, foreign files and URLs',async()=>{
  const f=await fixture(),m=manager(),digest=join(f.media,'a'.repeat(32)+'.mp4');await writeFile(digest,f.contents,{mode:0o600});expect(await m.issue(digest,f.checkout)).toBeTruthy();
  const foreign=await fixture();for(const file of [f.file.replace('/media/','/media/../media/'),join(f.media,'named.mp4'),join(f.media,'a'.repeat(64)+'.mp4'),foreign.file,'https://example.com/video.mp4','../video.mp4',f.file+'.png'])expect(await m.issue(file,f.checkout)).toBeUndefined();
  expect((await m.handle(request('/video?file='+encodeURIComponent(f.file)))).status).toBe(404);expect((await m.handle(request('/video?id=bad'))).status).toBe(404);const url=await m.issue(f.file,f.checkout);expect((await m.handle(request(url!+'&path='+encodeURIComponent(f.file)))).status).toBe(404);
 });
 it('rejects missing, linked, nonprivate or oversized files and unsafe media directories without changing modes',async()=>{
  const f=await fixture(),m=manager();expect(await m.issue(join(f.media,'b'.repeat(32)+'.mp4'),f.checkout)).toBeUndefined();
  await chmod(f.file,0o644);expect(await m.issue(f.file,f.checkout)).toBeUndefined();expect((await stat(f.file)).mode&0o777).toBe(0o644);await chmod(f.file,0o600);
  const link=join(f.media,'b'.repeat(32)+'.mp4');await symlink(f.file,link);expect(await m.issue(link,f.checkout)).toBeUndefined();
  await chmod(f.media,0o755);expect(await m.issue(f.file,f.checkout)).toBeUndefined();await chmod(f.media,0o700);
  const linkedRoot=await realpath(await mkdtemp(join(tmpdir(),'pibot-video-link-')));await symlink(f.checkout,join(linkedRoot,'checkout'));expect(await m.issue(f.file,join(linkedRoot,'checkout'))).toBeUndefined();
  const redirected=await fixture();await rename(redirected.media,redirected.media+'-moved');await symlink(redirected.media+'-moved',redirected.media);expect(await m.issue(redirected.file,redirected.checkout)).toBeUndefined();
  await truncate(f.file,200*1024*1024+1);expect(await m.issue(f.file,f.checkout)).toBeUndefined();
 });
 it('handles byte, open-ended and suffix ranges and rejects invalid or multiple ranges',async()=>{
  const f=await fixture(),m=manager(),url=(await m.issue(f.file,f.checkout))!;
  for(const [range,expected,header] of [['bytes=2-5','2345','bytes 2-5/10'],['bytes=7-','789','bytes 7-9/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=-100','0123456789','bytes 0-9/10'],['bytes=1-99','123456789','bytes 1-9/10']]){
   const response=await m.handle(request(url,{headers:{Range:range}}));expect(response.status).toBe(206);expect(response.headers.get('Content-Range')).toBe(header);expect(await response.text()).toBe(expected);expect((await fdForLastOpen()).fd).toBe(-1);
  }
  for(const value of ['bytes=10-','bytes=5-2','bytes=-0','bytes=-','bytes=0-1,3-4','items=0-1','bytes=9007199254740992-']){const response=await m.handle(request(url,{headers:{Range:value}}));expect(response.status).toBe(416);expect(response.headers.get('Content-Range')).toBe('bytes */10');expect(await response.text()).toBe('');expect((await fdForLastOpen()).fd).toBe(-1);}
 });
 it('returns HEAD metadata without a body and closes descriptors for denied methods and invalid ranges',async()=>{
  const f=await fixture(),m=manager(),url=(await m.issue(f.file,f.checkout))!;
  const head=await m.handle(request(url,{method:'HEAD'}));expect(head.status).toBe(200);expect(head.body).toBeNull();expect(head.headers.get('Content-Length')).toBe('10');expect((await fdForLastOpen()).fd).toBe(-1);
  const partial=await m.handle(request(url,{method:'HEAD',headers:{Range:'bytes=2-5'}}));expect(partial.status).toBe(206);expect(partial.body).toBeNull();expect(partial.headers.get('Content-Length')).toBe('4');expect((await fdForLastOpen()).fd).toBe(-1);
  const bad=await m.handle(request(url,{method:'POST'}));expect(bad.status).toBe(405);expect(bad.headers.get('Allow')).toBe('GET, HEAD');
 });
 it('expires and bounds capabilities while preserving active version identities across refreshes',async()=>{
  const f=await fixture();let time=0;const m=manager({now:()=>time,ttlMs:100,capacity:1}),url=(await m.issue(f.file,f.checkout))!;
  time=50;expect(await m.issue(f.file,f.checkout)).toBe(url);time=120;expect((await m.handle(request(url,{method:'HEAD'}))).status).toBe(200);time=151;expect((await m.handle(request(url))).status).toBe(404);
  const fresh=(await m.issue(f.file,f.checkout))!;expect(fresh).not.toBe(url);const second=join(f.media,'c'.repeat(32)+'.mp4');await writeFile(second,f.contents,{mode:0o600});expect(await m.issue(second,f.checkout)).toBeTruthy();expect((await m.handle(request(fresh))).status).toBe(404);
 });
 it('revalidates file identity and permissions on every request and invalidates old versions',async()=>{
  const f=await fixture(),m=manager(),url=(await m.issue(f.file,f.checkout))!;
  await chmod(f.file,0o644);expect((await m.handle(request(url))).status).toBe(404);await chmod(f.file,0o600);expect((await m.handle(request(url))).status).toBe(404);
  const current=(await m.issue(f.file,f.checkout))!;expect(current).not.toBe(url);await writeFile(f.file,Buffer.from('replacement'),{mode:0o600});expect((await m.handle(request(current))).status).toBe(404);expect((await fdForLastOpen()).fd).toBe(-1);
 });
 it('closes open descriptors on cancellation, abort, disposal and midstream permission revocation',async()=>{
  for(const mode of ['cancel','abort','dispose','revoke'] as const){
   const f=await fixture(Buffer.alloc(2*1024*1024,1)),m=manager(),url=(await m.issue(f.file,f.checkout))!,abort=new AbortController();const response=await m.handle(request(url,{signal:abort.signal}));const fd=await fdForLastOpen();
   if(mode==='cancel')await response.body!.cancel();
   else if(mode==='abort'){abort.abort();await expect(response.arrayBuffer()).rejects.toThrow();}
   else if(mode==='dispose'){m.dispose();await expect(response.arrayBuffer()).rejects.toThrow();expect(await m.issue(f.file,f.checkout)).toBeUndefined();expect((await m.handle(request(url))).status).toBe(404);}
   else{await chmod(f.file,0o644);await expect(response.arrayBuffer()).rejects.toThrow();}
   await vi.waitFor(()=>expect(fd.fd).toBe(-1));
  }
 });
});
