import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./core/agent-manager.js";
import { EventLog } from "./core/events.js";
import { EvolutionEngine } from "./core/evolution.js";
import { Scheduler } from "./core/scheduler.js";
import type { ProcessControl, ProcessSnapshot } from "./core/processes.js";
import { createWebApp, type WebDeps } from "./web.js";
import { formatAge } from "./web-processes.js";

const now = Date.UTC(2026, 9, 18, 20, 0, 0);
const snapshot: ProcessSnapshot = {
  takenAt: now,
  daemon: { pid: 4242, uptimeSec: 3700, rssKb: 512_000 },
  turns: [
    { id: 1, kind: "chat", agentId: "assistant", chatKey: "telegram:42", startedAt: now - 75_000, label: "what's on my calendar?", model: "openai-codex/gpt-6.1-sol" },
    { id: 2, kind: "goal-judge", startedAt: now - 3_000, label: "judge /goal progress" },
  ],
  tasks: {
    active: [{ id: "tk_run", agentId: "assistant", chatKey: "telegram:42", title: "Owner's <research>", instructions: "x", status: "running", createdAt: now - 120_000, updatedAt: now, attempts: 1 }],
    recent: [{ id: "tk_old", agentId: "assistant", chatKey: "telegram:42", title: "Old one", instructions: "x", status: "failed", createdAt: now - 900_000, updatedAt: now - 880_000, attempts: 1, error: "every model failed (ollama/glm): 429" }],
  },
  goals: [],
  voiceCalls: [],
  children: [{ pid: 777, ppid: 4242, depth: 1, elapsedSec: 42, rssKb: 30_000, command: "claude -p research" }],
};

describe("/processes admin page", () => {
  let dir: string;
  let scheduler: Scheduler;
  let app: ReturnType<typeof createWebApp>;
  let control: ProcessControl & { cancelTask: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-proc-"));
    const agents = new AgentManager(dir, { getModels: () => [] } as unknown as ModelRuntime);
    scheduler = new Scheduler(path.join(dir, "data"), () => {});
    const events = new EventLog(dir);
    const evolution = new EvolutionEngine({ agents, modelRuntime: {} as ModelRuntime, events, dataDir: dir, host: { announce: async () => {} }, io: { propose: vi.fn(), runProbe: vi.fn(), judge: vi.fn() } });
    control = { snapshot: vi.fn(async () => snapshot), cancelTask: vi.fn(async () => true) };
    app = createWebApp({ agents, scheduler, events, evolution, dataDir: dir, webToken: "t0ken", secrets: { get: () => ({}), save: async () => {} }, processes: control } satisfies WebDeps);
    const request = app.request.bind(app);
    app.request = ((input: Parameters<typeof request>[0], init?: Parameters<typeof request>[1]) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Bearer t0ken");
      return request(input, { ...init, headers });
    }) as typeof app.request;
  });
  afterEach(() => {
    scheduler.stop();
    try { (app as any)._authStore?.stop?.(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("requires authentication for HTML, JSON and cancellation before reading live data", async () => {
    for (const [url, method] of [["/processes", "GET"], ["/api/processes", "GET"], ["/processes/tasks/tk_run/cancel", "POST"]]) {
      const res = await app.fetch(new Request(`http://localhost${url}`, { method }));
      expect([302, 401, 403]).toContain(res.status);
    }
    expect(control.snapshot).not.toHaveBeenCalled();
    expect(control.cancelTask).not.toHaveBeenCalled();
  });

  it("formats ages compactly", () => {
    expect([formatAge(5), formatAge(75), formatAge(9000), formatAge(90000)]).toEqual(["5s", "1m 15s", "2h 30m", "1d 1h"]);
  });

  it("renders live turns, tasks with their outcome, and child processes", async () => {
    const res = await app.request("/processes");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("what's on my calendar?");
    expect(html).toContain("openai-codex/gpt-6.1-sol");
    expect(html).toContain("1m 15s");
    expect(html).toContain(">goal-judge<");
    expect(html).toContain("judge /goal progress");
    expect(html).toContain("Owner's &lt;research&gt;");
    expect(html).not.toContain("<research>");
    expect(html).toContain("every model failed (ollama/glm): 429");
    expect(html).toContain("/processes/tasks/tk_run/cancel");
    expect(html).toContain("claude -p research");
    expect(html).toContain('href="/processes"');
  });

  it("serves the same snapshot as JSON", async () => {
    const res = await app.request("/api/processes");
    expect(await res.json()).toMatchObject({ daemon: { pid: 4242 }, children: [{ pid: 777 }] });
  });

  it("cancels a task only with a valid CSRF token", async () => {
    const bad = new FormData(); bad.set("_csrf", "nope");
    expect((await app.request("/processes/tasks/tk_run/cancel", { method: "POST", body: bad })).status).toBe(403);
    expect(control.cancelTask).not.toHaveBeenCalled();
    const good = new FormData(); good.set("_csrf", (app as any)._csrf);
    const res = await app.request("/processes/tasks/tk_run/cancel", { method: "POST", body: good });
    expect(res.status).toBe(302);
    expect(control.cancelTask).toHaveBeenCalledWith("tk_run");
    expect(res.headers.get("location")).toContain("Cancel%20requested");
  });
});
