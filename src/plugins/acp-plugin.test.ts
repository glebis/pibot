import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpClient, AcpClientOptions } from "../acp/client.js";
import type { SessionUpdate } from "../acp/protocol.js";
import { acpPlugin, collectAgentText, renderAcpResult, summarizeToolCalls } from "./acp-plugin.js";

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };

function captureTools(ext: InlineExtension): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (t: ToolDefinition) => tools.set(t.name, t as Tool), registerCommand: vi.fn(), on: vi.fn() } as unknown as ExtensionAPI;
  const factory = typeof ext === "function" ? ext : ext.factory;
  factory(pi);
  return tools;
}

const UPDATES: SessionUpdate[] = [
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: " } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "added the test." } },
  { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read src/x.ts", status: "pending", kind: "read" },
  { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
  { sessionUpdate: "tool_call", toolCallId: "c2", title: "Run npm test", kind: "execute" },
  { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } },
];

describe("ACP result rendering", () => {
  it("joins streamed message chunks and ignores thought chunks", () => {
    expect(collectAgentText(UPDATES)).toBe("Done: added the test.");
  });

  it("merges tool_call + tool_call_update into one ordered list", () => {
    const calls = summarizeToolCalls(UPDATES);
    expect(calls.map((c) => c.toolCallId)).toEqual(["c1", "c2"]);
    expect(calls[0]).toMatchObject({ title: "Read src/x.ts", status: "completed" });
    expect(calls[1]).toMatchObject({ title: "Run npm test", status: "pending" });
  });

  it("renders text plus a tool summary", () => {
    const rendered = renderAcpResult("Command Code", UPDATES);
    expect(rendered).toContain("Done: added the test.");
    expect(rendered).toContain("tools used: 2");
    expect(rendered).toContain("Read src/x.ts — completed");
  });
});

describe("acpPlugin", () => {
  let workspace: string;
  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-acp-plugin-"));
    fs.mkdirSync(path.join(workspace, "sub"));
  });
  afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

  function stubClient(result: { stopReason: string; updates: SessionUpdate[] }) {
    return {
      start: vi.fn(),
      initialize: vi.fn(async () => ({})),
      newSession: vi.fn(async () => "s1"),
      prompt: vi.fn(async () => result),
      dispose: vi.fn(async () => undefined),
    } as unknown as AcpClient;
  }

  it("runs the ACP agent and returns its rendered result", async () => {
    const client = stubClient({ stopReason: "end_turn", updates: UPDATES });
    const tools = captureTools(acpPlugin({ allowed: ["cmd"], workspace, clientFactory: () => client }));
    const tool = tools.get("acp_run")!;
    const out = await tool.execute("t", { prompt: "add a test" });
    expect(out.details.ok).toBe(true);
    expect(out.details.stopReason).toBe("end_turn");
    expect(out.details.toolCalls).toBe(2);
    expect(out.content[0].text).toContain("Done: added the test.");
    expect(client.dispose).toHaveBeenCalled();
  });

  it("rejects an unknown agent without launching anything", async () => {
    const factory = vi.fn();
    const tools = captureTools(acpPlugin({ allowed: ["cmd"], workspace, clientFactory: factory as unknown as (o: AcpClientOptions) => AcpClient }));
    const out = await tools.get("acp_run")!.execute("t", { prompt: "x", agent: "nope" });
    expect(out.details.ok).toBe(false);
    expect(out.content[0].text).toContain("unknown ACP agent");
    expect(factory).not.toHaveBeenCalled();
  });

  it("refuses a cwd outside the workspace", async () => {
    const factory = vi.fn();
    const tools = captureTools(acpPlugin({ allowed: ["cmd"], workspace, clientFactory: factory as unknown as (o: AcpClientOptions) => AcpClient }));
    const out = await tools.get("acp_run")!.execute("t", { prompt: "x", cwd: "../../etc" });
    expect(out.details.ok).toBe(false);
    expect(out.content[0].text).toContain("ERROR");
    expect(factory).not.toHaveBeenCalled();
  });

  it("always disposes the client when the run fails", async () => {
    const client = stubClient({ stopReason: "end_turn", updates: [] });
    (client.prompt as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const tools = captureTools(acpPlugin({ allowed: ["cmd"], workspace, clientFactory: () => client }));
    const out = await tools.get("acp_run")!.execute("t", { prompt: "x" });
    expect(out.details.ok).toBe(false);
    expect(out.content[0].text).toContain("boom");
    expect(client.dispose).toHaveBeenCalled();
  });
});
