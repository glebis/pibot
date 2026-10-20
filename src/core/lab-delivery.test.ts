import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramTransport } from "../transports/telegram.js";
import { makeBot } from "./bot.test.js";

const OWNER = "42";
const GROUP = "-1001234567890";
const SERVICE = "Heads up — lab is answering on fallback model backup because the primary is unavailable. /cascade for status.";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** Real outbound transport/queue/formatting, stubbed only at the Telegram API boundary. */
function fixture() {
  const host = makeBot(undefined, { allowedChats: [OWNER] });
  roots.push(host.dir);
  const transport = new TelegramTransport("123:test", [OWNER], {
    nameSuffix: "lab", boundAgentId: "lab", reactions: false,
  });
  const sends: Array<{ chatId: string; text: string; options: unknown }> = [];
  const sendMessage = vi.fn(async (chatId: string | number, text: string, options: unknown) => {
    sends.push({ chatId: String(chatId), text, options });
    return { message_id: sends.length };
  });
  const sendRichMessage = vi.fn(async (chatId: string | number, payload: { markdown: string }, options: unknown) => {
    sends.push({ chatId: String(chatId), text: payload.markdown, options });
    return { message_id: sends.length };
  });
  (transport as unknown as { bot: unknown }).bot = { api: { sendMessage, sendRichMessage } };
  host.bot.addTransport(transport);
  const state = host.bot as unknown as { agentChats: Map<string, Set<string>>; chatAgent: Map<string, string> };
  state.agentChats.set("lab", new Set([`telegram:lab:${GROUP}`, `telegram:lab:${OWNER}`]));
  state.chatAgent.set(`telegram:lab:${GROUP}`, "lab");
  state.chatAgent.set(`telegram:lab:${OWNER}`, "lab");
  return { ...host, transport, sends, sendMessage, sendRichMessage };
}

describe("lab outbound delivery contract", () => {
  it("sends heartbeat output only to the owner DM, never to a remembered group", async () => {
    const t = fixture();
    await t.bot.deliverToAgent("lab", "Есть важное обновление курса.", { origin: "heartbeat" });
    expect(t.sends.map((send) => send.chatId)).toEqual([OWNER]);
    expect(t.sends[0]?.text).toContain("Есть важное обновление курса.");
  });

  it("blocks a heartbeat at the transport boundary for a participant DM too", async () => {
    const t = fixture();
    await t.transport.push("84", { text: "[heartbeat] Важное обновление." });
    expect(t.sends).toHaveLength(0);
  });

  it("does not change an ordinary group answer or its reply target", async () => {
    const t = fixture();
    const text = "Проверьте status задачи. Затем продолжим.\n\nВторая часть ответа.";
    await t.transport.push(GROUP, { text, replyToMessageId: 17 });
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0].text).toBe(text);
    expect(t.sends[0].options).toMatchObject({ reply_parameters: { message_id: 17 } });
  });

  it.each([SERVICE, "Status: provider unavailable; retry pending. /cascade for details."])(
    "does not send a standalone operational notice to a group: %s", async (text) => {
      const t = fixture();
      await t.transport.push(GROUP, { text, replyToMessageId: 17 });
      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.sendRichMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    `Задание к встрече: составьте краткий план.\n\n${SERVICE}`,
    `Задание к встрече: составьте краткий план. ${SERVICE} Продолжим завтра.`,
  ])("keeps the useful group reply but removes embedded operational text: %s", async (text) => {
    const t = fixture();
    await t.transport.push(GROUP, { text, replyToMessageId: 17 });
    expect(t.sends.length).toBeGreaterThan(0);
    expect(t.sends.every((send) => send.chatId === GROUP)).toBe(true);
    const wireText = t.sends.map((send) => send.text).join("\n");
    expect(wireText).toContain("Задание к встрече: составьте краткий план.");
    expect(wireText).not.toMatch(/fallback|primary is unavailable|\/cascade|Heads up/i);
  });

  it("allows a direct owner DM reply including operational text without filtering", async () => {
    const t = fixture();
    const text = `Диагностика по вашему запросу. ${SERVICE}`;
    await t.transport.push(OWNER, { text, replyToMessageId: 18 });
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0].chatId).toBe(OWNER);
    expect(t.sends[0].text).toContain("Диагностика по вашему запросу.");
    expect(t.sends[0].text).toContain(SERVICE);
  });
});
