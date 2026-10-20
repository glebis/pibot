import type { ProcessSnapshot } from "./core/processes.js";
import type { LedgerEntry } from "./durable/task-ledger.js";

type Esc = (s: unknown) => string;

/** 75 → "1m 15s", 9000 → "2h 30m" */
export function formatAge(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short", hour12: false });

const STATUS_PILL: Record<string, string> = { running: "on", queued: "", done: "on", failed: "bad", cancelled: "" };

/** Body of the /processes page (wrapped in the dashboard layout by the caller). */
export function renderProcesses(snap: ProcessSnapshot, esc: Esc, csrfField: () => string): string {
  const now = snap.takenAt;
  const age = (since: number) => formatAge((now - since) / 1000);
  const empty = (cols: number, text: string) => `<tr><td colspan="${cols}" class="muted">${esc(text)}</td></tr>`;

  const turns = snap.turns.map((t) => `<tr>
    <td><span class="pill">${esc(t.kind)}</span></td>
    <td>${t.agentId ? `<a href="/agents/${encodeURIComponent(t.agentId)}">${esc(t.agentId)}</a>` : '<span class="muted">—</span>'}</td>
    <td class="mono">${esc(t.chatKey ?? "—")}</td>
    <td>${esc(t.label)}</td>
    <td class="mono">${esc(t.model ?? "—")}</td>
    <td title="${esc(clock(t.startedAt))}">${age(t.startedAt)}</td></tr>`).join("");

  const taskRow = (e: LedgerEntry, live: boolean) => {
    const outcome = e.error ?? e.result ?? "";
    return `<tr>
    <td><span class="pill ${STATUS_PILL[e.status] ?? ""}">${esc(e.status)}</span></td>
    <td><a href="/agents/${encodeURIComponent(e.agentId)}">${esc(e.agentId)}</a></td>
    <td><strong>${esc(e.title)}</strong>${outcome
      ? `<details><summary class="muted">${esc(outcome.replace(/\s+/g, " ").slice(0, 110))}${outcome.length > 110 ? "…" : ""}</summary><pre class="events">${esc(outcome)}</pre></details>`
      : live ? "" : '<div class="muted">no result recorded</div>'}</td>
    <td title="${esc(clock(e.createdAt))}">${live ? age(e.createdAt) : `${esc(clock(e.updatedAt))}<div class="muted">took ${formatAge((e.updatedAt - e.createdAt) / 1000)}</div>`}</td>
    <td>${e.attempts}</td>
    <td>${live ? `<form method="post" action="/processes/tasks/${encodeURIComponent(e.id)}/cancel" class="inline" data-title="${esc(e.title)}" onsubmit="return confirm('Cancel task: ' + this.dataset.title + '?')">${csrfField()}<button class="mini danger" type="submit">Cancel</button></form>` : ""}</td></tr>`;
  };

  const goals = snap.goals.map((g) => `<tr>
    <td class="mono">${esc(g.chatKey)}</td><td>${esc(g.objective)}</td>
    <td>${g.turnsUsed} / ${g.maxTurns}</td><td title="${esc(clock(g.createdAt))}">${age(g.createdAt)}</td></tr>`).join("");

  const voice = snap.voiceCalls.map((v) => `<tr><td>${esc(v.agentId)}</td><td class="mono">${esc(v.chatKey)}</td></tr>`).join("");

  const children = snap.children.map((p) => `<tr>
    <td class="mono">${p.pid}</td>
    <td class="mono" style="padding-left:${8 + (p.depth - 1) * 16}px">${p.depth > 1 ? "└ " : ""}${esc(p.command.length > 160 ? `${p.command.slice(0, 160)}…` : p.command)}</td>
    <td>${formatAge(p.elapsedSec)}</td><td>${(p.rssKb / 1024).toFixed(0)} MB</td></tr>`).join("");

  const counts = [
    [snap.turns.length, "turns"], [snap.tasks.active.length, "tasks"], [snap.goals.length, "goals"],
    [snap.voiceCalls.length, "calls"], [snap.children.length, "OS processes"],
  ].map(([n, label]) => `<span class="pill ${n ? "on" : ""}">${n} ${label}</span>`).join("");

  return `
<div class="card row" style="align-items:baseline">
  <div>${counts}</div>
  <div class="muted" style="text-align:right">daemon pid <span class="mono">${snap.daemon.pid}</span> · up ${formatAge(snap.daemon.uptimeSec)} · ${(snap.daemon.rssKb / 1024).toFixed(0)} MB
    · updated ${esc(clock(now))} · <label style="display:inline"><input type="checkbox" id="live" checked> auto-refresh</label></div>
</div>

<h2>Model turns running now</h2>
<p class="muted">Every model call in flight — chat replies, heartbeats, background tasks, agent-to-agent messages, memory and evolution jobs.</p>
<table data-admin-list="turns"><tr><th>Kind</th><th>Agent</th><th>Chat</th><th>What</th><th>Model</th><th>Running</th></tr>${turns || empty(6, "No model calls running right now.")}</table>

<h2>Background tasks — running &amp; queued</h2>
<table data-admin-list="active tasks"><tr><th>Status</th><th>Agent</th><th>Task</th><th>Age</th><th>Tries</th><th></th></tr>${snap.tasks.active.map((e) => taskRow(e, true)).join("") || empty(6, "No background tasks running.")}</table>

<h2>Goal loops</h2>
<table data-admin-list="goals"><tr><th>Chat</th><th>Objective</th><th>Turns</th><th>Age</th></tr>${goals || empty(4, "No active /goal loops.")}</table>

<h2>Voice calls</h2>
<table data-admin-list="calls"><tr><th>Agent</th><th>Chat</th></tr>${voice || empty(2, "No voice call in progress.")}</table>

<h2>OS processes started by the daemon</h2>
${snap.childrenError ? `<div class="flash warn">Process listing failed: ${esc(snap.childrenError)}</div>` : ""}
<table data-admin-list="OS processes"><tr><th>PID</th><th>Command</th><th>Running</th><th>Memory</th></tr>${children || empty(4, "No child processes.")}</table>

<h2>Recently finished tasks</h2>
<table data-admin-list="recent tasks"><tr><th>Status</th><th>Agent</th><th>Task / result</th><th>Finished</th><th>Tries</th><th></th></tr>${snap.tasks.recent.map((e) => taskRow(e, false)).join("") || empty(6, "No finished tasks yet.")}</table>

<script>
(function(){
  // Reload every 5 s, but never while the owner is reading a result, searching, or has paused it.
  var box=document.getElementById('live');
  try{ box.checked = localStorage.getItem('processes.live') !== '0'; }catch(e){}
  box.onchange=function(){ try{ localStorage.setItem('processes.live', box.checked ? '1' : '0'); }catch(e){} };
  setInterval(function(){
    if(!box.checked) return;
    if(document.querySelector('details[open]')) return;
    var a=document.activeElement; if(a && (a.tagName==='INPUT' && a.type==='search')) return;
    location.reload();
  }, 5000);
})();
</script>`;
}
