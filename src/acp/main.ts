// ─── pibot as an ACP agent — stdio entry point ──────────────────────────────
//
//   npx tsx src/acp/main.ts        (or: npm run acp)
//
// An ACP client (Zed, …) spawns this process and speaks newline-delimited
// JSON-RPC over stdin/stdout. stdout carries ONLY protocol frames — every log
// line in this process is forced to stderr, because a stray console.log would
// be parsed as a (broken) ACP message and wedge the connection.
//
//   PIBOT_ACP_AGENT   pibot agent to serve (default: PIBOT_DEFAULT_AGENT, else
//                     the first discovered agent)

import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { AgentManager } from "../core/agent-manager.js";
import { installLogRedaction } from "../core/log-redact.js";
import { Scheduler } from "../core/scheduler.js";
import { ensureDir } from "../core/util.js";
import { createPibotAcpPrompt } from "./agent.js";
import { AcpServer } from "./server.js";

/** Every diagnostic goes to stderr; stdout is reserved for the protocol. */
function log(message: string): void {
  process.stderr.write(`[acp] ${message}\n`);
}

async function main(): Promise<void> {
  installLogRedaction();
  // console.log/info/debug/trace would land on stdout and corrupt the stream.
  const toStderr = (...args: unknown[]): void => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.trace = toStderr;
  process.umask(0o077);

  const config = loadConfig();
  const dataDir = path.join(config.dataDir, "acp");
  ensureDir(dataDir);

  const modelRuntime = await ModelRuntime.create();
  const agents = new AgentManager(config.agentsDir, modelRuntime, config.vaultDir, process.cwd(), dataDir);
  agents.docsDir = config.docsDir;
  await agents.discover();

  const agentId = process.env.PIBOT_ACP_AGENT?.trim() || config.defaultAgentId || agents.defaultAgentId();
  if (!agentId) {
    log("no agents found — create one first (see README) and set PIBOT_ACP_AGENT");
    process.exit(1);
  }
  if (!agents.getAgent(agentId)) {
    log(`unknown agent "${agentId}" — known: ${agents.list().map((a) => a.id).join(", ") || "(none)"}`);
    process.exit(1);
  }

  // A throwaway scheduler: an ACP session is interactive, its schedule_* tools
  // must not race the daemon's job store, so it writes to its own file.
  const scheduler = new Scheduler(dataDir, () => undefined, () => undefined);

  const server = new AcpServer({
    input: process.stdin,
    output: process.stdout,
    agentInfo: { name: "pibot", title: `pibot · ${agentId}`, version: "0.1.0" },
    prompt: createPibotAcpPrompt({ agents, scheduler, agentId, log }),
    onSessionNew: ({ sessionId, cwd }) => log(`session ${sessionId} opened (client cwd: ${cwd})`),
    log,
  });
  server.start();
  log(`serving agent "${agentId}" over ACP on stdio`);

  const shutdown = (): void => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`));
}

main().catch((e) => {
  log(`fatal: ${(e as Error)?.stack ?? String(e)}`);
  process.exit(1);
});
