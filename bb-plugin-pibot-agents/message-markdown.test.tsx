// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent} from '@testing-library/react';
import {definePluginApp} from '@get-bb/plugin-sdk/app';
import {loadPluginApp,renderSlot} from '@get-bb/plugin-sdk/testing/app';
import {MessageMarkdown} from './message-markdown';

afterEach(cleanup);
async function markdown(content:string){
 const app=await loadPluginApp(()=>({default:definePluginApp(app=>{
  app.slots.navPanel({id:'markdown',title:'Markdown',icon:'Link',path:'markdown',component:()=> <MessageMarkdown content={content}/>});
 })}));
 return renderSlot(app.navPanels[0],{},{openUrl:()=>true});
}

it('activates plain, Markdown and inline-code web URLs through BB navigation',async()=>{
 const url='http://127.0.0.1:8734/';
 const view=await markdown(`${url}\n\n[Dashboard](${url})\n\n\`${url}\``);
 const links=view.getAllByRole('link');
 expect(links).toHaveLength(3);
 expect(links[2].querySelector('code')?.textContent).toBe(url);
 for(const link of links){expect(link.getAttribute('href')).toBe(url);fireEvent.click(link);}
 expect(view.navigateCalls).toEqual(Array.from({length:3},()=>({method:'openUrl',url})));
});

it('keeps fenced code, commands, invalid URLs and unsafe schemes inert',async()=>{
 const view=await markdown('```\nhttp://127.0.0.1:8734/\n```\n\n```text\nhttps://example.com/\n```\n\n`curl http://127.0.0.1:8734/`\n\n`https://`\n\n`javascript:alert(1)`\n\n[Unsafe](javascript:alert(1))');
 expect(view.queryAllByRole('link')).toHaveLength(0);
 expect(view.container.querySelectorAll('pre code')).toHaveLength(2);
 expect(view.getByText('curl http://127.0.0.1:8734/').tagName).toBe('CODE');
});

it('preserves an existing link around a code URL without nesting anchors',async()=>{
 const view=await markdown('[`http://127.0.0.1:8734/`](https://example.com/dashboard)\n\n[`http://127.0.0.1:8734/`](javascript:alert(1))');
 const links=view.getAllByRole('link');
 expect(links).toHaveLength(1);
 expect(links[0].getAttribute('href')).toBe('https://example.com/dashboard');
 expect(links[0].querySelector('a')).toBeNull();
 expect(links[0].querySelector('code')?.textContent).toBe('http://127.0.0.1:8734/');
 fireEvent.click(links[0]);
 expect(view.navigateCalls).toEqual([{method:'openUrl',url:'https://example.com/dashboard'}]);
});
