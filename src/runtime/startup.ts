import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { serve } from "@hono/node-server";
import type { ExecutionContext } from "hono";
import type { Config, Settings } from "../config.js";
import { AgentManager } from "../core/agent-manager.js";
import { AudioMediaProcessor } from "../core/audio-media.js";
import { PiBot } from "../core/bot.js";
import { ModelCascade } from "../core/cascade.js";
import { EventLog } from "../core/events.js";
import { EvolutionEngine, createLlmEvolutionIO } from "../core/evolution.js";
import { HeartbeatEngine } from "../core/heartbeat.js";
import { ProviderManager } from "../core/providers.js";
import { Scheduler, type ScheduleFailureNotice } from "../core/scheduler.js";
import type { SecretStore } from "../core/secrets.js";
import { SttService } from "../core/stt.js";
import type { Schedule, Transport } from "../core/types.js";
import { CliTransport } from "../transports/cli.js";
import { TelegramTransport } from "../transports/telegram.js";
import { createWebApp, type TelegramControl } from "../web.js";

type Awaitable<T> = T | Promise<T>;
type Signal = "SIGINT" | "SIGTERM";
type SecretStoreLike = Pick<SecretStore, "get" | "save">;
export type StartupEnv = Partial<Pick<NodeJS.ProcessEnv, "PIBOT_MODEL_CASCADE" | "PIBOT_REACTIONS" | "PIBOT_WEB" | "PIBOT_WEB_PORT">>;
type StartupFetch = (request: Request, env?: unknown, executionCtx?: ExecutionContext) => Response | Promise<Response>;

export interface StartupServer {
  close(callback?: (error?: Error) => void): void;
  addListener(event: "error", listener: (error: Error) => void): void;
}

export interface StartupPlatform {
  cwd: string;
  env: StartupEnv;
  process: {
    on(signal: Signal, listener: () => void): void;
    off(signal: Signal, listener: () => void): void;
    exit(code: number): never;
  };
  console: Pick<Console, "log" | "error">;
  serve(options: { fetch: StartupFetch; port: number; hostname: "127.0.0.1" }): StartupServer;
}

export interface StartupBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  deliverFire(job: Schedule, snoozed: boolean): Awaitable<void>;
  deliverToAgent(agentId: string, text: string): Awaitable<void>;
  escalateToAgent(agentId: string, instruction: string): Awaitable<void>;
  lastUserMessageAt(agentId: string): number;
  hasTransport(name: string): boolean;
  enableTelegram(token: string, allowedChats: string[]): Promise<{ ok: boolean; botName?: string; error?: string }>;
  attachSubBot(agentId: string, token: string, allowedChats?: string[]): Promise<{ ok: boolean; botName?: string; error?: string }>;
}

export interface AssembleRuntimeInputs {
  config: Config;
  secretStore: SecretStoreLike;
  env: StartupEnv;
  cwd: string;
}

export interface RuntimeFactories {
  createModelRuntime(): Awaitable<ModelRuntime>;
  createAgents(input: { config: Config; cwd: string; modelRuntime: ModelRuntime }): Awaitable<AgentManager>;
  createEvents(input: { config: Config }): Awaitable<EventLog>;
  createCascade(input: { config: Config; env: StartupEnv; modelRuntime: ModelRuntime; log: (message: string) => void }): Awaitable<ModelCascade>;
  createScheduler(input: {
    config: Config;
    onFire: (job: Schedule, snoozed: boolean) => Awaitable<void>;
    onFailure: (job: Schedule, event: ScheduleFailureNotice) => Awaitable<void>;
  }): Awaitable<Scheduler>;
  createHeartbeat(input: {
    config: Config;
    agents: AgentManager;
    scheduler: Scheduler;
    modelRuntime: ModelRuntime;
    events: EventLog;
    cascade: ModelCascade;
    host: {
      deliverToAgent(agentId: string, text: string): Promise<void>;
      escalateToAgent(agentId: string, instruction: string): Promise<void>;
      lastUserMessageAt(agentId: string): number;
    };
  }): Awaitable<HeartbeatEngine>;
  createEvolution(input: {
    config: Config;
    agents: AgentManager;
    modelRuntime: ModelRuntime;
    events: EventLog;
    cascade: ModelCascade;
    host: { deliverToAgent(agentId: string, text: string): Promise<void> };
  }): Awaitable<EvolutionEngine>;
  createProviders(input: { modelRuntime: ModelRuntime }): Awaitable<ProviderManager>;
  createCliTransport(): Transport;
  createTelegramTransport(input: { token: string; allowedChats: string[]; openWhenEmpty: boolean; mediaDir: string; reactions: boolean }): Transport;
  createStt(): Awaitable<SttService>;
  createAudioMedia(input: { mediaDir: string }): Awaitable<AudioMediaProcessor>;
  createBot(input: {
    config: Config;
    agents: AgentManager;
    scheduler: Scheduler;
    heartbeat: HeartbeatEngine;
    events: EventLog;
    transports: Transport[];
    evolution: EvolutionEngine;
    modelRuntime: ModelRuntime;
    secretStore: SecretStoreLike;
    cascade: ModelCascade;
    providers: ProviderManager;
    stt: SttService;
    audioMedia: AudioMediaProcessor;
  }): Awaitable<StartupBot>;
  createWebApp(input: {
    agents: AgentManager;
    scheduler: Scheduler;
    events: EventLog;
    evolution: EvolutionEngine;
    dataDir: string;
    telegram: StartupBot;
    secretStore: SecretStoreLike;
    providerManager: ProviderManager;
    webToken?: string;
    webRpId?: string;
    webPort: number;
  }): { fetch: StartupFetch };
}

