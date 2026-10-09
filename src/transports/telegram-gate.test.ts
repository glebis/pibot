import { describe, expect, it } from "vitest";
import type { Context } from "grammy";
import { TelegramTransport } from "./telegram.js";

/** Build a minimal fake grammY context for gate tests — only chat/from/message fields are used. */
function fakeGateCtx(opts: {
  chatType?: "private" | "group" | "supergroup";
  chatId?: number;
  fromId?: number;
  text?: string;
  replyFromId?: number;
}): Context {
  const msg: Record<string, unknown> = { message_id: 1, date: 0, chat: { id: opts.chatId ?? -100123, type: opts.chatType ?? "private" } };
  if (opts.fromId) msg.from = { id: opts.fromId, is_bot: false, first_name: "U" };
  if (opts.text !== undefined) msg.text = opts.text;
  if (opts.replyFromId) msg.reply_to_message = { message_id: 9, from: { id: opts.replyFromId, is_bot: true, first_name: "B" } };
  return {
    chat: msg.chat,
    from: msg.from as never,
    message: msg,
    update: { update_id: 1, message: msg },
  } as unknown as Context;
}

/** Install a fake grammy bot.api on the transport's private bot field. */
function fakeApi(t: TelegramTransport, api: Record<string, unknown>): void {
  (t as unknown as { bot: { api: Record<string, unknown> } }).bot = { api };
}

describe("mention-only group gate (participant bots)", () => {
  function mentionBot(): TelegramTransport {
    const t = new TelegramTransport("123:test", ["-100123"], { groupMentionOnly: true });
    // verify() normally sets this from getMe
    (t as unknown as { me?: { id: number; username?: string } }).me = { id: 777, username: "lab_course_bot" };
    return t;
  }

  it("check is now async (group gating awaits membership)", async () => {
    const t = mentionBot();
    expect(typeof (t as unknown as { check: unknown }).check).toBe("function");
  });

  it("group message with @mention passes the mention gate", async () => {
    const t = mentionBot();
    const ok = await (t as unknown as { check: (c: Context) => Promise<boolean> }).check(
      fakeGateCtx({ chatType: "supergroup", chatId: -100123, fromId: 5, text: "hey @lab_course_bot when is the meeting?" })
    );
    expect(ok).toBe(true);
  });

  it("group message without mention is denied when mention-only", async () => {
    const t = mentionBot();
    const ok = await (t as unknown as { check: (c: Context) => Promise<boolean> }).check(
      fakeGateCtx({ chatType: "supergroup", chatId: -100123, fromId: 5, text: "casual group chatter" })
    );
    expect(ok).toBe(false);
  });

  it("reply to one of the bot's messages passes without an @mention", async () => {
    const t = mentionBot();
    const ok = await (t as unknown as { check: (c: Context) => Promise<boolean> }).check(
      fakeGateCtx({ chatType: "group", chatId: -100123, fromId: 5, text: "thanks!", replyFromId: 777 })
    );
    expect(ok).toBe(true);
  });

  it("non-mention bot: every group message passes the mention gate", async () => {
    const t = new TelegramTransport("123:test", ["-100123"]);
    const ok = await (t as unknown as { check: (c: Context) => Promise<boolean> }).check(
      fakeGateCtx({ chatType: "supergroup", chatId: -100123, fromId: 5, text: "casual group chatter" })
    );
    expect(ok).toBe(true);
  });

  it("private DM on a mention-only bot (no memberGroups) passes if allowlisted", async () => {
    const t = mentionBot();
    const ok = await (t as unknown as { check: (c: Context) => Promise<boolean> }).check(
      fakeGateCtx({ chatType: "private", chatId: -100123, fromId: 42, text: "hello" })
    );
    expect(ok).toBe(true);
  });
});

