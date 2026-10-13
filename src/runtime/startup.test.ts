import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { assembleRuntime, startRuntime, type RuntimeFactories, type StartupBot, type StartupPlatform } from "./startup.js";
import type { Config, Settings } from "../config.js";
import type { SecretStore } from "../core/secrets.js";

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
  transport: "cli",
  dataDir: "/tmp/pibot-test-data",
  agentsDir: "/tmp/pibot-test-agents",
  vaultDir: "/tmp/pibot-test-vault",
  allowedChats: [],
  telegramOpen: false,
  webToken: "secret-token",
  webRpId: "pibot.local",
  webPort: 9001,
  ...overrides,
});

const makeSecretStore = (settings: Settings = {}): Pick<SecretStore, "get" | "save"> => ({
  get: () => settings,
  save: vi.fn(async () => {}),
});

function makeProcess(calls: string[]) {
  const listeners = { SIGINT: new Set<() => void>(), SIGTERM: new Set<() => void>() };
  return {
    on(signal: "SIGINT" | "SIGTERM", listener: () => void) {
      calls.push(`on:${signal}`);
      listeners[signal].add(listener);
    },
    off(signal: "SIGINT" | "SIGTERM", listener: () => void) {
      calls.push(`off:${signal}`);
      listeners[signal].delete(listener);
    },
    exit(_code: number): never {
      throw new Error("exit");
    },
    seed(signal: "SIGINT" | "SIGTERM", listener: () => void) {
      listeners[signal].add(listener);
    },
    count(signal: "SIGINT" | "SIGTERM") {
      return listeners[signal].size;
    },
    getListeners(signal: "SIGINT" | "SIGTERM") {
      return Array.from(listeners[signal]);
    },
  };
}

async function makeHarness(options: {
  config?: Config;
  settings?: Settings;
  env?: NodeJS.ProcessEnv;
  factories?: Partial<RuntimeFactories>;
} = {}) {
  const calls: string[] = [];
  const process = makeProcess(calls);
  const server = {
    close: vi.fn((callback?: (error?: Error) => void) => {
      calls.push("server.close");
      callback?.();
    }),
    addListener: vi.fn((event: "error") => calls.push(`server.addListener:${event}`)),
  };
  const capture: { webArgs?: Parameters<RuntimeFactories["createWebApp"]>[0] } = {};
  const platform: StartupPlatform = {
    cwd: "/repo",
    env: options.env ?? {},
    process,
    console: {
      log: (...args: unknown[]) => calls.push(`log:${args.join(" ")}`),
      error: (...args: unknown[]) => calls.push(`error:${args.join(" ")}`),
    },
    serve: ({ hostname, port }) => {
      calls.push(`serve:${hostname}:${port}`);
      return server;
    },
  };

  let bot!: StartupBot;
  const factories: RuntimeFactories = {
    createModelRuntime: async () => ({ tag: "model-runtime" } as unknown as ModelRuntime),
    createAgents: async () => ({ tag: "agents" }) as any,
    createEvents: async () => ({ tag: "events" }) as any,
    createCascade: async () => ({ tag: "cascade" }) as any,
    createScheduler: async () =>
      ({
        rearm: vi.fn(() => calls.push("scheduler.rearm")),
        stop: vi.fn(() => calls.push("scheduler.stop")),
      }) as any,
    createHeartbeat: async () => ({ tag: "heartbeat" }) as any,
    createEvolution: async () => ({ tag: "evolution" }) as any,
    createProviders: async () => ({ tag: "providers" }) as any,
    createCliTransport: () => ({ name: "cli" }) as any,
    createTelegramTransport: ({ token, allowedChats }) => ({ name: "telegram", token, allowedChats }) as any,
    createStt: async () => ({ tag: "stt" }) as any,
    createAudioMedia: async () => ({ tag: "audio" }) as any,
    createBot: async ({ transports }) => {
      const transportNames = new Set(transports.map((transport) => transport.name));
      bot = {
        start: vi.fn(async () => { calls.push("bot.start"); }),
        stop: vi.fn(async () => { calls.push("bot.stop"); }),
        hasTransport: vi.fn((name: string) => transportNames.has(name)),
        enableTelegram: vi.fn(async (token: string) => {
          calls.push(`bot.enableTelegram:${token}`);
          transportNames.add("telegram");
          return { ok: true, botName: "pibot" };
        }),
        attachSubBot: vi.fn(async (agentId: string, token: string) => {
          calls.push(`bot.attachSubBot:${agentId}:${token}`);
          transportNames.add(`telegram:${agentId}`);
          return { ok: true, botName: `${agentId}bot` };
        }),
        deliverFire: vi.fn(async () => {}),
        deliverToAgent: vi.fn(async () => {}),
        escalateToAgent: vi.fn(async () => {}),
        lastUserMessageAt: vi.fn(() => 0),
      };
      return bot;
    },
    createWebApp: (args) => {
      capture.webArgs = args;
      calls.push("web.app");
      return { fetch: () => new Response("ok") };
    },
    ...options.factories,
  };

  const runtime = await assembleRuntime(
    {
      config: options.config ?? makeConfig(),
      secretStore: makeSecretStore(options.settings),
      env: options.env ?? {},
      cwd: "/repo",
    },
    factories,
  );

  return { calls, process, server, capture, runtime, bot, platform };
}

