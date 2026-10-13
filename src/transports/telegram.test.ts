import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InputFile } from "grammy";
import type { InputProfilePhoto } from "grammy/types";
import type { Card } from "../core/types.js";
import { TelegramDuplicateGuard, TelegramTransport, telegramRetryAfterMs, replyContextFrom, extFromMime, telegramMediaSpec } from "./telegram.js";

describe("TelegramDuplicateGuard", () => {
  it("suppresses an identical payload to the same chat inside the window", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    expect(guard.shouldSend("42", "same payload", 1_000)).toBe(true);
    guard.markSent("42", "same payload", 1_000);
    expect(guard.shouldSend("42", "same payload", 2_000)).toBe(false);
  });

  it("does not poison a retry when the network attempt failed", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    expect(guard.shouldSend("42", "retry me", 1_000)).toBe(true);
    expect(guard.shouldSend("42", "retry me", 2_000)).toBe(true);
    guard.markSent("42", "retry me", 2_000);
    expect(guard.shouldSend("42", "retry me", 3_000)).toBe(false);
  });

  it("allows distinct payloads and the same payload in another chat", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    guard.markSent("42", "first", 1_000);
    expect(guard.shouldSend("42", "second", 2_000)).toBe(true);
    expect(guard.shouldSend("84", "first", 2_000)).toBe(true);
  });

  it("allows the same payload again after the window", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    guard.markSent("42", "repeat later", 1_000);
    expect(guard.shouldSend("42", "repeat later", 31_001)).toBe(true);
  });
});

describe("telegramRetryAfterMs", () => {
  it("extracts Telegram's 429 retry_after delay and ignores other failures", () => {
    expect(telegramRetryAfterMs({ error_code: 429, parameters: { retry_after: 3 } })).toBe(3_000);
    expect(telegramRetryAfterMs({ error_code: 500, parameters: { retry_after: 3 } })).toBeNull();
    expect(telegramRetryAfterMs(new Error("offline"))).toBeNull();
  });
});

describe("replyContextFrom", () => {
  it("returns undefined when there is no quoted message or it has no text", () => {
    expect(replyContextFrom(undefined, 111)).toBeUndefined();
    expect(replyContextFrom({ message_id: 1 }, 111)).toBeUndefined();
    expect(replyContextFrom({ message_id: 1, text: "   " }, 111)).toBeUndefined();
    expect(replyContextFrom({ message_id: 1, caption: undefined }, 111)).toBeUndefined();
  });

  it("marks the bot's own messages as 'you'", () => {
    expect(replyContextFrom({ message_id: 5, text: "Pick one", from: { id: 111, first_name: "pibot" } }, 111)).toEqual({
      messageId: 5,
      sender: "you",
      quoted: "Pick one",
    });
  });

  it("falls back to the quoted sender's name without a known self id", () => {
    expect(replyContextFrom({ message_id: 6, text: "hey", from: { id: 999, first_name: "Gleb" } }, undefined)).toEqual({
      messageId: 6,
      sender: "Gleb",
      quoted: "hey",
    });
  });

  it("uses captions for media quotes and truncates long quotes", () => {
    expect(replyContextFrom({ message_id: 9, caption: "a photo caption", from: { id: 2, first_name: "Gleb" } }, 111)?.quoted).toBe("a photo caption");
    expect(replyContextFrom({ message_id: 10, text: "x".repeat(1000), from: { id: 2, first_name: "Gleb" } }, 111)?.quoted.length).toBeLessThanOrEqual(400);
  });
});

describe("extFromMime", () => {
  it("maps common media mimes and ignores parameters", () => {
    expect(extFromMime("audio/ogg; codecs=opus")).toBe(".ogg");
    expect(extFromMime("audio/mpeg")).toBe(".mp3");
    expect(extFromMime("image/jpeg")).toBe(".jpg");
    expect(extFromMime("application/pdf")).toBe(".pdf");
    expect(extFromMime("application/x-unknown")).toBeUndefined();
    expect(extFromMime(undefined)).toBeUndefined();
  });
});

describe("telegramMediaSpec", () => {
  it("accepts bounded video notes for local audio extraction", () => {
    expect(telegramMediaSpec({ video_note: { file_id: "vn", duration: 12, file_size: 1024 } })).toMatchObject({
      ok: true,
      kind: "video_note",
      fileId: "vn",
      durationSec: 12,
      extension: ".mp4",
    });
  });

  it("classifies only audio MIME documents as audio documents", () => {
    expect(telegramMediaSpec({ document: { file_id: "a", mime_type: "audio/mpeg", file_size: 2048 } })).toMatchObject({
      ok: true,
      kind: "audio_document",
      fileId: "a",
    });
    expect(telegramMediaSpec({ document: { file_id: "x", mime_type: "application/pdf", file_size: 2048 } })).toMatchObject({
      ok: true,
      kind: "document",
      fileId: "x",
    });
  });

  it("rejects oversized voice and video-note downloads before getFile", () => {
    expect(telegramMediaSpec({ voice: { file_id: "v", duration: 2, file_size: 20 * 1024 * 1024 + 1 } })).toMatchObject({ ok: false, error: expect.stringContaining("20MB") });
    expect(telegramMediaSpec({ video_note: { file_id: "vn", duration: 301, file_size: 1 } })).toMatchObject({ ok: false, error: expect.stringContaining("300s") });
  });
});