export interface AssembledRuntime {
  config: Config;
  secretStore: SecretStoreLike;
  env: StartupEnv;
  cwd: string;
  webPort: number;
  factories: RuntimeFactories;
  modelRuntime: ModelRuntime;
  agents: AgentManager;
  events: EventLog;
  cascade: ModelCascade;
  scheduler: Scheduler;
  heartbeat: HeartbeatEngine;
  evolution: EvolutionEngine;
  providerManager: ProviderManager;
  transports: Transport[];
  transportName: string;
  bot: StartupBot;
}

export interface RuntimeHandle {
  shutdown(): Promise<void>;
}

const defaultPlatform: StartupPlatform = {
  cwd: process.cwd(),
  env: process.env,
  process,
  console,
  serve: ({ fetch, port, hostname }) => serve({ fetch, port, hostname }),
};

const defaultFactories: RuntimeFactories = {
  createModelRuntime: () => ModelRuntime.create(),
  createAgents: ({ config, cwd, modelRuntime }) => new AgentManager(config.agentsDir, modelRuntime, config.vaultDir, cwd, config.dataDir),
  createEvents: ({ config }) => new EventLog(config.agentsDir),
  createCascade: ({ config, env, modelRuntime, log }) =>
    new ModelCascade({
      modelRuntime,
      statePath: path.join(config.dataDir, "cascade-state.json"),
      globalTail: (env.PIBOT_MODEL_CASCADE || "").split(",").map((item) => item.trim()).filter(Boolean),
      log,
    }),
  createScheduler: ({ config, onFire, onFailure }) => new Scheduler(config.dataDir, onFire, onFailure),
  createHeartbeat: ({ config, agents, scheduler, modelRuntime, events, cascade, host }) =>
    new HeartbeatEngine({
      agents,
      scheduler,
      modelRuntime,
      events,
      vaultDir: config.vaultDir,
      host,
      cascade,
      statePath: path.join(config.dataDir, "heartbeat-state.json"),
    }),
  createEvolution: ({ config, agents, modelRuntime, events, cascade, host }) =>
    new EvolutionEngine({
      agents,
      modelRuntime,
      events,
      dataDir: config.dataDir,
      host: { announce: async (agentId, text) => host.deliverToAgent(agentId, text) },
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
    }),
  createProviders: ({ modelRuntime }) => new ProviderManager(modelRuntime),
  createCliTransport: () => new CliTransport(),
  createTelegramTransport: ({ token, allowedChats, openWhenEmpty, mediaDir, reactions }) =>
    new TelegramTransport(token, allowedChats, { openWhenEmpty, mediaDir, reactions }),
  createStt: () => new SttService(),
  createAudioMedia: ({ mediaDir }) => new AudioMediaProcessor(mediaDir),
  createBot: ({ config, agents, scheduler, heartbeat, events, transports, evolution, modelRuntime, secretStore, cascade, providers, stt, audioMedia }) =>
    new PiBot({
      config,
      agents,
      scheduler,
      heartbeat,
      events,
      transports,
      evolution,
      modelRuntime,
      secrets: secretStore as SecretStore,
      cascade,
      providers,
      stt,
      audioMedia,
    }),
  createWebApp: ({ agents, scheduler, events, evolution, dataDir, telegram, secretStore, providerManager, webToken, webRpId, webPort }) =>
    createWebApp({
      agents,
      scheduler,
      events,
      evolution,
      dataDir,
      telegram: telegram as StartupBot & TelegramControl,
      secrets: secretStore,
      providers: providerManager,
      webToken,
      webRpId,
      webPort,
    }),
};

