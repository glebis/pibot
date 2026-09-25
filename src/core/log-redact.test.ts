import { afterEach, describe, expect, it, vi } from "vitest";
import { redactSecrets } from "./redact.js";
import { installLogRedaction, resetLogRedactionForTests } from "./log-redact.js";

/** The shape that actually leaked (bd pibot-vuu), verbatim from daemon.log. */
const LEAKED = (id: string) =>
  `[bot] push failed: HttpError: Network request for 'sendMessage' failed!\n` +
  `    at toHttpError (/repo/node_modules/grammy/out/core/error.js:82:12) {\n` +
  `  error: FetchError: request to https://api.telegram.org/bot${id}:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage failed, reason: getaddrinfo ENOTFOUND\n` +
  `      at ClientRequest.<anonymous> (/repo/node_modules/node-fetch/lib/index.js:1501:11) {\n` +
  `    type: 'system',\n    errno: 'ENOTFOUND',\n    code: 'ENOTFOUND'\n  }\n}`;

describe("redactSecrets", () => {
  it("removes a bot token from the exact error text that leaked, keeping the diagnosis", () => {
    const out = redactSecrets(LEAKED("8995890245"));
    expect(out).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(out).toContain("[TELEGRAM_BOT_TOKEN_REDACTED]");
    // the useful parts survive: bot id, method, reason, stack
    expect(out).toContain("api.telegram.org");
    expect(out).toContain("sendMessage");
    expect(out).toContain("getaddrinfo ENOTFOUND");
    expect(out).toContain("toHttpError");
  });

  it("covers the key shapes a provider error can carry", () => {
    const cases = [
      "sk-abcdefghijklmnopqrstuvwx",
      "AIzaSyA1234567890abcdefghijklmnopqrst",
      "xoxb-1234567890-abcdefghijkl",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk",
      "-----BEGIN AGE SECRET KEY-----\nAGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n-----END AGE SECRET KEY-----",
    ];
    for (const secret of cases) {
      const out = redactSecrets(`failed with ${secret} while calling`);
      expect(out, secret).not.toContain(secret);
      expect(out, secret).toMatch(/REDACTED/);
    }
  });

  it("covers assignment and Bearer forms", () => {
    expect(redactSecrets(`{"api_key":"abcdef1234567890"}`)).toBe(`{"api_key":"[REDACTED]"}`);
    expect(redactSecrets("token=abcdef1234567890")).toContain("[REDACTED]");
    expect(redactSecrets("Authorization: Bearer abcdef1234567890")).toContain("[REDACTED]");
    expect(redactSecrets("password: hunter2hunter2")).not.toContain("hunter2hunter2");
  });

  it("leaves ordinary agent text alone (no false positives on numbers or prose)", () => {
    const ordinary = [
      "evolution: create \"morning-brief\" staged, probes [5, 3]",
      "usage: 500 tokens, 12:30 elapsed",
      "chat 161427550 blocked — not in allowlist",
      "the model scored 5 of 5 on 3 probes",
    ];
    for (const text of ordinary) expect(redactSecrets(text), text).toBe(text);
  });
});

describe("installLogRedaction", () => {
  afterEach(() => resetLogRedactionForTests());

  it("scrubs an Error object logged through console.error — stack included", () => {
    const lines: string[] = [];
    const fake = { error: (...args: unknown[]) => { lines.push(args.map(String).join(" ")); } } as unknown as Console;
    installLogRedaction(fake);
    const err = new Error("Network request for 'sendMessage' failed!");
    err.stack = LEAKED("8694340006");
    (fake as unknown as { error: (...a: unknown[]) => void }).error(err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(lines[0]).toContain("[TELEGRAM_BOT_TOKEN_REDACTED]");
    expect(lines[0]).toContain("getaddrinfo ENOTFOUND");
  });

  it("scrubs nested fields of a logged object, not just the top-level string", () => {
    const lines: string[] = [];
    const fake = { warn: (...args: unknown[]) => { lines.push(args.map(String).join(" ")); } } as unknown as Console;
    installLogRedaction(fake);
    (fake as unknown as { warn: (...a: unknown[]) => void }).warn("push failed", { url: `https://api.telegram.org/bot8995890245:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage`, code: "ENOTFOUND" });
    expect(lines[0]).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(lines[0]).toContain("ENOTFOUND");
  });

  it("passes ordinary logging through unchanged and is idempotent", () => {
    const calls: string[] = [];
    const fake = { log: (...args: unknown[]) => { calls.push(args.map(String).join(" ")); } } as unknown as Console;
    installLogRedaction(fake);
    installLogRedaction(fake); // second install must not double-wrap
    (fake as unknown as { log: (...a: unknown[]) => void }).log("evolution: staged", 5, { probes: [5, 3] });
    expect(calls).toEqual(["evolution: staged 5 { probes: [ 5, 3 ] }"]);
  });

  it("never loses a line when rendering is impossible", () => {
    const calls: string[] = [];
    const fake = { error: (...args: unknown[]) => { calls.push(String(args[0])); } } as unknown as Console;
    installLogRedaction(fake);
    const hostile = { get boom(): never { throw new Error("cannot render"); } };
    expect(() => (fake as unknown as { error: (...a: unknown[]) => void }).error("prefix", hostile)).not.toThrow();
    expect(calls.length).toBe(1);
  });

  it("wraps the real console object, so the daemon's global install is covered", () => {
    const calls: string[] = [];
    const original = console.log;
    (console as unknown as { log: (...a: unknown[]) => void }).log = (...args: unknown[]) => { calls.push(args.map(String).join(" ")); };
    try {
      installLogRedaction();
      console.log(LEAKED("8995890245"));
    } finally {
      (console as unknown as { log: unknown }).log = original;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(calls[0]).toContain("[TELEGRAM_BOT_TOKEN_REDACTED]");
  });
});
