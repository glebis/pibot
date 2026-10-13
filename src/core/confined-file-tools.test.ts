import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confinedFileTools } from "./confined-file-tools.js";

let root: string;
let agentDir: string;
let outside: string;

type Tool = ReturnType<typeof confinedFileTools>[number];
const get = (tools: Tool[], name: string) => tools.find((t) => t.name === name)!;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const run = (t: Tool, params: Record<string, unknown>) => t.execute("id", params as never, undefined, undefined, undefined as never);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confined-")));
  agentDir = path.join(root, "agent");
  outside = path.join(root, "other-agent");
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "persona");
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOPSECRET");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function tools() {
  return confinedFileTools(agentDir, { readRoots: [agentDir], writeRoots: [path.join(agentDir, "memory")] });
}

describe("confinedFileTools", () => {
  it("exposes read/write/edit with confinement noted in the description", () => {
    const t = tools();
    expect(t.map((x) => x.name)).toEqual(["read", "write", "edit"]);
    for (const x of t) expect(x.description).toMatch(/Confined/);
  });

  it("reads inside the agent dir (relative and absolute)", async () => {
    const t = get(tools(), "read");
    expect(text(await run(t, { path: "AGENTS.md" }))).toContain("persona");
    expect(text(await run(t, { path: path.join(agentDir, "AGENTS.md") }))).toContain("persona");
  });

  it("refuses reads outside the agent dir", async () => {
    const t = get(tools(), "read");
    for (const p of [path.join(outside, "secret.txt"), "../other-agent/secret.txt", "~/.config/sops/age/keys.txt", "/etc/hosts", "@/etc/hosts"]) {
      const r = await run(t, { path: p });
      expect(text(r)).toMatch(/^refused: read is limited to \.\/ during heartbeat ticks/);
      expect(text(r)).not.toContain("TOPSECRET");
    }
  });

  it("refuses a read through a symlink pointing outside", async () => {
    fs.symlinkSync(outside, path.join(agentDir, "memory", "link"));
    const r = await run(get(tools(), "read"), { path: "memory/link/secret.txt" });
    expect(text(r)).toMatch(/^refused:/);
  });

  it("writes under memory/ and creates the file", async () => {
    const r = await run(get(tools(), "write"), { path: "memory/notes/x.md", content: "hello" });
    expect(text(r)).toContain("Successfully wrote");
    expect(fs.readFileSync(path.join(agentDir, "memory", "notes", "x.md"), "utf8")).toBe("hello");
    const abs = await run(get(tools(), "write"), { path: path.join(agentDir, "memory", "y.md"), content: "abs" });
    expect(text(abs)).toContain("Successfully wrote");
  });

  it("refuses writes outside memory/", async () => {
    const w = get(tools(), "write");
    const home = os.homedir();
    for (const p of [
      "AGENTS.md",
      "HEARTBEAT.md",
      "extensions/x.ts",
      "scripts/x.scpt",
      "skills/s/SKILL.md",
      "../other-agent/x",
      "~/x",
      path.join(home, ".zshrc"),
      "memory/../AGENTS.md",
    ]) {
      const r = await run(w, { path: p, content: "pwned" });
      expect(text(r), p).toMatch(/^refused: write is limited to memory\/ during heartbeat ticks/);
    }
    expect(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8")).toBe("persona");
    expect(fs.existsSync(path.join(agentDir, "extensions"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
  });

  it("edit works inside memory/ and is refused elsewhere", async () => {
    fs.writeFileSync(path.join(agentDir, "memory", "MEMORY.md"), "one two");
    const e = get(tools(), "edit");
    const ok = await run(e, { path: "memory/MEMORY.md", edits: [{ oldText: "one", newText: "1" }] });
    expect(text(ok)).toContain("Successfully replaced");
    expect(fs.readFileSync(path.join(agentDir, "memory", "MEMORY.md"), "utf8")).toBe("1 two");
    const bad = await run(e, { path: "AGENTS.md", edits: [{ oldText: "persona", newText: "pwned" }] });
    expect(text(bad)).toMatch(/^refused: edit is limited to memory\//);
    const bad2 = await run(e, { path: path.join(outside, "secret.txt"), edits: [{ oldText: "TOPSECRET", newText: "x" }] });
    expect(text(bad2)).toMatch(/^refused:/);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("TOPSECRET");
  });

  it("refuses writes through a symlink under memory/ that points outside", async () => {
    fs.symlinkSync(outside, path.join(agentDir, "memory", "escape"));
    const w = get(tools(), "write");
    expect(text(await run(w, { path: "memory/escape/pwn.txt", content: "x" }))).toMatch(/^refused:/);
    expect(fs.existsSync(path.join(outside, "pwn.txt"))).toBe(false);
    // symlinked file inside memory pointing at an outside file
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(agentDir, "memory", "f.md"));
    expect(text(await run(w, { path: "memory/f.md", content: "x" }))).toMatch(/^refused:/);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("TOPSECRET");
  });

  it("refuses writes through a dangling symlink pointing outside", async () => {
    fs.symlinkSync(path.join(outside, "new.txt"), path.join(agentDir, "memory", "dangling.md"));
    const r = await run(get(tools(), "write"), { path: "memory/dangling.md", content: "x" });
    expect(text(r)).toMatch(/^refused:/);
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  it("refuses NUL bytes and non-string paths", async () => {
    const w = get(tools(), "write");
    expect(text(await run(w, { path: "memory/a\0.md", content: "x" }))).toMatch(/^refused:/);
    expect(text(await run(get(tools(), "read"), { path: "AGENTS.md\0" }))).toMatch(/^refused:/);
    expect(text(await run(w, { content: "x" }))).toMatch(/^refused:/);
  });
});
