import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AcpPromptRequest } from "./server.js";
import { AcpServer } from "./server.js";
import type { JsonRpcMessage, StopReason } from "./protocol.js";

interface Harness {
  send: (msg: unknown) => void;
  lines: JsonRpcMessage[];
  waitFor: (predicate: () => boolean, ms?: number) => Promise<void>;
}

function harness(prompt: (req: AcpPromptRequest) => Promise<StopReason> = async () => "end_turn"): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: JsonRpcMessage[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) if (part.trim()) lines.push(JSON.parse(part));
  });
  const server = new AcpServer({
    input,
    output,
    agentInfo: { name: "pibot", title: "pibot · dev", version: "0.1.0" },
    prompt,
    log: () => undefined,
  });
  server.start();
  return {
    send: (msg) => input.write(JSON.stringify(msg) + "\n"),
    lines,
    waitFor: async (predicate, ms = 3_000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("timed out waiting for ACP output");
    },
  };
}

const byId = (lines: JsonRpcMessage[], id: number) => lines.find((m) => (m as { id?: number }).id === id);
const updates = (lines: JsonRpcMessage[]) =>
  lines.filter((m) => (m as { method?: string }).method === "session/update") as Array<{ params: { sessionId: string; update: { sessionUpdate: string; content?: { text?: string } } } }>;

describe("AcpServer", () => {
  it("answers initialize with wire version 1 and its agent info", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await h.waitFor(() => Boolean(byId(h.lines, 1)));
    const res = byId(h.lines, 1) as { result: { protocolVersion: number; agentInfo: { name: string }; agentCapabilities: { loadSession: boolean } } };
    expect(res.result.protocolVersion).toBe(1);
    expect(res.result.agentInfo.name).toBe("pibot");
    expect(res.result.agentCapabilities.loadSession).toBe(false);
  });

  it("answers authenticate with an empty result", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "x" } });
    await h.waitFor(() => Boolean(byId(h.lines, 2)));
    expect((byId(h.lines, 2) as { result: unknown }).result).toEqual({});
  });

  it("rejects session/new without a cwd", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { mcpServers: [] } });
    await h.waitFor(() => Boolean(byId(h.lines, 3)));
    expect((byId(h.lines, 3) as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("opens a session and reports it to the host", async () => {
    const onSessionNew = vi.fn();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: JsonRpcMessage[] = [];
    let buffer = "";
    output.setEncoding("utf8");
    output.on("data", (c: string) => {
      buffer += c;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) lines.push(JSON.parse(p));
    });
    new AcpServer({ input, output, agentInfo: { name: "pibot", version: "0.1.0" }, prompt: async () => "end_turn", onSessionNew, log: () => undefined }).start();
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/new", params: { cwd: "/tmp/work" } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    const sessionId = (byId(lines, 4) as { result: { sessionId: string } }).result.sessionId;
    expect(typeof sessionId).toBe("string");
    expect(onSessionNew).toHaveBeenCalledWith({ sessionId, cwd: "/tmp/work" });
  });

  it("runs a prompt, emitting session/update notifications and a stop reason", async () => {
    const seen: AcpPromptRequest[] = [];
    const h = harness(async (req) => {
      seen.push(req);
      req.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi there" } });
      return "end_turn";
    });
    h.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp/work" } });
    await h.waitFor(() => Boolean(byId(h.lines, 1)));
    const sessionId = (byId(h.lines, 1) as { result: { sessionId: string } }).result.sessionId;

    h.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello" }] } });
    await h.waitFor(() => Boolean(byId(h.lines, 2)));

    expect((byId(h.lines, 2) as { result: { stopReason: string } }).result.stopReason).toBe("end_turn");
    expect(seen[0].prompt).toEqual([{ type: "text", text: "hello" }]);
    const chunks = updates(h.lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].params.update.content?.text).toBe("hi there");
    expect(chunks[0].params.sessionId).toBe(sessionId);
  });

  it("rejects a prompt for an unknown session", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "nope", prompt: [] } });
    await h.waitFor(() => Boolean(byId(h.lines, 9)));
    expect((byId(h.lines, 9) as { error: { code: number } }).error.code).toBe(-32002);
  });

  it("cancels a running turn when session/cancel arrives as a notification", async () => {
    const h = harness(
      (req) =>
        new Promise<StopReason>((resolve) => {
          if (req.signal.aborted) return resolve("cancelled");
          req.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
        }),
    );
    h.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp/work" } });
    await h.waitFor(() => Boolean(byId(h.lines, 1)));
    const sessionId = (byId(h.lines, 1) as { result: { sessionId: string } }).result.sessionId;

    h.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "long task" }] } });
    h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    await h.waitFor(() => Boolean(byId(h.lines, 2)));
    expect((byId(h.lines, 2) as { result: { stopReason: string } }).result.stopReason).toBe("cancelled");
    // a notification must never get a response
    expect(h.lines.filter((m) => (m as { id?: unknown }).id === undefined && (m as { method?: string }).method === "session/cancel")).toHaveLength(0);
  });

  it("reports an internal error when the turn throws", async () => {
    const h = harness(async () => {
      throw new Error("model exploded");
    });
    h.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp/work" } });
    await h.waitFor(() => Boolean(byId(h.lines, 1)));
    const sessionId = (byId(h.lines, 1) as { result: { sessionId: string } }).result.sessionId;
    h.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "boom" }] } });
    await h.waitFor(() => Boolean(byId(h.lines, 2)));
    expect((byId(h.lines, 2) as { error: { code: number; message: string } }).error.code).toBe(-32603);
    expect((byId(h.lines, 2) as { error: { message: string } }).error.message).toBe("model exploded");
  });

  it("answers unknown capabilities-gated methods with method-not-found", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 7, method: "session/load", params: { sessionId: "s", cwd: "/tmp", mcpServers: [] } });
    await h.waitFor(() => Boolean(byId(h.lines, 7)));
    expect((byId(h.lines, 7) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("acknowledges set_mode and announces the new mode", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp/work" } });
    await h.waitFor(() => Boolean(byId(h.lines, 1)));
    const sessionId = (byId(h.lines, 1) as { result: { sessionId: string } }).result.sessionId;
    h.send({ jsonrpc: "2.0", id: 2, method: "session/set_mode", params: { sessionId, modeId: "plan" } });
    await h.waitFor(() => Boolean(byId(h.lines, 2)));
    expect((byId(h.lines, 2) as { result: unknown }).result).toEqual({});
    expect(updates(h.lines).some((u) => u.params.update.sessionUpdate === "current_mode_update")).toBe(true);
  });
});
