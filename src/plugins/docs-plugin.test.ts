import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { docsPlugin } from "./docs-plugin.js";

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

describe("docs plugin", () => {
  let docsDir: string;
  let outsideDir: string;

  beforeEach(() => {
    docsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibot-docs-")));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibot-outside-")));
    fs.mkdirSync(path.join(docsDir, "content/docs/meetings"), { recursive: true });
    fs.writeFileSync(path.join(docsDir, "content/docs/meetings/01.mdx"), "---\ntitle: Meeting 01\n---\n10:00–12:00");
    fs.writeFileSync(path.join(docsDir, "secrets.env"), "API_KEY=x");
  });

  afterEach(() => {
    fs.rmSync(docsDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("registers docs_read and docs_list (no write tool)", () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    expect(tools.has("docs_read")).toBe(true);
    expect(tools.has("docs_list")).toBe(true);
    expect(tools.has("docs_write")).toBe(false);
  });

  it("docs_read reads a file inside the docs root", async () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    const res = await tools.get("docs_read")!.execute("t1", { path: "content/docs/meetings/01.mdx" });
    expect(res.details.ok).toBe(true);
    expect(res.content[0].text).toContain("Meeting 01");
  });

  it("docs_read refuses paths outside the docs root", async () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    const res = await tools.get("docs_read")!.execute("t1", { path: "../outside-dir/secret.txt" });
    expect(res.details.ok).toBe(false);
  });

  it("docs_read refuses traversal above the tree via ..", async () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    const res = await tools.get("docs_read")!.execute("t1", { path: "content/docs/../../outside-dir/secret.txt" });
    expect(res.details.ok).toBe(false);
  });

  it("docs_read refuses files above the docs root even via relative ..", async () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    // resolves inside the root? no: docs root IS the root — paths above it escape
    const res = await tools.get("docs_read")!.execute("t1", { path: "../" });
    expect(res.details.ok).toBe(false);
  });

  it("docs_read refuses symlink escapes", async () => {
    fs.writeFileSync(path.join(outsideDir, "leak.md"), "outside");
    fs.symlinkSync(path.join(outsideDir, "leak.md"), path.join(docsDir, "content/docs/meetings/leak-link.mdx"));
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    const res = await tools.get("docs_read")!.execute("t1", { path: "content/docs/meetings/leak-link.mdx" });
    expect(res.details.ok).toBe(false);
  });

  it("docs_list lists directory entries with folders marked", async () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    const res = await tools.get("docs_list")!.execute("t1", { path: "content/docs" });
    expect(res.details.ok).toBe(true);
    expect(res.content[0].text).toContain("meetings/");
  });

  it("docs_list with empty path lists the docs root", async () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    const res = await tools.get("docs_list")!.execute("t1", { path: "content" });
    expect(res.details.ok).toBe(true);
    expect(res.content[0].text).toContain("docs/");
  });

  it("docs_list refuses directories outside the root", async () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    const res = await tools.get("docs_list")!.execute("t1", { path: "../" });
    expect(res.details.ok).toBe(false);
  });

  it("docs_read refuses files above maxBytes with a clear cap message", async () => {
    fs.writeFileSync(path.join(docsDir, "big.mdx"), "x".repeat(600_000));
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir, maxBytes: 512 * 1024 }))(pi);
    const res = await tools.get("docs_read")!.execute("t1", { path: "big.mdx" });
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toContain("600000 bytes");
  });
});
describe("docs plugin root listing", () => {
  let docsDir: string;
  beforeEach(() => {
    docsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibot-docs-")));
    fs.mkdirSync(path.join(docsDir, "content"), { recursive: true });
  });
  afterEach(() => fs.rmSync(docsDir, { recursive: true, force: true }));

  it("docs_list with '.' lists the docs root", async () => {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir }))(pi);
    const res = await tools.get("docs_list")!.execute("t1", { path: "." });
    expect(res.details.ok).toBe(true);
    expect(res.content[0].text).toContain("content/");
  });
});

describe("participant public docs isolation", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibot-public-docs-")));
    for (const folder of ["content/docs/course", "public", "src", "scripts", "content/private", "content/docs/.private"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
    for (const file of [".env.production.local", "package.json", "src/server.ts", "scripts/deploy.ts", "content/private/key.md", "content/docs/.private/key.md", "content/docs/course/.env", "public/.secret.json"]) fs.writeFileSync(path.join(root, file), "SECRET");
    fs.writeFileSync(path.join(root, "content/docs/course/lesson.mdx"), "Public lesson");
    fs.writeFileSync(path.join(root, "public/info.json"), '{"public":true}');
    fs.writeFileSync(path.join(root, "public/image.png"), Buffer.from([0, 1, 2]));
    fs.symlinkSync(path.join(root, "content/private"), path.join(root, "content/docs/linked"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function toolsFor(docsDir = root) {
    const { pi, tools } = captureTools();
    factoryOf(docsPlugin({ docsDir, publicOnly: true }))(pi);
    return tools;
  }
  it("refuses repository secrets, dot files, hidden directories and binary files", async () => {
    const tools = toolsFor();
    for (const file of [".env.production.local", "package.json", "src/server.ts", "scripts/deploy.ts", "content/private/key.md", "content/docs/.private/key.md", "content/docs/course/.env", "public/.secret.json", "public/image.png", "content/docs/linked/key.md"]) {
      const result = await tools.get("docs_read")!.execute("x", { path: file });
      expect(result.details.ok, file).toBe(false);
      expect(result.content[0].text).not.toContain("SECRET");
    }
  });
  it("exposes navigable published roots only and filters hidden/symlink entries", async () => {
    const tools = toolsFor();
    const list = async (requested: string) => (await tools.get("docs_list")!.execute("x", { path: requested })).content[0].text;
    expect(await list(".")).toBe("content/\npublic/");
    expect(await list("content")).toBe("docs/");
    expect(await list("content/docs")).toBe("course/");
    expect(await list("public")).toBe("info.json");
    expect((await tools.get("docs_list")!.execute("x", { path: "src" })).details.ok).toBe(false);
  });
  it("reads published text and supports content/docs as configured root", async () => {
    expect((await toolsFor().get("docs_read")!.execute("x", { path: "public/info.json" })).details.ok).toBe(true);
    const tools = toolsFor(path.join(root, "content/docs"));
    expect((await tools.get("docs_read")!.execute("x", { path: "course/lesson.mdx" })).content[0].text).toBe("Public lesson");
    expect((await tools.get("docs_read")!.execute("x", { path: "../private/key.md" })).details.ok).toBe(false);
    expect((await tools.get("docs_read")!.execute("x", { path: ".private/key.md" })).details.ok).toBe(false);
  });
});
