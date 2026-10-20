import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { delegateCommand, delegatePlugin, resolveDelegateCwd } from "./delegate-plugin.js";

describe("delegate cwd + env", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dlg-root-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dlg-out-")));
    fs.mkdirSync(path.join(root, "sub"));
    fs.symlinkSync(outside, path.join(root, "link"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    delete process.env.FAKE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.PIBOT_OFFICE_CLI;
    delete process.env.PAPERINSTRUMENTS_API_KEY;
  });

  it("allows inside, refuses outside / traversal / symlink escape", () => {
    expect(resolveDelegateCwd(undefined, root)).toEqual({ ok: true, cwd: root });
    expect(resolveDelegateCwd("sub", root)).toEqual({ ok: true, cwd: path.join(root, "sub") });
    expect(resolveDelegateCwd(outside, root).ok).toBe(false);
    expect(resolveDelegateCwd("../", root).ok).toBe(false);
    expect(resolveDelegateCwd("link", root).ok).toBe(false);
    expect(resolveDelegateCwd("sub", undefined).ok).toBe(false);
  });

  async function exec(cli: string, cwd?: string) {
    const calls: { cmd: string; args: string[]; timeout: number; env: NodeJS.ProcessEnv; cwd?: string }[] = [];
    const ext = delegatePlugin({ cwd: root, run: async (c, a, o) => (calls.push({ cmd: c, args: a, timeout: o.timeout, env: o.env, cwd: o.cwd }), { stdout: "ok" }) });
    let tool: any;
    (typeof ext === "function" ? ext : ext.factory)({ registerTool: (t: unknown) => (tool = t) } as never);
    const r = await tool.execute("id", { cli, prompt: "p", cwd });
    return { calls, text: r.content[0].text as string };
  }

  it("refuses escaping cwd without spawning", async () => {
    const { calls, text } = await exec("claude", outside);
    expect(calls).toHaveLength(0);
    expect(text).toMatch(/outside/);
  });

  it("scrubs secrets; gemini gets its default passthrough only", async () => {
    process.env.FAKE_API_KEY = "x";
    process.env.GEMINI_API_KEY = "g";
    const c = await exec("claude");
    expect(c.calls[0].env.FAKE_API_KEY).toBeUndefined();
    expect(c.calls[0].env.GEMINI_API_KEY).toBeUndefined();
    const g = await exec("gemini");
    expect(g.calls[0].env.GEMINI_API_KEY).toBe("g");
    expect(g.calls[0].env.FAKE_API_KEY).toBeUndefined();
  });

  it("refuses an unconfigured or relative office executable without spawning", async () => {
    for (const command of [undefined, "relative-office"]) {
      if (command) process.env.PIBOT_OFFICE_CLI = command;
      else delete process.env.PIBOT_OFFICE_CLI;
      expect(delegateCommand("office")).toBeUndefined();
      const result = await exec("office");
      expect(result.calls).toHaveLength(0);
      expect(result.text).toMatch(/not configured/);
    }
  });

  it("office resolves its executable from PIBOT_OFFICE_CLI and passes no secrets", async () => {
    expect(delegateCommand("office")).toBeUndefined();
    expect(delegateCommand("claude")).toBe("claude");
    expect(delegateCommand("nope")).toBeUndefined();
    process.env.PIBOT_OFFICE_CLI = "/opt/office/bin/pi-office";
    process.env.PAPERINSTRUMENTS_API_KEY = "secret";
    expect(delegateCommand("office")).toBe("/opt/office/bin/pi-office");
    const o = await exec("office");
    expect(o.calls[0].cmd).toBe("/opt/office/bin/pi-office");
    expect(o.calls[0].args).toEqual(["p"]);
    expect(o.calls[0].timeout).toBe(30 * 60_000);
    expect(o.calls[0].env.PAPERINSTRUMENTS_API_KEY).toBeUndefined();
  });
});
