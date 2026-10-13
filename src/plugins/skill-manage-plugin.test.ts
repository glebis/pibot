import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../core/agent-manager.js";
import { EvolutionEngine } from "../core/evolution.js";
import { EventLog } from "../core/events.js";
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

  const live = (name: string) => path.join(agentDir, "skills", name, "SKILL.md");
  const staged = (name: string) => path.join(agentDir, "skills", ".staging", name, "SKILL.md");
  const seedLive = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(live(name)), { recursive: true });
    fs.writeFileSync(live(name), text);
  };

  it("skill_save stages frontmatter + body and never creates a live skill", async () => {
    const res = await tools.get("skill_save")!.execute("t1", {
      name: "weekly-review",
      description: "Use when the user wants to review the week.",
      content: "# Weekly review\n\n## Steps\n- gather\n- summarize\n",
    });
    expect(res.content[0].text).toContain("Staged for owner review");
    expect(res.content[0].text).toContain("Review changes");
    expect(fs.existsSync(live("weekly-review"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "skills", "weekly-review"))).toBe(false);
    const raw = fs.readFileSync(staged("weekly-review"), "utf8");
    expect(raw).toContain("name: weekly-review");
    expect(raw).toContain("description: Use when the user wants to review the week.");
    expect(raw).toContain("- gather");
  });

  it("rejects invalid names and oversize bodies", async () => {
    const bad = await tools.get("skill_save")!.execute("t1", { name: "Bad Name", description: "Use when something.", content: "x" });
    expect(bad.content[0].text).toContain("ERROR");
    const big = await tools.get("skill_save")!.execute("t1", { name: "big", description: "Use when something big.", content: "y".repeat(16_000) });
    expect(big.content[0].text).toContain("too large");
    expect(fs.existsSync(path.join(agentDir, "skills"))).toBe(false);
  });

  it("a multi-line description cannot smuggle extra frontmatter keys", async () => {
    await tools.get("skill_save")!.execute("t1", { name: "multi-line", description: "Use when x.\nevil: yes", content: "# a\n- b" });
    const raw = fs.readFileSync(staged("multi-line"), "utf8");
    expect(raw).not.toMatch(/^evil:/m);
  });

  it("skill_patch leaves the live file byte-identical and stages the patched copy", async () => {
    const original = "---\nname: patch-me\ndescription: Use when patching is tested here.\n---\n\nalpha beta gamma\n";
    seedLive("patch-me", original);
    const res = await tools.get("skill_patch")!.execute("t1", { name: "patch-me", find: "beta", replace: "delta" });
    expect(res.content[0].text).toContain("Staged for owner review");
    expect(fs.readFileSync(live("patch-me"), "utf8")).toBe(original);
    expect(fs.readFileSync(staged("patch-me"), "utf8")).toBe(original.replace("beta", "delta"));
    const miss = await tools.get("skill_patch")!.execute("t1", { name: "patch-me", find: "nope", replace: "x" });
    expect(miss.content[0].text).toContain("ERROR");
  });

  it("skill_patch applies on top of the staged copy when one exists", async () => {
    seedLive("stacked", "---\nname: stacked\ndescription: Use when stacking patches.\n---\n\nlive-only text\n");
    await tools.get("skill_save")!.execute("t1", { name: "stacked", description: "Use when stacking patches.", content: "# S\n- one two three\n" });
    await tools.get("skill_patch")!.execute("t1", { name: "stacked", find: "two", replace: "2" });
    const raw = fs.readFileSync(staged("stacked"), "utf8");
    expect(raw).toContain("- one 2 three");
    expect(raw).not.toContain("live-only");
    // a second patch stacks on the first staged patch
    await tools.get("skill_patch")!.execute("t1", { name: "stacked", find: "three", replace: "3" });
    expect(fs.readFileSync(staged("stacked"), "utf8")).toContain("- one 2 3");
    expect(fs.readFileSync(live("stacked"), "utf8")).toContain("live-only text");
  });

  it("skill_patch treats replacement text literally (no $& expansion) and unknown skills error", async () => {
    await tools.get("skill_save")!.execute("t1", { name: "dollar", description: "Use when dollars appear.", content: "# D\n- price" });
    await tools.get("skill_patch")!.execute("t1", { name: "dollar", find: "price", replace: "$& and $1" });
    expect(fs.readFileSync(staged("dollar"), "utf8")).toContain("- $& and $1");
    const none = await tools.get("skill_patch")!.execute("t1", { name: "ghost", find: "a", replace: "b" });
    expect(none.content[0].text).toContain('No skill "ghost"');
    expect(fs.existsSync(staged("ghost"))).toBe(false);
  });

  it("skill_list shows live and staged skills", async () => {
    seedLive("live-one", "---\nname: live-one\ndescription: Use when a live skill exists.\n---\n\n# x\n");
    await tools.get("skill_save")!.execute("t1", { name: "skill-one", description: "Use when listing works correctly.", content: "# One\n\n## Steps\n- x\n" });
    const text = (await tools.get("skill_list")!.execute("t1", {})).content[0].text;
    expect(text).toContain("- live-one — Use when a live skill exists.");
    expect(text).toContain("skill-one (staged, awaiting review)");
    expect(text).toContain("Use when listing works correctly.");
    expect(text).not.toMatch(/- live-one \(staged/);
  });

  it("refuses a symlinked .staging directory (no write through to the target)", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-sm-out-"));
    try {
      fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true });
      fs.symlinkSync(outside, path.join(agentDir, "skills", ".staging"));
      const res = await tools.get("skill_save")!.execute("t1", { name: "escape", description: "Use when escaping.", content: "# e\n- x" });
      expect(res.content[0].text).toContain("ERROR");
      expect(fs.readdirSync(outside)).toEqual([]);
      seedLive("escape", "---\nname: escape\ndescription: Use when escaping.\n---\n\nbody\n");
      const patch = await tools.get("skill_patch")!.execute("t1", { name: "escape", find: "body", replace: "x" });
      expect(patch.content[0].text).toContain("ERROR");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked staged skill directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-sm-out-"));
    try {
      fs.mkdirSync(path.join(agentDir, "skills", ".staging"), { recursive: true });
      fs.symlinkSync(outside, path.join(agentDir, "skills", ".staging", "linked"));
      const res = await tools.get("skill_save")!.execute("t1", { name: "linked", description: "Use when linking.", content: "# e\n- x" });
      expect(res.content[0].text).toContain("ERROR");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("staged output is accepted by EvolutionEngine.stagedDetail and promote", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-sm-evo-"));
    try {
      const agents = new AgentManager(dataDir, { getModels: () => [] } as never);
      agents.createAgent("assistant");
      const agentDirReal = path.join(dataDir, "assistant");
      const t = captureTools();
      factoryOf(skillManagePlugin({ agentDir: agentDirReal, agentId: "assistant" }))(t.pi);
      const engine = new EvolutionEngine({
        agents, events: new EventLog(dataDir), modelRuntime: {} as never, dataDir,
        host: { announce: vi.fn(async () => {}) }, io: {} as never,
      });
      await t.tools.get("skill_save")!.execute("t1", { name: "evo-ok", description: "Use when evolution reviews it.", content: "# Evo\n- step one\n" });
      const detail = engine.stagedDetail("assistant");
      expect(detail.map((c) => c.name)).toEqual(["evo-ok"]);
      expect(detail[0].mode).toBe("create");
      expect(detail[0].description).toBe("Use when evolution reviews it.");
      expect(engine.reviewDetails("assistant").map((c) => c.name)).toEqual(["evo-ok"]);
      expect(engine.promote("assistant", "evo-ok")).toBe(true);
      const livePath = path.join(agentDirReal, "skills", "evo-ok", "SKILL.md");
      expect(fs.readFileSync(livePath, "utf8")).toContain("- step one");
      expect(fs.existsSync(path.join(agentDirReal, "skills", ".staging", "evo-ok"))).toBe(false);

      // patch flow: live stays until promote, then the patched version replaces it (with .bak)
      await t.tools.get("skill_patch")!.execute("t2", { name: "evo-ok", find: "step one", replace: "step uno" });
      expect(fs.readFileSync(livePath, "utf8")).toContain("step one");
      expect(engine.stagedDetail("assistant")[0].mode).toBe("patch");
      expect(engine.promote("assistant", "evo-ok")).toBe(true);
      expect(fs.readFileSync(livePath, "utf8")).toContain("step uno");
      expect(fs.readFileSync(`${livePath}.bak`, "utf8")).toContain("step one");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
