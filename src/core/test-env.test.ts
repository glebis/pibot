import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encryptedTestEnvPath, legacyTestEnvPath, migrateLegacyTestEnv, readLegacyTestEnv, readTestEnv, saveTestEnvVar,
} from "./test-env.js";
import { sopsAvailable } from "./secrets.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-testenv-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The sops/age toolchain is local to this machine (same assumption as secrets.test.ts). */
const HAS_SOPS = sopsAvailable();

describe("live-test credentials at rest", () => {
  it("parses the legacy plaintext file when one is present", () => {
    const dir = tmp();
    fs.writeFileSync(legacyTestEnvPath(dir), "TELEGRAM_LIVE_TEST_TOKEN=123:abc\n# comment\nTELEGRAM_LIVE_TEST_CHAT_ID=42\n");
    expect(readLegacyTestEnv(dir)).toEqual({ TELEGRAM_LIVE_TEST_TOKEN: "123:abc", TELEGRAM_LIVE_TEST_CHAT_ID: "42" });
  });

  it("returns an empty map when neither store exists", async () => {
    expect(readLegacyTestEnv(tmp())).toEqual({});
    expect(await readTestEnv(tmp())).toEqual({});
  });

  it.runIf(HAS_SOPS)("writes only ciphertext — the token never appears on disk in plaintext", async () => {
    const dir = tmp();
    await saveTestEnvVar(dir, "TELEGRAM_LIVE_TEST_TOKEN", "8293470098:AAE0TKsecretsecretsecretsecretsecretp4E");
    const file = encryptedTestEnvPath(dir);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).toContain("ENC[AES");
    expect(raw).not.toContain("AAE0TKsecretsecretsecretsecretsecretp4E");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // and no plaintext sidecar was created
    expect(fs.existsSync(legacyTestEnvPath(dir))).toBe(false);
  });

  it.runIf(HAS_SOPS)("round-trips values and merges new ones", async () => {
    const dir = tmp();
    await saveTestEnvVar(dir, "TELEGRAM_LIVE_TEST_TOKEN", "token-one");
    await saveTestEnvVar(dir, "TELEGRAM_LIVE_TEST_CHAT_ID", "161427550");
    expect(await readTestEnv(dir)).toEqual({ TELEGRAM_LIVE_TEST_TOKEN: "token-one", TELEGRAM_LIVE_TEST_CHAT_ID: "161427550" });
  });

  it.runIf(HAS_SOPS)("migrates the legacy file, verifies, then removes it", async () => {
    const dir = tmp();
    fs.writeFileSync(legacyTestEnvPath(dir), "TELEGRAM_LIVE_TEST_TOKEN=legacy-token\nTELEGRAM_LIVE_TEST_CHAT_ID=7\n");
    const moved = await migrateLegacyTestEnv(dir);
    expect(moved.sort()).toEqual(["TELEGRAM_LIVE_TEST_CHAT_ID", "TELEGRAM_LIVE_TEST_TOKEN"]);
    expect(await readTestEnv(dir)).toEqual({ TELEGRAM_LIVE_TEST_TOKEN: "legacy-token", TELEGRAM_LIVE_TEST_CHAT_ID: "7" });
    expect(fs.existsSync(legacyTestEnvPath(dir))).toBe(false);
  });

  it.runIf(HAS_SOPS)("is a no-op when there is nothing to migrate", async () => {
    expect(await migrateLegacyTestEnv(tmp())).toEqual([]);
  });

  it("refuses to persist a credential when sops is unavailable (no plaintext fallback)", async () => {
    const prev = process.env.SOPS_BIN;
    process.env.SOPS_BIN = "/nonexistent/sops";
    try {
      await expect(saveTestEnvVar(tmp(), "TELEGRAM_LIVE_TEST_TOKEN", "x")).rejects.toThrow(/refusing to persist|sops/i);
    } finally {
      if (prev === undefined) delete process.env.SOPS_BIN;
      else process.env.SOPS_BIN = prev;
    }
  });
});
