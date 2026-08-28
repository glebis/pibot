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
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../config.js";

const SOPS = process.env.SOPS_BIN || "sops";
const AGE_KEY_FILE = path.join(os.homedir(), ".config/sops/age/keys.txt");

export function sopsAvailable(): boolean {
  const paths = [SOPS, "/opt/homebrew/bin/sops", "/usr/local/bin/sops"];
  return paths.some((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function ageRecipient(): string {
  ensureAgeKey();
  const m = fs.readFileSync(AGE_KEY_FILE, "utf8").match(/public key:\s*(age1[0-9a-z]+)/);
  if (!m) throw new Error("could not read the age public key from " + AGE_KEY_FILE);
  return m[1];
}

export function ensureAgeKey(): void {
  if (fs.existsSync(AGE_KEY_FILE)) return;
  fs.mkdirSync(path.dirname(AGE_KEY_FILE), { recursive: true });
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  execFileSync("age-keygen", ["-o", AGE_KEY_FILE], { stdio: "pipe" });
  fs.chmodSync(AGE_KEY_FILE, 0o600);
}

function sopsRun(args: string[], input?: string): Promise<string> {
  return sopsRunEnv(args, input, { SOPS_AGE_KEY_FILE: AGE_KEY_FILE });
}

function sopsRunEnv(args: string[], input: string | undefined, extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(SOPS, args, {
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

function truncateErr(s: string): string {
  return s.trim().split("\n")[0]?.slice(0, 200) ?? "";
}

async function sopsEncrypt(obj: unknown, dataDir: string, encPath: string): Promise<void> {
  ensureAgeKey();
  sopsConfigPath(dataDir); // write our creation rules if missing
  // sops matches creation rules against the FILE path — encrypt in place at the final path
  fs.writeFileSync(encPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await sopsRunEnv(["-e", "-i", encPath], undefined, {
    ...process.env,
    SOPS_CONFIG: sopsConfigPath(dataDir),
  });
}

/** Own creation rules — written once into dataDir so sops never consults ambient configs */
export function sopsConfigPath(dataDir: string): string {
  const file = path.join(dataDir, ".sops.yaml");
  if (!fs.existsSync(file)) {
    const recipient = ageRecipient();
    fs.writeFileSync(file, `creation_rules:\n  - path_regex: \\.enc\\.json$\n    age: ${recipient}\n`);
  }
  return file;
}

async function sopsDecrypt(filePath: string): Promise<Settings> {
  const out = await sopsRun(["-d", "--output-type", "json", filePath]);
  return JSON.parse(out) as Settings;
}

/** Fields that must never sit in plaintext */
function isSecretSettings(s: Settings): boolean {
  return Boolean(s.telegram?.token || (s.telegram?.subBots && Object.values(s.telegram.subBots).some((b) => b.token)));
}

function stripSecrets(s: Settings): Settings {
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

const SECRET_ENV_RE = /(API_KEY|_TOKEN$|^TOKEN|SECRET)/;

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
        throw new Error(`FAIL-CLOSED: could not decrypt ${this.encPath} (${String(e)}). Check your age key at ${AGE_KEY_FILE}.`);
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
  private migrateEnv(): void {
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
    await sopsEncrypt(this.mem, this.dataDir, this.encPath);
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

function writeJsonAtomic(value: unknown, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
