/**
 * Encrypted settings via sops (Mozilla SOPS + age).
 *
 * Contract:
 * - Secret-bearing settings live ONLY in data/settings.enc.json (sops-encrypted).
 * - Decrypted values exist in process memory only — never on disk in plaintext,
 *   never logged.
 * - Boot fails CLOSED: if the encrypted file exists but can't be decrypted,
 *   pibot refuses to start with a clear message.
 * - Legacy plaintext settings.json / .env secrets are migrated automatically
 *   (encrypted, then scrubbed from the plaintext files).
 */
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../config.js";

export const SOPS = process.env.SOPS_BIN || "sops";
export function getSopsBin(): string {
  return process.env.SOPS_BIN || "sops";
}
export function getAgeKeyFile(): string {
  return path.join(os.homedir(), ".config/sops/age/keys.txt");
}
export const AGE_KEY_FILE = getAgeKeyFile();

export function sopsAvailable(): boolean {
  const sops = getSopsBin();
  const paths = [sops, "/opt/homebrew/bin/sops", "/usr/local/bin/sops"];
  return paths.some((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * A well-formed age recipient: "age1" + 58 bech32 payload chars = 62 total.
 * Truncated keys (e.g. "age1g3q8r2h6") pass a naive startsWith check, so length
 * is the guard that actually catches the corruption this module has to survive.
 */
const AGE_RECIPIENT_RE = /^age1[0-9a-z]{58}$/;

export function isValidAgeRecipient(recipient: string): boolean {
  return AGE_RECIPIENT_RE.test(recipient);
}

export function ageRecipient(): string {
  ensureAgeKey();
  const keyFile = getAgeKeyFile();
  const m = fs.readFileSync(keyFile, "utf8").match(/public key:\s*(age1[0-9a-z]+)/);
  if (!m) throw new Error("could not read the age public key from " + keyFile);
  if (!isValidAgeRecipient(m[1])) {
    throw new Error(
      `malformed age public key in ${keyFile}: "${m[1]}" (expected "age1" + 58 chars). ` +
        "Refusing to continue: encrypting against an invalid recipient would overwrite the encrypted store with plaintext."
    );
  }
  return m[1];
}

export function ensureAgeKey(): void {
  const keyFile = getAgeKeyFile();
  if (fs.existsSync(keyFile)) return;
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "pipe" });
  fs.chmodSync(keyFile, 0o600);
}

function sopsRun(args: string[], input?: string): Promise<string> {
  return sopsRunEnv(args, input, { SOPS_AGE_KEY_FILE: getAgeKeyFile() });
}

function sopsRunEnv(args: string[], input: string | undefined, extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(getSopsBin(), args, {
      stdio: input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`sops ${args[0]} failed (exit ${code}): ${truncateErr(err)}`));
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export function truncateErr(s: string): string {
  return s.trim().split("\n")[0]?.slice(0, 200) ?? "";
}

async function sopsEncryptTo(obj: unknown, dataDir: string, encPath: string): Promise<void> {
  ensureAgeKey();
  const cfg = sopsConfigPath(dataDir); // write our creation rules if missing
  // Encrypt a temp sibling FIRST. sops matches creation rules against the file
  // path, so the plaintext has to sit at a name ending in .enc.json — but writing
  // it straight to encPath means a failed `sops -e` (e.g. an unreadable recipient)
  // leaves the secrets in the clear at the final filename and destroys the
  // previous ciphertext. Rename only after sops exits clean.
  const tmp = tmpEncPath(encPath);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try {
    await sopsRunEnv(["-e", "-i", tmp], undefined, {
      ...process.env,
      SOPS_CONFIG: cfg,
    });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, encPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort — never mask the real failure */
    }
    throw e;
  }
  fs.chmodSync(encPath, 0o600);
}

/**
 * Temp sibling that still matches the `\.enc\.json$` creation rule — the name
 * must keep that suffix, otherwise sops reports "no matching creation rules".
 */
function tmpEncPath(encPath: string): string {
  const dir = path.dirname(encPath);
  const name = path.basename(encPath);
  const stem = name.endsWith(".enc.json") ? name.slice(0, -".enc.json".length) : path.basename(name, ".json");
  return path.join(dir, `${stem}.${process.pid}.tmp.enc.json`);
}

/** Own creation rules — written once into dataDir so sops never consults ambient configs */
export function sopsConfigPath(dataDir: string): string {
  const file = path.join(dataDir, ".sops.yaml");
  const recipient = ageRecipient();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const found = existing.match(/age1[0-9a-z]+/);
  // An existing config is only trustworthy if its recipient is well-formed.
  // A truncated or missing recipient makes `sops -e` fail *after* the plaintext
  // has already landed, so repair it rather than reuse it as-is.
  if (!found || !isValidAgeRecipient(found[0]) || !existing.includes("creation_rules")) {
    fs.writeFileSync(file, `creation_rules:\n  - path_regex: \\.enc\\.json$\n    age: ${recipient}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  return file;
}

async function sopsDecrypt(filePath: string): Promise<Settings> {
  return decryptJsonWithSops<Settings>(filePath);
}

/**
 * Decrypt any sops-encrypted JSON file (not just settings) — the one place the
 * daemon and its tooling read an encrypted store, so `.enc.json` files all go
 * through the same creation rules and the same age key.
 */
export async function decryptJsonWithSops<T = unknown>(filePath: string): Promise<T> {
  const out = await sopsRun(["-d", "--output-type", "json", filePath]);
  return JSON.parse(out) as T;
}

/**
 * Encrypt a JSON object IN PLACE at `encPath` (sops matches creation rules against
 * the file path, so the plaintext must land at the final name first and be
 * replaced by its ciphertext). Never leaves the plaintext behind on success.
 */
export async function encryptJsonWithSops(value: unknown, dataDir: string, encPath: string): Promise<void> {
  await sopsEncryptTo(value, dataDir, encPath);
}

/** Fields that must never sit in plaintext */
export function isSecretSettings(s: Settings): boolean {
  return Boolean(s.telegram?.token || (s.telegram?.subBots && Object.values(s.telegram.subBots).some((b) => b.token)));
}

export function stripSecrets(s: Settings): Settings {
  const out: Settings = JSON.parse(JSON.stringify(s));
  if (out.telegram) {
    const tg = out.telegram as Record<string, unknown>;
    delete tg.token;
    if (out.telegram.subBots) {
      for (const k of Object.keys(out.telegram.subBots)) {
        const b = out.telegram.subBots[k];
        if (b) delete (b as Record<string, unknown>).token;
      }
    }
  }
  return out;
}

export const SECRET_ENV_RE = /(API_KEY|_TOKEN$|^TOKEN|SECRET)/;

export class SecretStore {
  private mem: Settings = {};
  private encPath: string;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.encPath = path.join(dataDir, "settings.enc.json");
  }

  /** Decrypt-or-migrate at boot. Throws CLOSED on undecryptable secrets. */
  async init(plaintext: Settings): Promise<Settings> {
    const encExists = fs.existsSync(this.encPath);

    if (encExists) {
      if (!sopsAvailable()) {
        throw new Error(`FAIL-CLOSED: ${this.encPath} is sops-encrypted but sops is not installed. Install: brew install sops age`);
      }
      try {
        this.mem = await sopsDecrypt(this.encPath);
      } catch (e) {
        throw new Error(`FAIL-CLOSED: could not decrypt ${this.encPath} (${String(e)}). Check your age key at ${getAgeKeyFile()}.`);
      }
      // legacy plaintext secrets leftover → scrub
      if (isSecretSettings(plaintext)) this.writePlaintextWithoutSecrets(plaintext);
      this.injectEnv();
      return this.get();
    }

    // no encrypted file yet — migrate plaintext secrets if present
    if (isSecretSettings(plaintext)) {
      await this.migrate(plaintext);
      this.injectEnv();
      return this.get();
    }

    this.mem = plaintext;
    this.injectEnv();
    return this.get();
  }

  /** Migrate .env secret lines into the encrypted store, scrub .env */
  private async migrateEnv(): Promise<void> {
    const envFile = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envFile)) return;
    const lines = fs.readFileSync(envFile, "utf8").split("\n");
    const secretLines: string[] = [];
    const kept: string[] = [];
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && SECRET_ENV_RE.test(m[1]) && m[2].trim()) {
        secretLines.push(line);
        continue;
      }
      kept.push(line);
    }
    if (!secretLines.length) return;
    const envMap = { ...((this.mem as { env?: Record<string, string> }).env ?? {}) };
    for (const line of secretLines) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)!;
      envMap[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    (this.mem as { env?: Record<string, string> }).env = envMap;
    await this.flushEncrypted();
    fs.writeFileSync(envFile, kept.join("\n"));
  }

  private injectEnv(): void {
    const envMap = (this.mem as { env?: Record<string, string> }).env;
    if (!envMap) return;
    for (const [k, v] of Object.entries(envMap)) {
      if (!(k in process.env)) process.env[k] = v;
    }
  }

  private async migrate(plaintext: Settings): Promise<void> {
    if (!sopsAvailable()) {
      throw new Error(
        "FAIL-CLOSED: secrets exist in plaintext but sops is not installed. Install: brew install sops age (an age key will be generated)."
      );
    }
    ensureAgeKey();
    this.mem = plaintext;
    await this.flushEncrypted();
    // scrub plaintext
    this.writePlaintextWithoutSecrets(plaintext);
    console.log("[secrets] migrated plaintext settings → settings.enc.json (sops/age)");
  }

  private writePlaintextWithoutSecrets(s: Settings): void {
    const p = path.join(this.dataDir, "settings.json");
    writeJsonAtomic(stripSecrets(s), p);
  }

  private async flushEncrypted(): Promise<void> {
    await sopsEncryptTo(this.mem, this.dataDir, this.encPath);
  }

  private async persist(merged: Settings): Promise<void> {
    if (!sopsAvailable()) throw new Error("sops not installed — cannot persist encrypted settings");
    ensureAgeKey();
    this.mem = merged;
    await this.flushEncrypted();
    if (isSecretSettings(loadPlain(this.dataDir))) this.writePlaintextWithoutSecrets(merged);
  }

  /** Sync read from memory (decrypted at boot) */
  get(): Settings {
    return this.mem;
  }

  /** Merge a patch and re-encrypt (async — await where durability matters) */
  async save(patch: Partial<Settings>): Promise<void> {
    const cur = this.get();
    const telegram = { ...cur.telegram, ...patch.telegram };
    await this.persist({ ...cur, ...patch, telegram });
  }


}

function loadPlain(dataDir: string): Settings {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")) as Settings;
  } catch {
    return {};
  }
}

export function writeJsonAtomic(value: unknown, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
