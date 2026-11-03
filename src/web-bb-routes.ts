import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createAgentFromSpec, validateAgentName } from "./core/agent-factory.js";
import type { AgentManifest } from "./core/types.js";
import type { LedgerEntry } from "./durable/task-ledger.js";
import type { WebDeps } from "./web.js";

const bounded = (s: string | undefined, max = 160) => s?.slice(0, max);
const strings = (values: string[] | undefined) => values?.slice(0, 100).map(s => bounded(s)!);
const task = (t: LedgerEntry) => ({ id: bounded(t.id), agentId: bounded(t.agentId) ?? "", title: bounded(t.title), status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt, attempts: t.attempts });
function metadata(id: string, m: AgentManifest, deps: WebDeps) {
  return { id: bounded(id), description: bounded(m.description, 500) ?? "", model: bounded(m.model) ?? "", providers: strings(m.providers) ?? [], capabilities: strings(m.capabilities) ?? [], heartbeat: m.heartbeat ? { enabled: m.heartbeat.enabled, interval: bounded(m.heartbeat.interval) } : undefined, snoozed: (deps.scheduler?.snoozeState(id)?.until ?? 0) > Date.now() };
}

/** Dedicated bearer authentication: dashboard cookies/query tokens cannot authorize this API. */
export function registerBbRoutes(app: Hono, deps: WebDeps, token: string | undefined): void {
  app.use("/api/bb/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!token) return c.json({ error: "BB API token is not configured" }, 503);
    const actual = Buffer.from(c.req.header("Authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });
  app.use("/api/bb/*", bodyLimit({ maxSize: 8192, onError: c => c.json({ error: "Request body exceeds 8192 bytes" }, 400) }));
  app.get("/api/bb/agents", c => {
    try { return c.json({ agents: deps.agents.list().slice(0, 200).map(a => metadata(a.id, a.manifest, deps)) }); }
    catch { return c.json({ error: "Agents unavailable" }, 503); }
  });
  app.post("/api/bb/agents", async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected an object" }, 400);
    const b = body as Record<string, unknown>;
    if (Object.keys(b).some(k => !["id", "description", "proactivity"].includes(k)) || typeof b.id !== "string" || validateAgentName(b.id) || typeof b.description !== "string" || !b.description.trim() || b.description.length > 500 || (b.proactivity !== undefined && b.proactivity !== "quiet" && b.proactivity !== "off")) return c.json({ error: "Expected id, description (1–500 characters), and optional proactivity quiet|off" }, 400);
    try {
      // No scheduler/transport dependency: creation cannot arm jobs or contact Telegram.
      const result = await createAgentFromSpec({ agents: deps.agents }, { id: b.id, description: b.description, proactivity: b.proactivity as string | undefined ?? "off", capabilities: [] });
      if (!result.ok) return c.json({ error: "Agent creation refused" }, 400);
      return c.json({ id: result.id, agent: metadata(result.id, result.manifest, deps) }, 201);
    } catch { return c.json({ error: "Agent creation unavailable" }, 503); }
  });
  app.get("/api/bb/processes", async c => {
    if (!deps.processes) return c.json({ error: "Processes unavailable" }, 503);
    try {
      const s = await deps.processes.snapshot();
      return c.json({ takenAt: s.takenAt, daemon: { pid: s.daemon.pid, uptimeSec: s.daemon.uptimeSec, rssKb: s.daemon.rssKb }, turns: s.turns.slice(0, 200).map(t => ({ id: String(t.id), kind: t.kind, agentId: bounded(t.agentId) ?? "", model: bounded(t.model), startedAt: t.startedAt })), tasks: { active: s.tasks.active.slice(0, 200).map(task), recent: s.tasks.recent.slice(0, 100).map(task) }, goals: s.goals.slice(0, 100).map(g => ({ turnsUsed: g.turnsUsed, maxTurns: g.maxTurns, createdAt: g.createdAt, lastTurnAt: g.lastTurnAt })), voiceCalls: s.voiceCalls.slice(0, 100).map(v => ({ agentId: bounded(v.agentId) })), children: s.children.slice(0, 200).map(p => ({ pid: p.pid, ppid: p.ppid, depth: p.depth, elapsedSec: p.elapsedSec, rssKb: p.rssKb, command: bounded(p.command.trim().split(/\s+/)[0].split(/[\\/]/).pop(), 80) ?? "" })), childrenUnavailable: !!s.childrenError, childrenError: s.childrenError ? "Process listing unavailable" : undefined });
    } catch { return c.json({ error: "Processes unavailable" }, 503); }
  });
  app.post("/api/bb/tasks/:id/cancel", async c => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(c.req.param("id"))) return c.json({ error: "Invalid task id" }, 400);
    if (!deps.processes) return c.json({ error: "Processes unavailable" }, 503);
    try { const cancelled = await deps.processes.cancelTask(c.req.param("id")); return c.json({ cancelled }); }
    catch { return c.json({ error: "Cancellation unavailable" }, 503); }
  });
}
