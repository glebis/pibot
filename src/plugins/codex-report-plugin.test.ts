import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { codexReportPlugin } from "./codex-report-plugin.js";

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

describe("codex-report plugin", () => {
  let reportsDir: string;
  let outsideDir: string;

  beforeEach(() => {
    reportsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibot-reports-")));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pibot-outside-")));
    fs.mkdirSync(path.join(reportsDir, "2026-10-27"));
    fs.writeFileSync(path.join(reportsDir, "2026-10-27", "report.md"), "# Weekly report\n\nscreen time data");
    fs.writeFileSync(path.join(reportsDir, "2026-10-27", "raw.json"), "{\"minutes\":42}");
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "not for agents");
  });

  afterEach(() => {
    fs.rmSync(reportsDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("registers list and read, and no write tool", () => {
    const { pi, tools } = captureTools();
    factoryOf(codexReportPlugin({ reportsDir }))(pi);
    expect(tools.has("codex_report_list")).toBe(true);
    expect(tools.has("codex_report_read")).toBe(true);
    expect(tools.has("codex_report_write")).toBe(false);
  });

  it("lists the date overview and a subdir", async () => {
    const { pi, tools } = captureTools();
    factoryOf(codexReportPlugin({ reportsDir }))(pi);
    const root = await tools.get("codex_report_list")!.execute("t1", {});
    expect(root.details.ok).toBe(true);
    expect(root.content[0].text).toContain("dir 2026-10-27/");
    const sub = await tools.get("codex_report_list")!.execute("t2", { path: "2026-10-27" });
    expect(sub.content[0].text).toContain("file report.md");
    expect(sub.content[0].text).toContain("file raw.json");
  });

  it("reads a report file inside the root", async () => {
    const { pi, tools } = captureTools();
    factoryOf(codexReportPlugin({ reportsDir }))(pi);
    const res = await tools.get("codex_report_read")!.execute("t1", { path: "2026-10-27/report.md" });
    expect(res.details.ok).toBe(true);
    expect(res.content[0].text).toContain("screen time data");
  });

  it("refuses paths outside the reports root", async () => {
    const { pi, tools } = captureTools();
    factoryOf(codexReportPlugin({ reportsDir }))(pi);
    const traversal = await tools.get("codex_report_read")!.execute("t1", { path: "../../outside-dir/secret.md" });
    expect(traversal.details.ok).toBe(false);
    expect(traversal.content[0].text).toMatch(/^refused/);
    const absolute = await tools.get("codex_report_read")!.execute("t2", { path: outsideDir + "/secret.md" });
    expect(absolute.details.ok).toBe(false);
  });

  it("refuses symlink escapes and refuses the root itself as a read", async () => {
    const link = path.join(reportsDir, "escape");
    try { fs.symlinkSync(outsideDir, link); } catch { /* FS may disallow; skip branch */ }
    const { pi, tools } = captureTools();
    factoryOf(codexReportPlugin({ reportsDir }))(pi);
    const viaLink = await tools.get("codex_report_read")!.execute("t1", { path: "escape/secret.md" });
    expect(viaLink.details.ok).toBe(false);
    const root = await tools.get("codex_report_read")!.execute("t2", { path: "." });
    expect(root.details.ok).toBe(false);
  });

  it("caps oversized reads", async () => {
    const big = path.join(reportsDir, "2026-10-27", "big.md");
    fs.writeFileSync(big, "x".repeat(300 * 1024));
    const { pi, tools } = captureTools();
    factoryOf(codexReportPlugin({ reportsDir }))(pi);
    const res = await tools.get("codex_report_read")!.execute("t1", { path: "2026-10-27/big.md" });
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toContain("caps at");
  });
});