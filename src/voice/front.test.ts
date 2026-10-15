import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openTaskLedger, type TaskRun } from "../durable/task-ledger.js";
import { VoiceFront, type FrontHost } from "./front.js";

const say = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 } as unknown as AssistantMessage);
const call = (name: string, args: Record<string, unknown>, id = "tc1"): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: 1 } as unknown as AssistantMessage);

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) { const v = await read(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timed out");
}

function setup(script: AssistantMessage[], run: (t: TaskRun) => Promise<string> = async () => "Found five sources. Details follow.") {
  const runner = { run: vi.fn(run), notify: vi.fn(async () => {}) };
  const ledgerP = openTaskLedger({ runner });
  const complete = vi.fn(async () => script.shift() ?? say("Okay."));
  const host = (ledger: Awaited<typeof ledgerP>): FrontHost => ({
    complete,
    context: async () => ({ name: "knower", persona: "Curious researcher.", recent: "user: hi\nagent: hello" }),
    ledger: () => ledger,
  });
  return { ledgerP, complete, runner, host };
}

describe("voice front", () => {
  it("answers directly in one fast completion with the chat and tasks in its prompt", async () => {
    const s = setup([say("Hey, I'm here.")]);
    const ledger = await s.ledgerP;
    try {
      const front = new VoiceFront(s.host(ledger));
      front.open("c1", "knower", "telegram:42");
      expect(await front.turn("c1", "Can you hear me?", new AbortController().signal)).toBe("Hey, I'm here.");
      const [, ctx] = s.complete.mock.calls[0] as unknown as [string, { systemPrompt: string; tools: Array<{ name: string }> }];
      expect(ctx.systemPrompt).toContain("agent: hello");
      expect(ctx.systemPrompt).toContain("(none yet)");
      expect(ctx.tools.map((t) => t.name)).toEqual(["start_task", "list_tasks", "task_status", "cancel_task", "end_call"]);
    } finally { await ledger.close(); }
  });

  it("starts a durable task with the call's tool choice, keeps talking, and announces the result", async () => {
    const s = setup([call("start_task", { title: "Agent memory sources", instructions: "Find five recent sources on agent memory." }), say("On it — I'll tell you when it's back.")]);
    const ledger = await s.ledgerP;
    try {
      const front = new VoiceFront(s.host(ledger));
      front.open("c1", "knower", "telegram:42", ["web_search"]);
      expect(await front.events("c1")).toEqual([]); // baseline
      expect(await front.turn("c1", "Find me five sources on agent memory", new AbortController().signal)).toContain("On it");
      const [task] = await ledger.list({ agentId: "knower" });
      expect(task).toMatchObject({ title: "Agent memory sources", chatKey: "telegram:42", allowedTools: ["web_search"] });
      await until(() => ledger.get(task.id), (t) => t?.status === "done");
      const events = await front.events("c1");
      expect(events).toHaveLength(1);
      expect(events[0].text).toContain('"Agent memory sources" is done. Found five sources.');
      expect(await front.events("c1")).toEqual([]); // announced once
      const record = await front.close("c1");
      expect(record?.transcript.map((t) => t.role)).toEqual(["owner", "agent"]);
      expect(record?.tasks.map((t) => t.id)).toEqual([task.id]);
    } finally { await ledger.close(); }
  });

  it("puts a finished task's result into its own conversation, so it never claims the task is still running", async () => {
    const s = setup([call("start_task", { title: "Sources", instructions: "Find sources." }), say("Started."), say("Here are the five titles.")], async () => "Done. 1. Memory in agents (2026). 2. Long-context recall.");
    const ledger = await s.ledgerP;
    try {
      const front = new VoiceFront(s.host(ledger));
      front.open("c1", "knower", "telegram:42");
      await front.events("c1");
      await front.turn("c1", "find sources", new AbortController().signal);
      const [task] = await ledger.list({ agentId: "knower" });
      await until(() => ledger.get(task.id), (t) => t?.status === "done");
      const [event] = await front.events("c1");
      expect(event.text).toBe('"Sources" is done. 1. Memory in agents (2026). The full result is in the chat.'); // no "Done. Done."
      await front.turn("c1", "give me their names", new AbortController().signal);
      const [, ctx] = s.complete.mock.calls.at(-1) as unknown as [string, { systemPrompt: string; messages: Array<{ role: string; content: unknown }> }];
      expect(JSON.stringify(ctx.messages)).toContain("Background task update");
      expect(JSON.stringify(ctx.messages)).toContain("Long-context recall");
      expect(ctx.systemPrompt).toContain("Result: Done. 1. Memory in agents (2026). 2. Long-context recall.");
    } finally { await ledger.close(); }
  });

  it("hangs up on request with a short goodbye", async () => {
    const s = setup([{ role: "assistant", content: [{ type: "text", text: "Talk soon!" }, { type: "toolCall", id: "e1", name: "end_call", arguments: {} }], stopReason: "toolUse", timestamp: 1 } as unknown as AssistantMessage, say("")]);
    const ledger = await s.ledgerP;
    try {
      const front = new VoiceFront(s.host(ledger));
      front.open("c1", "knower", "telegram:42");
      expect(front.ending("c1")).toBe(false);
      expect(await front.turn("c1", "That's all, bye", new AbortController().signal)).toBe("Bye for now.");
      expect(front.ending("c1")).toBe(true);
      const [, ctx] = s.complete.mock.calls[0] as unknown as [string, { systemPrompt: string }];
      expect(ctx.systemPrompt).toContain("call end_call");
    } finally { await ledger.close(); }
  });

  it("only reports and cancels this chat's tasks", async () => {
    const s = setup([], (t) => new Promise((_, reject) => { if (t.signal.aborted) reject(new Error("x")); t.signal.addEventListener("abort", () => reject(new Error("x"))); }));
    const ledger = await s.ledgerP;
    try {
      const other = await ledger.start({ agentId: "knower", chatKey: "telegram:99", title: "Elsewhere", instructions: "x" });
      s.complete.mockResolvedValueOnce(call("cancel_task", { id: other.id })).mockResolvedValueOnce(say("I can't find that one."));
      const front = new VoiceFront(s.host(ledger));
      front.open("c1", "knower", "telegram:42");
      await front.turn("c1", "cancel it", new AbortController().signal);
      const toolResult = (s.complete.mock.calls[1] as unknown as [string, { messages: Array<{ role: string; content: unknown }> }])[1].messages.find((m) => m.role === "toolResult");
      expect(JSON.stringify(toolResult?.content)).toContain("No such task");
      expect((await ledger.get(other.id))?.status).not.toBe("cancelled");
      expect(await front.close("c2")).toBeUndefined();
    } finally { await ledger.close(); }
  });
});
