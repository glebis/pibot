import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { openTaskLedger } from "../durable/task-ledger.js";
import type { SttPolicy } from "../core/stt.js";
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

  it("surfaces a partial result and correlated evidence in task_status and list_tasks", async () => {
    const run = vi.fn(async () => ({
      text: "Delegate reply: transcript ready",
      status: "partial" as const,
      partialReason: "deadline; filing pending",
      evidence: "Delegate pibot-dev returned a reply: /tmp/a.txt",
    }));
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    try {
      const t = tools(tasksPlugin({ ledger, agentId: "coach", chat: { transport: "telegram", chatId: "42" } }));
      const started = await text(t.get("start_task")!.execute("call-p", { title: "Partial task", instructions: "work" }));
      const id = /task (t\w+)/.exec(started)![1];
      for (let i = 0; i < 200 && (await ledger.get(id))?.status !== "partial"; i++) await new Promise((r) => setTimeout(r, 10));
      const status = await text(t.get("task_status")!.execute("x", { id }));
      expect(status).toContain("Result (partial)");
      expect(status).toContain("transcript ready");
      expect(status).toContain("/tmp/a.txt");
      const list = await text(t.get("list_tasks")!.execute("x", {}));
      expect(list).toContain("transcript ready"); // partial result visible, bounded
      expect(list).toContain("usable receipt (delegate-reported, unverified):");
    } finally { await ledger.close(); }
  });

  it("labels refusal-only context on a failed task without implying partial output", async () => {
    const ledger = {
      get: vi.fn(async () => ({
        id: "t1", agentId: "coach", chatKey: "telegram:42", title: "refused", instructions: "x",
        status: "failed", createdAt: 1, updatedAt: 2, attempts: 1, error: "deadline",
        evidence: "Delegate pibot-dev returned a reply reporting a refusal/blocker: BLOCKED",
      })),
    } as unknown as import("../durable/task-ledger.js").TaskLedger;
    const t = tools(tasksPlugin({ ledger, agentId: "coach", chat: { transport: "telegram", chatId: "42" } }));
    const status = await text(t.get("task_status")!.execute("x", { id: "t1" }));
    expect(status).toContain("context (not independently usable output)");
    expect(status).not.toContain("evidence (usable");
    expect(status).not.toContain("Result (partial)");
  });

  it("keeps full evidence visible when it equals a partial result truncated at 1500 chars", async () => {
    const long = `${"x".repeat(1600)} /tmp/tail-path-after-1500.txt`;
    const ledger = {
      get: vi.fn(async () => ({
        id: "t2", agentId: "coach", chatKey: "telegram:42", title: "same", instructions: "x",
        status: "partial", createdAt: 1, updatedAt: 2, attempts: 1, error: "deadline", result: long,
        evidence: long, evidenceUsable: true,
      })),
    } as unknown as import("../durable/task-ledger.js").TaskLedger;
    const t = tools(tasksPlugin({ ledger, agentId: "coach", chat: { transport: "telegram", chatId: "42" } }));
    const status = await text(t.get("task_status")!.execute("x", { id: "t2" }));
    // The result body is cut at 1500; the evidence block must still show the reported tail path.
    expect(status).toContain("Result (partial)");
    expect(status).toContain("Legacy correlated delegate context (usability of retained text unknown)");
    expect(status).toContain("/tmp/tail-path-after-1500.txt");
  });

  it("shows the protected usable receipt after refusal spam removes it from rolling evidence", async () => {
    const ledger = await openTaskLedger({ runner: { run: async () => "done", notify: async () => {} } });
    try {
      const task = await ledger.start({ agentId: "coach", chatKey: "telegram:42", title: "Transcript", instructions: "work" });
      for (let i = 0; i < 200 && (await ledger.get(task.id))?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
      await ledger.appendEvidence(task.id, "Saved transcript to /tmp/only-usable.txt", { usable: true });
      await ledger.appendEvidence(task.id, `BLOCKED: ${"x".repeat(3600)}`, { usable: false });
      await ledger.appendEvidence(task.id, `REFUSED: ${"y".repeat(3600)}`, { usable: false });
      expect((await ledger.get(task.id))?.evidence).not.toContain("/tmp/only-usable.txt");
      const t = tools(tasksPlugin({ ledger, agentId: "coach", chat: { transport: "telegram", chatId: "42" } }));
      const status = await text(t.get("task_status")!.execute("x", { id: task.id }));
      const list = await text(t.get("list_tasks")!.execute("x", {}));
      expect(status).toContain("Correlated delegate usable receipt (delegate-reported, unverified)");
      expect(status).toContain("/tmp/only-usable.txt");
      expect(status).toContain("Correlated delegate context (not independently usable output)");
      expect(list).toContain("/tmp/only-usable.txt");
      expect(list).toContain("context:");
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

  it("the tasks capability prompt carries the long-audio owner rule", () => {
    const tasks = CAPABILITY_REGISTRY.find((c) => c.id === "tasks")!;
    expect(tasks.prompt).toMatch(/LONG AUDIO/);
    expect(tasks.prompt).toMatch(/never substitute local WhisperKit/i);
    expect(tasks.prompt).toMatch(/audioDurationSec/);
  });

  it("comes with the scheduler and is never offered inside agent-only sessions", () => {
    const base = { agent: { id: "a1", dir: "/tmp", manifest: { name: "a1" } }, workspace: "/tmp", vaultDir: "/tmp", scheduler: {}, tasks: {} } as unknown as CapabilityContext;
    const owner = resolveCapabilities({ ...base, chat: { transport: "telegram", chatId: "1" } }, CAPABILITY_REGISTRY, ["scheduler"]);
    expect(owner.tools).toContain("start_task");
    const taskRun = resolveCapabilities({ ...base, chat: { transport: "agent", chatId: "task-1" } }, CAPABILITY_REGISTRY, ["scheduler"]);
    expect(taskRun.tools).not.toContain("start_task");
  });
});

describe("task-record-canon (bd pibot-r47f)", () => {
  it("starts with lane/acceptance/output/linear fields and renders them; lanes filter", async () => {
    const run = vi.fn(async () => "result ok");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    const t = tools(tasksPlugin({ ledger, agentId: "creator", chat: { transport: "telegram", chatId: "42" } }));
    const r = await t.get("start_task")!.execute("c1", {
      title: "caption research", instructions: "do the dig",
      lane: "cross-agent", acceptanceCriteria: "ffprobe shows <=60s and h264+aac",
      outputLocation: "/media/vnote/note.mp4", linearRef: "MHT-12",
    });
    const taskId = ((r as unknown as { details?: { taskId?: string } }).details)?.taskId ?? "";
    for (let i = 0; i < 200 && (await ledger.get(taskId))?.status !== "done"; i++) await new Promise((x) => setTimeout(x, 10));

    const done = await ledger.get(taskId);
    expect(done).toMatchObject({ lane: "cross-agent", acceptanceCriteria: "ffprobe shows <=60s and h264+aac", linearRef: "MHT-12" });
    const listed = (await t.get("list_tasks")!.execute("l1", {})).content[0].text;
    expect(listed).toContain("lane:cross-agent");
    expect(listed).toContain("MHT-12");
    expect((await t.get("list_tasks")!.execute("l2", { lane: "dev" })).content[0].text).toBe("No background tasks yet.");
    ledger.close();
  });

  it("records private input paths and surfaces inputs that are gone (bd pibot-7bo)", async () => {
    let resolveRun!: (v: string) => void;
    const gate = new Promise<string>((res) => (resolveRun = res));
    const run = vi.fn(async () => gate);
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    const t = tools(tasksPlugin({ ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" } }));
    const present = path.join(os.tmpdir(), `pibot-input-${Date.now()}.m4a`);
    const missing = path.join(os.tmpdir(), `pibot-gone-${Date.now()}.m4a`);
    fs.writeFileSync(present, "audio");
    try {
      const started = (await t.get("start_task")!.execute("i1", {
        title: "re-transcribe Voss",
        instructions: "use the recorded audio",
        inputLocations: `${present}, ${missing}`,
      })) as unknown as { details?: { taskId?: string } };
      const id = started.details?.taskId ?? "";
      await new Promise((r) => setTimeout(r, 120)); // let it enter running
      expect((await ledger.get(id))?.inputLocations).toBe(`${present}, ${missing}`);

      const status = await text(t.get("task_status")!.execute("i2", { id }));
      expect(status).toContain(`Inputs missing from disk: ${missing}`);
      expect(status).not.toContain(`Inputs missing from disk: ${present}`);
      expect(status).toContain("INPUT MISSING");

      const up = await t.get("task_update")!.execute("i3", { id, inputLocations: present });
      expect(up.content[0].text).toContain("record updated");
      expect((await ledger.get(id))?.inputLocations).toBe(present);
      resolveRun("done");
      for (let i = 0; i < 200 && (await ledger.get(id))?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
    } finally {
      fs.rmSync(present, { force: true });
      await ledger.close();
    }
  });

  it("task_update sets nextAction/outputLocation on live tasks and refuses finished ones", async () => {
    let resolveRun!: (v: string) => void;
    const gate = new Promise<string>((res) => (resolveRun = res));
    const run = vi.fn(async () => gate);
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    const t = tools(tasksPlugin({ ledger, agentId: "worker", chat: { transport: "telegram", chatId: "42" } }));
    const started = (await t.get("start_task")!.execute("k1", { title: "long render", instructions: "run" })) as unknown as { details?: { taskId?: string } };
    const taskId = started.details?.taskId ?? "";
    await new Promise((r) => setTimeout(r, 120)); // let it enter running
    const up = await t.get("task_update")!.execute("k2", { id: taskId, nextAction: "await GPU slot", outputLocation: "/tmp/artifacts" });
    expect(up.content[0].text).toContain("record updated");
    const live = await ledger.get(taskId);
    expect(live).toMatchObject({ nextAction: "await GPU slot", outputLocation: "/tmp/artifacts" });
    // finish it, then the record update must refuse
    resolveRun("done");
    for (let i = 0; i < 200 && (await ledger.get(taskId))?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
    const after = await t.get("task_update")!.execute("k4", { id: taskId, nextAction: "post-finish" });
    expect(after.content[0].text).toMatch(/No task|ERROR/);
    ledger.close();
  });
});

describe("explicit expected target tuple from start_task (bd pibot-cida review)", () => {
  it("persists expectedPeer/account/idProtocol into the task and passes them to the runner", async () => {
    const run = vi.fn(async (_task: unknown) => "saved");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    try {
      const t = tools(tasksPlugin({ ledger, agentId: "coach", chat: { transport: "telegram", chatId: "42" } }));
      const r = await t.get("start_task")!.execute("e1", {
        title: "save the note", instructions: "post the result",
        expectedMedia: "video_note", expectedPeer: "telegram:99", expectedAccount: "@pibot", expectedIdProtocol: "bot_api",
      });
      const id = ((r as unknown as { details?: { taskId?: string } }).details)?.taskId ?? "";
      const terminal = new Set(["done", "partial", "failed", "blocked", "cancelled"]);
      for (let i = 0; i < 200 && !terminal.has((await ledger.get(id))?.status ?? ""); i++) await new Promise((x) => setTimeout(x, 10));
      const task = await ledger.get(id);
      expect(task).toMatchObject({ expectedPeer: "telegram:99", expectedAccount: "@pibot", expectedIdProtocol: "bot_api", expectedMedia: "video_note" });
      expect(run.mock.calls[0][0]).toMatchObject({ expectedPeer: "telegram:99", expectedAccount: "@pibot", expectedIdProtocol: "bot_api" });
    } finally { ledger.close(); }
  });
});

describe("duration-aware transcription policy in the task contract (bd pibot-0xpf.4)", () => {
  const started = (r: { details?: unknown }) => (r.details as { taskId?: string } | undefined)?.taskId ?? "";

  it("writes the Groq-chunk constraint into the durable contract for known long audio", async () => {
    const prev = process.env.STT_PROVIDERS;
    process.env.STT_PROVIDERS = "whisperkit,groq";
    try {
      const run = vi.fn(async () => "done");
      const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
      const t = tools(tasksPlugin({
        ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" },
        transcription: { policy: { providers: ["whisperkit", "groq"], allowExternal: true } },
      }));
      const r = await t.get("start_task")!.execute("c1", { title: "27-min talk", instructions: "transcribe it", audioDurationSec: 27 * 60 });
      const taskId = started(r as { details?: unknown });
      const task = await ledger.get(taskId);
      expect(task?.instructions).toContain("do NOT fall back to WhisperKit");
      expect(task?.instructions).toContain("2 chunks of <=15 min");
      expect((r as { content: Array<{ text: string }> }).content[0].text).toContain("chunked-external");
      ledger.close();
    } finally {
      if (prev === undefined) delete process.env.STT_PROVIDERS; else process.env.STT_PROVIDERS = prev;
    }
  });

  it("refuses a known long-audio task when Groq is not permitted, instead of starting a local substitution", async () => {
    const run = vi.fn(async () => "done");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    try {
      const t = tools(tasksPlugin({
        ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" },
        transcription: { policy: { providers: ["whisperkit"] } },
      }));
      const r = await t.get("start_task")!.execute("c2", { title: "long talk", instructions: "transcribe", audioDurationSec: 27 * 60 });
      expect((r as { content: Array<{ text: string }> }).content[0].text).toContain("REFUSED");
      expect(await ledger.list({ agentId: "knower" })).toEqual([]); // nothing started
      expect(run).not.toHaveBeenCalled();
    } finally { ledger.close(); }
  });

  it("mandates a probe (not a duration guess) when the audio duration is declared unknown", async () => {
    const run = vi.fn(async () => "done");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    try {
      const t = tools(tasksPlugin({
        ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" },
        transcription: { policy: { providers: ["whisperkit", "groq"], allowExternal: true } },
      }));
      const r = await t.get("start_task")!.execute("c3", { title: "unknown length", instructions: "transcribe", audioDurationUnknown: true });
      const task = await ledger.get(started(r as { details?: unknown }));
      expect(task?.instructions).toMatch(/PROBE it \(ffprobe\) FIRST/);
      expect(task?.instructions).not.toMatch(/is .* min \(>15 min\)/); // it never asserts a duration
    } finally { ledger.close(); }
  });

  it("leaves the instructions untouched for tasks that declare no audio work", async () => {
    const run = vi.fn(async () => "done");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    try {
      const t = tools(tasksPlugin({
        ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" },
        transcription: { policy: { providers: ["whisperkit"] } },
      }));
      const r = await t.get("start_task")!.execute("c4", { title: "plain", instructions: "just write it" });
      const task = await ledger.get(started(r as { details?: unknown }));
      expect(task?.instructions).toBe("just write it");
    } finally { ledger.close(); }
  });
});

describe("resource preflight (bd pibot-kdpg)", () => {
  it("refuses start_task when the preflight refuses; acquires+releases when green", async () => {
    const run = vi.fn(async () => "ok");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    const releases: string[] = [];
    const preflight = {
      check: async (_lane: unknown, acquire?: boolean) => {
        if (acquire && (preflight as { saturate?: boolean }).saturate) return { ok: false, issues: ["lane \"delegate\" at concurrency cap"] };
        if (acquire) releases.push("acquired");
        return { ok: true, issues: [] };
      },
      release: (lane: string) => releases.push(`released:${lane}`),
      saturate: false as boolean,
    };
    const t = tools(tasksPlugin({ ledger, agentId: "saturated-test", chat: { transport: "telegram", chatId: "42" }, preflight: preflight as never }));

    preflight.saturate = true;
    const blocked = await t.get("start_task")!.execute("b1", { title: "big job", instructions: "run" });
    expect(blocked.content[0].text).toContain("REFUSED by resource preflight");

    preflight.saturate = false;
    const go = await t.get("start_task")!.execute("b2", { title: "normal job", instructions: "run" });
    expect(go.content[0].text).toContain("Started task");
    expect(releases).toContain("acquired");
    expect(releases).toContain("released:delegate");
    ledger.close();
  });
});

describe("mandatory transcription policy survives the instructions cap (bd pibot-0xpf.4 review)", () => {
  const started = (r: { details?: unknown }) => (r.details as { taskId?: string } | undefined)?.taskId ?? "";
  const long = "x".repeat(8000);
  const policy: SttPolicy = { providers: ["whisperkit", "groq"], allowExternal: true };

  it("prepends and preserves the policy when instructions fill the 8000 cap (no-preflight branch)", async () => {
    const prev = process.env.STT_PROVIDERS;
    process.env.STT_PROVIDERS = "whisperkit,groq"; // the host must enable Groq for the chunked route
    try {
      const run = vi.fn(async () => "done");
      const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
      const t = tools(tasksPlugin({ ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" }, transcription: { policy } }));
      const r = await t.get("start_task")!.execute("cap1", { title: "max input", instructions: long, audioDurationSec: 27 * 60 });
      const task = await ledger.get(started(r as { details?: unknown }));
      expect(task!.instructions.length).toBeLessThanOrEqual(8000);
      expect(task!.instructions.startsWith("[pibot:transcription-policy] route=chunked-external")).toBe(true);
      expect(task!.instructions).toContain("do NOT fall back to WhisperKit");
      expect(task!.instructions).toContain("2 chunks of <=15 min");
      ledger.close();
    } finally {
      if (prev === undefined) delete process.env.STT_PROVIDERS; else process.env.STT_PROVIDERS = prev;
    }
  });

  it("prepends and preserves the policy with the preflight branch active", async () => {
    const run = vi.fn(async () => "done");
    const ledger = await openTaskLedger({ runner: { run, notify: async () => {} } });
    const preflight = { check: async () => ({ ok: true, issues: [] as string[] }), release: () => {} };
    const t = tools(tasksPlugin({ ledger, agentId: "knower", chat: { transport: "telegram", chatId: "42" }, preflight: preflight as never, transcription: { policy } }));
    const r = await t.get("start_task")!.execute("cap2", { title: "max input", instructions: long, audioDurationUnknown: true });
    const task = await ledger.get(started(r as { details?: unknown }));
    expect(task!.instructions.length).toBeLessThanOrEqual(8000);
    expect(task!.instructions.startsWith("[pibot:transcription-policy] route=probe-required")).toBe(true);
    expect(task!.instructions).toMatch(/PROBE it \(ffprobe\) FIRST/);
    ledger.close();
  });
});
