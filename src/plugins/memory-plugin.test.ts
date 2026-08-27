import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { memoryPlugin } from "./memory-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type CapturedTool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown }> };

function captureTools(): { pi: ExtensionAPI; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as CapturedTool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

describe("memory plugin", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-mem-"));
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("registers memory_save and memory_recall", () => {
    const { pi, tools } = captureTools();
    factoryOf(memoryPlugin({ agentDir }))(pi);
    expect(tools.has("memory_save")).toBe(true);
    expect(tools.has("memory_recall")).toBe(true);
  });

  it("memory_save writes a dated markdown note and reports the file", async () => {
    const { pi, tools } = captureTools();
    factoryOf(memoryPlugin({ agentDir }))(pi);
    const res = await tools.get("memory_save")!.execute("t1", { title: "Coffee preferences", content: "Oat milk, no sugar.", tags: "food" });
    const savedFile = (res.details as { file: string }).file;
    expect(savedFile).toContain(".md");
    expect(fs.existsSync(savedFile)).toBe(true);
    const body = fs.readFileSync(savedFile, "utf8");
    expect(body).toContain("title: Coffee preferences");
    expect(body).toContain("tags: [food]");
    expect(body).toContain("Oat milk, no sugar.");
  });

  it("memory_recall finds and ranks notes", async () => {
    const notes = path.join(agentDir, "memory", "notes");
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, "2026-01-01-coffee.md"), "title: Coffee\nOwner drinks oat milk lattes.\n");
    fs.writeFileSync(path.join(notes, "2026-01-02-berlin.md"), "title: Berlin\nOwner lives in Berlin, loves the lakes.\n");

    const { pi, tools } = captureTools();
    factoryOf(memoryPlugin({ agentDir }))(pi);
    const res = await tools.get("memory_recall")!.execute("t1", { query: "oat milk" });
    expect(res.content[0].text).toContain("Coffee");
    expect(res.content[0].text).toContain("oat milk");

    const none = await tools.get("memory_recall")!.execute("t1", { query: "quantum knitting" });
    expect(none.content[0].text).toContain("No memories match");
  });
});