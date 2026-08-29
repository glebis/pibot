import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJson, writeJsonAtomic } from "./core/util.js";

export interface Config {
  transport: "telegram" | "cli";
  dataDir: string;
  agentsDir: string;
  /** the owner's Obsidian vault — read-only ground truth for all agents */
  vaultDir: string;
  defaultAgentId?: string;
  heartbeatModel?: string;
  telegramToken?: string;
  allowedChats: string[];
  /** when true, empty allowlist means allow all (opt-in, insecure). Default closed. */
  telegramOpen: boolean;
  webToken?: string;
  webRpId?: string;
  webPort?: number;
}

// ─── runtime-editable settings (web-configurable, survives restarts) ───────

export interface Settings {
  telegram?: {
    token?: string;
    allowedChats?: string[];
    /** per-agent dedicated bots (sub-bots). allowedChats defaults to the main bot's
     *  allowlist (owner pairing) when not set per-agent. */
    subBots?: Record<string, { token: string; username?: string; allowedChats?: string[] }>;
  };
}

// NOTE: SecretStore.save (core/secrets.ts) deep-merges the `telegram` level, so
// sub-bot entries — including per-agent allowedChats — survive dashboard saves.

export function loadSettings(dataDir: string): Settings {
  return readJson<Settings>(path.join(dataDir, "settings.json"), {});
}

export function saveSettings(dataDir: string, patch: Settings): Settings {
  const merged = { ...loadSettings(dataDir), ...patch };
  writeJsonAtomic(path.join(dataDir, "settings.json"), merged);
  return merged;
}

/** Minimal .env loader (no dependency) — existing env vars win. */
function loadDotEnv(): void {
  const p = path.resolve(".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN || undefined;
  const transport = (process.env.PIBOT_TRANSPORT as Config["transport"]) || (token ? "telegram" : "cli");
  return {
    transport,
    dataDir: path.resolve(process.env.PIBOT_DATA_DIR || "./data"),
    agentsDir: path.resolve(process.env.PIBOT_AGENTS_DIR || "./agents"),
    vaultDir: path.resolve((process.env.PIBOT_VAULT_DIR || "~/Brains/brain").replace("~", os.homedir())),
    defaultAgentId: process.env.PIBOT_DEFAULT_AGENT || undefined,
    heartbeatModel: process.env.PIBOT_HEARTBEAT_MODEL && process.env.PIBOT_HEARTBEAT_MODEL !== "same"
      ? process.env.PIBOT_HEARTBEAT_MODEL
      : undefined,
    telegramToken: token,
    allowedChats: (process.env.TELEGRAM_ALLOWED_CHATS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    telegramOpen: (() => { const v = (process.env.PIBOT_TELEGRAM_OPEN || "").trim().toLowerCase(); return v === "1" || v === "true" || v === "yes" || v === "on"; })(),
    webToken: process.env.PIBOT_WEB_TOKEN?.trim() || undefined,
    webRpId: (process.env.PIBOT_WEB_RP_ID || process.env.PIBOT_WEB_AUTH || "").trim() || undefined,
    webPort: parseInt(process.env.PIBOT_WEB_PORT || "7860", 10),
  };
}