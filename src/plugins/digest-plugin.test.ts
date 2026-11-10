import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { digestPlugin } from "./digest-plugin.js";

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

function captureTools(): { pi: ExtensionAPI; tools: Map<string, Tool> } {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as Tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

describe("digest verdict plugin (bd pibot-jiqv)", () => {
  let agentDir: string;
  let tools: Map<string, Tool>;
  const NOW = Date.UTC(2026, 10, 5, 7, 7); // Nov 5 08:07 CET

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-digest-"));
    const { pi, tools: t } = captureTools();
    factoryOf(digestPlugin({ agentId: "knower", agentDir, now: () => NOW }))(pi);
    tools = t;
  });
  afterEach(() => { fs.rmSync(agentDir, { recursive: true, force: true }); });

  const call = (name: string, subjects: unknown[]) =>
    tools.get(name)!.execute("t", { subjects }) as Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;

  it("refuses to call a still-running search a thin day, and says so in plain words", async () => {
    const r = await call("digest_verdict", [
      { subject: "agentic-coding", state: "running", note: "researcher still scraping" },
    ]);
    expect(r.details.verdict).toBe("unavailable");
    expect(r.content[0].text).toContain("NOT a thin day");
    expect(r.content[0].text).not.toContain("Thin wire");
    expect(r.content[0].text).toContain("agentic-coding: search still running — researcher still scraping");
    expect(r.content[0].text).toContain("do not call the day thin");
  });

  it("states a genuinely quiet day as thin when every search completed", async () => {
    const r = await call("digest_verdict", [
      { subject: "a", state: "completed", qualified: 0 },
      { subject: "b", state: "completed", qualified: 0 },
    ]);
    expect(r.details.verdict).toBe("thin");
    expect(r.content[0].text).toContain("Thin wire — all 2 subject(s) searched, nothing met the inclusion bar.");
  });

  it("treats an omitted qualified count on a completed search as zero, not as unproven", async () => {
    const r = await call("digest_verdict", [{ subject: "a", state: "completed" }]);
    expect(r.details.verdict).toBe("thin");
  });

  it("keeps qualified counts only for completed searches, so a running subject cannot inflate a drop", async () => {
    const r = await call("digest_verdict", [
      { subject: "a", state: "completed", qualified: 2 },
      { subject: "b", state: "running", qualified: 9 },
    ]);
    expect(r.details.verdict).toBe("partial");
    expect(r.details.covered).toEqual(["a"]);
    expect(r.content[0].text).toContain("b: search still running");
  });

  it("says nothing-to-do for an empty registry instead of reporting a quiet day", async () => {
    const r = await call("digest_verdict", []);
    expect(r.details.verdict).toBe("skipped");
    expect(r.content[0].text).toBe("No active research subjects — nothing searched.\nverdict: skipped");
  });

  it("persists the verdict under state/ with owner-only permissions", async () => {
    await call("digest_verdict", [{ subject: "a", state: "completed", qualified: 1 }]);
    const file = path.join(agentDir, "state", "digest-verdict.json");
    expect(fs.existsSync(file)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored).toMatchObject({ date: "2026-11-05", view: { verdict: "drop" } });
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("upgrades an unavailable digest from the late result without searching again", async () => {
    await call("digest_verdict", [{ subject: "a", state: "running" }]);
    const r = await call("digest_late_result", [{ subject: "a", state: "completed", qualified: 2 }]);
    expect(r.details).toMatchObject({ ok: true, changed: true, resubmitted: false, verdict: "drop" });
    expect(r.content[0].text).toContain("unavailable → drop");
    expect(r.content[0].text).toContain("No subject was searched twice; the earlier report stands as sent.");
  });

  it("turns a partial digest into thin when the late search really did come back empty", async () => {
    await call("digest_verdict", [
      { subject: "a", state: "completed", qualified: 0 },
      { subject: "b", state: "running" },
    ]);
    const r = await call("digest_late_result", [
      { subject: "a", state: "completed", qualified: 0 },
      { subject: "b", state: "completed", qualified: 0 },
    ]);
    expect(r.details).toMatchObject({ changed: true, resubmitted: false, verdict: "thin" });
    expect(r.content[0].text).toContain("partial → thin");
    expect(r.content[0].text).toContain("the searches finished with nothing qualified");
  });

  it("reports no change and no resubmission when the late result matches what was already recorded", async () => {
    await call("digest_verdict", [{ subject: "a", state: "completed", qualified: 1 }]);
    const r = await call("digest_late_result", [{ subject: "a", state: "completed", qualified: 1 }]);
    expect(r.details).toMatchObject({ changed: false, resubmitted: false, verdict: "drop" });
    expect(r.content[0].text).toContain("Nothing was searched again.");
  });

  it("refuses to reconcile when no earlier verdict was recorded, instead of inventing one", async () => {
    const r = await call("digest_late_result", [{ subject: "a", state: "completed", qualified: 1 }]);
    expect(r.details).toMatchObject({ ok: false, reason: "no-previous-verdict" });
    expect(r.content[0].text).toContain("nothing to reconcile");
  });

  it("keeps the earlier verdict on disk when the late result changes nothing", async () => {
    await call("digest_verdict", [{ subject: "a", state: "completed", qualified: 1 }]);
    const file = path.join(agentDir, "state", "digest-verdict.json");
    const before = fs.readFileSync(file, "utf8");
    await call("digest_late_result", [{ subject: "a", state: "completed", qualified: 1 }]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
