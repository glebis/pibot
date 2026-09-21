import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildResearchSignals, clearSignalsCache } from "./research-signals.js";

const DAY = 86_400e3;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-signals-"));
}

/** Write a fake Codex session rollout: meta line + one user topic line. */
function fakeSession(dir: string, d: Date, topic: string): string {
  const day = path.join(dir, "sessions", `${d.getFullYear()}`, `${String(d.getMonth() + 1).padStart(2, "0")}`, `${String(d.getDate()).padStart(2, "0")}`);
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-${d.toISOString().replace(/[:.]/g, "-")}-test.jsonl`);
  const meta = JSON.stringify({ timestamp: d.toISOString(), type: "session_meta", payload: { session_id: "s1", id: "s1", timestamp: d.toISOString() } });
  const user = JSON.stringify({ timestamp: d.toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: topic }] } });
  fs.writeFileSync(file, `${meta}\n${user}\n`);
  return file;
}

describe("buildResearchSignals", () => {
  let dir: string;
  let vault: string;
  const NOW = new Date("2026-09-21T18:00:00Z").getTime();

  beforeEach(() => {
    dir = tmpDir();
    vault = tmpDir();
    clearSignalsCache();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it("extracts recent codex session topics, redacts credentials, caps the list", () => {
    for (let i = 0; i < 4; i++) {
      fakeSession(dir, new Date(NOW - i * 3600e3), `research topic number ${i} with api_key = "sk-secret123"` + " x".repeat(60));
    }
    const panel = buildResearchSignals({ codexHome: dir, vaultDir: vault, now: NOW, maxCodex: 3 });
    expect(panel).toContain("# Research signals");
    expect(panel).toContain("Codex: 4 sessions");
    expect(panel).toContain("[REDACTED]"); // credential redaction
    expect(panel).not.toContain("sk-secret123");
    expect(panel).toContain("research topic number 3"); // newest first
  });

  it("excludes sessions older than the window", () => {
    fakeSession(dir, new Date(NOW - 10 * DAY), "old topic");
    fakeSession(dir, new Date(NOW - 3600e3), "fresh topic");
    const panel = buildResearchSignals({ codexHome: dir, vaultDir: vault, now: NOW, windowDays: 7 });
    expect(panel).toContain("fresh topic");
    expect(panel).toContain("Codex: 1 sessions");
    expect(panel).not.toContain("old topic");
  });

  it("lists recently modified vault notes by title, newest first", () => {
    fs.writeFileSync(path.join(vault, "AI Research.md"), "content");
    fs.writeFileSync(path.join(vault, "Deep Research Brief.md"), "content");
    const old = new Date(NOW - 10 * DAY);
    fs.utimesSync(path.join(vault, "AI Research.md"), old, old);
    const panel = buildResearchSignals({ codexHome: dir, vaultDir: vault, now: NOW, windowDays: 7 });
    expect(panel).toContain("Deep Research Brief");
    expect(panel).toContain("Vault: 1 changed notes");
    expect(panel).not.toContain("AI Research.md"); // too old
  });

  it("returns an empty panel when there is no signal", () => {
    expect(buildResearchSignals({ codexHome: dir, vaultDir: vault, now: NOW })).toBe("");
  });

  it("caches the panel within the same time bucket (no rescan per tick)", () => {
    fakeSession(dir, new Date(NOW - 3600e3), "cached topic");
    const a = buildResearchSignals({ codexHome: dir, vaultDir: vault, now: NOW });
    fakeSession(dir, new Date(NOW - 1800e3), "newer topic");
    const b = buildResearchSignals({ codexHome: dir, vaultDir: vault, now: NOW });
    expect(b).toBe(a); // cached
    clearSignalsCache();
    const c = buildResearchSignals({ codexHome: dir, vaultDir: vault, now: NOW + 3600e3 });
    expect(c).not.toBe(a);
    expect(c).toContain("newer topic");
  });
});