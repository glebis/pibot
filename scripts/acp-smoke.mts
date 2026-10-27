/**
 * Live ACP smoke test — drive a REAL ACP peer through the client pibot uses.
 *
 *   npx tsx scripts/acp-smoke.mts ["prompt"] [--cwd DIR] [--agent cmd] [--permission allow|reject] [--timeout SECONDS]
 *   npx tsx scripts/acp-smoke.mts --server ["prompt"]     # verify pibot's own ACP server instead
 *
 * Default target is `cmd acp` (Command Code) in the current directory. Prints
 * the handshake, every tool call the agent made, its final answer and the stop
 * reason. Exit 0 only when the turn completed.
 *
 * `--server` spawns `npx tsx src/acp/main.ts` — pibot acting as an ACP agent —
 * which is the same entry point an editor (Zed, …) launches. PIBOT_ACP_AGENT
 * selects the pibot agent it serves.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, ACP_AGENTS } from "../src/acp/client.js";
import { collectAgentText, summarizeToolCalls } from "../src/plugins/acp-plugin.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]) {
  const opts = {
    prompt: "Reply with exactly: ACP-OK. Do not use any tools.",
    cwd: process.cwd(),
    agent: "cmd",
    permission: "allow" as "allow" | "reject",
    timeout: 180,
    server: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") opts.cwd = path.resolve(argv[++i] ?? ".");
    else if (arg === "--agent") opts.agent = argv[++i] ?? opts.agent;
    else if (arg === "--permission") opts.permission = argv[++i] === "reject" ? "reject" : "allow";
    else if (arg === "--timeout") opts.timeout = Number(argv[++i]) || opts.timeout;
    else if (arg === "--server") opts.server = true;
    else rest.push(arg);
  }
  if (rest.length) opts.prompt = rest.join(" ");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const spec = opts.server
  ? { label: "pibot acp server", command: "npx", args: ["tsx", "src/acp/main.ts"], cwd: repoRoot, envPassthrough: ["PIBOT_AGENTS_DIR", "PIBOT_ACP_AGENT", "PIBOT_DEFAULT_AGENT", "PIBOT_DATA_DIR", "PIBOT_VAULT_DIR"] }
  : { ...(ACP_AGENTS[opts.agent] ?? {}), cwd: opts.cwd, envPassthrough: [] as string[] };
if (!spec.command || !spec.args) {
  console.error(`unknown ACP agent "${opts.agent}" — known: ${Object.keys(ACP_AGENTS).join(", ")}`);
  process.exit(2);
}

const client = new AcpClient({
  command: spec.command,
  args: spec.args,
  cwd: spec.cwd,
  envPassthrough: spec.envPassthrough,
  permission: opts.permission,
  requestTimeoutMs: opts.timeout * 1000,
  onStderr: (line) => console.error(`[peer] ${line}`),
});

let exitCode = 1;
try {
  console.log(`spawning: ${spec.command} ${spec.args.join(" ")}  (cwd: ${spec.cwd})`);
  client.start();

  const init = await client.initialize();
  console.log(`handshake: protocol v${init.protocolVersion} · ${init.agentInfo?.name ?? "?"} ${init.agentInfo?.version ?? ""}`);
  console.log(`capabilities: ${JSON.stringify(init.agentCapabilities)}`);

  const sessionId = await client.newSession(opts.cwd);
  console.log(`session: ${sessionId}`);
  console.log(`prompt: ${JSON.stringify(opts.prompt)}`);

  const result = await client.prompt(sessionId, opts.prompt, opts.timeout * 1000);
  const calls = summarizeToolCalls(result.updates);
  if (calls.length) {
    console.log(`\ntool calls (${calls.length}):`);
    for (const call of calls) console.log(`  - ${call.title} — ${call.status}`);
  }
  console.log(`\n--- agent answer ---\n${collectAgentText(result.updates).trim() || "(no text)"}`);
  console.log(`\nstop reason: ${result.stopReason}`);
  exitCode = result.stopReason === "end_turn" || result.stopReason === "cancelled" ? 0 : 1;
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
} finally {
  await client.dispose();
}
process.exit(exitCode);
