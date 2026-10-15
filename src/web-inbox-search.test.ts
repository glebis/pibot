import { describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { renderInbox } from './web-inbox.js';
class Element {
 id=''; value=''; textContent=''; className=''; type=''; disabled=false; children:Element[]=[]; style={cssText:''}; scrollTop=0;scrollHeight=100;
 onclick?:()=>void; oninput?:()=>void;
 append(...nodes:Element[]){this.children.push(...nodes)}
 replaceChildren(...nodes:Element[]){this.children=nodes}
 setAttribute(){}removeAttribute(){}addEventListener(){}focus(){}showModal(){}close(){}
 dispatchEvent(){this.oninput?.()}
 classList={toggle:()=>false};
}
function browser(){
 const elements=new Map<string,Element>();
 const get=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!};
 let address='http://localhost/inbox';
 const context=createContext({document:{getElementById:get,createElement:()=>new Element()},location:{href:address,search:''},history:{replaceState:(_a:unknown,_b:unknown,url:URL)=>{address=String(url)}},URL,URLSearchParams,Event:class{},console});
 const source=renderInbox('csrf').match(/<script>([\s\S]*?)<\/script>/)![1].replace(/loadPeople\(\)\.then\([\s\S]*?\);\s*$/, '');
 runInContext(source,context);
 return {get,run:(s:string)=>runInContext(s,context),address:()=>address};
}
describe('inbox local list searches',()=>{
 it('filters loaded messages without discarding the corpus or composer draft',()=>{
  const b=browser(); b.get('reply').value='Unsent draft';
  b.run(`renderMessages([{id:'1',direction:'in',text:'Need a memory skill'},{id:'2',direction:'out',text:'Try the plugin',status:'sent'}]);`);
  b.get('message-search').value='plugin';b.get('message-search').oninput!();
  expect(b.get('message-count').textContent).toBe('1 of 2 loaded messages');
  expect(b.get('timeline').children).toHaveLength(1);
  expect(b.run('currentMessages.length')).toBe(2);
  expect(b.get('reply').value).toBe('Unsent draft');
  expect(b.address()).toContain('mq=plugin');
  b.get('message-clear').onclick!();expect(b.get('timeline').children).toHaveLength(2);
 });
 it('keeps loading earlier available and applies search to subsequently loaded messages',()=>{
  const b=browser();b.get('message-search').value='earlier';
  b.run(`nextBefore='cursor';renderMessages([{id:'1',text:'new',direction:'in'}]);`);
  expect(b.get('message-count').textContent).toContain('Earlier messages are not searched until loaded');
  expect(b.get('timeline').children[0].textContent).toBe('Load earlier messages');
  b.run(`renderMessages([{id:'0',text:'earlier text',direction:'in'},...currentMessages]);`);
  expect(b.get('message-count').textContent).toContain('1 of 2 loaded messages');
 });
 it('filters bounded log lines safely and provides empty and count feedback',()=>{
  const b=browser();b.run(`currentLogLines=['start okay','<script>error</script>','done okay'];logsLoaded=true;logsTruncated=true;renderLogs();`);
  b.get('logs-search').value='error';b.get('logs-search').oninput!();
  expect(b.get('logs-text').textContent).toBe('<script>error</script>');
  expect(b.get('logs-count').textContent).toContain('1 of 3 loaded log lines');
  expect(b.get('logs-count').textContent).toContain('outside this bounded log');
  b.get('logs-search').value='absent';b.get('logs-search').oninput!();
  expect(b.get('logs-text').textContent).toContain('No matching loaded log lines');
  b.get('logs-clear').onclick!();
  expect(b.get('logs-text').textContent).toBe('start okay\n<script>error</script>\ndone okay');
 });
 it('reports filtered participant counts without hiding the active conversation',()=>{
  const b=browser();b.run(`conversations=[{name:'Anna',chatId:'1'},{name:'Gleb',chatId:'2'}];selected='2';renderPeople();`);
  b.get('search').value='Anna';b.get('search').oninput!();
  expect(b.get('count').textContent).toBe('1 / 2');expect(b.run('selected')).toBe('2');
 });
});
