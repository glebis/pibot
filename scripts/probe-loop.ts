import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
const mr = await ModelRuntime.create();
const r = resolveCliModel({ cliModel: "ollama/glm-5.3-flash:cloud", modelRuntime: mr });
let ok = 0, fail = 0;
for (let i = 0; i < 8; i++) {
  try {
    const msg = await mr.complete(r.model!, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { maxTokens: 4 });
    msg.stopReason === "error" ? (fail++, console.log(i, "ERR", msg.errorMessage?.slice(0, 80))) : ok++;
  } catch (e) { fail++; console.log(i, "ERR", (e as Error).message.slice(0, 80)); }
}
console.log(`ok=${ok} fail=${fail}`);
process.exit(0);
