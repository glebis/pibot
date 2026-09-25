import * as fs from "node:fs";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { ensureDir, enforceOwnerOnlyRuntimeState, readJson } from "./core/util.js";
import { installLogRedaction } from "./core/log-redact.js";
import { SecretStore } from "./core/secrets.js";
import { AgentManager } from "./core/agent-manager.js";
import { PiBot } from "./core/bot.js";
import { EventLog } from "./core/events.js";
import { ModelCascade } from "./core/cascade.js";
import { installDiskGuard } from "./core/disk-guard.js";
import { EvolutionEngine, createLlmEvolutionIO } from "./core/evolution.js";
import { JevShadowFileStore, JevShadowObserver } from "./core/jev-shadow.js";
import { createLlmGoalIO } from "./core/goals.js";
import { createCompositeGoalJudge } from "./core/goal-jev.js";
import { ConsolidationEngine, createLlmConsolidationIO } from "./core/consolidation.js";
import { ProactiveStore } from "./core/proactive-store.js";
import { CommitmentEngine } from "./core/commitments.js";
import { IntakeStore } from "./core/research-intake.js";
import { HeartbeatEngine } from "./core/heartbeat.js";
import { Scheduler } from "./core/scheduler.js";
import { createWebApp } from "./web.js";
import { CliTransport } from "./transports/cli.js";
import { TelegramTransport } from "./transports/telegram.js";
import { ProviderManager } from "./core/providers.js";
import { SttService } from "./core/stt.js";
import { AudioMediaProcessor } from "./core/audio-media.js";

