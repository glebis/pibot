import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InputFile } from "grammy";
import type { InputProfilePhoto } from "grammy/types";
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

describe("push settle deadlock guard", () => {
  it("a reply that settles a marked message must not self-deadlock the outbox", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const calls: string[] = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendMessage: async () => {
          calls.push("sendMessage");
          return { message_id: 7 };
        },
        setMessageReaction: async () => {
          calls.push("setMessageReaction");
          return {};
        },
      },
    };
    // simulate: incoming message 99 still marked 👀 (settleIncoming has work to do)
    (t as unknown as { processingIds: Map<string, number[]> }).processingIds.set("42", [99]);
    // the old code deadlocked here (reaction enqueued behind the push itself)
    const p = t.push("42", { text: "here is your answer" });
    await Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("push deadlocked")), 3_000))]);
    expect(calls).toContain("sendMessage");
    expect(calls).toContain("setMessageReaction");
  });
});

describe("sendTelegram send timeout (outbox wedge guard)", () => {
  function bareTransport(): TelegramTransport {
    return new TelegramTransport("123:test", ["42"]);
  }
  it("fails a hung api call with a loud timeout error and does not wedge the queue", async () => {
    vi.stubEnv("PIBOT_TG_SEND_TIMEOUT_MS", "250");
    const t = bareTransport();
    const hung = new Promise(() => {});
    await expect((t as unknown as { sendTelegram: (cid: string, s: () => Promise<unknown>) => Promise<unknown> }).sendTelegram("42", () => hung)).rejects.toThrow(/timed out/);
    // the same chat's queue must still work after the timed-out attempt
    const next = await (t as unknown as { sendTelegram: (cid: string, s: () => Promise<unknown>) => Promise<unknown> }).sendTelegram("42", async () => "ok");
    expect(next).toBe("ok");
    vi.unstubAllEnvs();
  });

  it("returns the result when the call settles within the budget", async () => {
    vi.stubEnv("PIBOT_TG_SEND_TIMEOUT_MS", "2000");
    const t = bareTransport();
    const r = await (t as unknown as { sendTelegram: (cid: string, s: () => Promise<unknown>) => Promise<unknown> }).sendTelegram("42", async () => "delivered");
    expect(r).toBe("delivered");
    vi.unstubAllEnvs();
  });
});