describe("membership gate (memberGroups)", () => {
  function memberBot(getChatMemberImpl: (groupId: number, userId: number) => Promise<unknown>): TelegramTransport {
    const t = new TelegramTransport("123:test", ["-100123"], { memberGroups: ["-100123"] });
    (t as unknown as { me?: { id: number; username?: string } }).me = { id: 777, username: "lab_course_bot" };
    fakeApi(t, { getChatMember: getChatMemberImpl });
    return t;
  }

  it("DM from a group member passes", async () => {
    let calls = 0;
    const t = memberBot(async () => { calls++; return { status: "member" }; });
    const g = t as unknown as { check: (c: Context) => Promise<boolean>; membershipCache: Map<string, { ok: boolean; until: number }> };
    expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 5, fromId: 5, text: "hi" }))).toBe(true);
    expect(calls).toBe(1);
    expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 5, fromId: 5, text: "again" }))).toBe(true);
    expect(calls).toBe(1); // cached now
  });

  it("DM from a non-member is denied and cached briefly", async () => {
    let calls = 0;
    const t = memberBot(async () => { calls++; return { status: "left" }; });
    const g = t as unknown as { check: (c: Context) => Promise<boolean>; membershipCache: Map<string, { ok: boolean; until: number }> };
    expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 9, fromId: 9, text: "hi" }))).toBe(false);
    expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 9, fromId: 9, text: "hi" }))).toBe(false);
    expect(calls).toBe(1); // negative TTL cache
  });

  it("administrator and creator statuses count as members", async () => {
    for (const status of ["administrator", "creator", "restricted"]) {
      const t = memberBot(async () => ({ status }));
      const g = t as unknown as { check: (c: Context) => Promise<boolean>; membershipCache: Map<string, { ok: boolean; until: number }> };
      expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 5, fromId: 5, text: "hi" }))).toBe(true);
      g.membershipCache.clear(); // fresh lookup per status
    }
  });

  it("kicked members are denied", async () => {
    const t = memberBot(async () => ({ status: "kicked" }));
    const g = t as unknown as { check: (c: Context) => Promise<boolean> };
    expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 5, fromId: 5, text: "hi" }))).toBe(false);
  });

  it("API failure fails open with a short cache entry (never locks participants out)", async () => {
    const t = memberBot(async () => { throw new Error("telegram down"); });
    const g = t as unknown as { check: (c: Context) => Promise<boolean>; membershipCache: Map<string, { ok: boolean; until: number }> };
    expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 5, fromId: 5, text: "hi" }))).toBe(true);
    const entry = g.membershipCache.get("5");
    expect(entry?.ok).toBe(true);
    expect(entry!.until - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it("group messages skip the membership lookup entirely", async () => {
    let calls = 0;
    const t = memberBot(async () => { calls++; return { status: "member" }; });
    const g = t as unknown as { check: (c: Context) => Promise<boolean> };
    expect(await g.check(fakeGateCtx({ chatType: "supergroup", chatId: -100123, fromId: 5, text: "@lab_course_bot hi" }))).toBe(true);
    expect(calls).toBe(0);
  });

  it("no memberGroups configured: gate is a no-op for DMs", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const ok = await (t as unknown as { check: (c: Context) => Promise<boolean> }).check(
      fakeGateCtx({ chatType: "private", chatId: 42, fromId: 5, text: "hi" })
    );
    expect(ok).toBe(true);
  });
});

describe("memberGroups + mention-only compose", () => {
  it("group mention passes allowlist; participant DM needs membership", async () => {
    const t = new TelegramTransport("123:test", ["-100123", "42"], { memberGroups: ["-100123"], groupMentionOnly: true });
    (t as unknown as { me?: { id: number; username?: string } }).me = { id: 777, username: "lab_course_bot" };
    fakeApi(t, { getChatMember: async () => ({ status: "member" }) });
    const g = t as unknown as { check: (c: Context) => Promise<boolean> };
    expect(await g.check(fakeGateCtx({ chatType: "supergroup", chatId: -100123, fromId: 5, text: "@lab_course_bot hi" }))).toBe(true);
    expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 42, fromId: 42, text: "hi" }))).toBe(true); // DM gate = membership, not allowlist
    expect(await g.check(fakeGateCtx({ chatType: "private", chatId: 55, fromId: 55, text: "hi" }))).toBe(true); // any private DM gated by membership only
  });
});

describe("denied-path responses", () => {
  it("non-member DM gets a generic members-only note, not owner pairing help", async () => {
    const t = new TelegramTransport("123:test", ["-100123"], { memberGroups: ["-100123"], boundAgentId: "lab" });
    fakeApi(t, {
      getChatMember: async () => ({ status: "left" }),
      sendMessage: async (_cid: number, text: string) => { sent = text; return { message_id: 1 }; },
    });
    let sent = "";
    await (t as unknown as { handleDenied: (c: Context) => Promise<void> }).handleDenied(
      fakeGateCtx({ chatType: "private", chatId: 9, fromId: 9, text: "hi" })
    );
    expect(sent).toContain("course group");
    expect(sent).not.toContain("TELEGRAM_ALLOWED_CHATS");
  });

  it("group chatter in a mention-only group is silently ignored (no spam)", async () => {
    const t = new TelegramTransport("123:test", ["-100123"], { groupMentionOnly: true, boundAgentId: "lab" });
    (t as unknown as { me?: { id: number; username?: string } }).me = { id: 777, username: "lab_course_bot" };
    let sentCount = 0;
    fakeApi(t, { sendMessage: async () => { sentCount++; return { message_id: 1 }; } });
    await (t as unknown as { handleDenied: (c: Context) => Promise<void> }).handleDenied(
      fakeGateCtx({ chatType: "supergroup", chatId: -100123, fromId: 5, text: "casual chatter" })
    );
    expect(sentCount).toBe(0);
  });
});