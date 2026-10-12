// @ts-nocheck
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// must be before importing secrets so mocks are hoisted
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn(), execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    accessSync: vi.fn((...args) => (actual as any).accessSync(...args)),
    renameSync: vi.fn((...args) => (actual as any).renameSync(...args)),
  };
});

import * as cp from "node:child_process";
import {
  SecretStore,
  ensureAgeKey,
  sopsAvailable,
  ageRecipient,
  sopsConfigPath,
  isSecretSettings,
  stripSecrets,
  encryptJsonWithSops,
  SECRET_ENV_RE,
  truncateErr,
  writeJsonAtomic,
  getAgeKeyFile,
} from "./secrets.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  // use actual fs without mock
  const actualFs = awaitImportActualFs();
  return actualFs.mkdtempSync(path.join(os.tmpdir(), "pibot-secrets-test-"));
}

// we need to bypass mocked fs for tmpDir creation - use actual fs directly
function awaitImportActualFs() {
  // vi.mocked fs is mocked, but we can get actual via fs itself if mock delegates
  // our mock delegates to actual for most calls, so mkdtempSync still works via mock
  return fs;
}

// A well-formed 62-char age recipient (bech32 payload). Used by every test that
// exercises recipient validation, so the fixtures can never drift back to a
// truncated key that real `sops` would reject.
const VALID_AGE_PUB = "age1v9atktywpyagpq9ddha330rttp3gp7aamzwd4t9v2x5hc8kejcxsemnt7k";

function seedAgeKey(homeDir: string, pub = VALID_AGE_PUB) {
  const keyFile = path.join(homeDir, ".config/sops/age/keys.txt");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `# public key: ${pub}\nAGE-SECRET-KEY-...`);
  fs.chmodSync(keyFile, 0o600);
  return keyFile;
}

/** Create a mock ChildProcess that sopsRunEnv will consume */
function mockSpawn(opts: { stdout?: string; stderr?: string; exitCode?: number; error?: Error } = {}) {
  const { stdout = "", stderr = "", exitCode = 0, error } = opts;
  const mockedSpawn = vi.mocked(cp.spawn);
  mockedSpawn.mockImplementation(() => {
    const emitter: any = new EventEmitter();
    emitter.stdout = {
      on: (ev: string, cb: (d: Buffer) => void) => {
        if (ev === "data" && stdout) process.nextTick(() => cb(Buffer.from(stdout)));
      },
    };
    emitter.stderr = {
      on: (ev: string, cb: (d: Buffer) => void) => {
        if (ev === "data" && stderr) process.nextTick(() => cb(Buffer.from(stderr)));
      },
    };
    emitter.stdin = { end: vi.fn() };
    emitter.on = (ev: string, cb: (...a: any[]) => void) => {
      if (ev === "close") process.nextTick(() => cb(exitCode));
      else if (ev === "error" && error) process.nextTick(() => cb(error));
      return emitter;
    };
    emitter.once = emitter.on;
    return emitter as unknown as cp.ChildProcess;
  });
  return mockedSpawn;
}

/**
 * Generic spawn mock that dispatches by args[0]:
 *  "-d" -> decrypt returns JSON, "-e" -> encrypt succeeds
 */
function mockSpawnSops(decryptedObj: unknown) {
  const mockedSpawn = vi.mocked(cp.spawn);
  mockedSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
    const emitter: any = new EventEmitter();
    const isDecrypt = args[0] === "-d";
    let out = "";
    if (isDecrypt) out = JSON.stringify(decryptedObj);
    emitter.stdout = {
      on: (ev: string, cb: (d: Buffer) => void) => {
        if (ev === "data" && out) process.nextTick(() => cb(Buffer.from(out)));
      },
    };
    emitter.stderr = { on: () => {} };
    emitter.stdin = { end: vi.fn() };
    emitter.on = (ev: string, cb: (...a: any[]) => void) => {
      if (ev === "close") process.nextTick(() => cb(0));
      return emitter;
    };
    emitter.once = emitter.on;
    return emitter as unknown as cp.ChildProcess;
  });
  return mockedSpawn;
}

function tmpDirSync(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-secrets-test-"));
}