describe("assembleRuntime", () => {
  it("stays inert and prefers CLI when config forces cli over live telegram settings", async () => {
    const { calls, process, runtime, platform } = await makeHarness({
      config: makeConfig({ transport: "cli", telegramToken: "config-token" }),
      settings: { telegram: { token: "live-token", allowedChats: ["42"] } },
    });

    expect(runtime.transports.map((transport) => transport.name)).toEqual(["cli"]);
    expect(calls).not.toContain("bot.start");
    expect(process.count("SIGINT")).toBe(0);
    expect(process.count("SIGTERM")).toBe(0);
    expect(calls).not.toContain("web.app");
    expect(platform.env.PIBOT_WEB).toBeUndefined();
  });

  it("selects telegram from encrypted settings fallback when transport is telegram", async () => {
    const { runtime } = await makeHarness({
      config: makeConfig({ transport: "telegram", telegramToken: undefined, allowedChats: [] }),
      settings: { telegram: { token: "live-token", allowedChats: ["111", "222"] } },
    });

    expect(runtime.transports).toMatchObject([{ name: "telegram", token: "live-token", allowedChats: ["111", "222"] }]);
  });

  it("rejects an invalid web port and propagates unavailable model runtime", async () => {
    await expect(makeHarness({ config: makeConfig({ webPort: 70_000 }) })).rejects.toThrow("webPort");
    await expect(
      makeHarness({ factories: { createModelRuntime: async () => { throw new Error("model runtime unavailable"); } } }),
    ).rejects.toThrow("model runtime unavailable");
  });
});

