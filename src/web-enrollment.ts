import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { EnrollmentRequest, FreeEnrollmentGrant } from './core/lab-enrollment.js';
export interface EnrollmentControl {
    list(query?: string): EnrollmentRequest[];
    listGrants?(): Omit<FreeEnrollmentGrant, 'tokenHash'>[];
    approve(id: string, note?: string): Promise<EnrollmentRequest>;
    reject(id: string, note?: string): Promise<EnrollmentRequest>;
    issue(chatId: string, ttlMs?: number): {
        url: string;
        grant: Omit<FreeEnrollmentGrant, 'tokenHash'>;
    };
    revoke(id: string): unknown;
    evidence(id: string): {
        localPath: string;
        sha256?: string;
        bytes?: number;
    } | undefined;
}
export function renderEnrollments(csrf: string): string {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Course access · PiBot</title><link rel="stylesheet" href="/inbox/assets/pico.css"><style>body{max-width:1200px;margin:auto;padding:24px}header,nav{display:flex;gap:24px}article{border:1px solid #33443d}button{width:auto}small{color:#9baaa1}pre{white-space:pre-wrap}#notice{color:#a8dbb4}img{max-height:450px;max-width:100%}.actions{display:flex;gap:12px}</style><nav><a href="/">Dashboard</a><a href="/inbox">Messages</a><a href="/lab-payments">Payments</a></nav><h1>Course access</h1><p>Review crypto evidence before approval. Free access requires a personal link and a questionnaire. The site verifies the recipient’s email.</p><details><summary>Create a personal free-access link</summary><form id="issue"><label>Recipient Telegram ID<input id="chat" required pattern="[1-9][0-9]{0,19}" placeholder="Numeric private chat ID"></label><button>Create 7-day link</button></form><p id="link"></p></details><label>Search requests and personal links<input id="search" type="search" placeholder="Telegram ID, email, answers, status…"></label><p id="notice" role="status" aria-live="polite"></p><main id="requests"></main><details><summary>Personal links</summary><div id="grants"></div></details><script>
 const csrf=${JSON.stringify(csrf).replace(/</g, '\\u003c')};let rows=[],grants=[];const $=id=>document.getElementById(id);const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e};
 async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data}
 function show(){const q=$('search').value.toLowerCase();$('requests').replaceChildren();for(const r of rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q))){const a=el('article');a.append(el('h2',r.email||'Telegram '+r.chatId),el('p',r.method+' · '+r.status+' · '+new Date(r.updatedAt).toLocaleString()),el('small',r.id));for(const x of r.answers)a.append(el('p',x.question+' ('+x.source+'): '+(x.text||'Skipped')));if(r.evidence?.text)a.append(el('pre',r.evidence.text));if(r.evidence?.localPath){const image=el('img');image.src='/api/enrollments/'+r.id+'/evidence';image.alt='Submitted transfer evidence';a.append(image)}if(r.status==='pending_review'){a.append(el('p','Check recipient, network, token and actual received transfer before approval. A screenshot alone is insufficient.'));const note=el('textarea');note.placeholder='Review note / verified transaction reference';note.setAttribute('aria-label','Review note');a.append(note);const actions=el('div');actions.className='actions';for(const action of ['approve','reject']){const b=el('button',action==='approve'?'Approve eligibility':'Reject request');b.onclick=async()=>{b.disabled=true;try{await api('/api/enrollments/'+r.id+'/'+action,{note:note.value||undefined});$('notice').textContent='Decision saved. Check the conversation for delivery status.';await refresh()}catch(e){$('notice').textContent=e.message;b.disabled=false}};actions.append(b)}a.append(actions)}const history=el('details');history.append(el('summary','Decision history'));for(const x of r.audit)history.append(el('p',new Date(x.at).toLocaleString()+' · '+x.action+(x.note?' · '+x.note:'')));a.append(history);$('requests').append(a)}if(!$('requests').children.length)$('requests').append(el('p','No matching requests.'));$('grants').replaceChildren();for(const g of grants.filter(g=>JSON.stringify(g).toLowerCase().includes(q))){const a=el('article');a.append(el('p','Telegram '+g.recipientChatId+' · '+(g.revokedAt?'Revoked':g.redeemedAt?'Redeemed':g.expiresAt<Date.now()?'Expired':'Available')+' · expires '+new Date(g.expiresAt).toLocaleString()));if(!g.revokedAt&&!g.redeemedAt){const b=el('button','Revoke');b.onclick=async()=>{try{await api('/api/enrollments/grants/'+g.id+'/revoke',{});await refresh()}catch(e){$('notice').textContent=e.message}};a.append(b)}$('grants').append(a)}}
 async function refresh(){const d=await api('/api/enrollments');rows=d.requests;grants=d.grants;show()}$('search').oninput=show;$('issue').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/enrollments/issue',{chatId:$('chat').value.trim()});const a=el('a',d.url);a.href=d.url;a.rel='noreferrer';$('link').replaceChildren(a);$('notice').textContent='Copy this personal link now. It is only usable by the specified Telegram account.';await refresh()}catch(e){$('notice').textContent=e.message}};refresh().catch(e=>$('notice').textContent=e.message);
 </script></html>`;
}
/** Register after dashboard authentication. */
export function registerEnrollmentRoutes(app: Hono, deps: {
    enrollment?: EnrollmentControl;
}, csrf: string, origins: string[]): void {
    app.use('/api/enrollments/*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); await next(); });
    app.get('/enrollments', c => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'same-origin'); return c.html(renderEnrollments(csrf)); });
    app.get('/api/enrollments', c => { if (!deps.enrollment)
        return c.json({ error: 'Enrollment is not configured.' }, 503); try {
        return c.json({ requests: deps.enrollment.list(), grants: deps.enrollment.listGrants?.() ?? [] });
    }
    catch {
        return c.json({ error: 'Enrollment data unavailable.' }, 503);
    } });
    app.get('/api/enrollments/:id/evidence', c => { try {
        const e = deps.enrollment?.evidence(c.req.param('id'));
        if (!e)
            return c.notFound();
        const fd = fs.openSync(e.localPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let b: Buffer;
        try {
            const s = fs.fstatSync(fd);
            if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.() || s.size > 20 * 1024 * 1024)
                throw Error();
            b = fs.readFileSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        if (!e.sha256 || createHash('sha256').update(b).digest('hex') !== e.sha256)
            throw Error();
        const mime = b[0] === 137 ? 'image/png' : b[0] === 255 ? 'image/jpeg' : b.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : 'image/webp';
        c.header('Content-Type', mime);
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Content-Security-Policy', "default-src 'none'; sandbox");
        return c.body(new Uint8Array(b));
    }
    catch {
        return c.json({ error: 'Evidence unavailable.' }, 404);
    } });
    app.post('/api/enrollments/*', async (c) => {
        if (c.req.header('x-csrf-token') !== csrf || !origins.includes(c.req.header('origin') ?? ''))
            return c.json({ error: 'CSRF failed.' }, 403);
        if (!deps.enrollment)
            return c.json({ error: 'Enrollment is not configured.' }, 503);
        if (!c.req.header('content-type')?.startsWith('application/json'))
            return c.json({ error: 'Expected JSON.' }, 415);
        const reader = c.req.raw.body?.getReader();
        if (!reader)
            return c.json({ error: 'Missing body.' }, 400);
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > 8000) {
                await reader.cancel();
                return c.json({ error: 'Request too large.' }, 413);
            }
            chunks.push(value);
        }
        let b: any;
        try {
            b = JSON.parse(Buffer.concat(chunks).toString());
            if (!b || typeof b !== 'object' || Array.isArray(b))
                throw Error();
        }
        catch {
            return c.json({ error: 'Invalid JSON.' }, 400);
        }
        const route = c.req.path.slice('/api/enrollments/'.length);
        try {
            if (route === 'issue') {
                if (typeof b.chatId !== 'string' || !/^[1-9]\d{0,19}$/.test(b.chatId))
                    return c.json({ error: 'Enter a numeric private Telegram ID.' }, 400);
                const r = deps.enrollment.issue(b.chatId);
                return c.json({ url: r.url, grant: { id: r.grant.id, recipientChatId: r.grant.recipientChatId, expiresAt: r.grant.expiresAt } });
            }
            const revoke = /^grants\/([a-f0-9-]{36})\/revoke$/.exec(route);
            if (revoke) {
                deps.enrollment.revoke(revoke[1]);
                return c.json({ ok: true });
            }
            const decision = /^([a-f0-9-]{36})\/(approve|reject)$/.exec(route);
            if (!decision)
                return c.notFound();
            if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 4000))
                return c.json({ error: 'Invalid review note.' }, 400);
            const r = await deps.enrollment[decision[2] as 'approve' | 'reject'](decision[1], b.note);
            return c.json({ request: r });
        }
        catch {
            return c.json({ error: 'Action could not be confirmed. Refresh the request and conversation before retrying.' }, 409);
        }
    });
}