function scheduleFailureText(job: Schedule, event: ScheduleFailureNotice): string {
  return event.kind === "paused"
    ? `Scheduled item "${job.title}" was automatically paused. ${job.pauseReason ?? "Repeated delivery failures."} Last error: ${event.error}. Fix the delivery problem, then resume schedule ${job.id}.`
    : `Scheduled item "${job.title}" could not be delivered. It will retry without sending repeated notices. Last error: ${event.error}.`;
}

function resolveWebPort(config: Config, env: StartupEnv): number {
  const value = config.webPort ?? Number.parseInt(env.PIBOT_WEB_PORT || "7860", 10);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`webPort must be an integer from 1 to 65535 (received ${String(value)})`);
  }
  return value;
}

function mergeFactories(overrides?: Partial<RuntimeFactories>): RuntimeFactories {
  return { ...defaultFactories, ...overrides };
}

export async function assembleRuntime(inputs: AssembleRuntimeInputs, factories?: Partial<RuntimeFactories>): Promise<AssembledRuntime> {
  const runtimeFactories = mergeFactories(factories);
  const webPort = resolveWebPort(inputs.config, inputs.env);
  const modelRuntime = await runtimeFactories.createModelRuntime();
  const agents = await runtimeFactories.createAgents({ config: inputs.config, cwd: inputs.cwd, modelRuntime });
  const events = await runtimeFactories.createEvents({ config: inputs.config });
  const cascade = await runtimeFactories.createCascade({
    config: inputs.config,
    env: inputs.env,
    modelRuntime,
    log: (message) => defaultPlatform.console.log(message),
  });

  let botRef: StartupBot | undefined;
  const requireBot = (): StartupBot => {
    if (!botRef) throw new Error("runtime bot not assembled");
    return botRef;
  };

  const scheduler = await runtimeFactories.createScheduler({
    config: inputs.config,
    onFire: (job, snoozed) => requireBot().deliverFire(job, snoozed),
    onFailure: (job, event) => requireBot().deliverToAgent(job.agentId, scheduleFailureText(job, event)),
  });
  const heartbeat = await runtimeFactories.createHeartbeat({
    config: inputs.config,
    agents,
    scheduler,
    modelRuntime,
    events,
    cascade,
    host: {
      deliverToAgent: async (agentId, text) => requireBot().deliverToAgent(agentId, text),
      escalateToAgent: async (agentId, instruction) => requireBot().escalateToAgent(agentId, instruction),
      lastUserMessageAt: (agentId) => requireBot().lastUserMessageAt(agentId),
    },
  });
  const evolution = await runtimeFactories.createEvolution({
    config: inputs.config,
    agents,
    modelRuntime,
    events,
    cascade,
    host: { deliverToAgent: async (agentId, text) => requireBot().deliverToAgent(agentId, text) },
  });
  const providerManager = await runtimeFactories.createProviders({ modelRuntime });

  const settings = inputs.secretStore.get();
  const telegramToken = inputs.config.telegramToken ?? settings.telegram?.token;
  const allowedChats = inputs.config.allowedChats.length ? inputs.config.allowedChats : settings.telegram?.allowedChats ?? [];
  const mediaDir = path.join(inputs.config.dataDir, "media");
  const transports =
    telegramToken && inputs.config.transport !== "cli"
      ? [runtimeFactories.createTelegramTransport({ token: telegramToken, allowedChats, openWhenEmpty: inputs.config.telegramOpen, mediaDir, reactions: inputs.env.PIBOT_REACTIONS !== "0" })]
      : [runtimeFactories.createCliTransport()];
  const stt = await runtimeFactories.createStt();
  const audioMedia = await runtimeFactories.createAudioMedia({ mediaDir });
  const bot = await runtimeFactories.createBot({
    config: inputs.config,
    agents,
    scheduler,
    heartbeat,
    events,
    transports,
    evolution,
    modelRuntime,
    secretStore: inputs.secretStore,
    cascade,
    providers: providerManager,
    stt,
    audioMedia,
  });
  botRef = bot;

  return {
    ...inputs,
    webPort,
    factories: runtimeFactories,
    modelRuntime,
    agents,
    events,
    cascade,
    scheduler,
    heartbeat,
    evolution,
    providerManager,
    transports,
    transportName: transports[0]?.name ?? "unknown",
    bot,
  };
}

