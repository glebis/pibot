import { describe, expect, it, vi } from "vitest";
import type { InlineExtension, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { agentCommsPlugin, type CommsHooks } from "./agent-comms-plugin.js";
import { CAPABILITY_REGISTRY, resolveCapabilities, type CapabilityContext } from "../core/capabilities.js";
import { OWNER_CHAT_ID } from "../test-fixtures.js";

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
  const CHAT = { transport: "telegram", chatId: OWNER_CHAT_ID };

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
    expect(askAgent).toHaveBeenCalledWith("researcher", "pibot-dev", "please build X", undefined, CHAT, "message", undefined);
  });

  it("agent_ask passes its chat as originChat too", async () => {
    const { tools, askAgent } = makePlugin();
    await tools.get("agent_ask")!.execute("id", { to: "pibot-dev", question: "status?", timeoutMinutes: "2" });
    expect(askAgent).toHaveBeenCalledWith("researcher", "pibot-dev", "status?", 2 * 60e3, CHAT, "ask", undefined);
  });

  it("handoff passes its chat as originChat", async () => {
    const { tools, handoffContext } = makePlugin();
    await tools.get("handoff")!.execute("id", { to: "pibot-dev", note: "keep going" });
    expect(handoffContext).toHaveBeenCalledWith("researcher", "pibot-dev", "keep going", CHAT);
  });
});

describe("agent-comms delegated origin propagation (bd pibot-0xpf.5)", () => {
  it("forwards the ORIGINAL invoking chat through a delegated executor session, not the executor's own chat", async () => {
    const askAgent = vi.fn(async () => "ok");
    const ctx = {
      agent: { id: "dev", dir: "/tmp/dev", manifest: { name: "dev" } },
      workspace: "/tmp",
      vaultDir: "/tmp",
      scheduler: {},
      // the executor's own sub-bot chat
      chat: { transport: "telegram:dev", chatId: "8995" },
      // the chat the owner actually typed in (worker)
      deliveryChat: { transport: "telegram:worker", chatId: "8900" },
      comms: { askAgent, handoffContext: vi.fn(async () => "ack"), listAgents: () => [{ id: "knower" }] },
    } as unknown as CapabilityContext;
    const caps = resolveCapabilities(ctx, CAPABILITY_REGISTRY, ["agent-comms"]);
    const tools = toolsOf(caps.extensions.find((e) => e.name === "agent-comms")!);
    await tools.get("agent_message")!.execute("id", { to: "knower", text: "fetch the clips" });
    // worker → dev → knower must keep WORKER as the destination, not dev's own bot chat
    expect(askAgent).toHaveBeenCalledWith("dev", "knower", "fetch the clips", undefined, { transport: "telegram:worker", chatId: "8900" }, "message", undefined);
  });
});