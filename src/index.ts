import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { AgentManager } from "./core/agent-manager.js";
import { PiBot } from "./core/bot.js";
import { EventLog } from "./core/events.js";
import { EvolutionEngine, createLlmEvolutionIO } from "./core/evolution.js";
import { HeartbeatEngine } from "./core/heartbeat.js";
import { Scheduler } from "./core/scheduler.js";
import { ensureDir } from "./core/util.js";
import { CliTransport } from "./transports/cli.js";
import { TelegramTransport } from "./transports/telegram.js";

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDir(config.dataDir);

  const modelRuntime = await ModelRuntime.create();
  const agents = new AgentManager(config.agentsDir, modelRuntime);
  const events = new EventLog(config.agentsDir);

  // bot is created after its collaborators; they reach it through this ref
  let bot!: PiBot;

  const scheduler = new Scheduler(config.dataDir, (job, snoozed) => bot.deliverFire(job, snoozed));

  const heartbeat = new HeartbeatEngine({
    agents,
    scheduler,
    modelRuntime,
    events,
    host: {
      deliverToAgent: (agentId, text) => bot.deliverToAgent(agentId, text),
      escalateToAgent: (agentId, instruction) => bot.escalateToAgent(agentId, instruction),
    },
  });

  const evolution = new EvolutionEngine({
    agents,
    modelRuntime,
    events,
    dataDir: config.dataDir,
    host: { announce: (agentId, text) => bot.deliverToAgent(agentId, text) },
    io: createLlmEvolutionIO({
      agents,
      modelRuntime,
      modelFor: (agent) => {
        const spec = agent.manifest.evolution?.model ?? config.heartbeatModel;
        try {
          return agents.resolveModel(spec) ?? agents.resolveModel(agent.manifest.model);
        } catch {
          return undefined;
        }
      },
    }),
  });

  const transports =
    config.transport === "telegram" && config.telegramToken
      ? [new TelegramTransport(config.telegramToken, config.allowedChats)]
      : [new CliTransport()];

  bot = new PiBot({ config, agents, scheduler, heartbeat, events, transports, evolution });

  await bot.start();
  scheduler.rearm();

  const shutdown = () => {
    console.log("\n[pibot] stopping…");
    scheduler.stop();
    void bot
      .stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[pibot] fatal:", e);
  process.exit(1);
});