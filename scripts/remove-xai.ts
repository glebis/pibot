import { loadConfig } from "../src/config.js";
import { SecretStore } from "../src/core/secrets.js";
import { readJson } from "../src/core/util.js";

const config = loadConfig();
const store = new SecretStore(config.dataDir);
await store.init(readJson(config.dataDir + "/settings.json", {}));
const cur = store.get() as { env?: Record<string, string> };
const env = { ...(cur.env ?? {}) };
if ("XAI_API_KEY" in env) { delete env.XAI_API_KEY; console.log("removed XAI_API_KEY from encrypted env map"); }
else { console.log("no XAI_API_KEY found"); }
await store.save({ env });
console.log("env keys now:", Object.keys((store.get() as { env?: Record<string,string> }).env ?? {}).join(", ") || "(none)");
process.exit(0);
