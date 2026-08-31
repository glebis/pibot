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
// Env:
//   TELEGRAM_LIVE_TEST_TOKEN    test-bot token (spawn mode, required)
//   TELEGRAM_LIVE_TEST_CHAT_ID  numeric DM chat id with the test bot (spawn mode)
//   TELEGRAM_LIVE_TEST_TG       telethon CLI path (default: skill scripts/tg.py)
//
// One-time setup: create a TEST bot via BotFather, /start it from your
// account, then export TELEGRAM_LIVE_TEST_TOKEN and TELEGRAM_LIVE_TEST_CHAT_ID
// (your numeric Telegram user id — DMs with any bot use it as the chat id).

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
const chat = argVal("chat") ?? process.env.TELEGRAM_LIVE_TEST_CHAT_ID ?? process.env.TELEGRAM_LIVE_TEST_CHAT;
const webPort = parseInt(argVal("web-port") || "7871", 10);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-live-"));

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
  const r = sh(["recent", "--chat-id", chatRef.startsWith("-") || /^\d+$/.test(chatRef) ? chatRef : "", "--chat", chatRef, "--json", "--limit", String(limit)].filter((x, i, a) => x !== "" && a[i - 1] !== x));
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
  const token = process.env.TELEGRAM_LIVE_TEST_TOKEN;
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
  const chatRef = chat;
  if (!chatRef) {
    console.error("usage: --chat <test-bot-@username|DM chat id>  (or TELEGRAM_LIVE_TEST_CHAT_ID)");
    process.exit(2);
  }
  const t0 = Date.now();
  console.log(`🧪 telegram live-test — ${attach ? "ATTACH (read-only smoke vs a running bot)" : "spawn (isolated daemon)"} · chat=${chatRef} · scenario=${scenario}`);

  let logSource: () => string;
  let artifactsDir = "";

  if (!attach) {
    if (!process.env.TELEGRAM_LIVE_TEST_TOKEN) {
      console.error("TELEGRAM_LIVE_TEST_TOKEN is required for spawn mode (a dedicated TEST bot — never the production token).");
      process.exit(2);
    }
    const cliOk = sh(["status"]);
    record("T0a telethon CLI ready", /ready|True|ok/i.test(cliOk.out), cliOk.ok ? "" : cliOk.out.slice(0, 120));
    const booted = await spawnDaemon(chatRef);
    if (!booted) process.exit(1);
    record("T0b daemon boot (isolated env)", true, `lock + pollers up (${Math.round((Date.now() - t0) / 1000)}s)`);
    logSource = () => daemonLog.join("");
    artifactsDir = path.join(tmpRoot, "agents/assistant/memory/consolidated");
    const code = await dashStatus(webPort);
    record("T0c dashboard auth challenge", code === 302 || code === 401, `http ${code}`);
  } else {
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