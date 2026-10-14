import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The compaction guard has to exist for every agent, including ones created before
 * it did — so it is host wiring, not a manifest capability. These tests pin that:
 * a session built by AgentManager carries the auto-compact extension even though no
 * agent.json mentions it.
 */

const { captured, sessionStub } = vi.hoisted(() => ({
  captured: { loaderOpts: undefined as unknown },
  sessionStub: { prompts: [] as string[] },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getAgentDir: () => path.join(os.tmpdir(), "pibot-agent-dir-stub"),
    DefaultResourceLoader: class {
      constructor(opts: unknown) {
        captured.loaderOpts = opts;
      }
      async reload() {}
    },
    SessionManager: {
      open: vi.fn(() => ({})),
      create: vi.fn(() => ({})),
    },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    createAgentSession: vi.fn(async () => ({
      session: {
        sessionFile: undefined,
        prompt: async (text: string) => {
          sessionStub.prompts.push(text);
        },
        dispose() {},
        agent: { state: { messages: [] } },
      },
      modelFallbackMessage: undefined,
    })),
  };
});

const { AgentManager } = await import("./agent-manager.js");

const schedulerStub = { register: vi.fn() } as never;

describe("AgentManager host wiring", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-am-autocompact-"));
    sessionStub.prompts.length = 0;
    captured.loaderOpts = undefined;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives every session the auto-compact extension, capability list or not", async () => {
    const mgr = new AgentManager(dir, { getModels: () => [] } as never, undefined, undefined, dir);
    mgr.createAgent("alpha");
    await mgr.discover();
    // alpha's manifest does not mention compaction anywhere
    expect(fs.readFileSync(path.join(dir, "alpha", "agent.json"), "utf8")).not.toContain("auto-compact");

    await mgr.getOrCreateSession("alpha", "telegram:1", { transport: "telegram", chatId: "1" }, schedulerStub);

    const opts = captured.loaderOpts as { extensionFactories?: Array<{ name?: string }> };
    const names = (opts.extensionFactories ?? []).map((extension) => extension?.name).filter(Boolean);
    expect(names).toContain("auto-compact");
  });

  it("never loads the owner's global pi extensions into daemon agents", async () => {
    // A global extension registering a same-named tool (e.g. an interactive ask_user)
    // would shadow pibot's own and silently reroute questions away from the chat.
    const mgr = new AgentManager(dir, { getModels: () => [] } as never, undefined, undefined, dir);
    mgr.createAgent("alpha");
    await mgr.discover();
    await mgr.getOrCreateSession("alpha", "telegram:1", { transport: "telegram", chatId: "1" }, schedulerStub);

    const opts = captured.loaderOpts as { noExtensions?: boolean; additionalExtensionPaths?: unknown; extensionFactories?: Array<{ name?: string }> };
    expect(opts.noExtensions).toBe(true);
    // per-agent private plugins and host extensions still load
    expect(Array.isArray(opts.additionalExtensionPaths)).toBe(true);
    expect((opts.extensionFactories ?? []).map((extension) => extension?.name)).toContain("auto-compact");
  });

  it("logs compaction decisions to the agent's own event log", async () => {
    const mgr = new AgentManager(dir, { getModels: () => [] } as never, undefined, undefined, dir);
    mgr.createAgent("alpha");
    await mgr.discover();
    await mgr.getOrCreateSession("alpha", "telegram:1", { transport: "telegram", chatId: "1" }, schedulerStub);

    const opts = captured.loaderOpts as {
      extensionFactories: Array<{ name?: string; factory: (pi: unknown) => void }>;
    };
    const extension = opts.extensionFactories.find((entry) => entry.name === "auto-compact")!;
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    extension.factory({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
        return () => {};
      },
      sendUserMessage: () => {},
    });

    const compactions: unknown[] = [];
    const ctx = {
      getContextUsage: () => ({ tokens: 140000, contextWindow: 163840, percent: 85 }),
      isIdle: () => false,
      compact: (options: unknown) => compactions.push(options),
    };
    handlers.get("turn_end")!({ turnIndex: 1, message: {}, toolResults: [{}] }, ctx);

    expect(compactions).toHaveLength(1);
    const log = fs.readFileSync(path.join(dir, "alpha", "state", "events.jsonl"), "utf8");
    expect(log).toContain("compaction:");
    expect(log).toContain("compacting between tool batches");
  });
});
