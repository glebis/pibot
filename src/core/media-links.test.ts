import { describe, expect, it } from "vitest";
import { getMediaLinkKey, mediaLinkUrl, signMediaToken, verifyMediaToken } from "./media-links.js";

describe("media link tokens", () => {
  const KEY = "test-key-material";

  it("signs and verifies a token bound to one file", () => {
    const token = signMediaToken("report.mp4", KEY, 1_000);
    expect(verifyMediaToken(token, KEY, 1_500)).toBe("report.mp4");
  });

  it("rejects a token used for a different file", () => {
    const token = signMediaToken("report.mp4", KEY, 1_000);
    expect(verifyMediaToken(token, KEY, 1_500)).not.toBe("other.mp4");
  });

  it("rejects expired tokens", () => {
    const token = signMediaToken("report.mp4", KEY, 1_000, { ttlMs: 10_000 });
    expect(verifyMediaToken(token, KEY, 11_000)).toBeUndefined();
    expect(verifyMediaToken(token, KEY, 10_999)).toBe("report.mp4");
  });

  it("rejects tokens signed with a different key", () => {
    const token = signMediaToken("report.mp4", KEY, 1_000);
    expect(verifyMediaToken(token, "other-key", 1_500)).toBeUndefined();
  });

  it("rejects malformed tokens", () => {
    expect(verifyMediaToken("", KEY, 1)).toBeUndefined();
    expect(verifyMediaToken("garbage", KEY, 1)).toBeUndefined();
    expect(verifyMediaToken("a.b.c", KEY, 1)).toBeUndefined();
  });

  it("builds an https link with the encoded file and token", () => {
    const url = mediaLinkUrl("https://mac.tail1234.ts.net", "my file.mp4", KEY, 1_000, { ttlMs: 60_000 });
    expect(url).toMatch(/^https:\/\/mac\.tail1234\.ts\.net\/media\/my%20file\.mp4\?t=.+$/);
    const token = new URL(url).searchParams.get("t")!;
    expect(verifyMediaToken(token, KEY, 2_000)).toBe("my file.mp4");
  });

  it("getMediaLinkKey creates a persistent 0600 secret file and reuses it", () => {
    const dir = "/tmp/pibot-medialink-test";
    const key1 = getMediaLinkKey(dir);
    const key2 = getMediaLinkKey(dir);
    expect(key1).toBe(key2);
    expect(key1.length).toBeGreaterThanOrEqual(32);
  });
});