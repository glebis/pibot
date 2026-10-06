import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  autoCompactPlugin,
  readAutoCompactConfig,
  DEFAULT_AUTO_COMPACT,
} from "./auto-compact-plugin.js";

/**
 * The incident these tests encode (2026-10-05): mentalhealthtech grew a single
 * run to ~512k tokens because pibot declares glm-5.3-flash:cloud with a 1M
 * window, so Pi's native trigger (window - 16384) sat at ~1.03M. The cascade
 * then switched to a peer that really accepts 163k and every call failed.
 */

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

interface CtxState {
  tokens: number | null;
  contextWindow: number;
  idle: boolean;
  /** every compact() call, with its options */
  compactions: Array<{ onComplete?: (r: unknown) => void; onError?: (e: Error) => void }>;
}

function makeCtx(state: CtxState): ExtensionContext {
  return {
    getContextUsage: () => ({
      tokens: state.tokens,
      contextWindow: state.contextWindow,
      percent: state.tokens === null ? null : (state.tokens / state.contextWindow) * 100,
    }),
    isIdle: () => state.idle,
    compact: (options: { onComplete?: (r: unknown) => void; onError?: (e: Error) => void } = {}) => {
      state.compactions.push(options);
    },
    model: { provider: "ollama", id: "glm-5.3-flash:cloud", contextWindow: state.contextWindow },
  } as unknown as ExtensionContext;
}

interface Harness {
  handlers: Map<string, Handler[]>;
  sent: string[];
  logs: string[];
  state: CtxState;
  /** settle the most recent compact() call as a success */
  completeCompaction(): void;
  /** settle the most recent compact() call with an error */
  failCompaction(message: string): void;
}

function harness(overrides: Partial<CtxState> = {}): Harness {
  const handlers = new Map<string, Handler[]>();
  const sent: string[] = [];
  const logs: string[] = [];
  const state: CtxState = { tokens: 0, contextWindow: 163840, idle: true, compactions: [], ...overrides };
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    sendUserMessage: (text: string) => {
      sent.push(text);
    },
  } as unknown as ExtensionAPI;
  factoryOf(
    autoCompactPlugin({ dataDir: tmpDir(), log: (summary) => logs.push(summary) }),
  )(pi);
  return {
    handlers,
    sent,
    logs,
    state,
    // compaction aborts the running turn, so the agent is idle once it settles
    completeCompaction: () => {
      const call = state.compactions.at(-1);
      state.idle = true;
      call?.onComplete?.({});
    },
    failCompaction: (message) => state.compactions.at(-1)?.onError?.(new Error(message)),
  };
}

function fire(h: Harness, name: string, event: unknown): unknown {
  const list = h.handlers.get(name) ?? [];
  return list[list.length - 1]?.(event, makeCtx(h.state));
}

