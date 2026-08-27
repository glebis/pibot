import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const mr = await ModelRuntime.create();
const providers = mr.getProviders();
console.log("providers:", providers.map(p => p.id).join(", "));
const available = await mr.getAvailable();
console.log("available models:", available.slice(0, 10).map(m => `${m.provider}/${m.id}`).join(", ") || "(NONE)");
for (const p of providers.slice(0, 8)) {
  const st = await mr.checkAuth(p.id).catch((e) => `err:${e.message}`);
  console.log(`auth ${p.id}:`, typeof st === "string" ? st : JSON.stringify(st)?.slice(0, 80));
}
process.exit(0);
