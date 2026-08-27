import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import type { AgentManager, LoadedAgent } from "./core/agent-manager.js";
import { listSkillDirs } from "./core/agent-manager.js";
import type { EventLog } from "./core/events.js";
import type { EvolutionEngine } from "./core/evolution.js";
import type { Scheduler } from "./core/scheduler.js";
import type { AgentManifest, Schedule } from "./core/types.js";
import { loadSettings, saveSettings } from "./config.js";
import { errorMessage, fmtWhen, parseDuration, readJson, truncate, writeJsonAtomic } from "./core/util.js";

export interface TelegramControl {
  hasTransport(name: string): boolean;
  telegramUsername(): string | undefined;
  enableTelegram(token: string, allowedChats: string[]): Promise<{ ok: boolean; botName?: string; error?: string }>;
  disableTelegram(): Promise<boolean>;
}

export interface WebDeps {
  agents: AgentManager;
  scheduler: Scheduler;
  events: EventLog;
  evolution: EvolutionEngine;
  dataDir: string;
  telegram?: TelegramControl;
}

// ─── rendering helpers ──────────────────────────────────────────────────────

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, flash?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · pibot</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d0f12; color: #d7dce2; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: #8ab4ff; text-decoration: none; } a:hover { text-decoration: underline; }
  main { max-width: 880px; margin: 0 auto; padding: 32px 24px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #8a94a3; margin: 36px 0 10px; border-bottom: 1px solid #22262d; padding-bottom: 6px; }
  .sub { color: #8a94a3; font-size: 13px; margin: 0 0 24px; }
  .card { background: #14171c; border: 1px solid #23272f; border-radius: 10px; padding: 16px 18px; margin: 12px 0; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .row > * { flex: 1 1 160px; }
  label { display: block; font-size: 12px; color: #8a94a3; margin: 10px 0 4px; }
  input[type=text], input[type=number], textarea, select {
    width: 100%; background: #0d0f12; color: #d7dce2; border: 1px solid #2b313b; border-radius: 7px;
    padding: 7px 10px; font: inherit; font-size: 14px;
  }
  textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
  button, .btn {
    display: inline-block; background: #2563eb; color: #fff; border: 0; border-radius: 7px;
    padding: 7px 14px; font: inherit; font-size: 14px; cursor: pointer; margin-top: 10px;
  }
  button.ghost, .btn.ghost { background: transparent; border: 1px solid #2b313b; color: #aab3bf; }
  button.danger { background: #7f1d1d; }
  button.mini { padding: 3px 10px; font-size: 12px; margin: 0; }
  .flash { background: #10321c; border: 1px solid #1d5c33; color: #9fe0b5; border-radius: 8px; padding: 10px 14px; margin: 0 0 20px; }
  .flash.warn { background: #332a10; border-color: #5c4d1d; color: #e0cd9f; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: #8a94a3; font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid #22262d; }
  td { padding: 8px; border-bottom: 1px solid #1a1e24; vertical-align: top; }
  .muted { color: #8a94a3; font-size: 13px; }
  code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
  .pill { display: inline-block; border: 1px solid #2b313b; border-radius: 999px; padding: 1px 10px; font-size: 12px; color: #aab3bf; margin-right: 6px; }
  .pill.on { border-color: #1d5c33; color: #9fe0b5; }
  form.inline { display: inline; }
  pre.events { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #9aa4b1; max-height: 260px; overflow: auto; margin: 0; white-space: pre-wrap; }
</style></head><body><main>
<h1>🤖 pibot config</h1>
<p class="sub">agents · rhythm · schedules · evolution${flash ? "" : ""}</p>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
${body}
</main></body></html>`;
}

function manifestForm(agent: LoadedAgent): string {
  const m = agent.manifest;
  const hb = m.heartbeat ?? { enabled: false, interval: "45m", model: "same" };
  const ev = m.evolution ?? { enabled: false, interval: "6h", model: "same" };
  const qh = hb.quietHours ?? { from: "23:00", to: "08:00" };
  return `
<form method="post" action="/agents/${esc(agent.id)}/manifest" class="card">
  <div class="row">
    <div><label>Description</label><input type="text" name="description" value="${esc(m.description ?? "")}"></div>
    <div><label>Model (pi shorthand, empty = auto)</label><input type="text" name="model" value="${esc(m.model ?? "")}" placeholder="sonnet:medium"></div>
  </div>
  <div class="row">
    <div><label>Thinking</label>
      <select name="thinking">
        ${["off", "minimal", "low", "medium", "high"].map((t) => `<option ${((m.thinking ?? "off") === t ? "selected" : "")}>${t}</option>`).join("")}
      </select></div>
    <div><label>Tools (comma-separated)</label><input type="text" name="tools" value="${esc((m.tools ?? []).join(","))}"></div>
  </div>
  <h2 style="border:0;margin-top:18px">Heartbeat</h2>
  <div class="row">
    <div><label class="mono">enabled <input type="checkbox" name="hb_enabled" ${hb.enabled ? "checked" : ""} style="width:auto"></label></div>
    <div><label>Interval</label><input type="text" name="hb_interval" value="${esc(hb.interval)}"></div>
    <div><label>Model</label><input type="text" name="hb_model" value="${esc(hb.model ?? "same")}"></div>
  </div>
  <div class="row">
    <div><label>Quiet from</label><input type="text" name="hb_from" value="${esc(qh.from)}"></div>
    <div><label>Quiet to</label><input type="text" name="hb_to" value="${esc(qh.to)}"></div>
  </div>
  <h2 style="border:0;margin-top:18px">Evolution</h2>
  <div class="row">
    <div><label class="mono">enabled <input type="checkbox" name="ev_enabled" ${ev.enabled ? "checked" : ""} style="width:auto"></label></div>
    <div><label>Interval</label><input type="text" name="ev_interval" value="${esc(ev.interval ?? "6h")}"></div>
    <div><label>Model</label><input type="text" name="ev_model" value="${esc(ev.model ?? "same")}"></div>
  </div>
  <button type="submit">Save manifest</button>
</form>`;
}

// ─── app factory ────────────────────────────────────────────────────────────

export function createWebApp(deps: WebDeps): Hono {
  const app = new Hono();

  const agentOr404 = (id: string): LoadedAgent | null => {
    const a = deps.agents.getAgent(id);
    return a ?? null;
  };

  // ── overview ──
  app.get("/", (c) => {
    const agents = deps.agents.list();
    const cards = agents
      .map((a) => {
        const pending = deps.scheduler.list(a.id).filter((j) => !j.internal);
        const sn = deps.scheduler.snoozeState(a.id);
        const staged = deps.evolution.staged(a.id);
        const skills = listSkillDirs(path.join(a.dir, "skills"));
        return `<div class="card">
  <a href="/agents/${esc(a.id)}"><strong>${esc(a.id)}</strong></a>
  <span class="muted">${esc(a.manifest.description ?? "")}</span><br>
  <span class="pill ${a.manifest.heartbeat?.enabled ? "on" : ""}">heartbeat ${esc(a.manifest.heartbeat?.interval ?? "off")}</span>
  <span class="pill ${a.manifest.evolution?.enabled ? "on" : ""}">evolution ${esc(a.manifest.evolution?.interval ?? "off")}</span>
  <span class="pill">${pending.length} pending</span>
  ${skills.length ? `<span class="pill">${skills.length} skills</span>` : ""}
  ${staged.length ? `<span class="pill on">🧬 ${staged.length} staged</span>` : ""}
  ${sn ? `<span class="pill">😴 until ${esc(fmtWhen(sn.until))}</span>` : ""}
</div>`;
      })
      .join("\n");
    return c.html(page("overview", `${cards || '<p class="muted">No agents yet.</p>'}
<h2>Telegram</h2>
<div class="card">
  ${deps.telegram?.hasTransport("telegram")
    ? `<span class="pill on">🟢 connected${deps.telegram.telegramUsername() ? ` as <strong>@${esc(deps.telegram.telegramUsername())}</strong>` : ""}</span>`
    : `<span class="pill">⚪ not connected</span>`}
  <a href="/telegram">Configure →</a>
</div>
<h2>New agent</h2>
<form method="post" action="/agents" class="card">
  <div class="row">
    <div><label>Name (lowercase-dashes)</label><input type="text" name="name" placeholder="coach" required></div>
    <div><label>Persona (who it is, how it talks)</label><input type="text" name="persona" placeholder="You are a no-nonsense fitness coach…"></div>
  </div>
  <button type="submit">Create agent</button>
</form>`));
  });

  // ── create agent ──
  app.post("/agents", async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name ?? "").toLowerCase().trim();
    const persona = String(body.persona ?? "");
    const err = deps.agents.createAgent(name, persona || undefined);
    if (err) return c.redirect(`/?msg=${encodeURIComponent(err)}`);
    const agent = deps.agents.getAgent(name);
    if (agent) {
      // arm its rhythm jobs immediately
      const hb = agent.manifest.heartbeat;
      if (hb?.enabled) {
        const everyMs = parseDuration(hb.interval) ?? 45 * 60e3;
        deps.scheduler.ensure({
          id: `hb:${agent.id}`, agentId: agent.id, chat: { transport: "internal", chatId: "heartbeat" },
          title: "heartbeat", kind: "heartbeat", dueAt: Date.now() + everyMs, repeat: { everyMs },
          wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0, internal: true,
        });
      }
      if (agent.manifest.evolution?.enabled) {
        const everyMs = parseDuration(agent.manifest.evolution.interval ?? "6h") ?? 6 * 3600e3;
        deps.scheduler.ensure({
          id: `ev:${agent.id}`, agentId: agent.id, chat: { transport: "internal", chatId: "evolution" },
          title: "evolution", kind: "evolution", dueAt: Date.now() + everyMs, repeat: { everyMs },
          wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0, internal: true,
        });
      }
    }
    return c.redirect(`/agents/${encodeURIComponent(name)}?msg=${encodeURIComponent(`Agent "${name}" created`)}`);
  });

  // ── agent detail ──
  app.get("/agents/:id", (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const m = agent.manifest;
    const pending = deps.scheduler.list(agent.id).filter((j) => !j.internal);
    const staged = deps.evolution.staged(agent.id);
    const skills = listSkillDirs(path.join(agent.dir, "skills"));
    const events = deps.events.tail(agent.id, 12);
    const memoryFile = path.join(agent.dir, "memory", "MEMORY.md");
    const memory = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, "utf8") : "";

    const scheduleRows = pending
      .map(
        (j: Schedule) => `<tr>
  <td class="mono">${esc(j.id)}</td><td><strong>${esc(j.title)}</strong>${j.detail ? `<br><span class="muted">${esc(truncate(j.detail, 120))}</span>` : ""}</td>
  <td>${esc(fmtWhen(j.dueAt))}${j.repeat ? " ↻" : ""}${j.wake === "important" ? " ⚡" : ""}<br><span class="muted">${esc(j.kind)} · ${esc(j.delivery)}</span></td>
  <td><form method="post" action="/schedules/${esc(j.id)}/cancel"><button class="danger mini" type="submit">Cancel</button></form></td>
</tr>`
      )
      .join("\n") || `<tr><td colspan="4" class="muted">Nothing pending.</td></tr>`;

    const body = `
${staged.length ? `<div class="flash warn">🧬 Staged for review: ${staged.map((s) => `<strong>${esc(s)}</strong>`).join(", ")}</div>` : ""}
<div class="row">
  <div class="card"><span class="pill ${m.heartbeat?.enabled ? "on" : ""}">heartbeat ${esc(m.heartbeat?.interval ?? "off")}</span>
  <span class="pill ${m.evolution?.enabled ? "on" : ""}">evolution ${esc(m.evolution?.interval ?? "off")}</span>
  <span class="pill">model ${esc(m.model || "auto")}</span>
  ${skills.length ? `<span class="pill">${skills.length} skills</span>` : ""}</div>
</div>

<h2>Rhythm & model</h2>
${manifestForm(agent)}

<h2>Persona <span class="muted">(AGENTS.md)</span></h2>
<form method="post" action="/agents/${esc(agent.id)}/persona" class="card">
  <textarea name="persona" style="min-height:140px">${esc(fs.existsSync(path.join(agent.dir, "AGENTS.md")) ? fs.readFileSync(path.join(agent.dir, "AGENTS.md"), "utf8") : "")}</textarea>
  <button type="submit">Save persona</button>
</form>

<h2>Memory digest <span class="muted">(memory/MEMORY.md)</span></h2>
<form method="post" action="/agents/${esc(agent.id)}/memory" class="card">
  <textarea name="memory">${esc(memory)}</textarea>
  <button type="submit">Save memory digest</button>
</form>

<h2>Schedules</h2>
<form method="post" action="/agents/${esc(agent.id)}/snooze" class="card">
  <label>Snooze everything (e.g. 2h, 30m)</label>
  <div class="row">
    <div><input type="text" name="duration" placeholder="2h"></div>
    <div style="flex:0"><button type="submit" class="ghost">😴 Snooze</button></div>
    <div style="flex:0"><button type="submit" class="ghost" formaction="/agents/${esc(agent.id)}/wake">☀️ Wake</button></div>
  </div>
</form>
<div class="card" style="padding:0">
<table>
  <tr><th>id</th><th>item</th><th>due</th><th></th></tr>
  ${scheduleRows}
</table>
</div>

<h2>Skills</h2>
<div class="card">
  ${skills.length ? skills.map((s) => `<div><strong>${esc(s.name)}</strong> <span class="muted">${esc(s.description)}</span></div>`).join("") : '<span class="muted">No skills yet.</span>'}
  ${staged.length ? `<div style="margin-top:12px"><strong>Staged:</strong> ${staged.map((s) => `<span class="pill on">${esc(s)}</span> <form class="inline" method="post" action="/agents/${esc(agent.id)}/staged/${esc(s)}/promote"><button class="mini" type="submit">promote</button></form> <form class="inline" method="post" action="/agents/${esc(agent.id)}/staged/${esc(s)}/reject"><button class="mini danger" type="submit">reject</button></form>`).join(" · ")}</div>` : ""}
</div>

<h2>Run evolution now</h2>
<form method="post" action="/agents/${esc(agent.id)}/evolve" class="card">
  <label>Goal (optional — empty = self-directed)</label>
  <div class="row">
    <div><input type="text" name="goal" placeholder="get better at morning briefings"></div>
    <div style="flex:0"><button type="submit">🧬 Run cycle</button></div>
  </div>
</form>

<h2>Recent events</h2>
<div class="card"><pre class="events">${esc(events.map((e) => `${new Date(e.t).toLocaleTimeString()} [${e.type}] ${e.summary}`).join("\n") || "(none)")}</pre></div>
`;
    return c.html(page(agent.id, body, c.req.query("msg")));
  });

  // ── manifest save ──
  app.post("/agents/:id/manifest", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody();
    const str = (k: string) => String(b[k] ?? "").trim();
    const on = (k: string) => b[k] === "on";

    const hbInterval = str("hb_interval") || "45m";
    const evInterval = str("ev_interval") || "6h";
    if (!parseDuration(hbInterval) || !parseDuration(evInterval)) {
      return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Invalid interval (try 45m, 2h, 6h)")}`);
    }

    const manifest: AgentManifest = {
      ...agent.manifest,
      description: str("description") || agent.manifest.description,
      model: str("model") || undefined,
      thinking: (str("thinking") as AgentManifest["thinking"]) || "off",
      tools: str("tools") ? str("tools").split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      heartbeat: {
        enabled: on("hb_enabled"),
        interval: hbInterval,
        model: str("hb_model") || "same",
        quietHours: { from: str("hb_from") || "23:00", to: str("hb_to") || "08:00" },
      },
      evolution: {
        enabled: on("ev_enabled"),
        interval: evInterval,
        model: str("ev_model") || "same",
      },
    };
    writeJsonAtomic(path.join(agent.dir, "agent.json"), manifest);
    await deps.agents.discover(); // reload manifests
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Manifest saved — rhythm changes apply on next restart of jobs (or via chat)")}`);
  });

  // ── persona / memory ──
  app.post("/agents/:id/persona", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody();
    fs.writeFileSync(path.join(agent.dir, "AGENTS.md"), String(b.persona ?? "").trim() + "\n");
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Persona saved")}`);
  });

  app.post("/agents/:id/memory", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody();
    fs.mkdirSync(path.join(agent.dir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(agent.dir, "memory", "MEMORY.md"), String(b.memory ?? ""));
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Memory digest saved")}`);
  });

  // ── snooze / wake ──
  app.post("/agents/:id/snooze", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody();
    const ms = parseDuration(String(b.duration ?? ""));
    if (!ms) return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Couldn't parse duration — try 2h or 30m")}`);
    deps.scheduler.snooze(agent.id, Date.now() + ms, "web");
    deps.events.log(agent.id, "snooze", `web snooze ${String(b.duration)}`);
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent(`Snoozed ${String(b.duration)} — important items still fire`)}`);
  });

  app.post("/agents/:id/wake", (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    deps.scheduler.unsnooze(agent.id);
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("Rhythm resumed")}`);
  });

  // ── schedules ──
  app.post("/schedules/:id/cancel", (c) => {
    const job = deps.scheduler.cancel(c.req.param("id"));
    const back = job ? `/agents/${encodeURIComponent(job.agentId)}` : "/";
    return c.redirect(`${back}?msg=${encodeURIComponent(job ? `Cancelled: ${job.title}` : "Already gone")}`);
  });

  // ── evolution ──
  app.post("/agents/:id/evolve", async (c) => {
    const agent = agentOr404(c.req.param("id"));
    if (!agent) return c.notFound();
    const b = await c.req.parseBody();
    const goal = String(b.goal ?? "").trim() || undefined;
    // fire-and-forget: the cycle takes ~a minute; results land in events + chat
    void deps.evolution
      .evolve(agent.id, goal || undefined, { force: true })
      .then((r) => deps.events.log(agent.id, "system", `evolution: ${r.summary}`))
      .catch((e) => deps.events.log(agent.id, "system", `evolution failed: ${errorMessage(e)}`));
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?msg=${encodeURIComponent("🧬 Evolution cycle started — results appear in Recent events and are announced in chat")}`);
  });

  app.post("/agents/:id/staged/:name/promote", (c) => {
    const ok = deps.evolution.promote(c.req.param("id"), c.req.param("name"));
    return c.redirect(`/agents/${encodeURIComponent(c.req.param("id"))}?msg=${encodeURIComponent(ok ? "Promoted ✅" : "Nothing staged with that name")}`);
  });

  app.post("/agents/:id/staged/:name/reject", (c) => {
    deps.evolution.reject(c.req.param("id"), c.req.param("name"));
    return c.redirect(`/agents/${encodeURIComponent(c.req.param("id"))}?msg=${encodeURIComponent("Rejected 🗑")}`);
  });

  // ── telegram settings ──
  app.get("/telegram", (c) => {
    const enabled = deps.telegram?.hasTransport("telegram") ?? false;
    const username = deps.telegram?.telegramUsername();
    const settings = loadSettings(deps.dataDir);
    const configured = Boolean(settings.telegram?.token);
    const body = `<h2>Telegram bot</h2>
<div class="card">
  ${enabled
    ? `<span class="pill on">🟢 connected${username ? ` as <strong>@${esc(username)}</strong>` : ""}</span>`
    : configured
      ? `<span class="pill">⚪ configured but not running</span>`
      : `<span class="pill">⚪ not connected</span>`}
  <p class="muted">Any chat that can see the bot can talk to it (allowlist below to restrict). Agents are switched per chat with /agent.</p>
</div>
<form method="post" action="/telegram" class="card">
  <label>Bot token <span class="muted">(from @BotFather — /newbot)</span></label>
  <input type="password" name="token" placeholder="${configured ? "•••••••• (configured — leave empty to keep)" : "123456:ABC-your-token"}" autocomplete="off">
  <label>Allowed chat IDs (comma-separated, empty = anyone with access to the bot)</label>
  <input type="text" name="allowedChats" value="${esc((settings.telegram?.allowedChats ?? []).join(","))}" placeholder="123456789, 987654321">
  <button type="submit">${enabled ? "Test & reconnect" : "Test & connect"}</button>
</form>
${enabled
  ? `<form method="post" action="/telegram/disable"><button type="submit" class="danger">Disconnect bot</button></form>`
  : ""}`;
    return c.html(page("telegram", body, c.req.query("msg")));
  });

  app.post("/telegram", async (c) => {
    if (!deps.telegram) {
      return c.redirect(`/telegram?msg=${encodeURIComponent("Telegram control not wired")}`);
    }
    const b = await c.req.parseBody();
    const token = String(b.token ?? "").trim();
    const allowedChats = String(b.allowedChats ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const settings = loadSettings(deps.dataDir);
    const effectiveToken = token || settings.telegram?.token || "";
    if (!effectiveToken) {
      return c.redirect(`/telegram?msg=${encodeURIComponent("No token provided — create a bot with @BotFather (/newbot) and paste the token")}`);
    }
    // hot-swap: disable current instance, validate, enable with new config
    await deps.telegram.disableTelegram();
    const r = await deps.telegram.enableTelegram(effectiveToken, allowedChats);
    if (!r.ok) {
      saveSettings(deps.dataDir, { telegram: undefined });
      return c.redirect(`/telegram?msg=${encodeURIComponent(`⛔ ${r.error}`)}`);
    }
    saveSettings(deps.dataDir, { telegram: { token: effectiveToken, allowedChats } });
    deps.events.log("system", "system", `telegram connected as ${r.botName}`);
    return c.redirect(`/telegram?msg=${encodeURIComponent(`🟢 Connected as ${r.botName} — say hi in Telegram!`)}`);
  });

  app.post("/telegram/disable", async (c) => {
    if (deps.telegram) await deps.telegram.disableTelegram();
    saveSettings(deps.dataDir, { telegram: undefined });
    return c.redirect(`/telegram?msg=${encodeURIComponent("Bot disconnected")}`);
  });

  return app;
}