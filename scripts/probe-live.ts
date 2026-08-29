import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
const mr = await ModelRuntime.create();
const candidates = [
  "xai/grok-4.6",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-4.1-mini",
  "openai/gpt-5-mini",
  "groq/llama-3.3-70b-versatile",
  "cerebras/gpt-oss-120b",
  "lyceum/moonshotai/kimi-k3",
  "ollama/glm-5.3-flash:cloud",
  "ollama/minimax-m3:cloud",
];
for (const spec of candidates) {
  const r = resolveCliModel({ cliModel: spec, modelRuntime: mr });
  if (r.error || !r.model) { console.log(`✗ ${spec} — not in catalog`); continue; }
  const t0 = Date.now();
  try {
    const msg = await mr.complete(r.model, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { maxTokens: 4 });
    const ok = msg.stopReason !== "error" && msg.stopReason !== "aborted";
    console.log(ok ? `✓ ${spec} (${Date.now() - t0}ms)` : `✗ ${spec} — ${msg.errorMessage ?? `stopReason=${msg.stopReason}`}`);
  } catch (e) {
    console.log(`✗ ${spec} — ${(e as Error).message.slice(0, 160)}`);
  }
}
process.exit(0);
