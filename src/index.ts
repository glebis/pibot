import * as fs from "node:fs";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadSettings } from "./config.js";
import { AgentManager } from "./core/agent-manager.js";
import { PiBot } from "./core/bot.js";
import { EventLog } from "./core/events.js";
import { EvolutionEngine, createLlmEvolutionIO } from "./core/evolution.js";
import { HeartbeatEngine } from "./core/heartbeat.js";
import { Scheduler } from "./core/scheduler.js";
import { ensureDir } from "./core/util.js";
import { createWebApp } from "./web.js";
import { CliTransport } from "./transports/cli.js";
import { TelegramTransport } from "./transports/telegram.js";

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDir(config.dataDir);

  // single-instance guard: two processes would fight over the bot's getUpdates
  const lockFile = path.join(config.dataDir, "pibot.lock");
  if (fs.existsSync(lockFile)) {
    const pid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 0); // throws if not running
        console.error(`[pibot] another instance is running (pid ${pid}) — exiting. Kill it first or delete ${lockFile}.`);
        process.exit(1);
      } catch {
        /* stale lock */
      }
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));
  process.on("exit", () => {
    try {
      if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  });

  const modelRuntime = await ModelRuntime.create();
  const agents = new AgentManager(config.agentsDir, modelRuntime, config.vaultDir);
  const events = new EventLog(config.agentsDir);

  // bot is created after its collaborators; they reach it through this ref
  let bot!: PiBot;

  const scheduler = new Scheduler(config.dataDir, (job, snoozed) => bot.deliverFire(job, snoozed));

  const heartbeat = new HeartbeatEngine({
    agents,
    scheduler,
    modelRuntime,
    events,
    vaultDir: config.vaultDir,
    host: {
      deliverToAgent: (agentId, text) => bot.deliverToAgent(agentId, text),
      escalateToAgent: (agentId, instruction) => bot.escalateToAgent(agentId, instruction),
      lastUserMessageAt: (agentId) => bot.lastUserMessageAt(agentId),
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

  const settings = loadSettings(config.dataDir);
  const telegramToken = config.telegramToken ?? settings.telegram?.token;
  const allowedChats = config.allowedChats.length
    ? config.allowedChats
    : settings.telegram?.allowedChats ?? [];
  const transports =
    telegramToken && config.transport !== "cli"
      ? [new TelegramTransport(telegramToken, allowedChats)]
      : [new CliTransport()];

  bot = new PiBot({ config, agents, scheduler, heartbeat, events, transports, evolution });

  await bot.start();
  scheduler.rearm();

  // web dashboard (config CRUD) — always on unless disabled
  const webPort = parseInt(process.env.PIBOT_WEB_PORT || "7860", 10);
  if (process.env.PIBOT_WEB !== "0") {
    const webApp = createWebApp({ agents, scheduler, events, evolution, dataDir: config.dataDir, telegram: bot });
    const server = serve({ fetch: webApp.fetch, port: webPort, hostname: "127.0.0.1" });
    console.log(`[pibot] dashboard → http://127.0.0.1:${webPort}`);
    server.addListener("error", (e) => console.error("[web]", e.message));
  }

  // telegram configured via web (settings.json) survives restarts
  if (!bot.hasTransport("telegram")) {
    if (settings.telegram?.token) {
      const r = await bot.enableTelegram(settings.telegram.token, settings.telegram.allowedChats ?? []);
      console.log(r.ok ? `[pibot] telegram enabled (web config) as ${r.botName}` : `[pibot] telegram (web config) failed: ${r.error}`);
    }
    // per-agent sub-bots
    for (const [agentId, sub] of Object.entries(settings.telegram?.subBots ?? {})) {
      const r = await bot.attachSubBot(agentId, sub.token);
      console.log(r.ok ? `[pibot] sub-bot for ${agentId} → ${r.botName}` : `[pibot] sub-bot for ${agentId} failed: ${r.error}`);
    }
  }

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