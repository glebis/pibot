import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "./events.js";

describe("EventLog", () => {
  let dir: string;
  let log: EventLog;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-events-"));
    log = new EventLog(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends and tails events in order", () => {
    log.log("agent", "message", "hello");
    log.log("agent", "fire", "stretch");
    log.log("agent", "snooze", "1h");

    const tail = log.tail("agent", 2);
    expect(tail.map((e) => e.type)).toEqual(["fire", "snooze"]);
    expect(tail[0].summary).toBe("stretch");
    expect(tail[0].t).toBeGreaterThan(0);
    expect(log.tail("agent", 10)).toHaveLength(3);
  });

  it("keeps agents isolated", () => {
    log.log("a", "message", "one");
    log.log("b", "message", "two");
    expect(log.tail("a").map((e) => e.summary)).toEqual(["one"]);
  });

  it("keeps runtime event directories and files owner-only", () => {
    log.log("system", "system", "private event");
    const agentDir = path.join(dir, "system");
    const stateDir = path.join(agentDir, "state");
    const eventFile = path.join(stateDir, "events.jsonl");

    expect(fs.statSync(agentDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(eventFile).mode & 0o777).toBe(0o600);
  });

  it("redacts sensitive key assignments before persisting summaries", () => {
    log.log(
      "agent",
      "system",
      'token=top-secret api_key: "sk-live-123" password = hunter2 authorization: Basic-Zm9v client_secret=s3cr3t OPENAI_API_KEY=provider-key TELEGRAM_BOT_TOKEN=bot-key',
    );

    const eventFile = path.join(dir, "agent", "state", "events.jsonl");
    const persisted = fs.readFileSync(eventFile, "utf8");
    expect(persisted).not.toContain("top-secret");
    expect(persisted).not.toContain("sk-live-123");
    expect(persisted).not.toContain("hunter2");
    expect(persisted).not.toContain("Basic-Zm9v");
    expect(persisted).not.toContain("s3cr3t");
    expect(persisted).not.toContain("provider-key");
    expect(persisted).not.toContain("bot-key");
    expect(log.tail("agent")[0].summary).toBe(
      "token=[REDACTED] api_key: [REDACTED] password = [REDACTED] authorization: [REDACTED] client_secret=[REDACTED] OPENAI_API_KEY=[REDACTED] TELEGRAM_BOT_TOKEN=[REDACTED]",
    );
  });

  it("redacts Bearer credentials and Telegram bot-token shapes", () => {
    log.log(
      "agent",
      "system",
      "request failed: Bearer eyJhbGciOiJIUzI1Ni.test.sig; bot 123456789:AAEabcdefghijklmnopqrstuvwxyz012345",
    );

    expect(log.tail("agent")[0].summary).toBe(
      "request failed: Bearer [REDACTED]; bot [TELEGRAM_BOT_TOKEN_REDACTED]",
    );
  });

  it("redacts sensitive values embedded in JSON text", () => {
    log.log("agent", "system", '{"operation":"connect","token":"json-secret","nested":{"password":"json-password"}}');

    const summary = log.tail("agent")[0].summary;
    expect(summary).not.toContain("json-secret");
    expect(summary).not.toContain("json-password");
    expect(summary).toContain("[REDACTED]");
  });

  it("leaves ordinary prose about sensitive concepts unchanged", () => {
    const summary = "The password is wrong; rotate the token after authorization fails.";
    log.log("agent", "system", summary);

    expect(log.tail("agent")[0].summary).toBe(summary);
  });
});
