import { loadConfig } from "../src/config.js";
import { SecretStore } from "../src/core/secrets.js";
import { readJson } from "../src/core/util.js";
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";

const config = loadConfig();
const secretStore = new SecretStore(config.dataDir);
await secretStore.init(readJson(config.dataDir + "/settings.json", {}));
console.log("injected env:", Object.keys((secretStore.get() as { env?: Record<string, string> }).env ?? {}).join(", "));
console.log("process.env XAI_API_KEY set:", !!process.env.XAI_API_KEY);

const mr = await ModelRuntime.create();
for (const spec of ["ollama/glm-5.3-flash:cloud"]) {
  const r = resolveCliModel({ cliModel: spec, modelRuntime: mr });
  if (r.error || !r.model) { console.log(`resolve ${spec}: error`, r.error); continue; }
  const m = r.model as { provider: string; id: string; baseUrl?: string; api?: string };
  console.log(`resolved: provider=${m.provider} id=${m.id} api=${m.api} baseUrl=${m.baseUrl}`);
  try {
    const msg = await mr.complete(m, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { maxTokens: 4 });
    console.log("result stopReason:", msg.stopReason, msg.errorMessage ?? "(no error)");
  } catch (e) {
    console.log("COMPLETE ERROR:", (e as Error).message.slice(0, 200));
  }
}
process.exit(0);
