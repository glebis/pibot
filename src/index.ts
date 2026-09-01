import * as fs from "node:fs";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { ensureDir, hardenRuntimeDataDir, readJson } from "./core/util.js";
import { SecretStore } from "./core/secrets.js";
import { AgentManager } from "./core/agent-manager.js";
import { PiBot } from "./core/bot.js";
import { EventLog } from "./core/events.js";
import { ModelCascade } from "./core/cascade.js";
import { EvolutionEngine, createLlmEvolutionIO } from "./core/evolution.js";
import { ConsolidationEngine, createLlmConsolidationIO } from "./core/consolidation.js";
import { HeartbeatEngine } from "./core/heartbeat.js";
import { Scheduler } from "./core/scheduler.js";
import { createWebApp } from "./web.js";
import { CliTransport } from "./transports/cli.js";
import { TelegramTransport } from "./transports/telegram.js";
import { ProviderManager } from "./core/providers.js";
import { SttService } from "./core/stt.js";
import { AudioMediaProcessor } from "./core/audio-media.js";

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDir(config.dataDir);
  hardenRuntimeDataDir(config.dataDir);

  // rotate the daemon log if it grows past 5 MB
  const daemonLog = path.join(config.dataDir, "daemon.log");
  try {
    const st = fs.statSync(daemonLog);
    if (st.size > 5 * 1024 * 1024) {
      fs.renameSync(daemonLog, daemonLog + ".old");
    }
  } catch {
    /* fresh install */
  }

  // encrypted settings (sops/age): decrypt-or-migrate at boot, fail closed
  const secretStore = new SecretStore(config.dataDir);
  await secretStore.init(readJson(config.dataDir + "/settings.json", {}));

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
  const agents = new AgentManager(config.agentsDir, modelRuntime, config.vaultDir, process.cwd(), config.dataDir);
  const events = new EventLog(config.agentsDir);

  // model cascade: primary → manifest fallbacks → PIBOT_MODEL_CASCADE → authenticated models → queue
  const cascade = new ModelCascade({
    modelRuntime,
    statePath: path.join(config.dataDir, "cascade-state.json"),
    globalTail: (process.env.PIBOT_MODEL_CASCADE || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    log: (m) => console.log(m),
  });

  // bot is created after its collaborators; they reach it through this ref
  let bot!: PiBot;

  const scheduler = new Scheduler(
    config.dataDir,
    (job, snoozed) => bot.deliverFire(job, snoozed),
    (job, event) =>
      bot.notifyScheduleFailure(
        job,
        event.kind === "paused"
          ? `Scheduled item "${job.title}" was automatically paused. ${job.pauseReason ?? "Repeated delivery failures."} Last error: ${event.error}. Fix the delivery problem, then resume schedule ${job.id}.`
          : `Scheduled item "${job.title}" could not be delivered. It will retry without sending repeated notices. Last error: ${event.error}.`,
      ),
  );

  // event-log → durable-memory consolidation (Skill Forge blueprint). Cheap model,
  // cascade-aware: manifest fallbacks → global tail, like heartbeat and evolution.
  const consolidation = new ConsolidationEngine({
    agents,
    events,
    io: createLlmConsolidationIO({
      agents,
      modelRuntime,
      modelFor: (agent) => {
        const configured = agent.manifest.consolidation?.model ?? config.heartbeatModel;
        const wanted = configured && configured !== "same" ? configured : agent.manifest.model;
        const chain = cascade.chainFor({ model: wanted, cascade: agent.manifest.cascade, providers: agent.manifest.providers });
        const spec = cascade.firstHealthy(chain);
        if (!spec) throw new Error(`no permitted consolidation model available for ${agent.id}`);
        const model = agents.resolveModel(spec);
        if (!model) throw new Error(`permitted consolidation model unavailable: ${spec}`);
        return model;
      },
    }),
  });

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
    cascade,
    statePath: path.join(config.dataDir, "heartbeat-state.json"),
    consolidation,
  });

  const evolution = new EvolutionEngine({
    agents,
    modelRuntime,
    events,
    dataDir: config.dataDir,
    consolidation,
    host: { announce: (agentId, text) => bot.deliverToAgent(agentId, text) },
    io: createLlmEvolutionIO({
      agents,
      modelRuntime,
      modelFor: (agent) => {
        const configured = agent.manifest.evolution?.model ?? config.heartbeatModel;
        const wanted = configured && configured !== "same" ? configured : agent.manifest.model;
        const chain = cascade.chainFor({ model: wanted, cascade: agent.manifest.cascade, providers: agent.manifest.providers });
        const spec = cascade.firstHealthy(chain);
        if (!spec) throw new Error(`no permitted evolution model available for ${agent.id}`);
        const model = agents.resolveModel(spec);
        if (!model) throw new Error(`permitted evolution model unavailable: ${spec}`);
        return model;
      },
    }),
  });

  const settings = secretStore.get();
  const telegramToken = config.telegramToken ?? settings.telegram?.token;
  const allowedChats = config.allowedChats.length
    ? config.allowedChats
    : settings.telegram?.allowedChats ?? [];
  const mediaDir = path.join(config.dataDir, "media");
  const transports =
    telegramToken && config.transport !== "cli"
      ? [new TelegramTransport(telegramToken, allowedChats, { openWhenEmpty: config.telegramOpen, mediaDir, reactions: process.env.PIBOT_REACTIONS !== "0" })]
      : [new CliTransport()];

  const providerManager = new ProviderManager(modelRuntime);
  bot = new PiBot({ config, agents, scheduler, heartbeat, events, transports, evolution, consolidation, modelRuntime, secrets: secretStore, cascade, providers: providerManager, stt: new SttService(), audioMedia: new AudioMediaProcessor(mediaDir) });

  await bot.start();
  scheduler.rearm();

  // web dashboard (config CRUD) — always on unless disabled
  const webPort = config.webPort ?? parseInt(process.env.PIBOT_WEB_PORT || "7860", 10);
  if (process.env.PIBOT_WEB !== "0") {
    const webApp = createWebApp({
      agents, scheduler, events, evolution, dataDir: config.dataDir, telegram: bot, secrets: secretStore,
      webToken: config.webToken, webRpId: config.webRpId, webPort,
      providers: providerManager,
    });
    const server = serve({ fetch: webApp.fetch, port: webPort, hostname: "127.0.0.1" });
    console.log(`[pibot] dashboard → http://127.0.0.1:${webPort}${config.webToken ? " 🔒 token" : ""}${config.webRpId ? ` (rpId=${config.webRpId})` : ""}`);
    server.addListener("error", (e) => console.error("[web]", e.message));
  }

  // telegram configured via web (settings.json) survives restarts
  const liveSettings = secretStore.get();
  if (!bot.hasTransport("telegram")) {
    if (liveSettings.telegram?.token) {
      const r = await bot.enableTelegram(liveSettings.telegram.token, liveSettings.telegram.allowedChats ?? []);
      console.log(r.ok ? `[pibot] telegram enabled (web config) as ${r.botName}` : `[pibot] telegram (web config) failed: ${r.error}`);
    }
  }
  // per-agent sub-bots attach INDEPENDENTLY of the main bot's transport source.
  // Retried per bot: a boot-time network blip must not leave a bot silent for days.
  await bot.attachConfiguredSubBots();

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