async function wireLiveTelegram(bot: StartupBot, settings: Settings, log: (message: string) => void): Promise<void> {
  if (!bot.hasTransport("telegram") && settings.telegram?.token) {
    const result = await bot.enableTelegram(settings.telegram.token, settings.telegram.allowedChats ?? []);
    log(result.ok ? `[pibot] telegram enabled (web config) as ${result.botName}` : `[pibot] telegram (web config) failed: ${result.error}`);
  }
  for (const [agentId, sub] of Object.entries(settings.telegram?.subBots ?? {})) {
    if (bot.hasTransport(`telegram:${agentId}`)) continue;
    const result = await bot.attachSubBot(agentId, sub.token, sub.allowedChats);
    log(result.ok ? `[pibot] sub-bot for ${agentId} → ${result.botName}` : `[pibot] sub-bot for ${agentId} failed: ${result.error}`);
  }
}

export async function startRuntime(runtime: AssembledRuntime, platform: StartupPlatform = defaultPlatform): Promise<RuntimeHandle> {
  let server: StartupServer | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const onSignal = (): void => {
    void shutdown().finally(() => platform.process.exit(0));
  };

  const removeHandlers = (): void => {
    platform.process.off("SIGINT", onSignal);
    platform.process.off("SIGTERM", onSignal);
  };

  const closeServer = (): Promise<void> => {
    if (!server) return Promise.resolve();
    const activeServer = server;
    server = null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) platform.console.error("[pibot] dashboard close failed");
        resolve();
      };
      try {
        activeServer.close(finish);
      } catch {
        platform.console.error("[pibot] dashboard close failed");
        finish();
      }
    });
  };

  const beginShutdown = (announce: boolean): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    removeHandlers();
    if (announce) platform.console.log("\n[pibot] stopping…");

    // Defer cleanup to a microtask so the shared promise is assigned before
    // any synchronous cleanup step can throw or re-enter shutdown.
    shutdownPromise = Promise.resolve().then(async () => {
      try {
        runtime.scheduler.stop();
      } catch {
        platform.console.error("[pibot] scheduler stop failed");
      }

      await Promise.all([
        Promise.resolve()
          .then(() => runtime.bot.stop())
          .catch(() => platform.console.error("[pibot] bot stop failed")),
        closeServer(),
      ]);
    });
    return shutdownPromise;
  };

  const shutdown = (): Promise<void> => beginShutdown(true);

  try {
    await runtime.bot.start();
    runtime.scheduler.rearm();

    if (runtime.env.PIBOT_WEB !== "0") {
      const webApp = runtime.factories.createWebApp({
        agents: runtime.agents,
        scheduler: runtime.scheduler,
        events: runtime.events,
        evolution: runtime.evolution,
        dataDir: runtime.config.dataDir,
        telegram: runtime.bot,
        secretStore: runtime.secretStore,
        providerManager: runtime.providerManager,
        webToken: runtime.config.webToken,
        webRpId: runtime.config.webRpId,
        webPort: runtime.webPort,
      });
      server = platform.serve({ fetch: webApp.fetch, port: runtime.webPort, hostname: "127.0.0.1" });
      server.addListener("error", (error) => platform.console.error("[web]", error.message));
      platform.console.log(
        `[pibot] dashboard → http://127.0.0.1:${runtime.webPort}${runtime.config.webToken ? " 🔒 token" : ""}${runtime.config.webRpId ? ` (rpId=${runtime.config.webRpId})` : ""}`,
      );
    }

    await wireLiveTelegram(runtime.bot, runtime.secretStore.get(), (message) => platform.console.log(message));
    platform.process.on("SIGINT", onSignal);
    platform.process.on("SIGTERM", onSignal);
    return { shutdown };
  } catch (error) {
    await beginShutdown(false);
    throw error;
  }
}
