import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EXEC_ALLOWLIST, execPlugin, resolveExec, type ExecAllowEntry } from "./exec-plugin.js";

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

  it("urlsUnder: exactly one allowed-host URL, no extra flags", async () => {
    const plain = path.join(agentDir, "bin/fake-plain");
    const allowCurl = [{ bin: plain, pin: ["-sL", "--max-time", "15"], urlsUnder: ["https://api.github.com/"] }];
    const ok = await resolveExec([plain, "-sL", "--max-time", "15", "https://api.github.com/repos/x/y"], { workspace: agentDir, agentDir }, allowCurl);
    expect(ok.error).toBeUndefined();
    const evil = await resolveExec([plain, "-sL", "--max-time", "15", "https://evil.example.com/exfil"], { workspace: agentDir, agentDir }, allowCurl);
    expect(evil.error).toMatch(/exactly one https URL/);
    const extra = await resolveExec([plain, "-sL", "--max-time", "15", "-o", "/tmp/out", "https://api.github.com/x"], { workspace: agentDir, agentDir }, allowCurl);
    expect(extra.error).toMatch(/exactly one https URL/);
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

describe("default allowlist hardening (bypass regressions)", () => {
  let agentDir: string;
  let bins: Record<string, string>;
  let allow: ExecAllowEntry[];
  const deps = () => ({ workspace: agentDir, agentDir });

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-exec-hard-"));
    const binDir = path.join(agentDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    bins = {};
    // clone each default entry onto a distinct fake binary so tests do not need the real tools installed
    allow = DEFAULT_EXEC_ALLOWLIST.map((e, i) => {
      const name = `fake-${i}`;
      const p = path.join(binDir, name);
      fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(p, 0o755);
      const key = e.pin ? `${e.bin}:${e.pin.join(" ")}` : e.bin;
      bins[key] = p;
      return { ...e, bin: p };
    });
    fs.mkdirSync(path.join(agentDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "scripts", "good.scpt"), "stub");
    fs.writeFileSync("/tmp/evil.scpt", "stub");
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync("/tmp/evil.scpt", { force: true });
  });

  const run = (key: string, ...args: string[]) => resolveExec([bins[key], ...args], deps(), allow);
  const yt = (...args: string[]) => run("yt-dlp", ...args);
  const URL = "https://www.youtube.com/watch?v=abc123";

  describe("yt-dlp", () => {
    it("allows legitimate invocations", async () => {
      for (const args of [
        ["--list-subs", URL],
        ["--skip-download", "--write-auto-subs", "--sub-langs", "en,ru", "--convert-subs", "srt", URL],
        ["--skip-download", "--write-subs", "--sub-langs=en.*", "--sub-format", "vtt", "-o", "subs/%(id)s.%(ext)s", URL],
        ["--print", "title", "--print", "%(channel)s", "--print", "upload_date", "--no-playlist", URL],
        ["-O", "%(title)s", "-j", "-q", "--no-warnings", "--no-progress", URL],
        ["-x", "--audio-format", "mp3", "-f", "bestaudio/best", "-o", "audio.%(ext)s", URL],
        ["--playlist-items", "1:3,5", URL],
      ]) {
        const r = await yt(...args);
        expect(r.error, args.join(" ")).toBeUndefined();
      }
    });

    it("refuses command-execution and file/credential bypass flags", async () => {
      for (const args of [
        ["--downloader", "/bin/sh", URL],
        ["--downloader=/bin/sh", URL],
        ["--external-downloader", "/bin/sh", URL],
        ["--downloader-args", "x", URL],
        ["--ffmpeg-location", "/tmp/evil", URL],
        ["--ffmpeg-location=/tmp/evil", URL],
        ["--plugin-dirs", "/tmp/p", URL],
        ["--config-locations", "/tmp/c.conf", URL],
        ["--config-location=/tmp/c.conf", URL],
        ["--cookies-from-browser", "chrome", URL],
        ["--cookies-from-browser=chrome", URL],
        ["--cookies", "/tmp/c.txt", URL],
        ["--netrc", URL],
        ["--username", "u", "--password", "p", URL],
        ["--batch-file", "/etc/passwd"],
        ["-a", "/etc/passwd"],
        ["--load-info-json", "/tmp/i.json"],
        ["--paths", "/etc", URL],
        ["--print-to-file", "title", "/tmp/x", URL],
        ["--exec", "id", URL],
        ["--exec=id", URL],
        ["--exec-before-download", "id", URL],
        ["--postprocessor-args", "x", URL],
        ["--ppa", "x", URL],
        ["--use-postprocessor", "Exec", URL],
        ["-qx", URL], // combined short flags are not parsed
        ["--", "--exec", "id"],
      ]) {
        const r = await yt(...args);
        expect(r.error, args.join(" ")).toBeTruthy();
      }
    });

    it("-o/--output must stay workspace-relative", async () => {
      for (const o of ["/etc/x", "../../x", "a/../../x", "~/x", "~"]) {
        expect((await yt("-o", o, URL)).error, o).toMatch(/not allowed/);
        expect((await yt(`--output=${o}`, URL)).error, o).toMatch(/not allowed/);
      }
      expect((await yt("-o", "out/%(id)s.%(ext)s", URL)).error).toBeUndefined();
    });

    it("-o refuses type prefixes (their template may be absolute)", async () => {
      for (const o of ["subtitle:/Users/x/.zshrc", "infojson:/tmp/x", "pl_thumbnail:x", "SUBTITLE:x"]) {
        expect((await yt("-o", o, URL)).error, o).toMatch(/not allowed/);
        expect((await yt(`--output=${o}`, URL)).error, o).toMatch(/not allowed/);
      }
    });

    it("-o never writes into dirs whose files are later executed (osascript scripts/, extensions/, skills/)", async () => {
      for (const o of ["scripts/x.scpt", "./scripts/x", "Scripts/x", "scripts", "extensions/evil.ts", "skills/x/SKILL.md"]) {
        expect((await yt("-o", o, URL)).error, o).toMatch(/not allowed/);
      }
      expect((await yt("-o", "materials/scripts-notes.%(ext)s", URL)).error).toBeUndefined();
    });

    it("positionals must be https URLs; value flags need a safe value", async () => {
      expect((await yt("file:///etc/passwd")).error).toMatch(/not allowed/);
      expect((await yt("http://example.com/v")).error).toMatch(/not allowed/);
      expect((await yt("/etc/passwd")).error).toMatch(/not allowed/);
      expect((await yt("--list-subs")).error).toMatch(/positional/);
      expect((await yt("--sub-langs", URL)).error).toBeTruthy();
      expect((await yt(URL, "--sub-langs")).error).toMatch(/requires a value/);
      expect((await yt("--print", "$(id)", URL)).error).toBeTruthy();
      expect((await yt("--convert-subs", "exe", URL)).error).toMatch(/not allowed/);
      expect((await yt("--skip-download=1", URL)).error).toMatch(/takes no value/);
    });
  });

  describe("osascript", () => {
    const osa = (...args: string[]) => run("osascript", ...args);

    it("runs a script file under <agentDir>/scripts", async () => {
      const real = fs.realpathSync(path.join(agentDir, "scripts", "good.scpt"));
      const r = await osa(path.join(agentDir, "scripts", "good.scpt"), "arg1");
      expect(r.error).toBeUndefined();
      expect(r.argv.slice(1)).toEqual([real, "arg1"]);
    });

    it("refuses scripts outside scripts/, flags, missing files, directories and symlink escapes", async () => {
      expect((await osa("/tmp/evil.scpt")).error).toMatch(/must live under/);
      expect((await osa(path.join(agentDir, "scripts", "../bin/fake-0"))).error).toMatch(/must live under/);
      expect((await osa("-l", "JavaScript", path.join(agentDir, "scripts", "good.scpt"))).error).toMatch(/flags/);
      expect((await osa("-e", 'do shell script "id"')).error).toMatch(/flags/);
      expect((await osa("-i")).error).toMatch(/flags/);
      expect((await osa()).error).toMatch(/requires a script file/);
      expect((await osa(path.join(agentDir, "scripts", "nope.scpt"))).error).toMatch(/must exist/);
      expect((await osa(path.join(agentDir, "scripts"))).error).toMatch(/regular file/);
      fs.symlinkSync("/tmp/evil.scpt", path.join(agentDir, "scripts", "link.scpt"));
      expect((await osa(path.join(agentDir, "scripts", "link.scpt"))).error).toMatch(/must live under/);
    });
  });

  describe("gh", () => {
    const api = (...args: string[]) => run("gh:api", "api", ...args);
    const view = (...args: string[]) => run("gh:repo view", "repo", "view", ...args);

    it("allows read-only api fetches and repo view", async () => {
      expect((await api("repos/a/b")).error).toBeUndefined();
      expect((await api("repos/a/b/contents/README.md?ref=main", "--jq", ".content")).error).toBeUndefined();
      expect((await api("repos/a/b/issues?state=open", "--paginate", "-H", "Accept: application/vnd.github+json")).error).toBeUndefined();
      expect((await view("openclaw/openclaw", "--json", "stargazersCount,forks")).error).toBeUndefined();
      expect((await view("a/b", "--json", "forks", "--jq", ".forks")).error).toBeUndefined();
    });

    it("refuses mutations, inputs, fields and odd endpoints", async () => {
      for (const args of [
        ["-X", "DELETE", "repos/a/b"],
        ["--method", "DELETE", "repos/a/b"],
        ["--method=PATCH", "repos/a/b"],
        ["repos/a/b", "-X", "DELETE"],
        ["repos/a/b", "--input", "f"],
        ["repos/a/b", "-f", "name=x"],
        ["repos/a/b", "-F", "name=x"],
        ["repos/a/b", "--field", "name=x"],
        ["repos/a/b", "--raw-field", "name=x"],
        ["repos/a/b", "-H", "Authorization: token x"],
        ["repos/a/b", "--hostname", "evil.example"],
        ["user"],
        ["graphql"],
        ["repos/a/b/../../user"],
        ["repos/a/b", "repos/c/d"],
        [],
      ]) {
        expect((await api(...args)).error, args.join(" ")).toBeTruthy();
      }
      expect((await view("--web", "a/b")).error).toMatch(/not allowlisted/);
      expect((await view("a/b", "--web")).error).toMatch(/not allowlisted/);
      expect((await view("https://github.com/a/b")).error).toMatch(/not allowed/);
      expect((await view()).error).toMatch(/positional/);
    });
  });

  describe("curl", () => {
    const curl = (...args: string[]) => run("curl:-sL --max-time 15", ...args);
    it("allows exactly one allowlisted URL; -L cannot be combined with extra args", async () => {
      expect((await curl("-sL", "--max-time", "15", "https://api.github.com/repos/a/b")).error).toBeUndefined();
      expect((await curl("-sL", "--max-time", "15", "https://api.github.com/x", "https://evil.example/y")).error).toMatch(/exactly one/);
      expect((await curl("-sL", "--max-time", "15", "https://api.github.com/x", "-o", "/tmp/x")).error).toMatch(/exactly one/);
      expect((await curl("-sL", "--max-time", "15", "-K", "/tmp/cfg", "https://api.github.com/x")).error).toMatch(/exactly one/);
      expect((await curl("-sL", "--max-time", "15", "--next", "https://evil.example/y")).error).toMatch(/exactly one/);
      expect((await curl("-sL", "https://api.github.com/x")).error).toMatch(/pinned/);
    });
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