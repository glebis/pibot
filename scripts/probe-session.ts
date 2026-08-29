import { loadConfig } from "../src/config.js";
import { SecretStore } from "../src/core/secrets.js";
import { readJson } from "../src/core/util.js";
import { AgentManager } from "../src/core/agent-manager.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const config = loadConfig();
const secretStore = new SecretStore(config.dataDir);
await secretStore.init(readJson(config.dataDir + "/settings.json", {}));
const mr = await ModelRuntime.create();
const agents = new AgentManager(config.agentsDir, mr, config.vaultDir);
await agents.discover();
const agent = agents.getAgent("focuscoach")!;
console.log("manifest.model:", agent.manifest.model);
const resolved = agents.resolveModel(agent.manifest.model);
const m = resolved as unknown as { provider: string; id: string; baseUrl?: string } | undefined;
console.log("resolved:", m?.provider, m?.id, "baseUrl:", m?.baseUrl);
try {
  const msg = await mr.complete(m!, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { maxTokens: 4 });
  console.log("stopReason:", msg.stopReason, msg.errorMessage ?? "(ok)");
} catch (e) {
  console.log("ERROR:", (e as Error).message.slice(0, 200));
}
process.exit(0);
