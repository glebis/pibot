import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHALLENGE_TTL_MS, SESSION_TTL_MS, WebAuthStore } from "./web-auth.js";

describe("WebAuthStore lifetimes", () => {
  afterEach(() => vi.useRealTimers());

  const store = () => new WebAuthStore(fs.mkdtempSync(path.join(os.tmpdir(), "web-auth-")), { rpId: "localhost", rpName: "t" });

  it("uses a 5 minute challenge and a 12 hour session", () => {
    expect(CHALLENGE_TTL_MS).toBe(300_000);
    expect(SESSION_TTL_MS).toBe(43_200_000);
  });

  it("expires the server-side session together with the cookie", () => {
    vi.useFakeTimers();
    const s = store();
    const tok = s.createSession();
    expect(s.makeCookie(tok)).toContain(`Max-Age=${12 * 3600}`);
    vi.advanceTimersByTime(SESSION_TTL_MS - 1000);
    expect(s.validateSession(tok)).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(s.validateSession(tok)).toBe(false);
    s.stop();
  });

  it("expires challenges after 5 minutes", () => {
    vi.useFakeTimers();
    const s = store();
    const chal = s.createChallenge("auth");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1000);
    expect(s.consumeChallenge(chal, "auth")).toBe(false);
    s.stop();
  });
});
