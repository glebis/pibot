import { loadConfig } from "../src/config.js";
import { SecretStore } from "../src/core/secrets.js";
import { readJson } from "../src/core/util.js";
const config = loadConfig();
const store = new SecretStore(config.dataDir);
await store.init(readJson(config.dataDir + "/settings.json", {}));
const token = store.get().telegram?.token!;
const botId = process.argv[2];
const r = await fetch(`https://api.telegram.org/bot${token}/getManagedBotToken`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ user_id: Number(botId) }),
}).then((r) => r.json());
console.log(JSON.stringify(r, null, 1));
process.exit(0);
