import { describe, expect, it, vi } from "vitest";
import type { Transport } from "./types.js";
import { createCommandHandler, type CommandContext } from "./commands.js";
import type { VoiceOwnerCommands } from "../voice/owner-commands.js";

// /call and /voicetest are admin-only: the owner's private chat, never groups or participants.

const OWNER = "100000001";

function makeCtx(opts: { boundAgentId?: string; voice?: Partial<VoiceOwnerCommands> | null; agent?: string } = {}) {
  const pushed: Array<{ chatId: string; text: string; card?: { buttons: Array<{ label: string; action: string }> } }> = [];
  const transport = {
    name: "telegram",
    boundAgentId: opts.boundAgentId,
    push: vi.fn(async (chatId: string, p: { text: string; card?: never }) => pushed.push({ chatId, text: p.text, card: p.card })),
  } as unknown as Transport;
  const voice = opts.voice === null ? undefined : {
    callAvailability: vi.fn(() => "ok" as const),
    armCall: vi.fn(() => "tok123"),
    testPageUrl: vi.fn((a: string) => `http://127.0.0.1:8788/#token=${"a".repeat(64)}&agent=${a}`),
    ...opts.voice,
  };
  const ctx = {
    config: { allowedChats: [OWNER, "-100123"] } as never,
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
    currentAgent: () => opts.agent ?? "assistant",
    chatKey: (_t: Transport, chatId: string) => `telegram:${chatId}`,
    rememberChat: () => {},
    voice: () => voice as unknown as VoiceOwnerCommands | undefined,
  } as unknown as CommandContext;
  return { handler: createCommandHandler(ctx), transport, pushed, voice };
}

describe("/call", () => {
  it("asks for confirmation with single-use call/cancel buttons in the owner chat", async () => {
    const { handler, transport, pushed, voice } = makeCtx();
    await handler(transport, OWNER, "/call");
    const last = pushed.at(-1)!;
    expect(last.text).toContain("Call your phone as **assistant**");
    expect(last.card?.buttons.map((b) => b.action)).toEqual(["vcall:go:tok123", "vcall:x:tok123"]);
    expect(voice!.armCall).toHaveBeenCalledWith("assistant", `telegram:${OWNER}`);
  });

  it("is refused in groups, even allowlisted ones", async () => {
    const { handler, transport, pushed, voice } = makeCtx();
    await handler(transport, "-100123", "/call");
    expect(pushed.at(-1)?.text).toContain("only in your private owner chat");
    expect(voice!.armCall).not.toHaveBeenCalled();
  });

  it("is refused for participants of a bound sub-bot", async () => {
    const { handler, transport, pushed, voice } = makeCtx({ boundAgentId: "lab" });
    await handler(transport, "555", "/call");
    expect(pushed.at(-1)?.text).toContain("no such commands");
    expect(voice!.armCall).not.toHaveBeenCalled();
  });

  it("explains instead of arming when calls can't work", async () => {
    const unconfigured = makeCtx({ voice: { callAvailability: vi.fn(() => "not_configured" as const) } });
    await unconfigured.handler(unconfigured.transport, OWNER, "/call");
    expect(unconfigured.pushed.at(-1)?.text).toContain("aren't configured");
    const unbound = makeCtx({ voice: { callAvailability: vi.fn(() => "not_bound" as const) } });
    await unbound.handler(unbound.transport, OWNER, "/call");
    expect(unbound.pushed.at(-1)?.text).toContain("no voice binding");
    expect(unbound.voice!.armCall).not.toHaveBeenCalled();
    const none = makeCtx({ voice: null });
    await none.handler(none.transport, OWNER, "/call");
    expect(none.pushed.at(-1)?.text).toContain("Voice isn't set up");
  });
});

describe("/voicetest", () => {
  it("sends the private page link preselected with the current agent", async () => {
    const { handler, transport, pushed } = makeCtx({ agent: "knower" });
    await handler(transport, OWNER, "/voicetest");
    expect(pushed.at(-1)?.text).toContain("&agent=knower");
    expect(pushed.at(-1)?.text).toContain("isolated copy");
  });

  it("explains how to start the page when it isn't running", async () => {
    const { handler, transport, pushed } = makeCtx({ voice: { testPageUrl: vi.fn(() => undefined) } });
    await handler(transport, OWNER, "/voicetest");
    expect(pushed.at(-1)?.text).toContain("start-voice.sh");
  });

  it("is refused in groups", async () => {
    const { handler, transport, pushed } = makeCtx();
    await handler(transport, "-100123", "/voicetest");
    expect(pushed.at(-1)?.text).toContain("only in your private owner chat");
  });
});
