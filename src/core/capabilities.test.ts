import { describe, expect, it, vi } from "vitest";
import { CAPABILITY_REGISTRY, resolveCapabilities, type CapabilityContext, type CapabilityDefinition } from "./capabilities.js";

const baseContext = {
  agent: { id: "a1", dir: "/tmp/a1", manifest: { name: "a1" } },
  workspace: "/tmp/a1",
  vaultDir: "/tmp/vault",
  scheduler: {},
  chat: { transport: "test", chatId: "1" },
} as unknown as CapabilityContext;

function capability(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    id: "sample",
    defaultEnabled: false,
    tools: ["sample_read", "sample_write"],
    prompt: "sample_read / sample_write: use the sample service.",
    create: vi.fn(() => ({ name: "sample", factory: vi.fn() })),
    ...overrides,
  };
}

describe("capability registry", () => {
  it("loads only selected capabilities and derives factories, tools and prompt from one definition", () => {
    const def = capability();
    const result = resolveCapabilities(baseContext, [def], ["sample"]);
    expect(result.ids).toEqual(["sample"]);
    expect(result.tools).toEqual(["sample_read", "sample_write"]);
    expect(result.prompt).toContain("sample_read / sample_write");
    expect(result.extensions).toHaveLength(1);
    expect(def.create).toHaveBeenCalledWith(baseContext);
  });

  it("does not advertise or allow a selected capability whose runtime dependency is unavailable", () => {
    const result = resolveCapabilities(baseContext, [capability({ available: () => false })], ["sample"]);
    expect(result.ids).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.prompt).toBe("");
    expect(result.unavailable).toEqual(["sample"]);
  });

  it("uses the registry's explicit defaults and rejects unknown manifest capability ids", () => {
    const defaultDef = capability({ id: "default-one", defaultEnabled: true });
    const optInDef = capability({ id: "opt-in", defaultEnabled: false });
    expect(resolveCapabilities(baseContext, [defaultDef, optInDef]).ids).toEqual(["default-one"]);
    expect(() => resolveCapabilities(baseContext, [defaultDef], ["typo"])).toThrow(/Unknown capability "typo"/);
  });

  it("contains every formerly advertised host plugin with its tools and prompt contract", () => {
    const expected = new Map<string, string[]>([
      ["agent-comms", ["agent_message", "agent_ask", "agent_list", "handoff"]],
      ["knowledge", ["knowledge_share", "knowledge_read"]],
      ["attend", ["attend_enqueue", "attend_list", "attend_mark"]],
      ["telegram-responder", ["inbox_pending", "followups_open", "draft_reply"]],
      ["delegate", ["delegate_cli"]],
    ]);
    for (const [id, tools] of expected) {
      const definition = CAPABILITY_REGISTRY.find((item) => item.id === id);
      expect(definition?.tools).toEqual(tools);
      expect(definition?.prompt).toBeTruthy();
      expect(definition?.create).toBeTypeOf("function");
    }
  });

  it("keeps speech opt-in and exposes separate generate and send tools only when Telegram speech is available", () => {
    const definition = CAPABILITY_REGISTRY.find((item) => item.id === "speech");
    expect(definition).toMatchObject({ defaultEnabled: false, tools: ["speech_generate", "speech_send"] });
    const context = {
      ...baseContext,
      chat: { transport: "telegram:coach", chatId: "42" },
      speech: { providers: { list: () => [{ id: "local", configured: true }] }, store: {}, send: vi.fn() },
    } as unknown as CapabilityContext;
    const result = resolveCapabilities(context, CAPABILITY_REGISTRY, ["speech"]);
    expect(result.ids).toEqual(["speech"]);
    expect(result.prompt).toContain("explicitly asks");
    expect(result.prompt).toContain("Never use speech from heartbeat");
  });

  it("does not expose speech when no local speech provider is configured", () => {
    const context = {
      ...baseContext,
      chat: { transport: "telegram:coach", chatId: "42" },
      speech: { providers: { list: () => [{ id: "local", configured: false }] }, store: {}, send: vi.fn() },
    } as unknown as CapabilityContext;
    const result = resolveCapabilities(context, CAPABILITY_REGISTRY, ["speech"]);
    expect(result.ids).toEqual([]);
    expect(result.unavailable).toEqual(["speech"]);
  });

  it("loads and advertises the formerly disconnected plugins when explicitly selected and available", () => {
    const ids = ["agent-comms", "knowledge", "attend", "telegram-responder", "delegate"];
    const definitions = CAPABILITY_REGISTRY
      .filter((item) => ids.includes(item.id))
      .map((item) => ({ ...item, available: () => true }));
    const context = {
      ...baseContext,
      comms: { askAgent: vi.fn(), handoffContext: vi.fn(), listAgents: vi.fn(() => []) },
    } as unknown as CapabilityContext;
    const result = resolveCapabilities(context, definitions, ids);
    expect(result.ids).toEqual(ids);
    expect(result.extensions.map((extension) => extension.name)).toEqual([
      "agent-comms", "knowledge", "attend", "tg-responder", "delegate",
    ]);
    expect(result.tools).toEqual(expect.arrayContaining([
      "agent_message", "handoff", "knowledge_share", "attend_enqueue", "draft_reply", "delegate_cli",
    ]));
    for (const tool of ["agent_message", "knowledge_share", "attend_enqueue", "draft_reply", "delegate_cli"]) {
      expect(result.prompt).toContain(tool);
    }
  });
});
