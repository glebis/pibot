import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { openTaskLedger } from "../durable/task-ledger.js";
import { CAPABILITY_REGISTRY, resolveCapabilities, type CapabilityContext } from "../core/capabilities.js";
import { tasksPlugin } from "./tasks-plugin.js";

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };
function tools(ext: InlineExtension): Map<string, Tool> {
  const out = new Map<string, Tool>();
  const pi = { registerTool: (t: ToolDefinition) => out.set(t.name, t as Tool), registerCommand: vi.fn(), on: vi.fn() } as unknown as ExtensionAPI;
  (typeof ext === "function" ? ext : ext.factory)(pi);
  return out;
}
const text = async (p: Promise<{ content: Array<{ text: string }> }>) => (await p).content[0].text;

describe("tasks plugin", () => {
  it("starts once per tool call, reports status and stays scoped to its agent", async () => {
    const run = vi.fn(async (_task: unknown) => "summary ready");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    try {
      const t = tools(tasksPlugin({ ledger, agentId: "coach", chat: { transport: "telegram", chatId: "42" } }));
      const params = { title: "Weekly note", instructions: "Draft it." };
      const started = await text(t.get("start_task")!.execute("call-1", params));
      const id = /task (t\w+)/.exec(started)![1];
      await t.get("start_task")!.execute("call-1", params); // a replayed tool call must not start a second task
      for (let i = 0; i < 200 && (await ledger.get(id))?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toMatchObject({ chatKey: "telegram:42", agentId: "coach" });
      expect(await text(t.get("task_status")!.execute("x", { id }))).toContain("summary ready");
      expect(await text(t.get("list_tasks")!.execute("x", {}))).toContain("Weekly note");
      const other = tools(tasksPlugin({ ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" } }));
      expect(await text(other.get("task_status")!.execute("x", { id }))).toContain("No task");
    } finally { await ledger.close(); }
  });

  it("passes a per-task runtime cap to the runner, clamped to the 480-minute ceiling", async () => {
    const run = vi.fn(async (_task: unknown) => "long work done");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    try {
      const t = tools(tasksPlugin({ ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" } }));
      await t.get("start_task")!.execute("call-a", { title: "Transcribe talk", instructions: "yt-dlp + transcript.", timeoutMinutes: 90 });
      await t.get("start_task")!.execute("call-b", { title: "Absurd cap", instructions: "clamp me.", timeoutMinutes: 10000 });
      const ids = Object.values((await ledger.list({ agentId: "knower" }))).map((e) => e.id);
      for (let i = 0; i < 200 && Object.values(await ledger.list({ agentId: "knower" })).some((e) => e.status !== "done"); i++) await new Promise((r) => setTimeout(r, 10));
      const caps = run.mock.calls.map((c) => (c[0] as { timeoutMinutes?: number }).timeoutMinutes);
      expect(run).toHaveBeenCalledTimes(2);
      expect(caps).toContain(90);
      expect(caps).toContain(480); // clamped to the hard ceiling
      expect(ids.length).toBe(2);
    } finally { await ledger.close(); }
  });

  it("comes with the scheduler and is never offered inside agent-only sessions", () => {
    const base = { agent: { id: "a1", dir: "/tmp", manifest: { name: "a1" } }, workspace: "/tmp", vaultDir: "/tmp", scheduler: {}, tasks: {} } as unknown as CapabilityContext;
    const owner = resolveCapabilities({ ...base, chat: { transport: "telegram", chatId: "1" } }, CAPABILITY_REGISTRY, ["scheduler"]);
    expect(owner.tools).toContain("start_task");
    const taskRun = resolveCapabilities({ ...base, chat: { transport: "agent", chatId: "task-1" } }, CAPABILITY_REGISTRY, ["scheduler"]);
    expect(taskRun.tools).not.toContain("start_task");
  });
});
