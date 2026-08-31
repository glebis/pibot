// ─── Telegram live-test harness ─────────────────────────────────────────────
// Autonomous end-to-end testing for pibot's Telegram transport, driving the
// bot over the real Telegram wire exactly like a user. Codified from the
// 2026-08-31 debug loop: an outbox self-deadlock survived three restarts
// because nothing below the command layer had a live feedback loop.
//
// Two modes:
//   spawn (default) — boots an ISOLATED daemon in tmp dirs with a dedicated
//     test-bot token: deterministic scenarios, zero production side effects.
//   --attach — read-only smoke (/status, unknown command, log soak) against
//     an already-running bot chat via your user account (telethon). This is
//     the post-deploy verification gate: run it against the real bot chat
//     right after a restart, instead of typing test messages by hand.
//
// Env (each resolves env → data/telegram-test.env → AppleScript dialog):
//   TELEGRAM_LIVE_TEST_TOKEN    test-bot token (spawn mode) — asked with hidden input
//   TELEGRAM_LIVE_TEST_CHAT_ID  your numeric Telegram user id (the spawned test bot
//                               allowlists it) — asked with plain input, production
//                               allowlist suggested
//   TELEGRAM_LIVE_TEST_TG       telethon CLI path (default: skill scripts/tg.py)
// In spawn mode the DM chat target is derived from the token (<bot-id> peer), so
// --chat is unnecessary; --no-prompt disables the dialog for non-interactive runs.
//
// One-time prerequisites: create a TEST bot via BotFather (never reuse the
// production token) and /start it from your account once.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const TG_CLI =
  process.env.TELEGRAM_LIVE_TEST_TG ??
  path.join(os.homedir(), ".agents/skills/telegram-telethon/scripts/tg.py");
const BOOT_TIMEOUT_MS = 90_000;
const REPLY_TIMEOUT_MS = 45_000;
const SOAK_MS = 15_000;

// ─── args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argVal = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(`--${name}`);

const attach = hasFlag("attach");
const scenario = argVal("scenario") ?? (attach ? "smoke" : "full");
const noPrompt = hasFlag("no-prompt");
const webPort = parseInt(argVal("web-port") || "7871", 10);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-live-"));

// ─── test-env resolution (prompt via AppleScript dialog when missing) ───

/** Gitignored runtime store — data/ is tracked-never, file mode 0600. */
const testEnvFile = path.join(process.cwd(), "data", "telegram-test.env");

function loadPersistedVars(): Record<string, string> {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(testEnvFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
    );
  } catch {
    return {};
  }
}

