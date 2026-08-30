import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Scheduler } from "../core/scheduler.js";
import { schedulerPlugin } from "./scheduler-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };

function captureTools(): { pi: ExtensionAPI; tools: Map<string, Tool> } {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as Tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-sched-"));
}

describe("scheduler plugin", () => {
  let dataDir: string;
  let scheduler: Scheduler;

  beforeEach(() => {
    dataDir = tmpDir();
    scheduler = new Scheduler(dataDir, () => {});
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function pluginFor(agentId = "a1") {
    const tools = new Map<string, Tool>();
    const api = {
      registerTool: (t: ToolDefinition) => tools.set(t.name, t as Tool),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    factoryOf(schedulerPlugin({ scheduler, agentId, chat: { transport: "test", chatId: "c1" } }))(api);
    return { tools };
  }

  it("registers all scheduling tools", () => {
    const { tools } = pluginFor();
    for (const name of ["schedule_create", "schedule_list", "schedule_cancel", "schedule_resume", "snooze", "promise_make", "promise_keep"]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it("shows and resumes an automatically paused schedule", async () => {
    const { tools } = pluginFor();
    const job = scheduler.create({
      agentId: "a1", chat: { transport: "test", chatId: "c1" }, title: "daily check-in",
      kind: "reminder", dueAt: Date.now() + 3600_000, repeat: { everyMs: 15 * 60_000 },
      wake: "normal", delivery: "direct",
    });
    job.status = "paused";
    job.lastDeliveryError = "transport unavailable";

    const listed = await tools.get("schedule_list")!.execute("t1", {});
    expect(listed.content[0].text).toContain("PAUSED");
    expect(listed.content[0].text).toContain("transport unavailable");

    const resumed = await tools.get("schedule_resume")!.execute("t2", { id: job.id });
    expect(resumed.content[0].text).toContain("Resumed");
    expect(job.status).toBe("pending");
  });

  it("schedule_create parses natural language and creates a card-pending job", async () => {
    const { tools } = pluginFor();
    const res = await tools.get("schedule_create")!.execute("t1", {
      title: "stretch",
      when: "in 20m",
      kind: "reminder",
    });
    expect(res.content[0].text).toContain("Scheduled");
    const job = scheduler.list("a1")[0];
    expect(job.title).toBe("stretch");
    expect(job.dueAt).toBeGreaterThan(Date.now());
    expect(job.cardPending).toBe(true);
    expect(res.details.scheduleId).toBe(job.id);
  });

  it("schedule_create reports unparseable times as ERROR", async () => {
    const { tools } = pluginFor();
    const res = await tools.get("schedule_create")!.execute("t1", { title: "x", when: "wheneverish" });
    expect(res.content[0].text).toContain("ERROR");
    expect(scheduler.list()).toHaveLength(0);
  });

  it("schedule_create refuses recurring intervals below fifteen minutes", async () => {
    const { tools } = pluginFor();
    const res = await tools.get("schedule_create")!.execute("t1", { title: "nag", when: "every 1m" });
    expect(res.content[0].text).toContain("ERROR");
    expect(res.content[0].text).toContain("15 minutes");
    expect(scheduler.list()).toHaveLength(0);
  });

  it("promise_make preflights both slots instead of creating half a promise", async () => {
    const { tools } = pluginFor();
    for (let i = 0; i < 19; i++) {
      scheduler.create({
        agentId: "a1", chat: { transport: "test", chatId: "c1" }, title: `existing ${i}`,
        kind: "reminder", dueAt: Date.now() + 3600_000 + i, wake: "normal", delivery: "direct",
      });
    }
    const res = await tools.get("promise_make")!.execute("t1", { title: "send report", deadline: "in 3d" });
    expect(res.content[0].text).toContain("ERROR");
    expect(res.content[0].text).toContain("2 free");
    expect(scheduler.list("a1")).toHaveLength(19);
  });

  it("important wake and agent delivery are recorded", async () => {
    const { tools } = pluginFor();
    await tools.get("schedule_create")!.execute("t1", { title: "meds", when: "tomorrow 9am", wake: "important", delivery: "agent" });
    const job = scheduler.list("a1")[0];
    expect(job.wake).toBe("important");
    expect(job.delivery).toBe("agent");
  });

  it("snooze tool snoozes the agent rhythm", async () => {
    const { tools } = pluginFor();
    const res = await tools.get("snooze")!.execute("t1", { duration: "2h" });
    expect(res.content[0].text).toContain("Snoozed");
    expect(scheduler.snoozeState("a1")?.until).toBeGreaterThan(Date.now() + 3600e3 - 5000);
  });

  it("snooze tool errors on unparseable duration", async () => {
    const { tools } = pluginFor();
    const res = await tools.get("snooze")!.execute("t1", { duration: "forever and ever amen" });
    expect(res.content[0].text).toContain("ERROR");
  });

  it("schedule_list lists and schedule_cancel cancels", async () => {
    const { tools } = pluginFor();
    await tools.get("schedule_create")!.execute("t1", { title: "stretch", when: "in 20m" });
    const list = await tools.get("schedule_list")!.execute("t1", {});
    expect(list.content[0].text).toContain("stretch");

    const id = scheduler.list("a1")[0].id;
    const cancelled = await tools.get("schedule_cancel")!.execute("t1", { id });
    expect(cancelled.content[0].text).toContain("Cancelled");
    expect(scheduler.list()).toHaveLength(0);
  });

  it("promise_make creates a promise + pre-check sharing a groupId", async () => {
    const { tools } = pluginFor();
    // deadline far enough out that a pre-check fits between now and it
    const res = await tools.get("promise_make")!.execute("t1", { title: "send invoice", deadline: "in 3d", detail: "to Anna" });
    const jobs = scheduler.list("a1").filter((j) => j.kind === "promise");
    expect(jobs).toHaveLength(2);
    const groupId = res.details.groupId as string;
    expect(groupId).toBeTruthy();
    expect(new Set(jobs.map((j) => j.groupId))).toEqual(new Set([groupId]));

    const promise = jobs.find((j) => j.title === "send invoice")!;
    const precheck = jobs.find((j) => j.title.startsWith("pre-check"))!;
    expect(promise.wake).toBe("important");
    expect(promise.delivery).toBe("agent");
    expect(precheck.dueAt).toBeLessThan(promise.dueAt);
    expect(promise.dueAt).toBeGreaterThan(Date.now() + 2 * 86400e3);
  });

  it("promise_keep removes the whole group", async () => {
    const { tools } = pluginFor();
    const res = await tools.get("promise_make")!.execute("t1", { title: "call mum", deadline: "in 3d" });
    const groupId = res.details.groupId as string;
    const kept = await tools.get("promise_keep")!.execute("t1", { id: res.details.promiseId as string, note: "called" });
    expect(kept.content[0].text).toContain("kept");
    expect(scheduler.list("a1").filter((j) => j.groupId === groupId)).toHaveLength(0);
  });
});
