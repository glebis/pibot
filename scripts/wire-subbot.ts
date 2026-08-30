import { loadConfig } from "../src/config.js";
import { SecretStore } from "../src/core/secrets.js";
import { readJson } from "../src/core/util.js";
const config = loadConfig();
const store = new SecretStore(config.dataDir);
await store.init(readJson(config.dataDir + "/settings.json", {}));
const cur = store.get();
const botId = process.argv[2];
const agentId = process.argv[3];
const r = await fetch(`https://api.telegram.org/bot${cur.telegram?.token}/getManagedBotToken`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ user_id: Number(botId) }),
}).then((x) => x.json() as Promise<{ ok: boolean; result?: string; description?: string }>);
if (!r.ok) { console.error("token fetch failed:", r.description); process.exit(1); }
const subBots = { ...(cur.telegram?.subBots ?? {}), [agentId]: { token: r.result! } };
await store.save({ telegram: { ...cur.telegram, subBots } });
console.log(`wired sub-bot for "${agentId}" (token stored; attaches at boot with inherited allowlist)`);
process.exit(0);
