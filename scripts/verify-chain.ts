import { loadConfig } from "../src/config.js";
import { SecretStore } from "../src/core/secrets.js";
import { readJson } from "../src/core/util.js";
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";

const config = loadConfig();
const store = new SecretStore(config.dataDir);
await store.init(readJson(config.dataDir + "/settings.json", {}));
const mr = await ModelRuntime.create();
const providers = new Set<string>();
for (const p of mr.getProviders()) if (await mr.checkAuth(p.id).catch(() => undefined)) providers.add(p.id);
console.log("configured providers:", [...providers].join(", ") || "(none)");

const chainTail: string[] = [];
for (const m of mr.getModels()) {
  const spec = `${m.provider}/${m.id}`;
  if (mr.hasConfiguredAuth(m.provider)) chainTail.push(spec);
}
console.log("auto-tail (what joins every cascade):");
for (const s of chainTail) console.log("  -", s);
const r = resolveCliModel({ cliModel: "xai/grok-4.6", modelRuntime: mr });
console.log("xai/grok-4.6 resolves:", r.error ? `✗ ${r.error}` : "✓ (still configured!)");
const g = resolveCliModel({ cliModel: "ollama/glm-5.3-flash:cloud", modelRuntime: mr });
console.log("ollama/glm-5.3-flash:cloud resolves:", g.model ? "✓" : "✗");
process.exit(0);
