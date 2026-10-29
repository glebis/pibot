import { describe, it, expect, vi } from "vitest";
import { PiBot } from "./bot.js";
import { labMenu } from "./lab-companion.js";
import type { Transport } from "./types.js";
describe("isolated lab participant answers", () => {
  it("uses only scoped context and no shared agent session, persists both sides", async () => {
    const bot = Object.create(PiBot.prototype) as PiBot;
    const recordConversation = vi.fn();
    const complete = vi.fn(async (..._args: any[]) => ({stopReason:"stop",content:[{type:"text",text:"Следующий шаг"}]}));
    const getOrCreateSession = vi.fn();
    Object.assign(bot, {
      deps: {agents:{getAgent:()=>({manifest:{model:"local/model"}}),resolveModel:()=>({id:"model"}),getOrCreateSession},modelRuntime:{complete}},
      labFor:()=>({recordConversation,context:()=>"ONLY ALICE"}),
    });
    const t={push:vi.fn(async()=>{}),setTyping:vi.fn()} as unknown as Transport;
    await (bot as any).answerLabParticipant(t,"5","Моя цель — книга",{quoted:"Какова цель?"},71);
    expect(recordConversation).toHaveBeenNthCalledWith(1,t,"5","user","Моя цель — книга",71,"Какова цель?");
    expect(recordConversation).toHaveBeenNthCalledWith(2,t,"5","assistant","Следующий шаг");
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(complete.mock.calls[0][1].messages[0].content).toContain("ONLY ALICE");
    expect(t.push).toHaveBeenCalledWith("5",expect.objectContaining({replyToMessageId:71,text:"Следующий шаг"}));
  });
});


describe("fresh contextual recommendations", () => {
  it("includes recordings and memory, saves Markdown, and does not invent a user reply", async () => {
    const bot = Object.create(PiBot.prototype) as PiBot;
    const recordConversation = vi.fn(); const savePersonalizedRecommendation = vi.fn();
    const complete = vi.fn(async (..._args: any[]) => ({stopReason:"stop",content:[{type:"text",text:"# Мой следующий шаг\nПрактика по цели"}]}));
    const lab = {menuFor: () => labMenu({ subscribed: true }),recordConversation,savePersonalizedRecommendation,context:()=>"ALICE GOAL AND MEMORY",recordingsContext:async()=>"VERIFIED RECORDING",canPersonalize:()=>true};
    Object.assign(bot, {deps:{agents:{getAgent:()=>({manifest:{model:"local/model"}}),resolveModel:()=>({id:"model"})},modelRuntime:{complete}},labFor:()=>lab});
    const t={push:vi.fn(async()=>{}),setTyping:vi.fn()} as unknown as Transport;
    expect(await (bot as any).requestLabRecommendations(t,"5")).toBe(true);
    expect(complete.mock.calls[0][1].messages[0].content).toContain("ALICE GOAL AND MEMORYVERIFIED RECORDING");
    expect(savePersonalizedRecommendation).toHaveBeenCalledWith(t,"5","# Мой следующий шаг\nПрактика по цели");
    expect(recordConversation).toHaveBeenCalledTimes(1);
    expect(recordConversation.mock.calls[0][2]).toBe("assistant");
    expect(t.push).toHaveBeenCalledWith("5",expect.objectContaining({card:labMenu({ subscribed: true })}));
  });
});


describe("always-available feedback routing", () => {
  it("intercepts feedback before pending questions or model turns", async () => {
    const bot = Object.create(PiBot.prototype) as PiBot;
    const handleFeedback=vi.fn(async()=>true);
    const answerViaText=vi.fn(); const promptAgent=vi.fn();
    Object.assign(bot,{labFor:()=>({handleFeedback}),questions:{answerViaText},promptAgent});
    const t={name:"telegram:lab",boundAgentId:"lab"} as Transport;
    await bot.handleIncoming(t,"5","I have feedback, about the bot: the menu is confusing",undefined,88);
    expect(handleFeedback).toHaveBeenCalledWith(t,"5","I have feedback, about the bot: the menu is confusing",88);
    expect(answerViaText).not.toHaveBeenCalled();
    expect(promptAgent).not.toHaveBeenCalled();
  });
  it("leaves ordinary pending answers on their normal path", async () => {
    const bot=Object.create(PiBot.prototype) as PiBot;
    const answerViaText=vi.fn(()=>true);
    Object.assign(bot,{labFor:()=>({handleFeedback:vi.fn(async()=>false),requiresIsolatedConversation:()=>false}),questions:{answerViaText}});
    const t={name:"telegram:lab",boundAgentId:"lab"} as Transport;
    await bot.handleIncoming(t,"42","the second option");
    expect(answerViaText).toHaveBeenCalledWith("telegram:lab:42","the second option");
  });
});

