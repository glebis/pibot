import { describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandContext } from "./commands.js";
import type { Transport } from "./types.js";

function makeCtx(over: Partial<CommandContext> = {}): CommandContext & { pushed: Array<{ chatId: string; text: string }>; transports: Map<string, Transport> } {
  const pushed: Array<{ chatId: string; text: string }> = [];
  const transport = { name: "test", push: vi.fn(async (_chatId: string, p: { text: string }) => pushed.push({ chatId: "42", text: p.text })) } as unknown as Transport;
  const ctx = {
    transports: new Map([["test", transport]]),
    agentChats: new Map(),
    pendingSubBots: new Map(),
    wizardChats: new Set(),
    currentAgent: () => "assistant",
    chatKey: () => "test:42",
    rememberChat: () => {},
    resetSession: async () => {},
    ensureHeartbeatJob: () => {},
    ensureEvolutionJob: () => {},
    config: {},
    heartbeat: { tick: async () => {} },
    questions: { cancelPending: () => false },
    wizard: {},
    pushed,
    ...over,
  } as unknown as CommandContext & { pushed: Array<{ chatId: string; text: string }>; transports: Map<string, Transport> };
  return ctx;
}

describe("/commit command", () => {
  it("captures an explicit commitment when the pilot engine is wired", async () => {
    const captureExplicit = vi.fn(() => ({ commitment: { id: "cmABC12" }, reply: "Commitment tracked ✅ (id cmABC12)" }));
    const ctx = makeCtx({ commitments: { captureExplicit } as never });
    const handler = createCommandHandler(ctx);
    await handler(ctx.transports.get("test")!, "42", "/commit send invoice by in 3d");
    expect(captureExplicit).toHaveBeenCalledWith("assistant", { transport: "test", chatId: "42" }, "send invoice", expect.any(Number));
    expect(ctx.pushed.at(-1)!.text).toContain("cmABC12");
  });

  it("hints at usage when no 'by' clause is present", async () => {
    const ctx = makeCtx({ commitments: { captureExplicit: vi.fn() } as never });
    const handler = createCommandHandler(ctx);
    await handler(ctx.transports.get("test")!, "42", "/commit vague intention");
    expect(ctx.pushed.at(-1)!.text).toMatch(/by|usage/i);
  });

  it("tells the owner when the pilot is not enabled for this agent", async () => {
    const ctx = makeCtx();
    const handler = createCommandHandler(ctx);
    await handler(ctx.transports.get("test")!, "42", "/commit send invoice by in 2d");
    expect(ctx.pushed.at(-1)!.text).toMatch(/pilot/i);
  });
});