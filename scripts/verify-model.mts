// Verify the replacement free model end-to-end: ephemeral session exactly like
// HeartbeatEngine.tickOnce builds (createAgentSession + resolved model + ping).
import { ModelRuntime, createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";

const SLUG = process.argv[2] ?? "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";
const config = await loadConfig();
const modelRuntime = await ModelRuntime.create();
const r = resolveCliModel({ cliModel: SLUG, modelRuntime });
if (r.error || !r.model) throw new Error(`runtime cannot resolve ${SLUG}: ${r.error}`);
const model = r.model;
console.log("[verify] resolved: ok");

const loader = new DefaultResourceLoader({
  cwd: process.cwd(), agentDir: getAgentDir(),
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  systemPrompt: "You are a routing smoke test. Reply with exactly: OK",
});
await loader.reload();
const session = (await createAgentSession({
  cwd: process.cwd(), agentDir: getAgentDir(), modelRuntime, model,
  thinkingLevel: "off",
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(process.cwd()),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
})).session;
const started = Date.now();
await session.prompt("Reply with exactly: OK");
const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
const last = [...msgs].reverse().find((m) => m.role === "assistant");
const text = (last?.content ?? []).filter((b) => b?.type === "text" && b.text).map((b) => b.text).join(" ").trim();
console.log(`[verify] reply in ${Date.now() - started}ms: "${(text || "(empty)").slice(0, 80)}"`);
session.dispose();