let dir: string;
function tmpDir(): string {
  return dir;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-autocompact-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const OVER = { tokens: 140000, contextWindow: 163840 }; // 85% — over the 78% default
const UNDER = { tokens: 100000, contextWindow: 163840 }; // 61%

describe("auto-compact config", () => {
  it("defaults when the file is missing", () => {
    expect(readAutoCompactConfig(dir)).toEqual(DEFAULT_AUTO_COMPACT);
  });

  it("clamps the threshold into [30, 98] and ignores garbage", () => {
    fs.writeFileSync(path.join(dir, "auto-compact.json"), JSON.stringify({ threshold: 5 }));
    expect(readAutoCompactConfig(dir).threshold).toBe(30);
    fs.writeFileSync(path.join(dir, "auto-compact.json"), JSON.stringify({ threshold: 120 }));
    expect(readAutoCompactConfig(dir).threshold).toBe(98);
    fs.writeFileSync(path.join(dir, "auto-compact.json"), "{not json");
    expect(readAutoCompactConfig(dir)).toEqual(DEFAULT_AUTO_COMPACT);
  });

  it("honours enabled: false", () => {
    fs.writeFileSync(path.join(dir, "auto-compact.json"), JSON.stringify({ enabled: false }));
    expect(readAutoCompactConfig(dir).enabled).toBe(false);
  });
});

describe("idle prompt preflight (input event)", () => {
  it("stays quiet while the context is under the threshold", async () => {
    const h = harness(UNDER);
    const result = await fire(h, "input", { text: "hello", streamingBehavior: undefined });
    expect(result).toEqual({ action: "continue" });
    expect(h.state.compactions).toHaveLength(0);
  });

  it("skips prompts queued into a running agent — compact() would abort that run", async () => {
    const h = harness(OVER);
    const result = await fire(h, "input", { text: "hello", streamingBehavior: "followUp" });
    expect(result).toEqual({ action: "continue" });
    expect(h.state.compactions).toHaveLength(0);
  });

  it("compacts and waits before an idle prompt that crosses the threshold", async () => {
    const h = harness(OVER);
    const ctx = makeCtx(h.state);
    const handler = h.handlers.get("input")!.at(-1)!;
    let settled = false;
    const promise = Promise.resolve(handler({ text: "hello", streamingBehavior: undefined }, ctx)).then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    expect(h.state.compactions).toHaveLength(1); // started before the prompt is let through
    expect(settled).toBe(false); // and the prompt is held until it settles
    h.completeCompaction();
    expect(await promise).toEqual({ action: "continue" });
    expect(h.logs.some((line) => line.includes("compaction:"))).toBe(true);
  });

  it("counts the incoming message, not only the tokens already in the session", async () => {
    // 127k tokens is just under the 78% trigger for a 163840 window; a long prompt pushes it over
    const h = harness({ tokens: 127000, contextWindow: 163840 });
    const handler = h.handlers.get("input")!.at(-1)!;
    const promise = Promise.resolve(handler({ text: "x".repeat(8000), streamingBehavior: undefined }, makeCtx(h.state)));
    await Promise.resolve();
    expect(h.state.compactions).toHaveLength(1);
    h.completeCompaction();
    await promise;
  });

  it("never drops the owner's prompt when compaction fails hard", async () => {
    const h = harness(OVER);
    const handler = h.handlers.get("input")!.at(-1)!;
    const promise = Promise.resolve(handler({ text: "hi", streamingBehavior: undefined }, makeCtx(h.state)));
    await Promise.resolve();
    h.failCompaction("database is locked");
    // "handled" would swallow the message and leave the owner with silence
    expect(await promise).toEqual({ action: "continue" });
    expect(h.logs.some((line) => line.includes("database is locked"))).toBe(true);
  });

  it("treats 'Nothing to compact' as benign", async () => {
    const h = harness(OVER);
    const handler = h.handlers.get("input")!.at(-1)!;
    const promise = Promise.resolve(handler({ text: "hi", streamingBehavior: undefined }, makeCtx(h.state)));
    await Promise.resolve();
    h.failCompaction("Nothing to compact");
    expect(await promise).toEqual({ action: "continue" });
    expect(h.logs.some((line) => line.toLowerCase().includes("failed"))).toBe(false);
  });

  it("does nothing at all when disabled", async () => {
    fs.writeFileSync(path.join(dir, "auto-compact.json"), JSON.stringify({ enabled: false }));
    const h = harness(OVER);
    expect(await fire(h, "input", { text: "hi", streamingBehavior: undefined })).toEqual({ action: "continue" });
    expect(h.state.compactions).toHaveLength(0);
  });

  it("does not compact a second time right after a preflight compaction", async () => {
    const h = harness({ ...OVER, idle: false });
    const handler = h.handlers.get("input")!.at(-1)!;
    const promise = Promise.resolve(handler({ text: "hi", streamingBehavior: undefined }, makeCtx(h.state)));
    await Promise.resolve();
    h.completeCompaction();
    await promise;

    // the run that follows is still above the line (usage has not been re-read yet)
    await fire(h, "turn_end", { turnIndex: 1, message: {}, toolResults: [{}] });
    expect(h.state.compactions).toHaveLength(1);
    expect(h.sent).toEqual([]); // and nothing was resumed: the preflight interrupted no turn
  });
});

describe("mid-run compaction between tool batches (turn_end event)", () => {
  const toolTurn = { turnIndex: 3, message: { role: "assistant" }, toolResults: [{ terminate: undefined }] };

  it("compacts once the running turn crosses the threshold and resumes it", async () => {
    const h = harness({ ...OVER, idle: false }); // mid-run: the agent is streaming
    await fire(h, "turn_end", toolTurn);
    expect(h.state.compactions).toHaveLength(1);
    h.completeCompaction();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("[compaction-resume]");
  });

  it("does not double-compact while a compaction is still in flight", async () => {
    const h = harness({ ...OVER, idle: false });
    await fire(h, "turn_end", toolTurn);
    await fire(h, "turn_end", toolTurn);
    await fire(h, "turn_end", toolTurn);
    expect(h.state.compactions).toHaveLength(1);
  });

  it("does not resume a turn that ended with a final answer", async () => {
    const h = harness({ ...OVER, idle: true });
    await fire(h, "turn_end", { turnIndex: 9, message: { role: "assistant" }, toolResults: [] });
    expect(h.state.compactions).toHaveLength(0);
    expect(h.sent).toEqual([]);
  });

  it("does not resume when the tool batch asked to terminate the run", async () => {
    const h = harness({ ...OVER, idle: true });
    await fire(h, "turn_end", { turnIndex: 4, message: {}, toolResults: [{ terminate: true }] });
    expect(h.state.compactions).toHaveLength(0);
    expect(h.sent).toEqual([]);
  });

  it("queues no resume when the compaction fails, and logs it", async () => {
    const h = harness({ ...OVER, idle: false });
    await fire(h, "turn_end", toolTurn);
    h.failCompaction("compaction already running");
    expect(h.sent).toEqual([]);
    expect(h.logs.some((line) => line.includes("compaction already running"))).toBe(true);
  });

  it("stays quiet on turn_end while the context is under the threshold", async () => {
    const h = harness({ ...UNDER, idle: false });
    await fire(h, "turn_end", toolTurn);
    expect(h.state.compactions).toHaveLength(0);
  });
});

describe("re-arming", () => {
  const toolTurn = { turnIndex: 1, message: {}, toolResults: [{}] };

  it("re-arms only after usage has fallen back under the threshold", async () => {
    const h = harness({ ...OVER, idle: false });
    await fire(h, "turn_end", toolTurn);
    h.completeCompaction();
    // still over the threshold right after compacting → stays disarmed
    await fire(h, "turn_end", toolTurn);
    expect(h.state.compactions).toHaveLength(1);

    h.state.tokens = 40000; // compaction did its job
    await fire(h, "turn_end", toolTurn);
    h.state.tokens = 150000; // ...and the context grew again
    await fire(h, "turn_end", toolTurn);
    expect(h.state.compactions).toHaveLength(2);
  });

  it("does not resume a second time for the same interrupted turn", async () => {
    const h = harness({ ...OVER, idle: false });
    await fire(h, "turn_end", toolTurn);
    h.completeCompaction();
    h.state.tokens = 40000;
    await fire(h, "turn_end", toolTurn);
    expect(h.sent).toHaveLength(1);
  });
});
