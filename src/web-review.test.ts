import { describe, expect, it } from 'vitest';
import { renderReviewPage, reviewDiff, reviewFocus, type ReviewProposal } from './web-review.js';
const proposal: ReviewProposal = { id:'assistant/guard', agent:'assistant', name:'guard', mode:'patch', description:'Verify the recipient', currentContent:'first\nold\nlast', content:'first\nnew\nlast', contentHash:'hash-123', history:[{t:1700000000000,summary:'Installed guard'}] };
describe('review workbench',()=>{
 it('escapes hostile skill metadata, source, CSRF and history without embedding JSON in scripts',()=>{
  const hostile='<script>alert("owned")</script>';
  const html=renderReviewPage({csrfToken:'"><img src=x>',proposals:[{...proposal,name:hostile,content:hostile,description:hostile,history:[{t:'bad',summary:hostile}]}],tab:'source'});
  expect(html).not.toContain(hostile);
  expect(html).toContain('&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt;');
  expect(html).toContain('value="&quot;&gt;&lt;img src=x&gt;"');
 });
 it('preserves filters and selection across server-rendered proposal links',()=>{
  const html=renderReviewPage({csrfToken:'token',proposals:[proposal,{...proposal,id:'coach/second',agent:'coach',name:'second'}],query:'new',agent:'assistant',focus:'Reliability',tab:'source',selectedId:proposal.id});
  expect(html).toContain('q=new&amp;agent=assistant&amp;focus=Reliability&amp;tab=source&amp;status=staged&amp;id=assistant%2Fguard');
  expect(html).toContain('1 of 2 proposals');
 });
 it('uses scoped POST actions with CSRF and content hash plus archive Undo',()=>{
  const html=renderReviewPage({csrfToken:'token',proposals:[proposal],undo:{agent:'assistant',name:'guard',archiveId:'receipt'}});
  expect(html).toContain('action="/review/assistant/guard/apply"');
  expect(html).toContain('name="_csrf" value="token"');
  expect(html).toContain('name="contentHash" value="hash-123"');
  expect(html).toContain('action="/review/assistant/guard/archive"');
  expect(html).toContain('action="/review/assistant/guard/restore"');
  expect(html).toContain('name="archiveId" value="receipt"');
 });
 it('renders exact changed lines and does not invent evidence or version history',()=>{
  const html=renderReviewPage({csrfToken:'token',proposals:[proposal]});
  expect(html).toContain('diff-line added');expect(html).toContain('diff-line removed');
  expect(html).toContain('No evaluation scores were recorded');
  expect(html).toContain('They do not establish a version ancestry');
  expect(html).toContain('Installed guard');
  expect(html).not.toContain('Passed');
 });
 it('renders clear empty and missing-current states',()=>{
  expect(renderReviewPage({csrfToken:'token',proposals:[]})).toContain('Nothing awaiting review');
  expect(renderReviewPage({csrfToken:'token',proposals:[proposal],query:'unmatched'})).toContain('No matching proposals');
  expect(renderReviewPage({csrfToken:'token',proposals:[{...proposal,currentContent:null}]})).toContain('Current installed text is unavailable');
 });
 it('keeps archived proposals out of the default queue and exposes them explicitly',()=>{
  const archived={...proposal,id:'assistant/archived',status:'archived' as const};
  expect(renderReviewPage({csrfToken:'token',proposals:[proposal,archived]})).toContain('1 of 2 proposals');
  expect(renderReviewPage({csrfToken:'token',proposals:[proposal,archived],status:'archived'})).toContain('1 of 2 proposals');
  expect(renderReviewPage({csrfToken:'token',proposals:[proposal,archived],status:'all'})).toContain('2 of 2 proposals');
 });
 it('falls back safely for documents too large for bounded comparison',()=>{
  const large=Array(1300).fill('<row>').join('\n');
  expect(reviewDiff(large,large+'new')).toContain('full current and proposed text');
  expect(reviewDiff(large,large+'new')).not.toContain('<row>');
 });
 it('identifies focus as a heuristic, with a stable fallback',()=>{
  expect(reviewFocus({name:'memory-digest'})).toBe('Memory');
  expect(reviewFocus({name:'rate-limit-recovery'})).toBe('Reliability');
  expect(reviewFocus({name:'unknown'})).toBe('Other');
 });
});