// ---------------------------------------------------------------------------
// ensureAgeKey
// ---------------------------------------------------------------------------
describe("ensureAgeKey", () => {
  let home: string;
  beforeEach(() => {
    home = tmpDirSync();
    vi.mocked(os.homedir).mockReturnValue(home);
    // reset child_process mocks
    vi.mocked(cp.execFileSync).mockReset();
    vi.mocked(cp.spawn).mockReset();
    vi.mocked(fs.accessSync).mockImplementation((...args) => {
      // delegate to real fs
      const actual = (fs as any).__actualAccessSync ?? null;
      // we stored actual via mock factory, but simpler: call real fs via require
      try { return (awaitImportActualFs() as any).accessSync(...args); } catch(e){ throw e;}
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("creates file with 0600 when missing", () => {
    const keyFile = getAgeKeyFile();
    expect(fs.existsSync(keyFile)).toBe(false);
    vi.mocked(cp.execFileSync).mockImplementation(((cmd: string, args: readonly string[]) => {
      const out = (args as string[])[1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, "# public key: age1testkey0000000000000000000000000000000000000\nSECRET");
      return Buffer.from("");
    }) as any);

    ensureAgeKey();

    expect(vi.mocked(cp.execFileSync)).toHaveBeenCalledWith("age-keygen", ["-o", keyFile], { stdio: "pipe" });
    expect(fs.existsSync(keyFile)).toBe(true);
    const mode = fs.statSync(keyFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("no-ops when key already exists", () => {
    seedAgeKey(home);
    vi.mocked(cp.execFileSync).mockImplementation((() => {
      throw new Error("should not be called");
    }) as any);
    ensureAgeKey();
    expect(vi.mocked(cp.execFileSync)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sopsAvailable
// ---------------------------------------------------------------------------
describe("sopsAvailable", () => {
  afterEach(() => vi.clearAllMocks());

  it("detects via brew paths", () => {
    vi.mocked(fs.accessSync).mockImplementation((p: fs.PathLike) => {
      if (String(p) === "/opt/homebrew/bin/sops") return undefined as any;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    expect(sopsAvailable()).toBe(true);
  });

  it("returns false when no sops binary is executable", () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    expect(sopsAvailable()).toBe(false);
  });

  it("checks SOPS_BIN path first", () => {
    const prev = process.env.SOPS_BIN;
    process.env.SOPS_BIN = "/custom/sops";
    vi.mocked(fs.accessSync).mockImplementation((p: fs.PathLike) => {
      if (String(p) === "/custom/sops") return undefined as any;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    expect(sopsAvailable()).toBe(true);
    if (prev === undefined) delete process.env.SOPS_BIN;
    else process.env.SOPS_BIN = prev;
  });
});

// ---------------------------------------------------------------------------
// ageRecipient / sopsConfigPath
// ---------------------------------------------------------------------------
describe("ageRecipient", () => {
  let home: string;
  beforeEach(() => {
    home = tmpDirSync();
    vi.mocked(os.homedir).mockReturnValue(home);
  });
  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads public key from keys.txt", () => {
    seedAgeKey(home, VALID_AGE_PUB);
    expect(ageRecipient()).toBe(VALID_AGE_PUB);
  });

  it("throws on a truncated recipient", () => {
    seedAgeKey(home, "age1g3q8r2h6");
    expect(() => ageRecipient()).toThrow(/malformed age public key/);
  });

  it("throws when public key not found", () => {
    const keyFile = path.join(home, ".config/sops/age/keys.txt");
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, "no key here");
    expect(() => ageRecipient()).toThrow(/could not read the age public key/);
  });
});

describe("sopsConfigPath", () => {
  let home: string;
  let dataDir: string;
  beforeEach(() => {
    home = tmpDirSync();
    dataDir = tmpDirSync();
    vi.mocked(os.homedir).mockReturnValue(home);
    seedAgeKey(home);
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(home);
  });
  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes creation rules with recipient", () => {
    const cfg = sopsConfigPath(dataDir);
    expect(fs.existsSync(cfg)).toBe(true);
    const body = fs.readFileSync(cfg, "utf8");
    expect(body).toContain("creation_rules");
    expect(body).toContain(".enc");
    expect(body).toContain("age1");
  });

  it("preserves an existing config that already carries a valid recipient", () => {
    const cfg = path.join(dataDir, ".sops.yaml");
    fs.writeFileSync(cfg, `creation_rules:\n  - path_regex: \\.enc\\.json$\n    age: ${VALID_AGE_PUB}\n`);
    expect(sopsConfigPath(dataDir)).toBe(cfg);
    expect(fs.readFileSync(cfg, "utf8")).toContain(VALID_AGE_PUB);
  });

  it("repairs a config whose recipient is truncated", () => {
    const cfg = path.join(dataDir, ".sops.yaml");
    fs.writeFileSync(cfg, "creation_rules:\n  - path_regex: \\.enc\\.json$\n    age: age1g3q8r2h6\n");
    sopsConfigPath(dataDir);
    const body = fs.readFileSync(cfg, "utf8");
    expect(body).toContain(VALID_AGE_PUB);
    expect(body).not.toContain("age1g3q8r2h6");
  });

  it("repairs a config that has no recipient at all", () => {
    const cfg = path.join(dataDir, ".sops.yaml");
    fs.writeFileSync(cfg, "custom");
    sopsConfigPath(dataDir);
    expect(fs.readFileSync(cfg, "utf8")).toContain(VALID_AGE_PUB);
  });
});

// ---------------------------------------------------------------------------
// encryptJsonWithSops — a failed encryption must never expose plaintext
// ---------------------------------------------------------------------------
describe("encryptJsonWithSops", () => {
  let home: string;
  let dataDir: string;

  beforeEach(() => {
    home = tmpDirSync();
    dataDir = tmpDirSync();
    vi.mocked(os.homedir).mockReturnValue(home);
    seedAgeKey(home);
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(home);
  });
  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("leaves the existing store untouched when encryption fails", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    const encPath = path.join(dataDir, "settings.enc.json");
    fs.writeFileSync(encPath, "CIPHERTEXT-OLD", { mode: 0o600 });
    mockSpawn({ stderr: "malformed recipient", exitCode: 1 });

    await expect(
      encryptJsonWithSops({ telegram: { token: "LEAKME" } }, dataDir, encPath)
    ).rejects.toThrow(/sops -e failed/);

    expect(fs.readFileSync(encPath, "utf8")).toBe("CIPHERTEXT-OLD");
    const leaked = fs
      .readdirSync(dataDir)
      .filter((f) => fs.readFileSync(path.join(dataDir, f), "utf8").includes("LEAKME"));
    expect(leaked).toEqual([]);
  });

  it("replaces the store only after encryption succeeds", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    const encPath = path.join(dataDir, "settings.enc.json");
    fs.writeFileSync(encPath, "CIPHERTEXT-OLD", { mode: 0o600 });
    mockSpawnSops({});

    await encryptJsonWithSops({ telegram: { token: "NEW" } }, dataDir, encPath);

    expect(fs.readFileSync(encPath, "utf8")).not.toBe("CIPHERTEXT-OLD");
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    expect(fs.statSync(encPath).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// isSecretSettings / stripSecrets / SECRET_ENV_RE / truncateErr / writeJsonAtomic
// ---------------------------------------------------------------------------
describe("isSecretSettings / stripSecrets", () => {
  it("detects token and subBot tokens", () => {
    expect(isSecretSettings({})).toBe(false);
    expect(isSecretSettings({ telegram: { token: "x" } })).toBe(true);
    expect(isSecretSettings({ telegram: { subBots: { a: { token: "y" } } } })).toBe(true);
    expect(isSecretSettings({ telegram: { subBots: { a: { token: "" } } } })).toBe(false);
  });

  it("stripSecrets removes token and subBot tokens but keeps other fields", () => {
    const src: any = { telegram: { token: "secret", allowedChats: ["1"], subBots: { b1: { token: "tok", username: "bot" }, b2: { token: "tok2" } } } };
    const out = stripSecrets(src);
    expect(out.telegram?.token).toBeUndefined();
    expect(out.telegram?.allowedChats).toEqual(["1"]);
    expect((out.telegram?.subBots as any).b1.token).toBeUndefined();
    expect((out.telegram?.subBots as any).b1.username).toBe("bot");
    expect(src.telegram.token).toBe("secret");
  });
});

describe("SECRET_ENV_RE", () => {
  it("matches TELEGRAM_BOT_TOKEN and common secret names", () => {
    expect(SECRET_ENV_RE.test("TELEGRAM_BOT_TOKEN")).toBe(true);
    expect(SECRET_ENV_RE.test("OPENAI_API_KEY")).toBe(true);
    expect(SECRET_ENV_RE.test("MY_SECRET")).toBe(true);
    expect(SECRET_ENV_RE.test("TOKEN")).toBe(true);
    expect(SECRET_ENV_RE.test("SECRET_FOO")).toBe(true);
    expect(SECRET_ENV_RE.test("FOO_TOKEN")).toBe(true);
  });

  it("matches custom names containing SECRET or API_KEY", () => {
    expect(SECRET_ENV_RE.test("CUSTOM_API_KEY")).toBe(true);
    expect(SECRET_ENV_RE.test("MY_SUPER_SECRET_VALUE")).toBe(true);
    expect(SECRET_ENV_RE.test("GH_TOKEN")).toBe(true);
  });

  it("does not match non-secret vars", () => {
    expect(SECRET_ENV_RE.test("PIBOT_DATA_DIR")).toBe(false);
    expect(SECRET_ENV_RE.test("NODE_ENV")).toBe(false);
    expect(SECRET_ENV_RE.test("PORT")).toBe(false);
    expect(SECRET_ENV_RE.test("TELEGRAM_ALLOWED_CHATS")).toBe(false);
  });
});

describe("truncateErr", () => {
  it("returns first line truncated to 200", () => {
    expect(truncateErr("hello\nworld")).toBe("hello");
    expect(truncateErr("  ")).toBe("");
    const long = "a".repeat(300);
    expect(truncateErr(long).length).toBe(200);
  });
});

describe("writeJsonAtomic", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDirSync(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes atomically via tmp+rename", () => {
    const file = path.join(dir, "sub/settings.json");
    writeJsonAtomic({ a: 1 }, file);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 });
    // after write, tmp should not remain
    const tmp = `${file}.${process.pid}.tmp`;
    expect(fs.existsSync(tmp)).toBe(false);
    // verify rename was called via mock
    expect(vi.mocked(fs.renameSync).mock.calls.length).toBeGreaterThan(0);
  });

  it("overwrites existing file atomically", () => {
    const file = path.join(dir, "settings.json");
    writeJsonAtomic({ a: 1 }, file);
    vi.clearAllMocks();
    writeJsonAtomic({ a: 2 }, file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 2 });
  });
});

// ---------------------------------------------------------------------------
// SecretStore
// ---------------------------------------------------------------------------
describe("SecretStore", () => {
  let home: string;
  let dataDir: string;

  beforeEach(() => {
    home = tmpDirSync();
    dataDir = tmpDirSync();
    vi.mocked(os.homedir).mockReturnValue(home);
    seedAgeKey(home);
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(home);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.MY_API_KEY_TEST;
    delete process.env.FOO_TOKEN;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("init with missing file returns defaults and stores plaintext", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw Object.assign(new Error("no sops"), { code: "ENOENT" });
    });
    const store = new SecretStore(dataDir);
    const res = await store.init({});
    expect(res).toEqual({});
    expect(store.get()).toEqual({});
  });

  it("init migrates plaintext secrets (encrypts then scrubs plaintext)", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    mockSpawnSops({ telegram: { token: "migrated" } });

    const store = new SecretStore(dataDir);
    const plaintext: any = { telegram: { token: "tok123", allowedChats: ["1"] } };
    const res = await store.init(plaintext);

    expect(res.telegram?.token).toBe("tok123");
    expect(fs.existsSync(path.join(dataDir, "settings.enc.json"))).toBe(true);
    const plain = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    expect(plain.telegram?.token).toBeUndefined();
    expect(plain.telegram?.allowedChats).toEqual(["1"]);
    expect(fs.existsSync(path.join(dataDir, ".sops.yaml"))).toBe(true);
  });

  it("init fail-closed when sops not installed but plaintext has secrets", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw Object.assign(new Error("no sops"), { code: "ENOENT" });
    });
    const store = new SecretStore(dataDir);
    await expect(store.init({ telegram: { token: "x" } })).rejects.toThrow(/FAIL-CLOSED.*sops is not installed/);
  });

  it("init decrypts existing enc file (fail-closed success path)", async () => {
    fs.writeFileSync(path.join(dataDir, "settings.enc.json"), "encrypted-blob");
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    const decrypted: any = { telegram: { token: "decrypted-tok", allowedChats: ["9"] } };
    mockSpawnSops(decrypted);

    const store = new SecretStore(dataDir);
    const legacy: any = { telegram: { token: "legacy" } };
    fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(legacy));

    const res = await store.init(legacy);
    expect(res.telegram?.token).toBe("decrypted-tok");
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    expect(after.telegram?.token).toBeUndefined();
  });

  it("init fail-closed when enc file exists but sops not available", async () => {
    fs.writeFileSync(path.join(dataDir, "settings.enc.json"), "blob");
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw Object.assign(new Error("no sops"), { code: "ENOENT" });
    });
    const store = new SecretStore(dataDir);
    await expect(store.init({})).rejects.toThrow(/FAIL-CLOSED.*sops is not installed/);
  });

  it("init fail-closed on undecryptable file", async () => {
    fs.writeFileSync(path.join(dataDir, "settings.enc.json"), "blob");
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    mockSpawn({ stdout: "", stderr: "failed to decrypt\nsecond line", exitCode: 1 });

    const store = new SecretStore(dataDir);
    await expect(store.init({})).rejects.toThrow(/FAIL-CLOSED: could not decrypt/);
    // second call also checks age key message
    mockSpawn({ stdout: "", stderr: "failed to decrypt\nsecond line", exitCode: 1 });
    try {
      await store.init({});
    } catch (e) {
      expect(String(e)).toContain("Check your age key");
    }
  });

  it("save encrypts then scrubs plaintext", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    mockSpawnSops({ telegram: { token: "newtok" } });

    const store = new SecretStore(dataDir);
    await store.init({});
    fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ telegram: { token: "old" } }));

    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(home);
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    vi.mocked(cp.execFileSync).mockImplementation((() => Buffer.from("")) as any);
    mockSpawnSops({ telegram: { token: "newtok" } });

    await store.save({ telegram: { token: "newtok" } } as any);
    expect(store.get().telegram?.token).toBe("newtok");
    const plain = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    expect(plain.telegram?.token).toBeUndefined();
  });

  it("save throws when sops not installed", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw Object.assign(new Error("no sops"), { code: "ENOENT" });
    });
    const store = new SecretStore(dataDir);
    await store.init({});
    await expect(store.save({ telegram: { token: "x" } } as any)).rejects.toThrow(/sops not installed/);
  });

  it("injectEnv does not overwrite existing process.env", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    process.env.TELEGRAM_BOT_TOKEN = "existing";
    const store = new SecretStore(dataDir);
    fs.writeFileSync(path.join(dataDir, "settings.enc.json"), "blob");
    mockSpawnSops({ env: { TELEGRAM_BOT_TOKEN: "from-enc", MY_API_KEY_TEST: "enc-val" } } as any);

    await store.init({});
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("existing");
    expect(process.env.MY_API_KEY_TEST).toBe("enc-val");
    delete process.env.MY_API_KEY_TEST;
  });

  it("sopsRun truncates error to first line (via decrypt failure)", async () => {
    fs.writeFileSync(path.join(dataDir, "settings.enc.json"), "blob");
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    mockSpawn({ stdout: "", stderr: "first line error\nsecond line\nthird", exitCode: 2 });
    const store = new SecretStore(dataDir);
    await expect(store.init({})).rejects.toThrow(/first line error/);
    mockSpawn({ stdout: "", stderr: "first line error\nsecond line\nthird", exitCode: 2 });
    try {
      await store.init({});
    } catch (e) {
      expect(String(e)).not.toContain("second line");
    }
  });
  it("encrypts through a path that still matches the creation rule", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    const encPath = path.join(dataDir, "settings.enc.json");
    mockSpawnSops({});

    await encryptJsonWithSops({ telegram: { token: "NEW" } }, dataDir, encPath);

    const args = vi.mocked(cp.spawn).mock.calls.map((c) => (c[1] as string[]).join(" ")).join("\n");
    const target = vi
      .mocked(cp.spawn)
      .mock.calls.map((c) => (c[1] as string[])[2])
      .find((p) => typeof p === "string" && p.includes("settings"));
    // sops refuses a file whose name does not match `\.enc\.json$`
    expect(args).not.toContain("no matching creation rules");
    expect(target).toMatch(/\.enc\.json$/);
  });
});

