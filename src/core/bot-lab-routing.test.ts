import { describe, expect, it, vi } from "vitest";
import { PiBot } from "./bot.js";
import type { Transport } from "./types.js";

function fixture() {
  const bot = Object.create(PiBot.prototype) as PiBot;
  Object.assign(bot, { deps: { config: { allowedChats: ["42"] } } });
  const handle = vi.fn(async (..._args: [Transport, string, string]) => true);
  const preview = vi.fn(async (..._args: [Transport, string, string, string]) => true);
  const userView = vi.fn(async () => true);
  const lab = { handle, preview, userView };
  // Routing tests isolate filesystem content delivery, covered by LabCompanion tests.
  Object.assign(bot, { labFor: (t: Transport) => t.name === "telegram:lab" && t.boundAgentId === "lab" ? lab : undefined });
  const t = { name: "telegram:lab", boundAgentId: "lab", push: vi.fn(async () => {}) } as unknown as Transport;
  return { bot, t, handle, preview, userView };
}

describe("lab routing and participant command boundaries", () => {
  it("routes /start payloads and bot-suffixed recommendation commands", async () => {
    const { bot, t, handle } = fixture();
    await bot.handleCommand(t, "5", "/start@agency_lab_companion_bot welcome");
    await bot.handleCommand(t, "5", "/recommendations@agency_lab_companion_bot");
    expect(handle.mock.calls).toEqual([[t, "5", "start"], [t, "5", "recommendations"]]);
  });
  it("routes personal buttons for the lab only", async () => {
    const { bot, t, handle } = fixture();
    await bot.handleAction(t, "5", "lab:homework");
    expect(handle).toHaveBeenCalledWith(t, "5", "homework");
    await bot.handleAction({ ...t, name: "telegram:other" }, "5", "lab:homework");
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it("blocks participant goal/continue commands before privileged intercepts", async () => {
    const { bot, t } = fixture();
    const goal = vi.fn(); const cont = vi.fn();
    Object.assign(bot, { commandGoal: goal, commandContinue: cont });
    for (const command of ["/goal take over", "/continue", "/goal@agency_lab_companion_bot resume"]) await bot.handleCommand(t, "5", command);
    expect(goal).not.toHaveBeenCalled(); expect(cont).not.toHaveBeenCalled();
    await bot.handleCommand(t, "42", "/goal status");
    expect(goal).toHaveBeenCalledWith(t, "42", "status");
  });
  it("blocks all operational commands and never treats an allowlisted group as admin", async () => {
    const { bot, t } = fixture();
    const handler = vi.fn(); const minimal = vi.fn(); const goal = vi.fn();
    Object.assign(bot, { commandHandler: handler, commandMinimal: minimal, commandGoal: goal });
    for (const command of ["agents", "agent coach", "newagent coach", "new", "status", "schedules", "snooze 2h", "wake", "evolve", "promises", "minimal on", "id", "labtest anna"]) {
      await bot.handleCommand(t, "5", `/${command}`);
    }
    Object.assign(bot, { deps: { config: { allowedChats: ["42", "-100123"] } } });
    await bot.handleCommand(t, "-100123", "/agents");
    await bot.handleCommand(t, "-100123", "/goal resume");
    expect(handler).not.toHaveBeenCalled(); expect(minimal).not.toHaveBeenCalled(); expect(goal).not.toHaveBeenCalled();
    await bot.handleCommand(t, "42", "/agents");
    expect(handler).toHaveBeenCalledWith(t, "42", "/agents");
  });
  it("blocks owner callbacks from participants before side effects", async () => {
    const { bot, t } = fixture();
    const goal = vi.fn(); const cont = vi.fn();
    Object.assign(bot, { commandGoal: goal, commandContinue: cont });
    for (const action of ["goal:resume", "continue", "bdshow:secret", "snz:morning", "cm:1:done"]) expect(await bot.handleAction(t, "5", action)).toContain("/menu");
    expect(goal).not.toHaveBeenCalled(); expect(cont).not.toHaveBeenCalled();
  });
});

 it("clears the lab polling timer during shutdown", async () => {
   const { bot } = fixture();
   vi.useFakeTimers();
   const timer = setInterval(() => {}, 60_000);
   Object.assign(bot, { labTimer: timer, transports: new Map() });
   await bot.stop();
   expect(vi.getTimerCount()).toBe(0);
   vi.useRealTimers();
 });

 describe("owner lab preview routing", () => {
   it("allows only private owner previews with a valid kind", async () => {
     const { bot, t, preview } = fixture();
     await bot.handleCommand(t, "42", "/labtest@agency_lab_companion_bot anna homework");
     expect(preview).toHaveBeenCalledWith(t, "42", "anna", "homework");
     await bot.handleCommand(t, "42", "/labtest anna");
     expect(preview).toHaveBeenLastCalledWith(t, "42", "anna", "recommendations");
     for (const command of ["/labtest", "/labtest anna secret", "/labtest anna homework extra"]) await bot.handleCommand(t, "42", command);
     expect(preview).toHaveBeenCalledTimes(2);
     expect(t.push).toHaveBeenLastCalledWith("42", expect.objectContaining({ text: expect.stringContaining("Usage:") }));
   });
   it("never previews for participants, public chats or other transports", async () => {
     const { bot, t, preview } = fixture();
     await bot.handleCommand(t, "5", "/labtest anna");
     await bot.handleCommand(t, "-100123", "/labtest anna");
     await bot.handleCommand({ ...t, name: "telegram:other" }, "5", "/labtest anna");
     expect(preview).not.toHaveBeenCalled();
   });
   it("reports unavailable previews to the owner", async () => {
     const { bot, t, preview } = fixture();
     preview.mockResolvedValue(false);
     await bot.handleCommand(t, "42", "/labtest unknown");
     expect(t.push).toHaveBeenLastCalledWith("42", expect.objectContaining({ text: expect.stringContaining("known participant key") }));
   });
 });

describe("admin participant view routing", () => {
  it("only lets the private owner select and leave preview or inspect publication messages", async () => {
    const { bot, t, userView, handle } = fixture();
    await bot.handleCommand(t, "42", "/userview anna");
    expect(userView).toHaveBeenLastCalledWith(t, "42", "anna");
    await bot.handleCommand(t, "42", "/userview off");
    expect(userView).toHaveBeenLastCalledWith(t, "42", "off");
    await bot.handleCommand(t, "42", "/lessonpreview");
    expect(handle).toHaveBeenLastCalledWith(t, "42", "lesson");
    for (const chat of ["5", "-100123"]) for (const cmd of ["/userview anna", "/lessonpreview"]) await bot.handleCommand(t, chat, cmd);
    expect(userView).toHaveBeenCalledTimes(2); expect(handle).toHaveBeenCalledTimes(1);
  });
});
