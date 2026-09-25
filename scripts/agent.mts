/**
 * pibot agent CLI — programmatic agent creation via the daemon's owner API.
 *
 *   npx tsx scripts/agent.mts create <id> --description "..." [options]
 *
 * Options:
 *   --description/-d <text>    what the agent is for (required; anchors the persona)
 *   --vibe <text>              persona voice (default: "dry & efficient")
 *   --proactivity <p>          quiet | balanced | chatty | off  (default: quiet)
 *   --capabilities <a,b,c>     capability ids (default: conservative fleet defaults)
 *   --model <spec>             optional pi model shorthand
 *   --providers <a,b,c>        optional provider allowlist
 *   --subbot                   also fire the managed Telegram bot-creation flow
 *
 * Talks to the local dashboard (127.0.0.1:<webPort>) with the owner web token
 * (PIBOT_WEB_TOKEN / config). The daemon must be running.
 */
import { loadConfig } from "../src/config.js";

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error("usage: npx tsx scripts/agent.mts create <id> --description \"...\" [--vibe ...] [--proactivity quiet|balanced|chatty|off] [--capabilities a,b,c] [--model ...] [--providers a,b,c] [--subbot]");
  process.exit(1);
}

const [, , cmd, id, ...rest] = process.argv;
if (cmd !== "create" || !id) fail("first arguments must be: create <id>");

const flags: Record<string, string | boolean> = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) fail(`unexpected argument "${a}"`);
  const key = a.slice(2);
  const next = rest[i + 1];
  if (next != null && !next.startsWith("--")) {
    flags[key] = next;
    i++;
  } else {
    flags[key] = true;
  }
}

const description = flags.description ?? flags.d;
if (typeof description !== "string" || !description.trim()) fail("--description is required (what the agent is for)");

const config = loadConfig();
const port = config.webPort ?? parseInt(process.env.PIBOT_WEB_PORT || "7860", 10);
const token = config.webToken ?? process.env.PIBOT_WEB_TOKEN?.trim();
if (!token) fail("no web token found — set PIBOT_WEB_TOKEN (the dashboard's token)");

const payload: Record<string, unknown> = {
  id,
  description,
  ...(typeof flags.vibe === "string" ? { vibe: flags.vibe } : {}),
  ...(typeof flags.proactivity === "string" ? { proactivity: flags.proactivity } : {}),
  ...(typeof flags.capabilities === "string" ? { capabilities: flags.capabilities.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  ...(typeof flags.model === "string" ? { model: flags.model } : {}),
  ...(typeof flags.providers === "string" ? { providers: flags.providers.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  ...(flags.subbot ? { subbot: true } : {}),
};

let res: Response;
try {
  res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
} catch {
  fail(`daemon not reachable on 127.0.0.1:${port} — is pibot running?`);
}

const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
if (!res.ok || !body?.ok) {
  if (res.status === 404) console.error("error: the daemon has no /api/agents route — it predates this feature; restart pibot first");
  else console.error(`error: ${body?.error ?? `HTTP ${res.status}`}`);
  process.exit(1);
}

console.log(`agent created ✅ ${body.id}`);
console.log(`  dir: ${body.dir}`);
const subbot = body.subbot as { armed?: boolean; suggestedUsername?: string; deepLink?: string; error?: string } | undefined;
if (subbot) {
  if (subbot.armed && subbot.deepLink) {
    console.log(`  subbot: request armed — tap this link to create @${subbot.suggestedUsername}:`);
    console.log(`  ${subbot.deepLink}`);
  } else {
    console.error(`  subbot: NOT armed — ${subbot.error ?? "unknown error"}`);
  }
}