describe("startRuntime", () => {
  it("starts in order, binds loopback web with auth plumbing, then enables live telegram and sub-bots", async () => {
    const { calls, process, runtime, platform, capture } = await makeHarness({
      config: makeConfig({ transport: "cli", webToken: "admin-token", webRpId: "bot.local", webPort: 8123 }),
      env: { PIBOT_WEB: "1" },
      settings: {
        telegram: {
          token: "live-token",
          allowedChats: ["42"],
          subBots: { writer: { token: "writer-token" }, coach: { token: "coach-token" } },
        },
      },
    });

    await startRuntime(runtime, platform);

    expect(calls).toEqual(expect.arrayContaining([
      "bot.start",
      "scheduler.rearm",
      "web.app",
      "serve:127.0.0.1:8123",
      "server.addListener:error",
      "bot.enableTelegram:live-token",
      "bot.attachSubBot:writer:writer-token",
      "bot.attachSubBot:coach:coach-token",
      "on:SIGINT",
      "on:SIGTERM",
    ]));
    expect(calls.indexOf("bot.start")).toBeLessThan(calls.indexOf("scheduler.rearm"));
    expect(calls.indexOf("scheduler.rearm")).toBeLessThan(calls.indexOf("web.app"));
    expect(calls.indexOf("web.app")).toBeLessThan(calls.indexOf("bot.enableTelegram:live-token"));
    expect(capture.webArgs).toMatchObject({ webToken: "admin-token", webRpId: "bot.local", webPort: 8123, dataDir: "/tmp/pibot-test-data" });
    expect(process.count("SIGINT")).toBe(1);
    expect(process.count("SIGTERM")).toBe(1);
  });

  it("skips web startup when PIBOT_WEB is disabled", async () => {
    const { calls, runtime, platform } = await makeHarness({ env: { PIBOT_WEB: "0" } });

    await startRuntime(runtime, platform);

    expect(calls).not.toContain("web.app");
    expect(calls.find((entry) => entry.startsWith("serve:"))).toBeUndefined();
  });

  it("propagates bot.start failure without leaking listeners", async () => {
    const { process, runtime, platform, bot } = await makeHarness();
    process.seed("SIGINT", () => {});
    process.seed("SIGTERM", () => {});
    const foreignSigInt = process.getListeners("SIGINT")[0];
    const foreignSigTerm = process.getListeners("SIGTERM")[0];
    vi.mocked(bot.start).mockRejectedValueOnce(new Error("boom"));

    await expect(startRuntime(runtime, platform)).rejects.toThrow("boom");
    expect(process.getListeners("SIGINT")).toContain(foreignSigInt);
    expect(process.getListeners("SIGTERM")).toContain(foreignSigTerm);
  });

  it("shuts down once and removes only its own handlers", async () => {
    const { calls, process, server, runtime, platform } = await makeHarness({ env: { PIBOT_WEB: "1" } });
    process.seed("SIGINT", () => {});
    process.seed("SIGTERM", () => {});

    const handle = await startRuntime(runtime, platform);
    expect(process.count("SIGINT")).toBe(2);
    expect(process.count("SIGTERM")).toBe(2);

    await handle.shutdown();
    await handle.shutdown();

    expect(calls.filter((entry) => entry === "scheduler.stop")).toHaveLength(1);
    expect(calls.filter((entry) => entry === "bot.stop")).toHaveLength(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(process.count("SIGINT")).toBe(1);
    expect(process.count("SIGTERM")).toBe(1);
  });

  it("shutdown awaits a delayed server.close callback before process.exit(0) and preserves foreign listeners", async () => {
    const { process, server, runtime, platform } = await makeHarness({ env: { PIBOT_WEB: "1" } });
    const foreignSigInt = () => {};
    const foreignSigTerm = () => {};
    process.seed("SIGINT", foreignSigInt);
    process.seed("SIGTERM", foreignSigTerm);

    let resolveClose: (() => void) | null = null;
    const closeSteps: string[] = [];
    (server as any).close = vi.fn((cb?: () => void) => {
      closeSteps.push("close-invoked");
      if (cb) resolveClose = cb;
    });

    const exitCodes: number[] = [];
    process.exit = ((code: number) => {
      exitCodes.push(code);
    }) as any;

    const handle = await startRuntime(runtime, platform);
    expect(process.count("SIGINT")).toBe(2);
    expect(process.count("SIGTERM")).toBe(2);

    const owned = process.getListeners("SIGINT")[process.getListeners("SIGINT").length - 1];
    expect(owned).not.toBe(foreignSigInt);

    // Emit the owned signal handler without mutating real process.
    owned!();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Delayed close callback not yet resolved: exit must not have fired.
    expect(exitCodes).not.toContain(0);
    expect(closeSteps).toContain("close-invoked");
    // Foreign listener must survive owned-handler removal.
    expect(process.getListeners("SIGINT")).toContain(foreignSigInt);
    expect(process.getListeners("SIGTERM")).toContain(foreignSigTerm);

    // Resolve the delayed close callback; only now may exit(0) run.
    resolveClose!();
    await handle.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitCodes).toContain(0);
  });

  it("scheduler.stop throwing synchronously is idempotent and still attempts bot.stop and delayed server.close best-effort", async () => {
    const { calls, process, server, runtime, platform, bot } = await makeHarness({ env: { PIBOT_WEB: "1" } });
    process.seed("SIGINT", () => {});
    process.seed("SIGTERM", () => {});

    const schedulerStopCalls: string[] = [];
    (runtime.scheduler.stop as any) = vi.fn(() => {
      schedulerStopCalls.push("stop");
      throw new Error("scheduler stop threw");
    });

    let resolveClose: (() => void) | null = null;
    (server as any).close = vi.fn((cb?: () => void) => {
      if (cb) resolveClose = cb;
    });

    const handle = await startRuntime(runtime, platform);

    const first = handle.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    // stop attempted exactly once so far; idempotency established before cleanup.
    expect(schedulerStopCalls).toHaveLength(1);
    // best-effort: bot.stop and server.close still attempted despite scheduler.stop throwing.
    expect(calls).toContain("bot.stop");
    expect(server.close).toHaveBeenCalledTimes(1);

    // Repeated shutdown returns the same cleanup and does not retry scheduler.stop.
    const second = handle.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    expect(schedulerStopCalls).toHaveLength(1);
    expect(second).toBe(first);

    resolveClose!();
    await first;
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(calls.filter((entry) => entry === "bot.stop")).toHaveLength(1);
  });

  it("preserves the original startup error and still awaits bot.stop and delayed server.close during cleanup", async () => {
    const { calls, process, server, runtime, platform, bot } = await makeHarness({
      config: makeConfig({ transport: "cli", webToken: "t", webRpId: "r", webPort: 9001 }),
      env: { PIBOT_WEB: "1" },
      settings: { telegram: { token: "live-token", allowedChats: ["42"] } },
    });
    process.seed("SIGINT", () => {});
    process.seed("SIGTERM", () => {});

    let resolveClose: (() => void) | null = null;
    (server as any).close = vi.fn((cb?: () => void) => {
      if (cb) resolveClose = cb;
    });

    vi.mocked(bot.enableTelegram).mockRejectedValueOnce(new Error("telegram original boom"));
    (runtime.scheduler.stop as any) = vi.fn(() => {
      throw new Error("scheduler stop threw");
    });

    let settled = false;
    const outcome = startRuntime(runtime, platform).then(
      () => ({ error: undefined }),
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    // Let cleanup advance while the delayed close callback remains unresolved.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(calls).toContain("bot.stop");
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(resolveClose).not.toBeNull();

    resolveClose!();
    const result = await outcome;
    expect(settled).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("telegram original boom");
  });
});
