import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { commitmentPlugin } from "./commitment-plugin.js";
import type { Commitment, ProactiveStore } from "../core/proactive-store.js";

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };

function captureTools(ext: InlineExtension): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as Tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  const factory = typeof ext === "function" ? ext : ext.factory;
  factory(pi);
  return tools;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-cmplug-"));
}

describe("commitment plugin", () => {
  let dir: string;
  beforeEach(() => (dir = tmpDir()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function makePlugin(proposed?: Commitment) {
    const deliverToAgent = vi.fn(async () => true);
    const engine = {
      captureInferred: vi.fn(() => ({ commitment: proposed, reply: 'Commitment proposed 📌 "book the dentist" (id cmABC12) — awaiting your confirmation in the chat.' })),
      listCommitments: vi.fn(() => [
        { id: "cmABC12", text: "book the dentist", status: "active", dueAt: Date.now() + 86_400e3, origin: "explicit" },
      ]),
      cancelCommitment: vi.fn(() => true),
    };
    const ext = commitmentPlugin({
      agentId: "assistant",
      chat: { transport: "test", chatId: "c1" },
      engine: engine as never,
    });
    return { tools: captureTools(ext), engine, deliverToAgent };
  }

  it("registers the capture/list/cancel tools", () => {
    const { tools } = makePlugin();
    for (const name of ["commitment_capture", "commitment_list", "commitment_cancel"]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it("commitment_capture proposes and states the confirmation is pending", async () => {
    const { tools, engine } = makePlugin();
    const res = await tools.get("commitment_capture")!.execute("id", { text: "book the dentist", deadline: "in 5d" });
    expect(res.content[0].text).toMatch(/awaiting your confirmation/i);
    expect(res.content[0].text).toContain("cmABC12");
    expect(engine.captureInferred).toHaveBeenCalledWith("assistant", { transport: "test", chatId: "c1" }, "book the dentist", expect.any(Number));
  });

  it("commitment_capture reports the error when the deadline is unparseable", async () => {
    const { tools } = makePlugin();
    const res = await tools.get("commitment_capture")!.execute("id", { text: "x", deadline: "sometime" });
    expect(res.content[0].text).toMatch(/ERROR/i);
  });

  it("commitment_list renders status + origin", async () => {
    const { tools } = makePlugin();
    const res = await tools.get("commitment_list")!.execute("id", {});
    expect(res.content[0].text).toContain("cmABC12");
    expect(res.content[0].text).toContain("explicit");
    expect(res.content[0].text).toContain("active");
  });

  it("commitment_cancel removes a tracked commitment", async () => {
    const { tools, engine } = makePlugin();
    const res = await tools.get("commitment_cancel")!.execute("id", { id: "cmABC12" });
    expect(res.content[0].text).toContain("cmABC12");
    expect(engine.cancelCommitment).toHaveBeenCalledWith("cmABC12");
  });
});