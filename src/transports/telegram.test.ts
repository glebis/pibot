import { describe, expect, it, vi } from "vitest";
import { InputFile } from "grammy";
import type { InputProfilePhoto } from "grammy/types";
import { TelegramDuplicateGuard, telegramRetryAfterMs, replyContextFrom, extFromMime } from "./telegram.js";

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
