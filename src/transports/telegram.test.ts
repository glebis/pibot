import { describe, expect, it } from "vitest";
import { TelegramDuplicateGuard } from "./telegram.js";

describe("TelegramDuplicateGuard", () => {
  it("suppresses an identical payload to the same chat inside the window", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    expect(guard.allow("42", "same payload", 1_000)).toBe(true);
    expect(guard.allow("42", "same payload", 2_000)).toBe(false);
  });

  it("allows distinct payloads and the same payload in another chat", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    expect(guard.allow("42", "first", 1_000)).toBe(true);
    expect(guard.allow("42", "second", 2_000)).toBe(true);
    expect(guard.allow("84", "first", 2_000)).toBe(true);
  });

  it("allows the same payload again after the window", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    expect(guard.allow("42", "repeat later", 1_000)).toBe(true);
    expect(guard.allow("42", "repeat later", 31_001)).toBe(true);
  });
});
