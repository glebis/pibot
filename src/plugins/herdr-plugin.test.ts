import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { deriveLabel, herdrPlugin, resolveWorkspaceId, type HerdrExecFn } from "./herdr-plugin.js";

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

const TAB_CREATE_JSON = JSON.stringify({
  result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } },
});
const WORKSPACES_JSON = JSON.stringify({
  result: { workspaces: [{ workspace_id: "w1", label: "tax" }, { workspace_id: "w5", label: "cenno" }] },
});
const PANES_JSON = JSON.stringify({
  result: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", focused: false }, { pane_id: "w5:p6", workspace_id: "w5", focused: true }] },
});

/** Scripted runner: maps a stable prefix of "herdr args…" → response */
function fakeHerdr(responses: Record<string, { stdout?: string; fail?: boolean }>): { exec: HerdrExecFn; calls: string[] } {
  const calls: string[] = [];
  const exec: HerdrExecFn = async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    calls.push(key);
    const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
    if (!hit) return { stdout: "", stderr: "" };
    if (hit[1].fail) {
      const e = new Error(`Command failed: ${key}`) as Error & { stdout: string; stderr: string };
      e.stdout = "";
      e.stderr = "boom";
      throw e;
    }
    return { stdout: hit[1].stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

const noSleep = async () => undefined;

function makePlugin(exec: HerdrExecFn, env: NodeJS.ProcessEnv = {}) {
  return herdrPlugin({ exec, env, settleMs: 0, sleep: noSleep });
}

describe("herdr plugin", () => {
  let tmp: string;
  let tools: Map<string, Tool>;

  function setup(exec: HerdrExecFn, env: NodeJS.ProcessEnv = {}) {
    const { pi, tools: t } = captureTools();
    factoryOf(makePlugin(exec, env))(pi);
    tools = t;
    return tools;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-herdr-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("registers herdr_dispatch, herdr_read, herdr_wait", () => {
    setup(fakeHerdr({}).exec);
    expect([...tools.keys()].sort()).toEqual(["herdr_dispatch", "herdr_read", "herdr_wait"]);
  });

  it("rejects unknown agents and conflicting flags without touching herdr", async () => {
    const { exec, calls } = fakeHerdr({});
    setup(exec);
    const bad = await tools.get("herdr_dispatch")!.execute("t1", { brief: "x", agent: "rm -rf /" });
    expect(bad.content[0].text).toContain("ERROR");
    const conflict = await tools.get("herdr_dispatch")!.execute("t1", { brief: "x", detach: true, close_when_done: true });
    expect(conflict.content[0].text).toContain("mutually exclusive");
    expect(calls).toEqual([]);
  });

  it("errors with available workspaces when none can be resolved", async () => {
    const { exec } = fakeHerdr({ "herdr workspace list": { stdout: WORKSPACES_JSON } });
    setup(exec, {}); // no HERDR_ENV
    const res = await tools.get("herdr_dispatch")!.execute("t1", { brief: "do a thing" });
    expect(res.content[0].text).toContain("ERROR");
    expect(res.content[0].text).toContain("w5 (cenno)");
    expect(res.details.ok).toBe(false);
  });

  it("dispatches: creates tab, writes brief, prompts, waits, reads — leaves tab open", async () => {
    const { exec, calls } = fakeHerdr({
      "herdr workspace list": { stdout: WORKSPACES_JSON },
      "herdr tab create --workspace w1": { stdout: TAB_CREATE_JSON },
      "herdr wait agent-status w1:p9": { stdout: "" },
      "herdr pane read w1:p9": { stdout: "all done, report at /tmp/out.md\n" },
    });
    setup(exec, { HERDR_ENV: "1" });
    const res = await tools.get("herdr_dispatch")!.execute("t1", { brief: "Audit /abs/path and write /tmp/out.md", workspace: "w1", timeout_seconds: 60 });
    const text = res.content[0].text as string;
    expect(res.details.ok).toBe(true);
    expect(res.details.paneId).toBe("w1:p9");
    expect(res.details.tabId).toBe("w1:t9");
    expect(text).toContain("finished in tab `w1:t9`");
    expect(text).toContain("report at /tmp/out.md");

    // tab create is no-focus; agent TUI starts in the pane; brief sent as a file; Enter submitted
    expect(calls.some((c) => c.startsWith("herdr tab create --workspace w1 --label audit-abs-path") && c.endsWith("--no-focus"))).toBe(true);
    expect(calls.some((c) => c === "herdr pane run w1:p9 claude")).toBe(true);
    const briefCall = calls.find((c) => c.startsWith("herdr pane run w1:p9 Read "));
    expect(briefCall).toMatch(/Read (\S+) and carry out exactly what it specifies/);
    const briefPath = briefCall!.split(" ")[5];
    const briefPathFromDetails = res.details.briefPath as string;
    expect(briefPathFromDetails).toBe(briefPath);
    expect(fs.readFileSync(briefPathFromDetails, "utf8")).toContain("/tmp/out.md");
    expect(calls.some((c) => c === "herdr pane send-keys w1:p9 Enter")).toBe(true);
    // wait uses milliseconds
    expect(calls.some((c) => c === "herdr wait agent-status w1:p9 --status done --timeout 60000")).toBe(true);
    // tab left open → brief file kept so the subagent can re-read it
    expect(fs.existsSync(briefPathFromDetails)).toBe(true);
    fs.rmSync(briefPathFromDetails, { force: true });
  });

  it("close_when_done closes the tab and removes the brief", async () => {
    const { exec, calls } = fakeHerdr({
      "herdr workspace list": { stdout: WORKSPACES_JSON },
      "herdr tab create --workspace w1": { stdout: TAB_CREATE_JSON },
      "herdr wait agent-status w1:p9": { stdout: "" },
      "herdr pane read w1:p9": { stdout: "done\n" },
    });
    setup(exec, {});
    const res = await tools.get("herdr_dispatch")!.execute("t1", { brief: "x", workspace: "w1", close_when_done: true });
    expect(res.content[0].text).toContain("closed");
    expect(calls.some((c) => c === "herdr tab close w1:t9")).toBe(true);
    expect(fs.existsSync(res.details.briefPath as string)).toBe(false);
  });

  it("detach returns ids immediately without waiting", async () => {
    const { exec, calls } = fakeHerdr({
      "herdr workspace list": { stdout: WORKSPACES_JSON },
      "herdr tab create --workspace w1": { stdout: TAB_CREATE_JSON },
    });
    setup(exec, {});
    const res = await tools.get("herdr_dispatch")!.execute("t1", { brief: "long job", workspace: "w1", detach: true });
    expect(res.content[0].text).toContain("detached");
    expect(res.content[0].text).toContain("herdr_wait");
    expect(calls.some((c) => c.startsWith("herdr wait"))).toBe(false);
    fs.rmSync(res.details.briefPath as string, { force: true });
  });

  it("on a mid-loop failure closes the tab and cleans the brief", async () => {
    const { exec, calls } = fakeHerdr({
      "herdr workspace list": { stdout: WORKSPACES_JSON },
      "herdr tab create --workspace w1": { stdout: TAB_CREATE_JSON },
      "herdr pane run w1:p9 claude": { fail: true },
    });
    setup(exec, {});
    const res = await tools.get("herdr_dispatch")!.execute("t1", { brief: "x", workspace: "w1" });
    expect(res.content[0].text).toContain("ERROR");
    expect(calls.some((c) => c === "herdr tab close w1:t9")).toBe(true);
    expect(fs.existsSync(res.details.briefPath as string)).toBe(false);
  });

  it("fails fast on a first-run trust dialog instead of feeding it the brief", async () => {
    const { exec, calls } = fakeHerdr({
      "herdr workspace list": { stdout: WORKSPACES_JSON },
      "herdr tab create --workspace w1": { stdout: TAB_CREATE_JSON },
      "herdr pane read w1:p9 --source recent-unwrapped --lines 30": { stdout: "❯ [✔] browsermcp\n  3 new MCP servers found in this project" },
    });
    setup(exec, {});
    const res = await tools.get("herdr_dispatch")!.execute("t1", { brief: "x", workspace: "w1", timeout_seconds: 5 });
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toContain("trust/onboarding dialog");
    expect(res.content[0].text).toContain("left open");
    expect(calls.some((c) => c.includes("Read "))).toBe(false);
    expect(calls.some((c) => c.startsWith("herdr wait"))).toBe(false);
    expect(calls.some((c) => c === "herdr tab close w1:t9")).toBe(false);
    fs.rmSync(res.details.briefPath as string, { force: true });
  });

  it("reports timeout and leaves the tab open", async () => {
    const { exec } = fakeHerdr({
      "herdr workspace list": { stdout: WORKSPACES_JSON },
      "herdr tab create --workspace w1": { stdout: TAB_CREATE_JSON },
      "herdr wait agent-status w1:p9": { fail: true }, // nonzero exit = wait timeout
      "herdr pane read w1:p9": { stdout: "still working…" },
    });
    setup(exec, {});
    const res = await tools.get("herdr_dispatch")!.execute("t1", { brief: "x", workspace: "w1", timeout_seconds: 5 });
    expect(res.details.timedOut).toBe(true);
    expect(res.content[0].text).toContain("did not reach `done` within 5s");
    expect(res.content[0].text).toContain("left open");
    fs.rmSync(res.details.briefPath as string, { force: true });
  });

  it("resolves workspace by exact label", async () => {
    const { exec, calls } = fakeHerdr({
      "herdr workspace list": { stdout: WORKSPACES_JSON },
      "herdr tab create --workspace w5": { stdout: TAB_CREATE_JSON },
      "herdr wait agent-status w1:p9": { stdout: "" },
      "herdr pane read w1:p9": { stdout: "ok" },
    });
    setup(exec, {});
    await tools.get("herdr_dispatch")!.execute("t1", { brief: "x", workspace: "cenno", detach: true });
    expect(calls.some((c) => c.startsWith("herdr tab create --workspace w5 "))).toBe(true);
  });

  it("resolveWorkspaceId uses the focused pane when inside herdr", async () => {
    const { exec } = fakeHerdr({ "herdr pane list": { stdout: PANES_JSON } });
    const inside = await resolveWorkspaceId({ bin: "herdr", exec, env: { HERDR_ENV: "1" }, settleMs: 0, sleep: noSleep });
    expect(inside).toBe("w5");
    const outside = await resolveWorkspaceId({ bin: "herdr", exec, env: {}, settleMs: 0, sleep: noSleep });
    expect(outside).toBeUndefined();
  });

  it("resolveWorkspaceId falls back to PIBOT_HERDR_WORKSPACE (id or label)", async () => {
    const { exec } = fakeHerdr({ "herdr workspace list": { stdout: WORKSPACES_JSON } });
    const deps = { bin: "herdr", exec, env: {}, settleMs: 0, sleep: noSleep };
    expect(await resolveWorkspaceId(deps, "")).toBeUndefined();
    expect(await resolveWorkspaceId({ ...deps, env: { PIBOT_HERDR_WORKSPACE: "cenno" } })).toBe("w5");
    expect(await resolveWorkspaceId({ ...deps, env: { PIBOT_HERDR_WORKSPACE: "w1" } })).toBe("w1");
    expect(await resolveWorkspaceId({ ...deps, env: { PIBOT_HERDR_WORKSPACE: "nope" } })).toBeUndefined();
  });

  it("herdr_read reads a pane and herdr_wait routes to wait output / agent-status", async () => {
    const { exec, calls } = fakeHerdr({
      "herdr pane read w1:p9 --source recent-unwrapped --lines 10": { stdout: "line1\nline2" },
      "herdr wait output w1:p9 --match ready": { stdout: "" },
      "herdr wait agent-status w1:p9 --status done --timeout 5000": { stdout: "" },
    });
    setup(exec, {});
    const read = await tools.get("herdr_read")!.execute("t1", { pane: "w1:p9", lines: 10 });
    expect(read.content[0].text).toContain("line1");

    const waitMatch = await tools.get("herdr_wait")!.execute("t1", { pane: "w1:p9", match: "ready", timeout_seconds: 5 });
    expect(waitMatch.details.ok).toBe(true);

    const waitStatus = await tools.get("herdr_wait")!.execute("t1", { pane: "w1:p9", status: "done", timeout_seconds: 5 });
    expect(waitStatus.details.ok).toBe(true);
    expect(calls.some((c) => c.includes("--status done --timeout 5000"))).toBe(true);
  });

  it("herdr_wait requires a status or match and reports timeouts", async () => {
    const { exec } = fakeHerdr({ "herdr wait agent-status w1:p9": { fail: true } });
    setup(exec, {});
    const empty = await tools.get("herdr_wait")!.execute("t1", { pane: "w1:p9" });
    expect(empty.content[0].text).toContain("ERROR");

    const timeout = await tools.get("herdr_wait")!.execute("t1", { pane: "w1:p9", status: "done", timeout_seconds: 1 });
    expect(timeout.details.timedOut).toBe(true);
  });

  it("deriveLabel slugifies the brief and honors explicit labels", () => {
    expect(deriveLabel("Fix the login bug in auth module")).toBe("fix-the-login");
    expect(deriveLabel("", "custom")).toBe("custom");
    expect(deriveLabel("!!!")).toBe("task");
  });
});