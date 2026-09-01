import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { vaultPlugin } from "./vault-plugin.js";

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

describe("vault plugin", () => {
  let vaultDir: string;
  let outsideDir: string;

  beforeEach(() => {
    vaultDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibot-vault-")));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibot-outside-")));
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("registers vault_read and vault_write", () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    expect(tools.has("vault_read")).toBe(true);
    expect(tools.has("vault_write")).toBe(true);
  });

  it("vault_write creates parent dirs and writes inside the vault", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    const res = await tools.get("vault_write")!.execute("t1", { path: "Sources/20260901-knowledge-graph-creator.md", content: "---\nsource: x\n---\n# Title" });
    expect(res.details.ok).toBe(true);
    const written = path.join(vaultDir, "Sources/20260901-knowledge-graph-creator.md");
    expect(fs.readFileSync(written, "utf8")).toContain("# Title");
    expect(res.content[0].text).toContain("Sources/20260901-knowledge-graph-creator.md");
  });

  it("vault_write overwrites an existing file", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    fs.mkdirSync(path.join(vaultDir, "Daily"), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "Daily/20260901.md"), "old");
    const res = await tools.get("vault_write")!.execute("t1", { path: "Daily/20260901.md", content: "new" });
    expect(res.details.ok).toBe(true);
    expect(fs.readFileSync(path.join(vaultDir, "Daily/20260901.md"), "utf8")).toBe("new");
  });

  it("vault_read returns file content", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    fs.writeFileSync(path.join(vaultDir, "note.md"), "hello vault");
    const res = await tools.get("vault_read")!.execute("t1", { path: "note.md" });
    expect(res.details.ok).toBe(true);
    expect(res.content[0].text).toContain("hello vault");
  });

  it("refuses traversal outside the vault", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    for (const tool of ["vault_read", "vault_write"]) {
      const res = await tools.get(tool)!.execute("t1", { path: "../outside/secret.md", content: "x" });
      expect(res.details.ok).toBe(false);
      expect(res.content[0].text).toContain("refused");
    }
  });

  it("refuses absolute paths outside the vault", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    for (const requested of ["/etc/passwd", path.join(outsideDir, "note.md")]) {
      const res = await tools.get("vault_write")!.execute("t1", { path: requested, content: "x" });
      expect(res.details.ok).toBe(false);
      expect(res.content[0].text).toContain("refused");
    }
  });

  it("refuses symlink escapes", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    const target = path.join(outsideDir, "escape.md");
    fs.writeFileSync(target, "outside");
    const link = path.join(vaultDir, "escape-link.md");
    fs.symlinkSync(target, link);
    const read = await tools.get("vault_read")!.execute("t1", { path: "escape-link.md" });
    expect(read.details.ok).toBe(false);
    const write = await tools.get("vault_write")!.execute("t1", { path: "escape-link.md", content: "x" });
    expect(write.details.ok).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("outside");
  });

  it("refuses the vault root itself", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    const res = await tools.get("vault_write")!.execute("t1", { path: ".", content: "x" });
    expect(res.details.ok).toBe(false);
  });

  it("refuses missing files on read", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir }))(pi);
    const res = await tools.get("vault_read")!.execute("t1", { path: "nope.md" });
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toContain("read failed");
  });

  it("enforces the byte cap on read and write", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir, maxBytes: 16 }))(pi);
    const big = "x".repeat(64);
    const write = await tools.get("vault_write")!.execute("t1", { path: "big.md", content: big });
    expect(write.details.ok).toBe(false);
    fs.writeFileSync(path.join(vaultDir, "big.md"), big);
    const read = await tools.get("vault_read")!.execute("t1", { path: "big.md" });
    expect(read.details.ok).toBe(false);
  });

  it("refuses everything when the vault directory does not exist", async () => {
    const { pi, tools } = captureTools();
    factoryOf(vaultPlugin({ vaultDir: path.join(vaultDir, "does-not-exist") }))(pi);
    const res = await tools.get("vault_write")!.execute("t1", { path: "note.md", content: "x" });
    expect(res.details.ok).toBe(false);
  });
});