import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const mr = await ModelRuntime.create();
const providers = mr.getProviders();
const available = await mr.getAvailable();
const byProvider = new Map<string, string[]>();
for (const m of available) {
  const k = (m as any).provider ?? m.id.split("/")[0];
  byProvider.set(k, [...(byProvider.get(k) ?? []), m.id]);
}
console.log("=== providers with credentials & their available models ===");
for (const p of providers) {
  const auth = await mr.checkAuth(p.id).catch((e) => `err:${e.message}`);
  const s = typeof auth === "string" ? auth : JSON.stringify(auth);
  if (!s || s === "undefined") continue;
  const models = byProvider.get(p.id) ?? [];
  console.log(`\n${p.id} [${s}]\n  ${models.length} models: ${models.slice(0, 12).join(", ")}${models.length > 12 ? `, …(+${models.length - 12})` : ""}`);
}
process.exit(0);
