import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { devToolsPlugin, extractVitestSummary, stagingBlockers, type ExecFn } from "./dev-tools-plugin.js";

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

/** Scripted command runner: maps "cmd args…" → response */
function fakeExec(responses: Record<string, { stdout?: string; stderr?: string } | "fail">): { exec: ExecFn; calls: string[] } {
  const calls: string[] = [];
  const exec: ExecFn = async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    calls.push(key);
    const r = Object.entries(responses).find(([k]) => key.startsWith(k));
    if (!r) return { stdout: "", stderr: "" };
    if (r[1] === "fail") {
      const e = new Error(`Command failed: ${key}`) as Error & { stdout: string; stderr: string };
      e.stdout = `${key} failed loudly`;
      e.stderr = "";
      throw e;
    }
    return { stdout: r[1].stdout ?? "", stderr: r[1].stderr ?? "" };
  };
  return { exec, calls };
}

describe("dev-tools plugin", () => {
  let repo: string;
  let agentDir: string;
  let tools: Map<string, Tool>;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-dv-repo-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-dv-agent-"));
    const { pi, tools: t } = captureTools();
    factoryOf(devToolsPlugin({ repoRoot: repo, agentDir, exec: fakeExec({}).exec }))(pi);
    tools = t;
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("registers dev_status, dev_test, dev_stage", () => {
    expect([...tools.keys()].sort()).toEqual(["dev_stage", "dev_status", "dev_test"]);
  });

  it("dev_stage refuses when the tree is clean", async () => {
    const { exec } = fakeExec({ "git status --porcelain": { stdout: "" } });
    const { pi, tools: t2 } = captureTools();
    factoryOf(devToolsPlugin({ repoRoot: repo, agentDir, exec }))(pi);
    const res = await t2.get("dev_stage")!.execute("t1", { title: "x", rationale: "y" });
    expect(res.content[0].text).toContain("Nothing to stage");
    expect(res.details.ok).toBe(false);
  });

  it("dev_stage refuses when forbidden paths changed", async () => {
    const { exec } = fakeExec({ "git status --porcelain": { stdout: " M src/core/x.ts\n M data/state.json\n" } });
    const { pi, tools: t2 } = captureTools();
    factoryOf(devToolsPlugin({ repoRoot: repo, agentDir, exec }))(pi);
    const res = await t2.get("dev_stage")!.execute("t1", { title: "x", rationale: "y" });
    expect(res.content[0].text).toContain("Refusing");
    expect(res.details.blocked).toEqual(["data/state.json"]);
    expect(res.details.ok).toBe(false);
  });

  it("dev_stage refuses when typecheck is red — never commits", async () => {
    const { exec, calls } = fakeExec({
      "git status --porcelain": { stdout: " M src/core/x.ts\n" },
      "npm run typecheck": "fail",
    });
    const { pi, tools: t2 } = captureTools();
    factoryOf(devToolsPlugin({ repoRoot: repo, agentDir, exec }))(pi);
    const res = await t2.get("dev_stage")!.execute("t1", { title: "x", rationale: "y" });
    expect(res.content[0].text).toContain("Stage refused");
    expect(res.details.ok).toBe(false);
    expect(calls.filter((c) => c.startsWith("git commit"))).toHaveLength(0);
  });

  it("dev_stage runs the full suite, commits when green, and appends the staging log", async () => {
    const { exec, calls } = fakeExec({
      "git status --porcelain": { stdout: " M src/core/x.ts\n M src/core/x.test.ts\n" },
      "npm run typecheck": { stdout: "ok" },
      "npm test": { stdout: " Test Files  10 passed (10)\n      Tests  42 passed (42)\n" },
      "git commit": { stdout: "" },
      "git rev-parse --short HEAD": { stdout: "abc1234\n" },
    });
    const { pi, tools: t2 } = captureTools();
    factoryOf(devToolsPlugin({ repoRoot: repo, agentDir, exec }))(pi);
    const res = await t2.get("dev_stage")!.execute("t1", { title: "fix: cascade retry", rationale: "double-push guard" });
    expect(res.content[0].text).toContain("abc1234");
    expect(res.details.ok).toBe(true);

    // gate actually ran: typecheck AND tests before commit
    expect(calls.some((c) => c.startsWith("npm run typecheck"))).toBe(true);
    expect(calls.some((c) => c.startsWith("npm test"))).toBe(true);
    expect(calls.find((c) => c.startsWith("git commit"))).toContain("fix: cascade retry");

    const log = fs.readFileSync(path.join(agentDir, "staging", "log.jsonl"), "utf8").trim();
    const entry = JSON.parse(log.split("\n").pop()!);
    expect(entry).toMatchObject({ commit: "abc1234", title: "fix: cascade retry", files: ["src/core/x.ts", "src/core/x.test.ts"] });
  });
});

describe("stagingBlockers", () => {
  const repo = "/repo";

  it("flags runtime state and secrets, allows source", () => {
    const blocked = stagingBlockers(repo, [".env", "data/state.json", "node_modules/x/index.js", "agents/foo/sessions/i.json"]);
    expect(blocked).toEqual([".env", "data/state.json", "node_modules/x/index.js", "agents/foo/sessions/i.json"]);
    expect(stagingBlockers(repo, ["src/core/secrets.ts", "scripts/evolve.ts", "agents/foo/AGENTS.md"])).toEqual([]);
  });

  it("flags paths outside the repo", () => {
    expect(stagingBlockers(repo, ["../elsewhere/x.ts"])).toEqual(["../elsewhere/x.ts"]);
  });
});

describe("extractVitestSummary", () => {
  it("pulls the Test Files/Tests lines", () => {
    const out = [
      " RUN  v4.1.11",
      " Test Files  25 passed (25)",
      "      Tests  210 passed (210)",
      "   Duration  3.21s",
    ].join("\n");
    expect(extractVitestSummary(out)).toContain("Test Files  25 passed");
    expect(extractVitestSummary(out)).toContain("210 passed (210)");
  });

  it("returns empty for unstructured output", () => {
    expect(extractVitestSummary("nope")).toBe("");
  });
});