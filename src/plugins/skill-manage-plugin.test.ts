import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { skillManagePlugin } from "./skill-manage-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };

function captureTools(): { pi: ExtensionAPI; tools: Map<string, Tool> } {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as Tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

describe("skill-manage plugin", () => {
  let agentDir: string;
  let tools: Map<string, Tool>;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-sm-"));
    const { pi, tools: t } = captureTools();
    factoryOf(skillManagePlugin({ agentDir, agentId: "a1" }))(pi);
    tools = t;
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("registers skill_save, skill_patch, skill_list", () => {
    expect([...tools.keys()].sort()).toEqual(["skill_list", "skill_patch", "skill_save"]);
  });

  it("skill_save writes frontmatter + body into the agent skills dir", async () => {
    const res = await tools.get("skill_save")!.execute("t1", {
      name: "weekly-review",
      description: "Use when the user wants to review the week.",
      content: "# Weekly review\n\n## Steps\n- gather\n- summarize\n",
    });
    expect(res.content[0].text).toContain("saved");
    const file = path.join(agentDir, "skills", "weekly-review", "SKILL.md");
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).toContain("name: weekly-review");
    expect(raw).toContain("description: Use when the user wants to review the week.");
  });

  it("rejects invalid names and oversize bodies", async () => {
    const bad = await tools.get("skill_save")!.execute("t1", { name: "Bad Name", description: "Use when something.", content: "x" });
    expect(bad.content[0].text).toContain("ERROR");
    const big = await tools.get("skill_save")!.execute("t1", { name: "big", description: "Use when something big.", content: "y".repeat(16_000) });
    expect(big.content[0].text).toContain("too large");
  });

  it("skill_patch applies exact find-replace", async () => {
    await tools.get("skill_save")!.execute("t1", { name: "patch-me", description: "Use when patching is tested here.", content: "alpha beta gamma" });
    const res = await tools.get("skill_patch")!.execute("t1", { name: "patch-me", find: "beta", replace: "delta" });
    expect(res.content[0].text).toContain("Patched");
    expect(fs.readFileSync(path.join(agentDir, "skills", "patch-me", "SKILL.md"), "utf8")).toContain("alpha delta gamma");
    const miss = await tools.get("skill_patch")!.execute("t1", { name: "patch-me", find: "nope", replace: "x" });
    expect(miss.content[0].text).toContain("ERROR");
  });

  it("skill_list lists saved skills with descriptions", async () => {
    await tools.get("skill_save")!.execute("t1", { name: "skill-one", description: "Use when listing works correctly.", content: "# One\n\n## Steps\n- x\n" });
    const res = await tools.get("skill_list")!.execute("t1", {});
    expect(res.content[0].text).toContain("skill-one");
    expect(res.content[0].text).toContain("Use when listing works correctly.");
  });
});