describe("Telegram profile photo adapter", () => {
  it("uploads every static JPG through setMyProfilePhoto with a fresh InputFile", async () => {
    const transport = new (await import("./telegram.js")).TelegramTransport("123:test", ["42"], { nameSuffix: "coach", boundAgentId: "coach" });
    const setMyProfilePhoto = vi.fn(async (_photo: InputProfilePhoto) => true);
    (transport as unknown as { bot: { api: { setMyProfilePhoto: typeof setMyProfilePhoto } } }).bot.api.setMyProfilePhoto = setMyProfilePhoto;

    await transport.setProfilePhoto("/tmp/coach-avatar.jpg");
    await transport.setProfilePhoto("/tmp/coach-avatar.jpg");

    expect(setMyProfilePhoto).toHaveBeenCalledTimes(2);
    const first = setMyProfilePhoto.mock.calls[0][0];
    const second = setMyProfilePhoto.mock.calls[1][0];
    expect(first.type).toBe("static");
    if (first.type !== "static" || second.type !== "static") throw new Error("expected static profile photos");
    expect(first.photo).toBeInstanceOf(InputFile);
    expect(first.photo.filename).toBe("coach-avatar.jpg");
    expect(second.photo).toBeInstanceOf(InputFile);
    expect(second.photo).not.toBe(first.photo);
  });
});

