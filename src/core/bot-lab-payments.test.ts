import { describe, expect, it, vi } from "vitest";
import { PiBot } from "./bot.js";
import type { Transport } from "./types.js";

describe("bot payment routing", () => {
  function fixture() {
    const bot = Object.create(PiBot.prototype) as any;
    const service = { menu: vi.fn(async () => {}), check: vi.fn(async () => {}) };
    Object.assign(bot, { paymentsFor: () => service, labFor: () => ({}), inboxFor: () => undefined, captureInbox: vi.fn(), participantChat: () => false });
    const t = { name: "telegram:lab", boundAgentId: "lab", push: vi.fn(async () => {}) } as unknown as Transport;
    return { bot, service, t };
  }
  it("handles payment buttons before private model dispatch", async () => {
    const { bot, service, t } = fixture();
    await bot.handleAction(t, "42", "lab:payment");
    await bot.handleAction(t, "42", "lab:payment-check");
    expect(service.menu).toHaveBeenCalledWith(t, "42");
    expect(service.check).toHaveBeenCalledWith(t, "42");
  });
  it("activates only the explicitly supported deep link", async () => {
    const { bot, service, t } = fixture();
    await bot.publicLabRequest(t, "42", "/start KRAFT");
    await bot.publicLabRequest(t, "42", "/agents");
    expect(service.menu.mock.calls).toEqual([[t, "42", "KRAFT"], [t, "42", undefined]]);
  });
  it("allows a member to open the KRAFT offer", async () => {
    const { bot, service, t } = fixture();
    await bot.handleCommand(t, "42", "/start@agency_lab_companion_bot KRAFT");
    expect(service.menu).toHaveBeenCalledWith(t, "42", "KRAFT");
  });
});
