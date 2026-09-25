// ─── Live-test credentials, encrypted at rest ───────────────────────────────
//
// The harness needs a test-bot token and the owner's chat id. Those used to live
// in data/telegram-test.env as plaintext KEY=value lines — a third copy of a bot
// token on disk, in the one place nobody was redacting (bd pibot-z8w follow-up).
//
// They now live in data/telegram-test.enc.json, sops/age-encrypted with the same
// creation rules and key as settings.enc.json. The plaintext file is read only
// for migration and then deleted; nothing writes it back.

import * as fs from "node:fs";
import * as path from "node:path";
import { decryptJsonWithSops, encryptJsonWithSops, sopsAvailable } from "./secrets.js";

export type TestEnv = Record<string, string>;

export function legacyTestEnvPath(dataDir: string): string {
  return path.join(dataDir, "telegram-test.env");
}

export function encryptedTestEnvPath(dataDir: string): string {
  return path.join(dataDir, "telegram-test.enc.json");
}

/** Plaintext KEY=value lines, if the legacy file is still around. */
export function readLegacyTestEnv(dataDir: string): TestEnv {
  try {
    const raw = fs.readFileSync(legacyTestEnvPath(dataDir), "utf8");
    return Object.fromEntries(
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
  } catch {
    return {};
  }
}

/** Encrypted store, or {} when absent/undecryptable (missing key ⇒ unset, never a crash). */
export async function readTestEnv(dataDir: string): Promise<TestEnv> {
  const file = encryptedTestEnvPath(dataDir);
  if (!fs.existsSync(file) || !sopsAvailable()) return {};
  try {
    const parsed = await decryptJsonWithSops<TestEnv>(file);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge one variable into the encrypted store. Refuses to write plaintext, so a
 * prompted value can never reintroduce the legacy file.
 */
export async function saveTestEnvVar(dataDir: string, name: string, value: string): Promise<void> {
  if (!sopsAvailable()) {
    throw new Error("sops is not installed — refusing to persist a test credential in plaintext");
  }
  const current = await readTestEnv(dataDir);
  await encryptJsonWithSops({ ...current, [name]: value }, dataDir, encryptedTestEnvPath(dataDir));
}

/**
 * Migration: fold the legacy plaintext file into the encrypted store and remove it.
 * Returns the keys moved (empty when there was nothing to do).
 */
export async function migrateLegacyTestEnv(dataDir: string): Promise<string[]> {
  const legacy = readLegacyTestEnv(dataDir);
  const names = Object.keys(legacy);
  if (!names.length) return [];
  if (!sopsAvailable()) throw new Error("sops is not installed — cannot migrate the test env");
  const merged = { ...(await readTestEnv(dataDir)), ...legacy };
  await encryptJsonWithSops(merged, dataDir, encryptedTestEnvPath(dataDir));
  // verify the ciphertext round-trips before deleting the only other copy
  const check = await readTestEnv(dataDir);
  for (const name of names) {
    if (check[name] !== legacy[name]) throw new Error(`migration verification failed for ${name} — legacy file kept`);
  }
  fs.rmSync(legacyTestEnvPath(dataDir), { force: true });
  return names;
}
