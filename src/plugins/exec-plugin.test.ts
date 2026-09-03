import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { execPlugin, resolveExec, type ExecAllowEntry } from "./exec-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type CapturedTool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { ok?: boolean } }> };

function captureTools(): { pi: ExtensionAPI; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as CapturedTool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

/** Distinct fake binaries (so no allowlist entry shadows another) + a wrapper script under the agent dir. */
function makeFakeBins(agentDir: string): ExecAllowEntry[] {
  const binDir = path.join(agentDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ["fake-plain", "fake-py", "fake-osa", "fake-deny"]) {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
  fs.mkdirSync(path.join(agentDir, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "inbox", "wrapper.scpt"), "stub");
  return [
    { bin: path.join(binDir, "fake-plain") },
    { bin: path.join(binDir, "fake-py"), pin: ["/tmp/fake/pinned.py"] },
    { bin: path.join(binDir, "fake-osa"), requireScriptUnder: agentDir },
    { bin: path.join(binDir, "fake-deny"), denyArgRe: [/^--exec/] },
  ];
}

describe("exec plugin allowlist resolution", () => {
  let agentDir: string;
  let allow: ExecAllowEntry[];

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-exec-"));
    allow = makeFakeBins(agentDir);
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("allows a pinned binary and runs it without a shell", async () => {
    const r = await resolveExec([path.join(agentDir, "bin/fake-plain"), "hello", "world"], { workspace: agentDir, agentDir }, allow);
    expect(r.error).toBeUndefined();
    expect(r.argv[0]).toBe(path.join(agentDir, "bin/fake-plain"));
    expect(r.cwd).toBe(agentDir);
  });

  it("refuses commands not on the allowlist", async () => {
    const r = await resolveExec(["/bin/ls", "/"], { workspace: agentDir, agentDir }, allow);
    expect(r.error).toMatch(/not on this agent's exec allowlist/);
  });

  it("refuses empty and malformed argv", async () => {
    expect((await resolveExec([], { workspace: agentDir, agentDir }, allow)).error).toBeTruthy();
    expect((await resolveExec([path.join(agentDir, "bin/fake-plain"), 3 as unknown as string], { workspace: agentDir, agentDir }, allow)).error).toMatch(/strings/);
  });

  it("refuses shell metacharacters — argv runs without a shell", async () => {
    const r = await resolveExec([path.join(agentDir, "bin/fake-plain"), "a && /bin/ls"], { workspace: agentDir, agentDir }, allow);
    expect(r.error).toMatch(/shell metacharacters/);
  });

  it("enforces pin: python3-style pinned script must match exactly", async () => {
    const py = path.join(agentDir, "bin/fake-py");
    const ok = await resolveExec([py, "/tmp/fake/pinned.py", "--flag", "x"], { workspace: agentDir, agentDir }, allow);
    expect(ok.error).toBeUndefined();
    const bad = await resolveExec([py, "/tmp/fake/other.py"], { workspace: agentDir, agentDir }, allow);
    expect(bad.error).toMatch(/pinned/);
    const missing = await resolveExec([py], { workspace: agentDir, agentDir }, allow);
    expect(missing.error).toMatch(/pinned/);
  });

  it("enforces requireScriptUnder: script files must live under the agent dir", async () => {
    const osa = path.join(agentDir, "bin/fake-osa");
    const ok = await resolveExec([osa, path.join(agentDir, "inbox/wrapper.scpt"), "arg"], { workspace: agentDir, agentDir }, allow);
    expect(ok.error).toBeUndefined();
    const escape = await resolveExec([osa, path.join(agentDir, "../other/x.scpt")], { workspace: agentDir, agentDir }, allow);
    expect(escape.error).toMatch(/must live under/);
  });

  it("enforces denied argument patterns", async () => {
    const deny = path.join(agentDir, "bin/fake-deny");
    const r = await resolveExec([deny, "--exec", "x"], { workspace: agentDir, agentDir }, allow);
    expect(r.error).toMatch(/denied argument/);
    const ok = await resolveExec([deny, "--flag", "x"], { workspace: agentDir, agentDir }, allow);
    expect(ok.error).toBeUndefined();
  });

  it("tries sibling entries when a constraint fails — two ssh pins coexist", async () => {
    const plain = path.join(agentDir, "bin/fake-plain");
    const allowSsh: ExecAllowEntry[] = [
      { bin: plain, pin: ["pibot-mini"] },
      { bin: plain, pin: ["pibot-mini-alt"] },
    ];
    const ok = await resolveExec([plain, "pibot-mini-alt", "echo", "hi"], { workspace: agentDir, agentDir }, allowSsh);
    expect(ok.error).toBeUndefined();
    const refused = await resolveExec([plain, "evil-host"], { workspace: agentDir, agentDir }, allowSsh);
    expect(refused.error).toMatch(/pinned/);
  });

  it("refuses unknown binaries without throwing", async () => {
    const r = await resolveExec(["definitely-not-a-real-binary-xyz"], { workspace: agentDir, agentDir }, allow);
    expect(r.error).toMatch(/not on this agent's exec allowlist|command not found/);
  });
});

describe("exec plugin tool", () => {
  it("registers exec_run and runs an allowlisted command end-to-end", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-exec-tool-"));
    try {
      const { pi, tools } = captureTools();
      factoryOf(execPlugin({ workspace: dir, agentDir: dir, allowlist: [{ bin: "/bin/echo" }], timeoutMs: 5_000 }))(pi);
      expect(tools.has("exec_run")).toBe(true);
      const res = await tools.get("exec_run")!.execute("t1", { argv: ["/bin/echo", "hello-exec"] });
      expect(res.details.ok).toBe(true);
      expect(res.content[0].text).toContain("exit 0");
      expect(res.content[0].text).toContain("hello-exec");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports non-zero exits with captured output instead of throwing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-exec-tool-"));
    try {
      const { pi, tools } = captureTools();
      factoryOf(execPlugin({ workspace: dir, agentDir: dir, allowlist: [{ bin: "/bin/sh" }], timeoutMs: 5_000 }))(pi);
      const res = await tools.get("exec_run")!.execute("t1", { argv: ["/bin/sh", "-c", "exit 3"] });
      expect(res.details.ok).toBe(false);
      expect(res.content[0].text).toContain("exit 3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});