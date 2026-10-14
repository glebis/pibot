import { describe, expect, it, vi } from "vitest";
import type { Transport } from "./types.js";
import { createCommandHandler, type CommandContext } from "./commands.js";
import { OWNER_CHAT_ID } from "../test-fixtures.js";

// ─── participant sub-bot command gate ───────────────────────────────────────
// boundAgentId present + chat NOT on the owner allowlist → only /start /help
// /minimal /id pass; everything else is refused. Owner chats keep the deck.

function makeCtx(opts: { allowedChats?: string[] } = {}) {
  const pushed: Array<{ chatId: string; text: string }> = [];
  const transport = {
    name: "telegram",
    boundAgentId: "lab",
    push: vi.fn(async (chatId: string, p: { text: string }) => pushed.push({ chatId, text: p.text })),
  } as unknown as Transport;
  const ctx = {
    config: { allowedChats: opts.allowedChats ?? [OWNER_CHAT_ID], allowedChatsReal: undefined } as never,
    agents: { list: () => [], getAgent: () => undefined, discover: async () => {} } as never,
    scheduler: { list: () => [], snoozeState: () => ({}) } as never,
    events: { log: () => {} } as never,
    transports: new Map([["telegram", transport]]),
    agentChats: new Map(),
    pendingSubBots: new Map(),
    wizardChats: new Set(),
    heartbeat: { tick: async () => {} },
    questions: { cancelPending: () => false, ask: async () => ({}) },
    wizard: {},
    currentAgent: () => "lab",
    chatKey: (_t: Transport, chatId: string) => `telegram:${chatId}`,
    rememberChat: () => {},
    pushed,
  } as unknown as CommandContext & { pushed: Array<{ chatId: string; text: string }> };
  return { ctx, transport: ctx.transports.get("telegram")! };
}

describe("participant sub-bot command gate", () => {
  it("refuses owner commands for non-owner chats on a bound sub-bot", async () => {
    const { ctx, transport } = makeCtx();
    const handler = createCommandHandler(ctx);
    const pushed = (ctx as unknown as { pushed: Array<{ chatId: string; text: string }> }).pushed;
    for (const cmd of ["/schedules", "/model ollama/x", "/subbot lab", "/quit", "/newagent x", "/cascade", "/evolve goal"]) {
      pushed.length = 0;
      await handler(transport, "-1004311316115", cmd);
      expect(pushed.at(-1)?.text).toContain("no such commands");
      expect(pushed.at(-1)?.text).not.toContain("/schedules");
    }
  });

  it("allows basic commands (/start /help /minimal /id) for participants", async () => {
    const { ctx, transport } = makeCtx();
    const handler = createCommandHandler(ctx);
    const last = () => (ctx as unknown as { pushed: Array<{ chatId: string; text: string }> }).pushed.at(-1)?.text ?? "";
    await handler(transport, "-1004311316115", "/start");
    expect(last()).toContain("Course companion");
    await handler(transport, "-1004311316115", "/help");
    expect(last()).toContain("Course companion");
    await handler(transport, "-1004311316115", "/minimal on");
    await handler(transport, "-1004311316115", "/id");
    expect(last()).toContain("Your id");
    expect(last()).not.toContain("transport");
  });

  it("keeps the full command deck for the owner allowlist chat", async () => {
    const { ctx, transport } = makeCtx({ allowedChats: ["42"] });
    const handler = createCommandHandler(ctx);
    const pushed = (ctx as unknown as { pushed: Array<{ chatId: string; text: string }> }).pushed;
    await handler(transport, "42", "/help");
    expect(pushed.at(-1)?.text).toContain("/schedules");
    await handler(transport, "42", "/id");
    expect(pushed.at(-1)?.text).toContain("transport");
  });

  it("unknown agent-bound chat that IS in the global allowlist still gets owner commands", async () => {
    const { ctx, transport } = makeCtx({ allowedChats: ["55"] });
    const handler = createCommandHandler(ctx);
    const pushed = (ctx as unknown as { pushed: Array<{ chatId: string; text: string }> }).pushed;
    await handler(transport, "55", "/help");
    expect(pushed.at(-1)?.text).toContain("/schedules");
  });
});