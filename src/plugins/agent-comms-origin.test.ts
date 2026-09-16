import { describe, expect, it, vi } from "vitest";
import type { InlineExtension, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { agentCommsPlugin, type CommsHooks } from "./agent-comms-plugin.js";

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

function toolsOf(ext: InlineExtension): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as Tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  factoryOf(ext)(pi);
  return tools;
}

describe("agent-comms plugin origin-chat routing", () => {
  const CHAT = { transport: "telegram", chatId: "161427550" };

  function makePlugin(over: Partial<CommsHooks> = {}) {
    const askAgent = vi.fn(async () => "ok");
    const handoffContext = vi.fn(async () => "ack");
    const hooks: CommsHooks = {
      askAgent,
      handoffContext,
      listAgents: () => [{ id: "tax", description: "tax agent" }],
      ...over,
    };
    const tools = toolsOf(agentCommsPlugin({
      agentId: "researcher",
      chat: CHAT,
      askAgent: hooks.askAgent,
      handoffContext: hooks.handoffContext,
      listAgents: hooks.listAgents,
    }));
    return { tools, askAgent, handoffContext };
  }

  it("agent_message passes the invoking chat as originChat", async () => {
    const { tools, askAgent } = makePlugin();
    await tools.get("agent_message")!.execute("id", { to: "pibot-dev", text: "please build X" });
    expect(askAgent).toHaveBeenCalledWith("researcher", "pibot-dev", "please build X", undefined, CHAT);
  });

  it("agent_ask passes its chat as originChat too", async () => {
    const { tools, askAgent } = makePlugin();
    await tools.get("agent_ask")!.execute("id", { to: "pibot-dev", question: "status?", timeoutMinutes: "2" });
    expect(askAgent).toHaveBeenCalledWith("researcher", "pibot-dev", "status?", 2 * 60e3, CHAT);
  });

  it("handoff passes its chat as originChat", async () => {
    const { tools, handoffContext } = makePlugin();
    await tools.get("handoff")!.execute("id", { to: "pibot-dev", note: "keep going" });
    expect(handoffContext).toHaveBeenCalledWith("researcher", "pibot-dev", "keep going", CHAT);
  });
});