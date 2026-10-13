import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CAPABILITY_REGISTRY, resolveCapabilities, type CapabilityContext } from "../core/capabilities.js";
import type { QuestionAnswer, QuestionSpec } from "../core/questions.js";
import { questionPlugin } from "./question-plugin.js";

type Tool = ToolDefinition<any, any>;

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

function captureTool(ext: InlineExtension): Tool {
  const tools = new Map<string, Tool>();
  factoryOf(ext)({
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI);
  return tools.get("ask_user")!;
}

function textOf(result: Awaited<ReturnType<Tool["execute"]>>): string {
  const item = result.content[0];
  return item.type === "text" ? item.text : "";
}

function run(tool: Tool, params: unknown) {
  return tool.execute("test-call", params, undefined, undefined, {} as never);
}

const CHAT = { transport: "telegram:coach", chatId: "chat-7" } as const;
const baseContext = {
  agent: { id: "agent-1", dir: "/tmp/agent-1", manifest: { name: "agent-1" } },
  workspace: "/tmp/workspace",
  vaultDir: "/tmp/vault",
  scheduler: {},
  chat: CHAT,
} as unknown as CapabilityContext;

describe("question plugin", () => {
  it("registers ask_user and exposes the structured parameter contract", () => {
    const tool = captureTool(questionPlugin({ chat: CHAT, ask: vi.fn() }));
    expect(tool.name).toBe("ask_user");
    expect(tool.description).toContain("structured question");
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["question", "options"],
      properties: {
        question: { type: "string" },
        options: { type: "array", minItems: 2, maxItems: 10, items: { type: "string" } },
      },
    });
  });

  it("executes a valid question, trims options, and selects a poll for 7+ options", async () => {
    const ask = vi.fn(async (spec: QuestionSpec): Promise<QuestionAnswer> => ({ choice: spec.options[6], index: 6, via: "poll", timedOut: false }));
    const result = await run(captureTool(questionPlugin({ chat: CHAT, ask })), {
      question: "Pick one",
      options: [" one ", "two", "three", "four", "five", "six", " seven "],
    });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: "Pick one", options: ["one", "two", "three", "four", "five", "six", "seven"], poll: true }));
    expect(textOf(result)).toContain('User chose: "seven"');
    expect(result.details).toMatchObject({ choice: "seven", index: 6, via: "poll", timedOut: false });
  });

  it("rejects malformed option lists without invoking the dependency", async () => {
    const ask = vi.fn();
    const result = await run(captureTool(questionPlugin({ chat: CHAT, ask })), { question: "Pick", options: [" ", ""] });
    expect(textOf(result)).toBe("ERROR: need at least 2 options.");
    expect(result.details).toMatchObject({ choice: "", index: -1 });
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps the capability unavailable when no ask dependency is bound", () => {
    const definition = CAPABILITY_REGISTRY.find((entry) => entry.id === "questions")!;
    expect(definition.available?.(baseContext)).toBe(false);
    const resolved = resolveCapabilities(baseContext, CAPABILITY_REGISTRY, ["questions"]);
    expect(resolved.ids).not.toContain("questions");
    expect(resolved.tools).not.toContain("ask_user");
    expect(resolved.unavailable).toContain("questions");
  });

  it("returns a dependency failure as an explicit tool error", async () => {
    const ask = vi.fn(async () => { throw new Error("delivery unavailable"); });
    const result = await run(captureTool(questionPlugin({ chat: CHAT, ask })), { question: "Pick", options: ["a", "b"] });
    expect(textOf(result)).toBe("ERROR asking: Error: delivery unavailable");
    expect(result.details).toMatchObject({ timedOut: true, index: -1 });
  });

  it("discovers the capability without invoking the ask dependency or any external call", () => {
    const ask = vi.fn();
    const resolved = resolveCapabilities({ ...baseContext, ask }, CAPABILITY_REGISTRY, ["questions"]);
    expect(resolved.ids).toEqual(["questions"]);
    expect(ask).not.toHaveBeenCalled();
  });
});