// ---------------------------------------------------------------------------
// migrateEnv (private) — via (store as any).migrateEnv()
// ---------------------------------------------------------------------------
describe("SecretStore.migrateEnv", () => {
  let home: string;
  let dataDir: string;
  let cwdDir: string;
  let prevCwd: string;

  beforeEach(() => {
    home = tmpDirSync();
    dataDir = tmpDirSync();
    cwdDir = tmpDirSync();
    prevCwd = process.cwd();
    vi.mocked(os.homedir).mockReturnValue(home);
    seedAgeKey(home);
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(home);
    process.chdir(cwdDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    vi.clearAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cwdDir, { recursive: true, force: true });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.FOO_TOKEN;
    delete process.env.MY_API_KEY_TEST;
    delete process.env.OPENAI_API_KEY;
  });

  it("scrubs SECRET_ENV_RE matching lines (TELEGRAM_BOT_TOKEN) and keeps others", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    mockSpawnSops({});

    const envContent = [
      "PIBOT_DATA_DIR=./data",
      "TELEGRAM_BOT_TOKEN=123:abc",
      "OPENAI_API_KEY=sk-xyz",
      "NODE_ENV=production",
      "SECRET_FOO=bar",
      "FOO_TOKEN=tok",
      "EMPTY_TOKEN=",
      "MY_KEEP_VAR=keep",
    ].join("\n");

    fs.writeFileSync(path.join(cwdDir, ".env"), envContent);

    const store = new SecretStore(dataDir);
    (store as any).mem = {};
    await (store as any).migrateEnv();

    const kept = fs.readFileSync(path.join(cwdDir, ".env"), "utf8").split("\n");
    expect(kept).toContain("PIBOT_DATA_DIR=./data");
    expect(kept).toContain("NODE_ENV=production");
    expect(kept).toContain("MY_KEEP_VAR=keep");
    expect(kept).not.toContain("TELEGRAM_BOT_TOKEN=123:abc");
    expect(kept).not.toContain("OPENAI_API_KEY=sk-xyz");
    expect(kept).not.toContain("SECRET_FOO=bar");
    expect(kept).not.toContain("FOO_TOKEN=tok");
    expect(kept).toContain("EMPTY_TOKEN=");

    const mem = (store as any).mem;
    expect(mem.env.TELEGRAM_BOT_TOKEN).toBe("123:abc");
    expect(mem.env.OPENAI_API_KEY).toBe("sk-xyz");
  });

  it("strips surrounding quotes from env values", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    mockSpawnSops({});
    fs.writeFileSync(path.join(cwdDir, ".env"), `TELEGRAM_BOT_TOKEN="quoted-val"\nMY_API_KEY='single'\n`);
    const store = new SecretStore(dataDir);
    (store as any).mem = {};
    await (store as any).migrateEnv();
    expect((store as any).mem.env.TELEGRAM_BOT_TOKEN).toBe("quoted-val");
    expect((store as any).mem.env.MY_API_KEY).toBe("single");
  });

  it("no-ops when .env missing or no secret lines", async () => {
    const store = new SecretStore(dataDir);
    (store as any).mem = {};
    await (store as any).migrateEnv();
    expect((store as any).mem.env).toBeUndefined();

    fs.writeFileSync(path.join(cwdDir, ".env"), "PORT=3000\nNODE_ENV=test\n");
    await (store as any).migrateEnv();
    expect((store as any).mem.env).toBeUndefined();
    expect(fs.readFileSync(path.join(cwdDir, ".env"), "utf8")).toContain("PORT=3000");
  });

  it("merges with existing env map", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => undefined as any);
    mockSpawnSops({});
    fs.writeFileSync(path.join(cwdDir, ".env"), "TELEGRAM_BOT_TOKEN=newtok\n");
    const store = new SecretStore(dataDir);
    (store as any).mem = { env: { EXISTING: "keep" } };
    await (store as any).migrateEnv();
    expect((store as any).mem.env.EXISTING).toBe("keep");
    expect((store as any).mem.env.TELEGRAM_BOT_TOKEN).toBe("newtok");
  });
});
