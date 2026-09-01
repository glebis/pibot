// ─── Wire a sub-bot token into encrypted settings ───────────────────────────
// For a bot that already exists in BotFather but whose token never reached the
// daemon (e.g. a failed managed-token transfer): asks for the token via an
// AppleScript dialog (hidden input), validates it against Telegram's getMe,
// and merges it into the sops-encrypted settings under telegram.subBots.
// The daemon attaches configured sub-bots at boot — restart afterwards.
//
// Usage: npx tsx scripts/attach-sub-bot.mts --agent creator [--token <t>] [--no-prompt]

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { SecretStore } from "../src/core/secrets.js";

const args = process.argv.slice(2);
const argVal = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const agentId = argVal("agent");
const tokenArg = argVal("token");
const noPrompt = args.includes("--no-prompt");

if (!agentId) {
  console.error("usage: --agent <agent-id>  (the agent whose bot this token belongs to)");
  process.exit(2);
}

// sanity: the agent must exist
const agentsDir = process.env.PIBOT_AGENTS_DIR ?? path.join(os.homedir(), ".local/share/pibot/agents");
if (!fs.existsSync(path.join(agentsDir, agentId, "agent.json"))) {
  console.error(`unknown agent "${agentId}" (no manifest under ${agentsDir})`);
  process.exit(2);
}

async function main(): Promise<void> {
  let token = tokenArg?.trim();
  if (!token) {
    const persisted = process.env.SUBBOT_TOKEN_CREATOR; // reserved for scripted runs
    if (persisted) token = persisted;
  }
  if (!token && !noPrompt) {
    const scriptText =
      `display dialog "Telegram bot token for the \\"${agentId}\\" sub-bot (from BotFather — /mybots → API Token):" ` +
      `default answer "" with hidden answer with title "pibot sub-bot wiring" buttons {"Cancel", "Save"} default button "Save"`;
    const r = spawnSync("osascript", ["-e", scriptText], { timeout: 180_000, encoding: "utf8" });
    const m = r.status === 0 ? /text returned:([\s\S]*?)\s*$/.exec(r.stdout) : null;
    token = m ? m[1].trim() : undefined;
  }
  if (!token || !/^\d+:/.test(token)) {
    console.error("no valid token provided (format <bot-id>:<secret>) — cancelled?");
    process.exit(2);
  }

  // validate against Telegram and learn the username
  let username = "";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = (await res.json()) as { ok?: boolean; result?: { id?: number; username?: string } };
    if (!j.ok || !j.result?.username) {
      console.error("getMe rejected the token — double-check it in BotFather.");
      process.exit(2);
    }
    username = j.result.username;
    console.log(`bot: @${username} (id ${j.result?.id})`);
  } catch (e) {
    console.error("network error calling Telegram getMe:", (e as Error).message);
    process.exit(2);
  }

  const store = new SecretStore(path.join(process.cwd(), "data"));
  await store.init(JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "settings.json"), "utf8")));
  const cur = store.get() as {
    telegram?: { token?: string; subBots?: Record<string, { token: string; username?: string }> };
  };
  const subBots = { ...(cur.telegram?.subBots ?? {}), [agentId]: { token, username } };
  await store.save({ telegram: { ...cur.telegram, subBots } });

  const mask = `${token.split(":")[0]}:…(masked)`;
  console.log(`✅ configured sub-bot for "${agentId}" → @${username} (${mask})`);
  console.log("next: restart pibot (one kickstart) — attachConfiguredSubBots wires it at boot;");
  console.log(`then send any message to @${username} once so the chat binds to "${agentId}".`);
  process.exit(0);
}

function maskToken(t: string): string {
  return `${t.split(":")[0]}:…(masked)`;
}

main().catch((e) => {
  console.error("attach-sub-bot failed:", e);
  process.exit(1);
});