import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../core/agent-manager.js";
import type { Scheduler } from "../core/scheduler.js";
import { createPibotAcpPrompt } from "./agent.js";
import type { SessionUpdate } from "./protocol.js";

/** A stub pibot session that replays events through its subscriber. */
function stubSession(opts: { slow?: boolean; onPrompt?: (emit: (ev: unknown) => void) => void; onStarted?: () => void; finalMessages?: unknown[] } = {}) {
  let listener: ((ev: unknown) => void) | null = null;
  let release: (() => void) | null = null;
  const session = {
    agent: { state: { messages: opts.finalMessages ?? [] } },
    subscribe(l: (ev: unknown) => void) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    async prompt() {
      opts.onStarted?.();
      opts.onPrompt?.((ev) => listener?.(ev));
      if (opts.slow) await new Promise<void>((resolve) => (release = resolve));
    },
    abort: vi.fn(async () => release?.()),
  };
  return session as unknown as AgentSession;
}

const managerFor = (session: AgentSession) => ({ getOrCreateSession: vi.fn(async () => session) }) as unknown as AgentManager;
const scheduler = {} as Scheduler;
const run = (
  clients: SessionUpdate[],
  session: AgentSession,
  signal = new AbortController().signal,
  sessionId = "s1",
) =>
  createPibotAcpPrompt({ agents: managerFor(session), scheduler: scheduler, agentId: "assistant" })({
    sessionId,
    prompt: [{ type: "text", text: "go" }],
    emit: (u) => clients.push(u),
    signal,
  });

const kinds = (clients: SessionUpdate[]) => clients.map((u) => (u as { sessionUpdate: string }).sessionUpdate);

describe("createPibotAcpPrompt", () => {
  it("translates streamed deltas and tool events into session/update notifications", async () => {
    const session = stubSession({
      onPrompt: (emit) => {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking…" } });
        emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/x.ts" } });
        emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { ok: true }, isError: false });
      },
    });
    const updates: SessionUpdate[] = [];
    const stop = await run(updates, session);
    expect(stop).toBe("end_turn");
    expect(kinds(updates)).toEqual(["agent_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);
    const call = updates[3] as { title: string; kind: string; status: string; rawInput: { path: string } };
    expect(call.title).toContain("src/x.ts");
    expect(call.kind).toBe("read");
    expect(call.status).toBe("in_progress");
    expect(call.rawInput).toEqual({ path: "src/x.ts" });
    const done = updates[4] as { status: string; toolCallId: string };
    expect(done.status).toBe("completed");
    expect(done.toolCallId).toBe("c1");
  });

  it("maps a failed tool execution to a failed tool_call_update", async () => {
    const session = stubSession({
      onPrompt: (emit) => {
        emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "npm test" } });
        emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: "boom", isError: true });
      },
    });
    const updates: SessionUpdate[] = [];
    await run(updates, session);
    expect((updates[0] as { kind: string }).kind).toBe("execute");
    expect((updates[1] as { status: string }).status).toBe("failed");
  });

  it("sends the final assistant text once when the model never streamed a delta", async () => {
    const session = stubSession({ finalMessages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }] });
    const updates: SessionUpdate[] = [];
    await run(updates, session);
    expect(kinds(updates)).toEqual(["agent_message_chunk"]);
    expect((updates[0] as { content: { text: string } }).content.text).toBe("final answer");
  });

  it("does not duplicate the final text when deltas were streamed", async () => {
    const session = stubSession({
      onPrompt: (emit) => emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed" } }),
      finalMessages: [{ role: "assistant", content: [{ type: "text", text: "streamed" }] }],
    });
    const updates: SessionUpdate[] = [];
    await run(updates, session);
    expect(kinds(updates)).toEqual(["agent_message_chunk"]);
  });

  it("returns cancelled when the turn is aborted", async () => {
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((r) => (signalStarted = r));
    const session = stubSession({ slow: true, onStarted: () => signalStarted?.() });
    const controller = new AbortController();
    const updates: SessionUpdate[] = [];
    const pending = run(updates, session, controller.signal);
    await started; // abort only once the turn is actually running
    controller.abort();
    expect(await pending).toBe("cancelled");
    expect((session as unknown as { abort: ReturnType<typeof vi.fn> }).abort).toHaveBeenCalled();
  });

  it("reuses one pibot session per ACP session, keyed acp-<sessionId>", async () => {
    const session = stubSession();
    const agents = managerFor(session);
    const prompt = createPibotAcpPrompt({ agents, scheduler, agentId: "assistant" });
    const emit = () => undefined;
    await prompt({ sessionId: "xyz", prompt: [{ type: "text", text: "one" }], emit, signal: new AbortController().signal });
    await prompt({ sessionId: "xyz", prompt: [{ type: "text", text: "two" }], emit, signal: new AbortController().signal });
    expect(agents.getOrCreateSession).toHaveBeenCalledTimes(1);
    const call = (agents.getOrCreateSession as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("assistant");
    expect(call[1]).toBe("acp-xyz");
    expect(call[2]).toEqual({ transport: "acp", chatId: "xyz" });
  });

  it("ends the turn without building a session on an empty prompt", async () => {
    const session = stubSession();
    const agents = managerFor(session);
    const prompt = createPibotAcpPrompt({ agents, scheduler, agentId: "assistant" });
    const stop = await prompt({ sessionId: "s1", prompt: [], emit: () => undefined, signal: new AbortController().signal });
    expect(stop).toBe("end_turn");
    expect(agents.getOrCreateSession).not.toHaveBeenCalled();
  });
});