describe("Telegram speech delivery", () => {
  it("sends voice through the guarded per-chat outbox and suppresses an immediate duplicate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-voice-"));
    const file = path.join(dir, "voice.ogg");
    fs.writeFileSync(file, "OggS-voice", { mode: 0o600 });
    const transport = new (await import("./telegram.js")).TelegramTransport("123:test", ["42"]);
    const sendVoice = vi.fn(async (_chatId: string, _voice: unknown, _options?: unknown) => ({ message_id: 1 }));
    (transport as unknown as { bot: { api: { sendVoice: typeof sendVoice } } }).bot.api.sendVoice = sendVoice;

    await transport.sendVoice("42", file, "hello");
    await transport.sendVoice("42", file, "hello");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendVoice.mock.calls[0][0]).toBe("42");
    expect(sendVoice.mock.calls[0][1]).toBeInstanceOf(InputFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends M4A through Telegram audio delivery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-audio-"));
    const file = path.join(dir, "audio.m4a");
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp-audio")]), { mode: 0o600 });
    const transport = new (await import("./telegram.js")).TelegramTransport("123:test", ["42"]);
    const sendAudio = vi.fn(async (_chatId: string, _audio: unknown, _options?: unknown) => ({ message_id: 1 }));
    (transport as unknown as { bot: { api: { sendAudio: typeof sendAudio } } }).bot.api.sendAudio = sendAudio;

    await transport.sendAudio("42", file);

    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(sendAudio.mock.calls[0][1]).toBeInstanceOf(InputFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens a fresh voice upload when Telegram asks for a rate-limit retry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-retry-"));
    const file = path.join(dir, "voice.ogg");
    fs.writeFileSync(file, "OggS-voice", { mode: 0o600 });
    const transport = new (await import("./telegram.js")).TelegramTransport("123:test", ["42"]);
    const uploads: unknown[] = [];
    const sendVoice = vi.fn(async (_chatId: string, voice: unknown) => {
      uploads.push(voice);
      if (uploads.length === 1) throw { error_code: 429, parameters: { retry_after: 0 } };
      return { message_id: 1 };
    });
    (transport as unknown as { bot: { api: { sendVoice: typeof sendVoice } } }).bot.api.sendVoice = sendVoice;

    await transport.sendVoice("42", file);

    expect(uploads).toHaveLength(2);
    expect(uploads[0] === uploads[1]).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("TelegramTransport outbound push path", () => {
  function makeTransport(allowed: string[] = ["42", "84"]) {
    const T = new TelegramTransport("123:test", allowed, { nameSuffix: "x" });
    return T as unknown as {
      push(chatId: string, opts: { text: string; card?: Card }): Promise<void>;
      bot: { api: { [method: string]: (...args: unknown[]) => Promise<unknown> } };
    };
  }

  it("sends the payload through Telegram sendMessage with HTML parse mode", async () => {
    const transport = makeTransport();
    const send = vi.fn(async (chatId: string, text: string, options?: unknown) => ({ message_id: 1 }));
    transport.bot.api.sendMessage = send as never;

    await transport.push("42", { text: "hello **world**" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("42");
    expect(send.mock.calls[0][1]).toBe("hello <b>world</b>");
    expect(send.mock.calls[0][2]).toMatchObject({ parse_mode: "HTML" });
  });

  it("keeps a failed push retry-eligible and delivers on explicit retry", async () => {
    const transport = makeTransport();
    let attempts = 0;
    const send = vi.fn(async (chatId: string, text: string, options?: unknown) => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return { message_id: 1 };
    });
    transport.bot.api.sendMessage = send as never;

    await expect(transport.push("42", { text: "retry me" })).rejects.toThrow("transient");
    expect(send).toHaveBeenCalledTimes(1);

    // failed attempt was not marked sent — the identical payload is not suppressed
    await transport.push("42", { text: "retry me" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("serializes pushes to the same chat and enforces the minimum send gap", async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport();
      const sendTimes: number[] = [];
      const send = vi.fn(async (chatId: string, text: string, options?: unknown) => {
        sendTimes.push(Date.now());
        return { message_id: 1 };
      });
      transport.bot.api.sendMessage = send as never;

      const p1 = transport.push("42", { text: "first" });
      const p2 = transport.push("42", { text: "second" });
      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0][1]).toBe("first");
      expect(send.mock.calls[1][1]).toBe("second");
      expect(sendTimes[1] - sendTimes[0]).toBeGreaterThanOrEqual(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors Telegram 429 retry_after and retries once", async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport();
      let attempts = 0;
      const sendTimes: number[] = [];
      const send = vi.fn(async (chatId: string, text: string, options?: unknown) => {
        sendTimes.push(Date.now());
        attempts++;
        if (attempts === 1) throw { error_code: 429, parameters: { retry_after: 2 } };
        return { message_id: 1 };
      });
      transport.bot.api.sendMessage = send as never;

      const p = transport.push("42", { text: "throttled" });
      await vi.runAllTimersAsync();
      await p;

      expect(send).toHaveBeenCalledTimes(2);
      expect(sendTimes[1] - sendTimes[0]).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry on non-429 errors and leaves the chat retry-eligible", async () => {
    const transport = makeTransport();
    const send = vi.fn(async (chatId: string, text: string, options?: unknown): Promise<unknown> => {
      throw { error_code: 500, parameters: { retry_after: 99 } };
    });
    transport.bot.api.sendMessage = send as never;

    await expect(transport.push("42", { text: "fail" })).rejects.toMatchObject({ error_code: 500 });
    expect(send).toHaveBeenCalledTimes(1);

    // a different, non-throttled error still blocks until the caller retries
    send.mockResolvedValueOnce({ message_id: 1 });
    await transport.push("42", { text: "fail" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("delivers to each chat independently with no cross-chat coupling or serialization", async () => {
    const transport = makeTransport();
    const send = vi.fn(async (chatId: string, text: string, options?: unknown) => ({ message_id: 1 }));
    transport.bot.api.sendMessage = send as never;

    await Promise.all([
      transport.push("42", { text: "hello" }),
      transport.push("84", { text: "world" }),
    ]);

    expect(send).toHaveBeenCalledTimes(2);
    const byChat = Object.fromEntries(send.mock.calls.map((c) => [c[0], c[1]]));
    expect(byChat).toEqual({ "42": "hello", "84": "world" });
  });

  it("isolates a slow chat so a fast chat is not held up", async () => {
    const transport = makeTransport();
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const order: string[] = [];
    const send = vi.fn(async (chatId: string, text: string, options?: unknown) => {
      order.push(`start:${chatId}`);
      if (chatId === "84") await slowGate;
      order.push(`done:${chatId}`);
      return { message_id: 1 };
    });
    transport.bot.api.sendMessage = send as never;

    // slow chat enqueued first
    const p84 = transport.push("84", { text: "slow" });

    // wait until slow chat's send has started (entered the mock)
    await vi.waitFor(() => expect(order).toEqual(["start:84"]));

    // now enqueue fast chat on a different chat
    const p42 = transport.push("42", { text: "fast" });
    await p42;

    // fast chat completed while slow chat is still gated
    expect(order).toEqual(["start:84", "start:42", "done:42"]);

    releaseSlow();
    await p84;

    // slow chat completes after release
    expect(order).toEqual(["start:84", "start:42", "done:42", "done:84"]);
  });

  it("suppresses an identical push within the duplicate window after a successful send", async () => {
    const transport = makeTransport();
    const send = vi.fn(async (chatId: string, text: string, options?: unknown) => ({ message_id: 1 }));
    transport.bot.api.sendMessage = send as never;

    await transport.push("42", { text: "once" });
    await transport.push("42", { text: "once" });

    expect(send).toHaveBeenCalledTimes(1);
  });
});