function persistVar(key: string, value: string): void {
  const vars = loadPersistedVars();
  vars[key] = value;
  fs.mkdirSync(path.dirname(testEnvFile), { recursive: true });
  fs.writeFileSync(testEnvFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
}

/** Pops a native dialog for the user to type the value. Never logs the result. */
function requestVarViaAppleScript(prompt: string, opts: { hidden?: boolean; def?: string } = {}): string | undefined {
  const scriptText =
    `display dialog ${JSON.stringify(prompt)} default answer ${JSON.stringify(opts.def ?? "")}` +
    (opts.hidden ? " with hidden answer" : "") +
    ` with title "pibot telegram live-test" buttons {"Cancel", "Save"} default button "Save"`;
  const r = spawnSync("osascript", ["-e", scriptText], { timeout: 180_000, encoding: "utf8" });
  if (r.status !== 0) return undefined; // cancelled or no GUI session
  const m = /text returned:([\s\S]*?)\s*$/.exec(r.stdout);
  return m ? m[1] : undefined;
}

/** Suggest a default chat id from the production launchd plist's allowlist, when present. */
function suggestedChatId(): string {
  const plist = path.join(os.homedir(), "Library/LaunchAgents/com.glebkalinin.pibot.plist");
  try {
    const r = spawnSync("plutil", ["-extract", "EnvironmentVariables.TELEGRAM_ALLOWED_CHATS", "raw", plist], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

/** env → persisted file → AppleScript prompt (unless --no-prompt). Persists prompted values. */
function resolveTestVar(envName: string, opts: { prompt: string; hidden?: boolean; def?: string }): string | undefined {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv.trim();
  const persisted = loadPersistedVars()[envName];
  if (persisted) return persisted.trim();
  if (noPrompt) return undefined;
  const value = requestVarViaAppleScript(opts.prompt, { hidden: opts.hidden, def: opts.def });
  if (value && value.trim()) {
    persistVar(envName, value.trim());
    return value.trim();
  }
  return undefined;
}

function maskToken(t: string): string {
  return `${t.slice(0, String(t).indexOf(":") < 0 ? 4 : String(t).indexOf(":") + 1)}…(masked)`;
}

// ─── telethon CLI driver ────────────────────────────────────────────────────

interface TgMessage {
  id: number;
  sender: string;
  text: string;
  date: string;
  chat_id?: string;
  reactions?: Array<{ emoji: string; count: number }>;
}

function sh(a: string[]): { ok: boolean; out: string } {
  const r = spawnSync("python3", [TG_CLI, ...a], { timeout: 60_000, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

function sendTg(chatRef: string, text: string): { sent: boolean; id?: number } {
  const r = sh(["send", "--chat", chatRef, "--text", text]);
  if (!r.ok) return { sent: false };
  try {
    const j = JSON.parse(r.out) as { sent?: boolean; message_id?: number };
    return { sent: Boolean(j.sent), id: j.message_id };
  } catch {
    return { sent: r.out.includes("true") };
  }
}

function recentJson(chatRef: string, limit = 8): TgMessage[] {
  const a = ["recent", "--json", "--limit", String(limit)];
  if (/^-?\d+$/.test(chatRef)) a.push("--chat-id", chatRef);
  else a.push("--chat", chatRef);
  const r = sh(a);
  if (!r.ok) return [];
  try {
    return JSON.parse(r.out) as TgMessage[];
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── scenario harness ───────────────────────────────────────────────────────

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function awaitReply(chatRef: string, pattern: RegExp, sinceEpoch: number, timeoutMs = REPLY_TIMEOUT_MS): Promise<TgMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = recentJson(chatRef).find(
      (m) => m.text && pattern.test(m.text) && Date.parse(m.date) >= sinceEpoch - 1_000
    );
    if (hit) return hit;
    await sleep(2_000);
  }
  return null;
}

async function reactionsFor(chatRef: string, messageId: number, timeoutMs = 30_000): Promise<TgMessage["reactions"] | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = recentJson(chatRef, 6).find((x) => x.id === messageId);
    if (m?.reactions?.length) return m.reactions;
    await sleep(2_000);
  }
  return null;
}

// ─── daemon control (spawn mode) ────────────────────────────────────────────

let child: ChildProcess | null = null;
const daemonLog: string[] = [];

function collect(p: ChildProcess): void {
  for (const stream of [p.stdout, p.stderr]) {
    stream?.on("data", (d: Buffer) => {
      daemonLog.push(String(d));
      if (daemonLog.length > 400) daemonLog.splice(0, daemonLog.length - 400);
    });
  }
}

function logTail(n = 20): string {
  return daemonLog.slice(-n).join("");
}

async function spawnDaemon(chatId: string): Promise<boolean> {
  const token = process.env.TELEGRAM_LIVE_TEST_TOKEN ?? loadPersistedVars().TELEGRAM_LIVE_TEST_TOKEN;
  if (!token) return false;
  const dataDir = path.join(tmpRoot, "data");
  const agentsDir = path.join(tmpRoot, "agents");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PIBOT_DATA_DIR: dataDir,
      PIBOT_AGENTS_DIR: agentsDir,
      PIBOT_TRANSPORT: "telegram",
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_ALLOWED_CHATS: chatId,
      PIBOT_WEB: "1",
      PIBOT_WEB_PORT: String(webPort),
      PIBOT_QUICK_KEYBOARD: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  collect(child);

  // readiness: pollers up + lock file present
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const booted = daemonLog.join("").includes("polling as");
    const lock = fs.existsSync(path.join(dataDir, "pibot.lock"));
    if (booted && lock) return true;
    if (child.exitCode != null) {
      record("T0b daemon boot", false, `exited early (code ${child.exitCode}):\n${logTail()}`);
      return false;
    }
    await sleep(1_000);
  }
  record("T0b daemon boot", false, `timeout after ${BOOT_TIMEOUT_MS / 1000}s:\n${logTail()}`);
  return false;
}

async function stopDaemon(): Promise<void> {
  if (!child || child.exitCode != null) return;
  const ref = child;
  ref.kill("SIGTERM");
  await Promise.race([new Promise<void>((r) => ref.once("exit", () => r())), sleep(10_000)]);
  if (ref.exitCode == null) ref.kill("SIGKILL");
}

// ─── scenarios ──────────────────────────────────────────────────────────────

async function scenarioStatusRoundTrip(chatRef: string): Promise<void> {
  const sentTs = Date.now();
  const r = sendTg(chatRef, "/status");
  if (!r.sent) return record("T1 /status round-trip", false, "telethon send failed");
  let reply: TgMessage | null = null;
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline && !reply) {
    reply = recentJson(chatRef).find((m) => m.text && /model:/i.test(m.text) && Date.parse(m.date) >= sentTs - 1_000) ?? null;
    if (!reply) await sleep(2_000);
  }
  record("T1 /status round-trip", Boolean(reply), reply ? reply.text.split("\n")[0].slice(0, 70) : "no reply within 45s");
}

async function scenarioUnknownCommand(chatRef: string): Promise<void> {
  const sentTs = Date.now();
  const r = sendTg(chatRef, "/zzz-not-a-real-command");
  if (!r.sent) return record("T2 unknown command reply", false, "telethon send failed");
  let reply: TgMessage | null = null;
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline && !reply) {
    reply = recentJson(chatRef).find((m) => m.text && /Unknown/.test(m.text) && Date.parse(m.date) >= sentTs - 1_000) ?? null;
    if (!reply) await sleep(2_000);
  }
  record("T2 unknown command reply", Boolean(reply), reply ? reply.text.split("\n")[0].slice(0, 70) : "no reply within 45s");
}

async function scenarioConsolidateNoop(chatRef: string, artifactsDir: string): Promise<void> {
  const sentTs = Date.now();
  const r = sendTg(chatRef, "/consolidate");
  if (!r.sent) return record("T3 /consolidate no-op", false, "telethon send failed");
  const ack = await awaitReply(chatRef, /Distilling/i, sentTs, 20_000);
  if (!ack) return record("T3 /consolidate no-op", false, "no ack within 20s");
  const report = await awaitReply(chatRef, /no new events to consolidate/, Date.parse(ack.date), 30_000);
  const blocksWritten = fs.existsSync(path.join(artifactsDir, "blocks.json"));
  record("T3 /consolidate no-op", Boolean(report), report ? report.text.split("\n")[0].slice(0, 70) : "ack ok, report missing");
  record("T3b /consolidate determinism", Boolean(report) && !blocksWritten, blocksWritten ? "blocks.json written on an empty log" : "no-op run wrote no blocks");
}

/** THE deadlock canary: a reply-to-command must settle a reaction on the sent message. */
async function scenarioReactionSettle(chatRef: string, sentinel: string): Promise<void> {
  const r = sendTg(chatRef, sentinel);
  const rx = r.sent && r.id ? await reactionsFor(chatRef, r.id, 30_000) : null;
  record("T4 reaction settle (wedge canary)", Boolean(rx), rx ? `got ${rx.map((x) => x.emoji).join("+")}` : "no reaction within 30s — outbox likely wedged");
}

async function scenarioLogSoak(logSource: () => string): Promise<void> {
  await sleep(SOAK_MS);
  const text = logSource();
  const bad = [
    /POLLING STOPPED/i,
    /\[bot\] message error/i,
    /\[telegram\] message handler:/i,
    /timed out after/i,
    /reaction failed/i,
  ].filter((re) => re.test(text));
  record("T5 log soak (no errors)", bad.length === 0, bad.length ? `found: ${bad.map(String).join(", ")}` : `${SOAK_MS / 1000}s clean`);
}

async function dashStatus(port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 4_000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(-1));
    req.setTimeout(5_000, () => {
      req.destroy();
      resolve(-1);
    });
  });
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const t0 = Date.now();
  let chatRef: string;
  let artifactsDir = "";
  let logSource: () => string;

  if (!attach) {
    // Spawn mode: creds resolve env → data/telegram-test.env → AppleScript prompt.
    // The DM chat target is derived from the token (its bot id — the same peer
    // telethon used when you /start'ed the bot); the bot's allowlist needs YOUR
    // numeric id instead.
    const token = resolveTestVar("TELEGRAM_LIVE_TEST_TOKEN", {
      prompt: "Test-bot token (from BotFather — a TEST bot, never the production one):",
      hidden: true,
    });
    if (!token || !/^\d+:/.test(token)) {
      console.error("TELEGRAM_LIVE_TEST_TOKEN required (cancelled or malformed — format <bot-id>:<secret>). Create a test bot with BotFather.");
      process.exit(2);
    }
    process.env.TELEGRAM_LIVE_TEST_TOKEN = token;
    const testerChatId = resolveTestVar("TELEGRAM_LIVE_TEST_CHAT_ID", {
      prompt: "Tester DM chat id (numeric — DMs with any bot use your own user id):",
      def: suggestedChatId(),
    });
    if (!testerChatId || !/^-?\d+$/.test(testerChatId)) {
      console.error("TELEGRAM_LIVE_TEST_CHAT_ID must be your numeric Telegram user id (the spawned test bot allowlists it). Got: " + JSON.stringify(testerChatId ?? null));
      process.exit(2);
    }
    const botPeer = token.split(":")[0];
    // resolve the test bot's @username via getMe — telethon can't address a raw bot id without a cached entity
    let botUsername = "";
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const j = (await res.json()) as { ok?: boolean; result?: { username?: string } };
      if (j.ok && j.result?.username) botUsername = j.result.username;
    } catch {
      /* handled below */
    }
    if (!botUsername) {
      console.error("could not reach Telegram getMe for the test bot — check the token / network.");
      process.exit(2);
    }
    chatRef = `@${botUsername}`;
    console.log(`🧪 spawn · token ${maskToken(token)} · tester chat id ${testerChatId} · scenarios target @${botUsername} · creds in data/telegram-test.env (0600, gitignored)`);

    const cliOk = sh(["status"]);
    record("T0a telethon CLI ready", /ready|True|ok/i.test(cliOk.out), cliOk.ok ? "" : cliOk.out.slice(0, 120));
    const booted = await spawnDaemon(testerChatId);
    if (!booted) process.exit(1);
    record("T0b daemon boot (isolated env)", true, `lock + pollers up (${Math.round((Date.now() - t0) / 1000)}s)`);
    logSource = () => daemonLog.join("");
    artifactsDir = path.join(tmpRoot, "agents/assistant/memory/consolidated");
    const code = await dashStatus(webPort);
    record("T0c dashboard auth challenge", code === 302 || code === 401, `http ${code}`);
  } else {
    chatRef = argVal("chat") ?? process.env.TELEGRAM_LIVE_TEST_CHAT ?? "";
    if (!chatRef) {
      console.error("attach mode needs --chat <bot chat id or @username> (read-only smoke scenarios)");
      process.exit(2);
    }
    const prodLog = path.join(REPO_ROOT, "data", "daemon.log");
    const sizeAtStart = fs.existsSync(prodLog) ? fs.statSync(prodLog).size : 0;
    logSource = () => (fs.existsSync(prodLog) ? fs.readFileSync(prodLog, "utf8").slice(sizeAtStart) : "");
    record("attach mode", true, "smoke only — no side-effecting commands run in a live bot chat");
  }

  await scenarioStatusRoundTrip(chatRef);
  await scenarioUnknownCommand(chatRef);

  if (scenario === "full" && !attach) {
    await scenarioConsolidateNoop(chatRef, artifactsDir);
    await scenarioReactionSettle(chatRef, "/status");
  } else if (scenario === "full" && attach) {
    console.log("⚠︎ full scenario requires spawn mode (isolated daemon); running smoke in attach mode");
  }

  await scenarioLogSoak(logSource);

  if (!attach && child) {
    await stopDaemon();
    const lock = path.join(tmpRoot, "data/pibot.lock");
    record("T6 shutdown + lock cleanup", !fs.existsSync(lock), fs.existsSync(lock) ? "lock file survived shutdown" : "");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? "🛑" : "✅"} ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

process.on("SIGINT", () => child?.kill("SIGKILL"));
main().catch((e) => {
  console.error("harness crashed:", e);
  child?.kill("SIGKILL");
  process.exit(1);
});