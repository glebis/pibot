import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  describe("durable outbox", () => {
    const tmpOutbox = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tg-outbox-")), "outbox.json");
    const readOutbox = (p: string) => JSON.parse(fs.readFileSync(p, "utf8")).entries as Record<string, any>;
    const seed = (p: string, entries: Record<string, unknown>) =>
      fs.writeFileSync(p, JSON.stringify({ version: 1, entries }), { mode: 0o600 });

    it("replays a pending entry after a crash with the original requestId and marks it delivered", async () => {
      const file = tmpOutbox();
      seed(file, { "telegram:77:5": { chatId: "77", text: "lost question", status: "pending", createdAt: 1 } });
      const t = new FakeTransport();
      const sat = fakeSatellite();
      const surface = attachTelegramSurface({ transport: t, satellite: sat, outboxPath: file });
      await surface.ready;

      expect(sat.askSpy).toHaveBeenCalledWith("lost question", "telegram:77:5");
      expect(t.pushed).toEqual([{ chatId: "77", opts: { text: "satellite says hi" } }]);
      expect(readOutbox(file)["telegram:77:5"].status).toBe("delivered");
      surface.dispose();
    });

    it("moves an unreadable outbox aside instead of overwriting it", async () => {
      const file = tmpOutbox();
      fs.writeFileSync(file, "{ truncated", { mode: 0o600 });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const t = new FakeTransport();
      const surface = attachTelegramSurface({ transport: t, satellite: fakeSatellite(), outboxPath: file });
      await surface.ready;
      await t.say("fresh", 9);

      const aside = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith("outbox.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8")).toBe("{ truncated");
      expect(readOutbox(file)["telegram:42:9"].status).toBe("delivered");
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      surface.dispose();
    });

    it("does not replay delivered entries", async () => {
      const file = tmpOutbox();
      seed(file, { "telegram:77:5": { chatId: "77", text: "done", status: "delivered", createdAt: 1, settledAt: Date.now() } });
      const t = new FakeTransport();
      const sat = fakeSatellite();
      const surface = attachTelegramSurface({ transport: t, satellite: sat, outboxPath: file });
      await surface.ready;
      expect(sat.askSpy).not.toHaveBeenCalled();
      expect(t.pushed).toEqual([]);
      surface.dispose();
    });

    it("marks a failed ask as failed and never replays it", async () => {
      const file = tmpOutbox();
      const t = new FakeTransport();
      const failing = { ask: vi.fn(async () => { throw new Error("boom"); }) } as unknown as SatelliteLike;
      const s1 = attachTelegramSurface({ transport: t, satellite: failing, outboxPath: file });
      await t.say("bad", 3);
      expect(t.lastText()).toContain("boom");
      expect(readOutbox(file)["telegram:42:3"].status).toBe("failed");
      s1.dispose();

      const t2 = new FakeTransport();
      const sat = fakeSatellite();
      const s2 = attachTelegramSurface({ transport: t2, satellite: sat, outboxPath: file });
      await s2.ready;
      expect(sat.askSpy).not.toHaveBeenCalled();
      expect(t2.pushed).toEqual([]);
      s2.dispose();
    });

    it("persists pending before ask and writes the file with mode 0o600", async () => {
      const file = tmpOutbox();
      const t = new FakeTransport();
      let seenDuringAsk: string | undefined;
      const sat = {
        ask: vi.fn(async () => {
          seenDuringAsk = readOutbox(file)["telegram:42:9"]?.status;
          return "ok";
        }),
      } as unknown as SatelliteLike;
      const surface = attachTelegramSurface({ transport: t, satellite: sat, outboxPath: file });
      await t.say("hello", 9);
      expect(seenDuringAsk).toBe("pending");
      expect(readOutbox(file)["telegram:42:9"].status).toBe("delivered");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      surface.dispose();
    });

    it("keeps concurrent messages' entries (serialized writes)", async () => {
      const file = tmpOutbox();
      const t = new FakeTransport();
      const surface = attachTelegramSurface({ transport: t, satellite: fakeSatellite(), outboxPath: file });
      await Promise.all([t.say("a", 1), t.say("b", 2), t.say("c", 3)]);
      const e = readOutbox(file);
      expect(Object.keys(e).sort()).toEqual(["telegram:42:1", "telegram:42:2", "telegram:42:3"]);
      expect(Object.values(e).every((x) => x.status === "delivered")).toBe(true);
      surface.dispose();
    });

    it("warns but still processes a message without messageId", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const t = new FakeTransport();
      const sat = fakeSatellite();
      const surface = attachTelegramSurface({ transport: t, satellite: sat });
      await t.messageCb?.("no id", "42", undefined, undefined);
      expect(warn).toHaveBeenCalled();
      expect(t.lastText()).toBe("satellite says hi");
      warn.mockRestore();
      surface.dispose();
    });
  });
});
