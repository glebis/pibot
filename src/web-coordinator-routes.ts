import type { Hono } from 'hono';

export interface CoordinatorControl {
  inspect(): unknown;
  create(input: { sourceContractId: string; question: string; choices: string[]; deadline: number }): unknown;
}

function renderCoordinator(csrf: string): string {
  const token = JSON.stringify(csrf).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contract decisions · PiBot</title>
<style>body{font:17px/1.5 system-ui;max-width:760px;margin:2rem auto;padding:0 1rem;color:#18212c;background:#f8f9fb}label{display:block;margin:1rem 0}input,textarea,button{font:inherit;padding:.6rem;box-sizing:border-box}input,textarea{display:block;width:100%}button{cursor:pointer}button:disabled{cursor:wait}article{background:white;padding:1rem;margin:1rem 0;border:1px solid #ddd;border-radius:8px}article.uncertain{border:2px solid #9b5800}article p{margin:.5rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:1rem}small{display:block}#status{font-weight:600}</style>
<body><a href="/">Dashboard</a><h1>Contract decisions</h1><p>Queue a question for your own Telegram inbox under your approved contact mandate. This milestone sends messages only. It makes no telephone calls.</p>
<p>The contract reference below is entered manually. Contract ownership and its current contents are not verified here. An answer records a decision; it does not execute or change the contract.</p>
<form id="decision"><label>Contract reference<input name="sourceContractId" required maxlength="200" autocomplete="off"></label><label>Question<textarea name="question" required maxlength="2500" rows="3"></textarea></label><label>Choices, one per line<textarea name="choices" required rows="4" placeholder="Proceed&#10;Wait"></textarea><small>One to five distinct choices, up to 50 characters each.</small></label><label>Response deadline<input name="deadline" type="datetime-local" required><small>Shown in this browser’s local time.</small></label><button type="submit">Queue decision</button></form>
<p id="status" role="status" aria-live="polite"></p><button id="refresh" type="button">Refresh status</button><h2>Decisions and delivery attempts</h2><p>Uncertain delivery stays visible for review. Do not submit the same decision again if the result is unclear.</p><div id="state">Loading…</div><details><summary>Technical details</summary><pre id="raw-state"></pre></details>
<script>const csrf=${token};const status=document.getElementById('status');const state=document.getElementById('state');const form=document.getElementById('decision');
let available=false;
function availability(value){available=value;for(const field of form.elements)field.disabled=!value;}
function line(card,label,value){const p=document.createElement('p');const strong=document.createElement('strong');strong.textContent=label+': ';p.append(strong,document.createTextNode(String(value)));card.append(p);}
function render(data){state.replaceChildren();document.getElementById('raw-state').textContent=JSON.stringify(data,null,2);const decisions=Array.isArray(data.decisions)?data.decisions:[];const attempts=Array.isArray(data.attempts)?data.attempts:[];if(!decisions.length){state.textContent='No decisions queued yet.';return;}const deliveryLabels={planned:'Waiting to send',dispatching:'Sending — confirmation pending',accepted:'Accepted by Telegram',rejected:'Telegram rejected this message',unknown:'Delivery uncertain — review before any retry',cancelled:'Delivery cancelled'};const attentionLabels={pending:'Awaiting your attention',acknowledged:'Acknowledged',snoozed:'Snoozed'};for(const decision of decisions){const card=document.createElement('article');const title=document.createElement('h3');title.textContent=decision.question;card.append(title);line(card,'Contract reference',decision.sourceContractId);line(card,'Decision',decision.state==='answered'?'Answered':decision.state==='dismissed'?'Dismissed':decision.state==='cancelled'?'Cancelled':decision.state==='expired'?'Expired':'Open');if(decision.answer!==undefined)line(card,'Your answer',decision.answer);line(card,'Attention',attentionLabels[decision.attention]||decision.attention);const latest=attempts.filter(a=>a.decisionId===decision.id).sort((a,b)=>b.createdAt-a.createdAt)[0];line(card,'Message',latest?deliveryLabels[latest.status]||latest.status:'Not queued for delivery');if(latest&&(latest.status==='unknown'||latest.status==='dispatching'))card.classList.add('uncertain');if(latest&&latest.reason)line(card,'Delivery note',String(latest.reason).replaceAll('_',' '));line(card,'Deadline',new Date(decision.deadline).toLocaleString());state.append(card);}}
async function refresh(){try{const r=await fetch('/api/coordinator',{cache:'no-store'});const data=await r.json();availability(r.ok&&!data.paused&&data.workerHealthy!==false);if(r.ok){render(data);if(data.paused)status.textContent='Sending is paused for recovery review.';else if(data.workerHealthy===false)status.textContent='The message worker needs attention. New decisions are disabled.';}else{state.textContent=data.error||'Status unavailable.';status.textContent='New decisions are disabled until the coordinator is available.';}}catch{availability(false);status.textContent='Status unavailable. Try refreshing.';}}
availability(false);
document.getElementById('refresh').addEventListener('click',refresh);
form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Queuing decision…';const fields=new FormData(form);try{const r=await fetch('/api/coordinator/decisions',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({sourceContractId:fields.get('sourceContractId'),question:fields.get('question'),choices:String(fields.get('choices')).split('\\n').map(x=>x.trim()).filter(Boolean),deadline:new Date(String(fields.get('deadline'))).getTime()})});const data=await r.json();status.textContent=r.ok?'Decision queued. Delivery still depends on the approved mandate.':data.error||'Could not queue decision. Refresh before retrying.';await refresh();if(r.ok)form.reset();}catch{status.textContent='Result unclear. Refresh status before submitting again.';}finally{button.disabled=!available;}});refresh();</script></body></html>`;
}

/** The caller MUST mount these routes after the dashboard authentication gate. */
export function registerCoordinatorRoutes(app: Hono, deps: { coordinator?: CoordinatorControl }, csrf: string, origins: string[]): void {
  app.use('/api/coordinator/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.get('/coordinator', c => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(renderCoordinator(csrf));
  });
  app.get('/api/coordinator', async c => {
    c.header('Cache-Control', 'no-store');
    if (!deps.coordinator) return c.json({ error: 'Message coordinator is disabled.' }, 503);
    try { return c.json(await deps.coordinator.inspect() as object); }
    catch { return c.json({ error: 'Coordinator status unavailable.' }, 503); }
  });
  app.post('/api/coordinator/decisions', async c => {
    const origin = c.req.header('origin');
    if (c.req.header('x-csrf-token') !== csrf || (origin && !origins.includes(origin))) return c.json({ error: 'CSRF failed.' }, 403);
    if (!deps.coordinator) return c.json({ error: 'Message coordinator is disabled.' }, 503);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: 'Expected JSON.' }, 415);
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.json({ error: 'Missing body.' }, 400);
    let body: unknown;
    try {
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 12 * 1024) { await reader.cancel(); return c.json({ error: 'Decision too large.' }, 413); }
        chunks.push(value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return c.json({ error: 'Invalid JSON.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid decision.' }, 400);
    const input = body as Record<string, unknown>;
    const { sourceContractId, question, choices, deadline } = input;
    if (Object.keys(input).some(key => !['sourceContractId', 'question', 'choices', 'deadline'].includes(key)) ||
      typeof sourceContractId !== 'string' || !sourceContractId.trim() || sourceContractId.length > 200 ||
      typeof question !== 'string' || !question.trim() || question.length > 2500 ||
      !Array.isArray(choices) || choices.length < 1 || choices.length > 5 ||
      choices.some(value => typeof value !== 'string' || !value.trim() || value.length > 50) ||
      new Set(choices.map(value => String(value).trim())).size !== choices.length ||
      typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= Date.now() || deadline > 8640000000000000) {
      return c.json({ error: 'Enter a contract reference, question, one to five distinct choices, and a future deadline.' }, 400);
    }
    try {
      const result = await deps.coordinator.create({ sourceContractId: sourceContractId.trim(), question: question.trim(), choices: choices.map(value => String(value).trim()), deadline });
      return c.json(result as object, 201);
    } catch { return c.json({ error: 'Decision could not be confirmed. Refresh status before trying again.' }, 409); }
  });
}
