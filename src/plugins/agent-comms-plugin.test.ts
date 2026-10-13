import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { agentCommsPlugin } from "./agent-comms-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type CapturedTool = ToolDefinition & {
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

describe("agent comms plugin", () => {
  const makeDeps = (overrides: Partial<{
    agentId: string;
    askAgent: any;
    handoffContext: any;
    listAgents: any;
  }> = {}) => ({
    agentId: "bot-1",
    chat: { transport: "mock", chatId: "42" },
    askAgent: vi.fn(async (_from: string, _to: string, _text: string, _timeoutMs?: number) => {
      return "reply from target";
    }),
    handoffContext: vi.fn(async (_from: string, _to: string, _note?: string) => {
      return "handoff reply";
    }),
    listAgents: overrides.listAgents ?? (() => [{ id: "tax", description: "Tax agent" }, { id: "billing", description: "Billing agent" }]),
    ...overrides,
  });

  function captureTools(deps: ReturnType<typeof makeDeps>) {
    const tools = new Map<string, CapturedTool>();
    const pi = {
      registerTool: (t: ToolDefinition) => tools.set(t.name, t as CapturedTool),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    factoryOf(agentCommsPlugin(deps))(pi);
    return { pi, tools };
  }

  it("registers all four tools: agent_message, agent_ask, handoff, agent_list", () => {
    const { tools } = captureTools(makeDeps());
    expect(tools.has("agent_message")).toBe(true);
    expect(tools.has("agent_ask")).toBe(true);
    expect(tools.has("handoff")).toBe(true);
    expect(tools.has("agent_list")).toBe(true);
  });

  describe("schema validation via registered TypeBox schemas", () => {
    it("agent_message schema rejects missing required fields and wrong types", () => {
      const { tools } = captureTools(makeDeps());
      const schema = tools.get("agent_message")!.parameters;
      expect(Value.Check(schema, { to: "tax", text: "hi" } as unknown)).toBe(true);
      expect(Value.Check(schema, { text: "hello" } as unknown)).toBe(false);
      expect(Value.Check(schema, { to: "tax" } as unknown)).toBe(false);
      expect(Value.Check(schema, { to: 42, text: { not: "a string" } } as unknown)).toBe(false);
    });

    it("agent_ask schema rejects missing required fields and wrong types", () => {
      const { tools } = captureTools(makeDeps());
      const schema = tools.get("agent_ask")!.parameters;
      expect(Value.Check(schema, { to: "tax", question: "hi" } as unknown)).toBe(true);
      expect(Value.Check(schema, { to: "tax", question: "hi", timeoutMinutes: "5" } as unknown)).toBe(true);
      expect(Value.Check(schema, { question: "hi" } as unknown)).toBe(false);
      expect(Value.Check(schema, { to: "tax" } as unknown)).toBe(false);
      expect(Value.Check(schema, { to: 1, question: 2 } as unknown)).toBe(false);
    });

    it("handoff schema rejects missing required fields and wrong types", () => {
      const { tools } = captureTools(makeDeps());
      const schema = tools.get("handoff")!.parameters;
      expect(Value.Check(schema, { to: "tax" } as unknown)).toBe(true);
      expect(Value.Check(schema, { to: "tax", note: "hi" } as unknown)).toBe(true);
      expect(Value.Check(schema, {} as unknown)).toBe(false);
      expect(Value.Check(schema, { to: 1 } as unknown)).toBe(false);
    });

    it("agent_list schema accepts empty object", () => {
      const { tools } = captureTools(makeDeps());
      const schema = tools.get("agent_list")!.parameters;
      expect(Value.Check(schema, {} as unknown)).toBe(true);
    });
  });

  describe("agent_message", () => {
    it("sends message to another agent via askAgent", async () => {
      const deps = makeDeps();
      const { tools } = captureTools(deps);
      const res = await tools.get("agent_message")!.execute("t1", { to: "tax", text: "file taxes by Friday" });
      expect(res.content[0].text).toBe("Delivered to **tax**.");
      expect(res.details).toEqual({ ok: true });
      expect(deps.askAgent).toHaveBeenCalledWith("bot-1", "tax", "file taxes by Friday", undefined, { transport: "mock", chatId: "42" });
    });

    it("blocks message to self with 'That's you — just think it.'", async () => {
      const { tools } = captureTools(makeDeps());
      const res = await tools.get("agent_message")!.execute("t1", { to: "bot-1", text: "hello" });
      expect(res.content[0].text).toBe("That's you — just think it.");
      expect(res.details).toEqual({ ok: false });
    });

    it("normalizes downstream askAgent failure as ERROR text", async () => {
      const deps = makeDeps({ askAgent: vi.fn(async () => { throw new Error("agent unreachable"); }) });
      const { tools } = captureTools(deps);
      const res = await tools.get("agent_message")!.execute("t1", { to: "tax", text: "hi" });
      expect(res.content[0].text).toContain("delivery failed");
      expect(res.content[0].text).toContain("agent unreachable");
      expect(res.details).toEqual({ ok: false });
    });
  });

  describe("agent_ask", () => {
    it("asks another agent via askAgent and shows full reply", async () => {
      const deps = makeDeps();
      const { tools } = captureTools(deps);
      const res = await tools.get("agent_ask")!.execute("t1", { to: "tax", question: "deadline for filings?" });
      expect(res.content[0].text).toBe("**tax** replied:\nreply from target");
      expect(res.details).toEqual({ reply: "reply from target" });
      expect(deps.askAgent).toHaveBeenCalledWith("bot-1", "tax", "deadline for filings?", undefined, { transport: "mock", chatId: "42" });
    });

    it("passes parsed timeoutMinutes to askAgent", async () => {
      const deps = makeDeps();
      const { tools } = captureTools(deps);
      await tools.get("agent_ask")!.execute("t1", { to: "tax", question: "hello", timeoutMinutes: "2.5" });
      expect(deps.askAgent).toHaveBeenCalledWith("bot-1", "tax", "hello", 150000, { transport: "mock", chatId: "42" });
    });

    it("uses default 10m when timeoutMinutes is non-numeric", async () => {
      const deps = makeDeps();
      const { tools } = captureTools(deps);
      await tools.get("agent_ask")!.execute("t1", { to: "tax", question: "hello", timeoutMinutes: "notanumber" });
      expect(deps.askAgent).toHaveBeenCalledWith("bot-1", "tax", "hello", 600000, { transport: "mock", chatId: "42" });
    });

    it("blocks ask to self with 'That's you — answer from your own knowledge.'", async () => {
      const { tools } = captureTools(makeDeps());
      const res = await tools.get("agent_ask")!.execute("t1", { to: "bot-1", question: "what do you know?" });
      expect(res.content[0].text).toBe("That's you — answer from your own knowledge.");
      expect(res.details).toEqual({ ok: false });
    });

    it("normalizes downstream askAgent failure as ERROR text", async () => {
      const deps = makeDeps({ askAgent: vi.fn(async () => { throw new Error("no reply"); }) });
      const { tools } = captureTools(deps);
      const res = await tools.get("agent_ask")!.execute("t1", { to: "tax", question: "?" });
      expect(res.content[0].text).toContain("ask failed");
      expect(res.content[0].text).toContain("no reply");
      expect(res.details).toEqual({ ok: false });
    });
  });

  describe("handoff", () => {
    it("handoffs to another agent via handoffContext", async () => {
      const deps = makeDeps();
      const { tools } = captureTools(deps);
      const res = await tools.get("handoff")!.execute("t1", { to: "tax", note: "urgent: client call" });
      expect(res.content[0].text).toBe("Handed off to **tax**. They have the context now.\nhandoff reply");
      expect(res.details).toEqual({ ok: true });
      expect(deps.handoffContext).toHaveBeenCalledWith("bot-1", "tax", "urgent: client call", { transport: "mock", chatId: "42" });
    });

    it("passes undefined note when note is not provided", async () => {
      const deps = makeDeps();
      const { tools } = captureTools(deps);
      await tools.get("handoff")!.execute("t1", { to: "tax" });
      expect(deps.handoffContext).toHaveBeenCalledWith("bot-1", "tax", undefined, { transport: "mock", chatId: "42" });
    });

    it("blocks handoff to self with 'That's you.'", async () => {
      const { tools } = captureTools(makeDeps());
      const res = await tools.get("handoff")!.execute("t1", { to: "bot-1" });
      expect(res.content[0].text).toBe("That's you.");
      expect(res.details).toEqual({ ok: false });
    });

    it("normalizes downstream handoffContext failure as ERROR text", async () => {
      const deps = makeDeps({ handoffContext: vi.fn(async () => { throw new Error("cannot handoff"); }) });
      const { tools } = captureTools(deps);
      const res = await tools.get("handoff")!.execute("t1", { to: "tax" });
      expect(res.content[0].text).toContain("handoff failed");
      expect(res.content[0].text).toContain("cannot handoff");
      expect(res.details).toEqual({ ok: false });
      expect(deps.handoffContext).toHaveBeenCalledWith("bot-1", "tax", undefined, { transport: "mock", chatId: "42" });
    });
  });

  describe("unknown/unauthorized dependency errors via generic normalization path", () => {
    it("unknown target dependency error normalizes to {ok:false} with user-visible content", async () => {
      const deps = makeDeps({
        askAgent: vi.fn(async () => { throw new Error("agent not found"); }),
        listAgents: () => [{ id: "tax", description: "Tax agent" }],
      });
      const { tools } = captureTools(deps);
      const res = await tools.get("agent_message")!.execute("t1", { to: "ghost", text: "hi" });
      expect(res.details).toEqual({ ok: false });
      expect(res.content[0].text).toContain("delivery failed");
      expect(res.content[0].text).toContain("agent not found");
    });

    it("unauthorized target dependency error normalizes to {ok:false} with user-visible content", async () => {
      const deps = makeDeps({
        askAgent: vi.fn(async () => { throw new Error("access denied"); }),
        listAgents: () => [{ id: "tax", description: "Tax agent" }],
      });
      const { tools } = captureTools(deps);
      const res = await tools.get("agent_ask")!.execute("t1", { to: "billing", question: "test" });
      expect(res.details).toEqual({ ok: false });
      expect(res.content[0].text).toContain("ask failed");
      expect(res.content[0].text).toContain("access denied");
    });
  });

  describe("agent_list", () => {
    it("lists sibling agents filtered without the invoking agent", async () => {
      const { tools, deps } = (() => {
        const d = makeDeps();
        const t = captureTools(d);
        return { ...t, deps: d };
      })();
      const res = await tools.get("agent_list")!.execute("t1", {});
      expect(res.content[0].text).toBe("- **tax** — Tax agent\n- **billing** — Billing agent");
      expect(res.details).toEqual({ count: 2 });
    });

    it("shows 'No other agents.' when listAgents returns only the invoking agent", async () => {
      const { tools, deps } = (() => {
        const d = makeDeps({ listAgents: (() => [{ id: "bot-1", description: "me" }]) });
        const t = captureTools(d);
        return { ...t, deps: d };
      })();
      const res = await tools.get("agent_list")!.execute("t1", {});
      expect(res.content[0].text).toBe("No other agents.");
      expect(res.details).toEqual({ count: 0 });
    });

    it("filters out the invoking agent even when it appears in listAgents results", async () => {
      const { tools, deps } = (() => {
        const d = makeDeps({ listAgents: (() => [{ id: "bot-1", description: "me" }, { id: "tax", description: "tax agent" }]) });
        const t = captureTools(d);
        return { ...t, deps: d };
      })();
      const res = await tools.get("agent_list")!.execute("t1", {});
      expect(res.content[0].text).toBe("- **tax** — tax agent");
      expect(res.details).toEqual({ count: 1 });
    });

    it("makes no external or paid call on discovery — listAgents is only source of truth", async () => {
      const listAgentsSpy = vi.fn(() => [{ id: "tax" }]);
      const deps = makeDeps({ listAgents: listAgentsSpy });
      const { tools } = captureTools(deps);
      await tools.get("agent_list")!.execute("t1", {});
      expect(listAgentsSpy).toHaveBeenCalledTimes(1);
      expect(deps.askAgent).not.toHaveBeenCalled();
      expect(deps.handoffContext).not.toHaveBeenCalled();
    });
  });
});
