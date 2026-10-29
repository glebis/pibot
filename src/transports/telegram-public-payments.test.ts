import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { TelegramTransport } from "./telegram.js";

describe("public course flow remains outside the agent gate", () => {
  const ctx = (text: string, type = "private") => ({ chat: { id: 42, type }, from: { id: 42 }, message: { text } }) as unknown as Context;
  it("routes nonmember lab requests only to the fixed public handler", async () => {
    const t = new TelegramTransport("123:test", ["1"], { nameSuffix: "lab", boundAgentId: "lab", memberGroups: ["-1001"] });
    const publicFlow = vi.fn(async () => {});
    t.onPublicRequest(publicFlow);
    await (t as any).handleDenied(ctx("/start KRAFT"));
    await (t as any).handleDenied(ctx("/agents"));
    expect(publicFlow.mock.calls).toEqual([["42", "/start KRAFT"], ["42", "/agents"]]);
  });
  it("never grants membership or changes the command gate", async () => {
    const t = new TelegramTransport("123:test", ["1"], { nameSuffix: "lab", boundAgentId: "lab", memberGroups: ["-1001"] });
    (t as any).bot = { api: { getChatMember: vi.fn(async () => ({ status: "left" })) } };
    t.onPublicRequest(async () => {});
    expect(await (t as any).check(ctx("/agents"))).toBe(false);
  });
  it("does not open another participant bot", async () => {
    const t = new TelegramTransport("123:test", ["1"], { nameSuffix: "other", boundAgentId: "other", memberGroups: ["-1001"] });
    const publicFlow = vi.fn(async () => {});
    t.onPublicRequest(publicFlow);
    (t as any).sendTelegram = async () => {};
    await (t as any).handleDenied(ctx("/start KRAFT"));
    expect(publicFlow).not.toHaveBeenCalled();
  });
  it("does not open group requests", async () => {
    const t = new TelegramTransport("123:test", ["1"], { nameSuffix: "lab", boundAgentId: "lab", memberGroups: ["-1001"] });
    const publicFlow = vi.fn(async () => {});
    t.onPublicRequest(publicFlow);
    await (t as any).handleDenied(ctx("/start KRAFT", "supergroup"));
    expect(publicFlow).not.toHaveBeenCalled();
  });
});