async function main(): Promise<void> {
  // FIRST: daemon.log is stdout/stderr, and error objects (grammy/node-fetch)
  // embed live bot tokens in their stack text. Redact at the console before
  // anything can write, so no later sink has to remember to (bd pibot-vuu).
  installLogRedaction();
  // Private runtime state (sessions, memories, skills, media, secrets) is written by
  // several layers, including the SDK — a process-wide umask makes every file the daemon
  // creates owner-only, and the boot-time repair fixes what earlier runs left readable.
  process.umask(0o077);
  const config = loadConfig();
  ensureDir(config.dataDir);
  enforceOwnerOnlyRuntimeState([config.dataDir, config.agentsDir]);

  // disk guard: catch ENOSPC anywhere in the daemon (process events, swallowed
  // catches via errorMessage, low-water watcher) and auto-run the disk-cleanup
  // skill's safe preset. Owner-authorized: includes --empty-trash; --no-quit
  // means running apps are never auto-quit. Durable 30-min cooldown in data/.
  const diskGuard = process.env.PIBOT_DISK_GUARD === "0"
    ? null
    : installDiskGuard({ dataDir: config.dataDir, log: (m) => console.log(m) });

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

  // measurable commitment loop (proactive pilot): metadata-only store + engine.
  // The engine reaches the bot through the same late-bound ref pattern.
  const proactiveStore = new ProactiveStore(config.dataDir);
  const commitments = new CommitmentEngine({
    agents,
    scheduler,
    events,
    store: proactiveStore,
    bot: {
      deliverToAgent: (agentId, text, card) => bot.deliverToAgent(agentId, text, undefined, card),
      pushChat: (chat, text, card) => bot.pushChatRef(chat, text, card),
    },
  });
  agents.commitments = commitments;
  agents.intake = new IntakeStore(config.dataDir);

  const heartbeat = new HeartbeatEngine({
    agents,
    scheduler,
    modelRuntime,
    events,
    vaultDir: config.vaultDir,
    host: {
      deliverToAgent: (agentId, text, opts) => bot.deliverToAgent(agentId, text, opts),
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
    // Jev shadow observer (bd pibot-n13): advisory, and gated by TWO independent
    // switches — the per-agent manifest flag plus this daemon-level mode. Only
    // PIBOT_JEV_SHADOW=live performs external calls; anything else records what
    // would have been sent (size, redaction, failure class) without sending it,
    // so granting an agent the flag can never ship probe text off the machine.
    shadow: new JevShadowObserver({
      store: new JevShadowFileStore(path.join(config.dataDir, "jev-shadow.json")),
      mode: process.env.PIBOT_JEV_SHADOW === "live" ? "live" : "dry_run",
    }),
    host: { announce: async (agentId, text) => {
      await bot.deliverToAgent(agentId, text);
    } },
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

  // /goal's judge + contract drafting: cheap ephemeral sessions on the first
  // healthy model of the default agent's chain (same resolution as consolidation).
  const localGoalIO = await createLlmGoalIO({
    modelRuntime,
    model: (() => {
      const defaultAgentId = agents.defaultAgentId() ?? config.defaultAgentId ?? "";
      const chain = cascade.chainFor(agents.getAgent(defaultAgentId)?.manifest ?? {});
      const spec = cascade.firstHealthy(chain);
      return spec ? cascade.resolveModel(spec) : undefined;
    })(),
  });

  // Jev as the goal judge is OPTIONAL and configurable: default local, and only
  // when BOTH the agent's manifest asks for it (goal.judge="jev" + scope +
  // provider) AND this daemon switch allows it. Every failure falls back to the
  // local judge, so an unavailable evaluator can never look like a verdict.
  const goalJudge = createCompositeGoalJudge({
    local: (state, reply) => localGoalIO.judge(state, reply),
    enabled: process.env.PIBOT_GOAL_JUDGE === "jev",
  });
  const goalIO = {
    draftContract: (objective: string) => localGoalIO.draftContract(objective),
    judge: (state: Parameters<typeof goalJudge.judge>[0], reply: string, ctx?: Parameters<typeof goalJudge.judge>[2]) =>
      goalJudge.judge(state, reply, ctx),
  };

  const providerManager = new ProviderManager(modelRuntime);
  bot = new PiBot({ config, agents, scheduler, heartbeat, events, transports, evolution, consolidation, commitments, modelRuntime, secrets: secretStore, cascade, providers: providerManager, stt: new SttService(), audioMedia: new AudioMediaProcessor(mediaDir), goalIO });
  diskGuard?.setNotify((text) => void bot.notifyOwnerEvent(text));

  await bot.start();
  scheduler.rearm();

  // pilot governance on boot: weekly scorecard jobs follow the manifest flags
  for (const a of agents.list()) commitments.syncPilotGovernance(a.id);

  // web dashboard (config CRUD) — always on unless disabled
  const webPort = config.webPort ?? parseInt(process.env.PIBOT_WEB_PORT || "7860", 10);
  if (process.env.PIBOT_WEB !== "0") {
    // Prefer the encrypted store; an explicit env value still wins for one-off runs.
    const webToken = config.webToken ?? secretStore.get().web?.token;
    const webApp = createWebApp({
      agents, scheduler, events, evolution, dataDir: config.dataDir, telegram: bot, secrets: secretStore,
      proactiveStore,
      commitments: { syncGovernance: (agentId) => commitments.syncPilotGovernance(agentId) },
      webToken, webRpId: config.webRpId, webPort,
      providers: providerManager,
      // same cascade control facade the /cascade chat command uses
      cascade: bot.commandContext().cascade,
    });
    const server = serve({ fetch: webApp.fetch, port: webPort, hostname: "127.0.0.1" });
    console.log(`[pibot] dashboard → http://127.0.0.1:${webPort}${webToken ? " 🔒 token" : ""}${config.webRpId ? ` (rpId=${config.webRpId})` : ""}`);
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
  const subBoot = await bot.attachConfiguredSubBots();
  // post-boot confirmation (owner request, Sep 20): one line, every boot —
  // the restart verdict reaches the owner's chat without anyone asking
  await bot.notifyBoot(subBoot).catch(() => {});

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
