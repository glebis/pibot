import { describe, expect, it, vi } from "vitest";
import { attachTelegramSurface, type SatelliteLike } from "./telegram-surface.js";
import type { ReplyContext, Transport, PushOptions } from "../core/types.js";

class FakeTransport implements Transport {
  readonly name = "telegram";
  readonly chatId = "42";
  pushed: Array<{ chatId: string; opts: PushOptions }> = [];
  messageCb: ((text: string, chatId: string, reply?: ReplyContext, messageId?: number) => Promise<void>) | null = null;

  async push(chatId: string, opts: PushOptions): Promise<void> {
    this.pushed.push({ chatId, opts });
  }
  async notifyError(chatId: string, message: string): Promise<void> {
    await this.push(chatId, { text: `⚠︎ ${message}` });
  }
  onMessage(cb: (text: string, chatId: string, reply?: ReplyContext, messageId?: number) => Promise<void>): void {
    this.messageCb = cb;
  }
  onAction(): void {}
  setTyping(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  botUsername(): string {
    return "@satellite_bot";
  }
  async say(text: string, messageId = 7): Promise<void> {
    await this.messageCb?.(text, "42", undefined, messageId);
  }
  lastText(): string {
    return this.pushed.at(-1)?.opts.text ?? "";
  }
}


function fakeSatellite(): SatelliteLike & { askSpy: ReturnType<typeof vi.fn> } {
  const askSpy = vi.fn(async (_content: string, _requestId?: string) => "satellite says hi");
  return { ask: askSpy, askSpy } as unknown as SatelliteLike & { askSpy: ReturnType<typeof vi.fn> };
}

describe("telegram surface for the durable satellite", () => {
  it("routes a chat message into the satellite and pushes the answer", async () => {
    const t = new FakeTransport();
    const sat = fakeSatellite();
    const surface = attachTelegramSurface({ transport: t, satellite: sat });
    await t.say("what is durable about you?");

    expect(sat.askSpy).toHaveBeenCalledWith("what is durable about you?", expect.stringContaining("telegram:42:"));
    expect(t.lastText()).toBe("satellite says hi");
    surface.dispose();
  });

  it("builds a stable requestId per chat+message so a re-delivered message dedupes", async () => {
    const t = new FakeTransport();
    const sat = fakeSatellite();
    const surface = attachTelegramSurface({ transport: t, satellite: sat });
    await t.say("once only", 99);
    await t.say("once only", 99); // same message redelivered (e.g. after a network flap)

    expect(sat.askSpy).toHaveBeenNthCalledWith(1, "once only", expect.any(String));
    expect(sat.askSpy).toHaveBeenNthCalledWith(2, "once only", expect.any(String));
    const first = sat.askSpy.mock.calls[0][1];
    const second = sat.askSpy.mock.calls[1][1];
    expect(second).toBe(first); // identical requestId → the harness replays, never re-runs
    surface.dispose();
  });

  it("surfaces ask failures as a warning instead of silence", async () => {
    const t = new FakeTransport();
    const askSpy = vi.fn(async () => {
      throw new Error("model exploded");
    });
    const surface = attachTelegramSurface({ transport: t, satellite: { ask: askSpy } as unknown as SatelliteLike });
    await t.say("break me");
    expect(t.lastText()).toContain("⚠");
    expect(t.lastText()).toContain("model exploded");
    surface.dispose();
  });
});