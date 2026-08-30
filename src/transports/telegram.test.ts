import { describe, expect, it } from "vitest";
import { TelegramDuplicateGuard, telegramRetryAfterMs } from "./telegram.js";

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
