import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { telegramSendPlugin, type TelegramSendHooks } from "./telegram-send-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };

const CHAT = { transport: "telegram", chatId: "42" };

function pluginFor(hooks: TelegramSendHooks) {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as Tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  factoryOf(telegramSendPlugin({ agentId: "a1", chat: CHAT, hooks }))(pi);
  return { tools };
}

describe("telegram-send plugin", () => {
  it("registers the send and chats tools", () => {
    const hooks: TelegramSendHooks = { send: vi.fn(), chats: () => [] };
    const { tools } = pluginFor(hooks);
    expect(tools.has("telegram_send")).toBe(true);
    expect(tools.has("telegram_chats")).toBe(true);
  });

  it("defaults to the current chat and passes explicit targets through", async () => {
    const send = vi.fn(async () => ({ sent: 1, targets: ["telegram:42"] }));
    const { tools } = pluginFor({ send, chats: () => [] });

    await tools.get("telegram_send")!.execute("t1", { text: "hello board" });
    expect(send).toHaveBeenCalledWith("a1", "telegram:42", "hello board");

    await tools.get("telegram_send")!.execute("t2", { text: "cross post", chat: "telegram:-1001234" });
    expect(send).toHaveBeenLastCalledWith("a1", "telegram:-1001234", "cross post");
  });

  it("surfaces hook errors as tool errors instead of throwing", async () => {
    const send = vi.fn(async () => { throw new Error("no transport \"telegram:x\""); });
    const { tools } = pluginFor({ send, chats: () => [] });
    const r = await tools.get("telegram_send")!.execute("t1", { text: "hi", chat: "telegram:x" });
    expect(r.content[0].text).toContain("ERROR");
    expect(r.content[0].text).toContain("no transport");
  });

  it("reports an empty send result honestly", async () => {
    const send = vi.fn(async () => ({ sent: 0, targets: [] }));
    const { tools } = pluginFor({ send, chats: () => [] });
    const r = await tools.get("telegram_send")!.execute("t1", { text: "hi" });
    expect(r.content[0].text).toContain("Nothing sent");
  });

  it("reports the destination-aware receipt tuple without overclaiming delivery", async () => {
    const send = vi.fn(async () => ({
      sent: 1,
      targets: ["telegram:42"],
      receipts: [{ peer: "telegram:42", messageId: 7, mediaType: "video_note", idProtocol: "bot_api", evidence: "ack" as const }],
    }));
    const { tools } = pluginFor({ send, chats: () => [] });
    const r = await tools.get("telegram_send")!.execute("t1", { text: "round note" });
    expect(r.content[0].text).toContain("telegram:42");
    expect(r.content[0].text).toContain("message 7");
    expect(r.content[0].text).toContain("video_note");
    expect(r.content[0].text).toContain("bot_api id");
    // an API ack is not a readback or a view — the report must say so
    expect(r.content[0].text).toContain("API acknowledgement");
    expect(r.details.receipts).toHaveLength(1);
  });

  it("treats an id-less ack as unverified instead of claiming the message was delivered", async () => {
    const send = vi.fn(async () => ({ sent: 1, targets: ["telegram:42"], receipts: [{ peer: "telegram:42" }] }));
    const { tools } = pluginFor({ send, chats: () => [] });
    const r = await tools.get("telegram_send")!.execute("t1", { text: "hi" });
    expect(r.content[0].text).toContain("telegram:42");
    expect(r.content[0].text).toContain("no message id came back");
    expect(r.content[0].text).not.toContain("Sent ✅");
  });

  it("persists the bot account and calls a receipt without one incomplete", async () => {
    const send = vi.fn(async () => ({
      sent: 2,
      targets: ["telegram:42", "telegram:43"],
      receipts: [
        { peer: "telegram:42", messageId: 7, mediaType: "video_note", idProtocol: "bot_api", account: "@pibot", evidence: "ack" as const },
        { peer: "telegram:43", messageId: 8, mediaType: "text" },
      ],
    }));
    const { tools } = pluginFor({ send, chats: () => [] });
    const r = await tools.get("telegram_send")!.execute("t1", { text: "x" });
    expect(r.content[0].text).toContain("as @pibot");
    // a receipt missing the account and the id namespace must not read as a complete delivery
    expect(r.content[0].text).toContain("incomplete (no account/id protocol)");
    expect(r.details.receipts).toHaveLength(2);
  });

  it("telegram_chats lists reachable chats and explains empty state", async () => {
    const chats = vi.fn(() => [{ chat: "telegram:42", dedicated: false, owned: false }]);
    let { tools } = pluginFor({ send: vi.fn(), chats });
    const listed = await tools.get("telegram_chats")!.execute("t1", {});
    expect(listed.content[0].text).toContain("telegram:42");
    expect(listed.content[0].text).toContain("not owned");

    ({ tools } = pluginFor({ send: vi.fn(), chats: () => [] }));
    const empty = await tools.get("telegram_chats")!.execute("t1", {});
    expect(empty.content[0].text).toContain("No reachable Telegram chats");
  });
});