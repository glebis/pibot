import { describe, expect, it, vi } from "vitest";
import { prepareDelegatedReply } from "./delegated-delivery.js";
import type { DeliveryReceipt } from "./types.js";

const originChat = { transport: "telegram:worker", chatId: "test-owner" };
const receipt: DeliveryReceipt = { messageId: 41, mediaType: "photo", peer: "telegram:worker:test-owner", account: "test-bot", idProtocol: "bot_api", evidence: "ack" };
const base = { reply: "A result\nMEDIA:canary.png", cleanReply: "A result", media: ["canary.png"], ownerFacing: true, originChat };

describe("delegated attachment delivery reporting", () => {
  it("returns actual receipt to the caller, leaving owner text clean and sending once", async () => {
    const sendMedia = vi.fn(async () => receipt);
    const result = await prepareDelegatedReply({ ...base, transport: { name: originChat.transport, sendMedia } });
    expect(sendMedia).toHaveBeenCalledExactlyOnceWith("test-owner", "canary.png");
    expect(result.ownerReply).toBe("A result");
    expect(result.callerReply).toContain('"status":"acknowledged"');
    expect(result.callerReply).toContain('"messageId":41');
    expect(result.callerReply).toContain('"peer":"telegram:worker:test-owner"');
    expect(result.callerReply).toContain('"evidence":"ack"');
    expect(result.callerReply).toContain("do not resend or forward");
    expect(result.callerReply).not.toContain("MEDIA:canary.png");
  });

  it("keeps exactly one truthful outcome when diagnostic callbacks throw", async () => {
    const onSent = () => { throw new Error("log unavailable"); };
    const success = await prepareDelegatedReply({ ...base, onSent, transport: { name: originChat.transport, sendMedia: async () => receipt } });
    expect(success.attachments).toEqual([{ index: 0, status: "acknowledged", receipt }]);
    const failed = await prepareDelegatedReply({ ...base, onError: onSent, transport: { name: originChat.transport, sendMedia: async () => { throw new Error("network"); } } });
    expect(failed.attachments).toEqual([{ index: 0, status: "uncertain" }]);
  });

  it("preserves stronger evidence without turning an ack into readback", async () => {
    const result = await prepareDelegatedReply({ ...base, transport: { name: originChat.transport, sendMedia: async () => ({ ...receipt, evidence: "readback" }) } });
    expect(result.attachments[0].receipt?.evidence).toBe("readback");
    expect(result.callerReply).toContain("not independent readback or a human view");
  });

  it("does not manufacture a receipt when send resolves without one", async () => {
    const sendMedia = vi.fn(async () => {});
    const result = await prepareDelegatedReply({ ...base, transport: { name: originChat.transport, sendMedia } });
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(result.attachments).toEqual([{ index: 0, status: "unverified" }]);
    expect(result.callerReply).not.toContain('"receipt"');
  });

  it("keeps a message id without destination/account/evidence unverified", async () => {
    const result = await prepareDelegatedReply({ ...base, transport: { name: originChat.transport, sendMedia: async () => ({ messageId: 7 }) } });
    expect(result.attachments).toEqual([{ index: 0, status: "unverified", receipt: { messageId: 7 } }]);
  });

  it("reports wrong-peer acknowledgements as mismatch, never correct destination success", async () => {
    const result = await prepareDelegatedReply({ ...base, transport: { name: originChat.transport, sendMedia: async () => ({ ...receipt, peer: "telegram:other:test-owner" }) } });
    expect(result.attachments[0].status).toBe("mismatch");
    expect(result.attachments[0].receipt?.peer).toBe("telegram:other:test-owner");
    expect(result.callerReply).toContain('"acknowledged":0');
  });

  it("does not send when the origin transport or media capability is unavailable", async () => {
    for (const transport of [undefined, { name: originChat.transport }]) {
      const result = await prepareDelegatedReply({ ...base, transport });
      expect(result.attachments).toEqual([{ index: 0, status: "unavailable" }]);
    }
  });

  it("reports rejection/timeout as uncertain and never retries", async () => {
    const sendMedia = vi.fn(async () => { throw new Error("timeout"); });
    const result = await prepareDelegatedReply({ ...base, transport: { name: originChat.transport, sendMedia } });
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(result.attachments).toEqual([{ index: 0, status: "uncertain" }]);
    expect(result.callerReply).toContain("never retry automatically");
  });

  it("keeps each mixed outcome rather than reporting all attachments delivered", async () => {
    const sendMedia = vi.fn().mockResolvedValueOnce(receipt).mockRejectedValueOnce(new Error("network"));
    const result = await prepareDelegatedReply({ ...base, media: ["one.png", "two.png"], transport: { name: originChat.transport, sendMedia } });
    expect(sendMedia).toHaveBeenCalledTimes(2);
    expect(result.attachments.map((item) => item.status)).toEqual(["acknowledged", "uncertain"]);
    expect(result.callerReply).toContain('"acknowledged":1');
    expect(result.callerReply).toContain('"uncertain":1');
  });

  it("leaves internal coordination and text-only replies unchanged", async () => {
    const sendMedia = vi.fn(async () => receipt);
    const internal = await prepareDelegatedReply({ ...base, ownerFacing: false, transport: { name: originChat.transport, sendMedia } });
    expect(internal.callerReply).toBe(base.reply);
    expect(sendMedia).not.toHaveBeenCalled();
    const textOnly = await prepareDelegatedReply({ ...base, reply: "plain text", cleanReply: "plain text", media: [], transport: { name: originChat.transport, sendMedia } });
    expect(textOnly).toEqual({ ownerReply: "plain text", callerReply: "plain text", attachments: [] });
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("puts receipt evidence before the delegate text so the tool's 2500-character cap retains it", async () => {
    const result = await prepareDelegatedReply({ ...base, reply: "x".repeat(5000), cleanReply: "x".repeat(5000), transport: { name: originChat.transport, sendMedia: async () => receipt } });
    expect(result.callerReply.slice(0, 2500)).toContain('"messageId":41');
    expect(result.callerReply.slice(0, 2500)).toContain("MEDIA lines were consumed");
    expect(result.ownerReply).toBe("x".repeat(5000));
  });
});
