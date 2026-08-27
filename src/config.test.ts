import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "PIBOT_TRANSPORT", "PIBOT_DATA_DIR", "PIBOT_AGENTS_DIR", "PIBOT_DEFAULT_AGENT", "PIBOT_HEARTBEAT_MODEL", "TELEGRAM_ALLOWED_CHATS"] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("loadConfig", () => {
  afterEach(() => clearEnv());

  it("defaults to cli transport without a token", () => {
    clearEnv();
    const c = loadConfig();
    expect(c.transport).toBe("cli");
    expect(c.allowedChats).toEqual([]);
  });

  it("defaults to telegram when a token is present", () => {
    clearEnv();
    process.env.TELEGRAM_BOT_TOKEN = "x:y";
    expect(loadConfig().transport).toBe("telegram");
  });

  it("respects explicit transport override", () => {
    clearEnv();
    process.env.TELEGRAM_BOT_TOKEN = "x:y";
    process.env.PIBOT_TRANSPORT = "cli";
    expect(loadConfig().transport).toBe("cli");
  });

  it("parses allowed chats and heartbeat model", () => {
    clearEnv();
    process.env.TELEGRAM_ALLOWED_CHATS = " 111, 222 ,";
    process.env.PIBOT_HEARTBEAT_MODEL = "same";
    const c = loadConfig();
    expect(c.allowedChats).toEqual(["111", "222"]);
    expect(c.heartbeatModel).toBeUndefined(); // "same" is not an override
  });

  it("reads values from .env without clobbering real env", () => {
    clearEnv();
    fs.writeFileSync(".env", "PIBOT_DEFAULT_AGENT=env-agent\nPIBOT_TRANSPORT=telegram\n");
    process.env.PIBOT_TRANSPORT = "cli"; // real env must win
    try {
      const c = loadConfig();
      expect(c.defaultAgentId).toBe("env-agent");
      expect(c.transport).toBe("cli");
    } finally {
      fs.unlinkSync(".env");
    }
  });
});