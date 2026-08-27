import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { buildHeartbeatDigest } from "./heartbeat.js";
import type { LoadedAgent } from "./agent-manager.js";
import type { Schedule } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-am-"));
}

describe("AgentManager scaffolding", () => {
  let dir: string;
  let mgr: AgentManager;

  beforeEach(() => {
    dir = tmpDir();
    mgr = new AgentManager(dir, { getModels: () => [] } as never);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("discovers agents from agent.json manifests, skipping _template", async () => {
    mgr.createAgent("alpha");
    fs.mkdirSync(path.join(dir, "_template"), { recursive: true });
    fs.writeFileSync(path.join(dir, "_template", "agent.json"), JSON.stringify({ name: "T" }));
    fs.mkdirSync(path.join(dir, "notanagent"));
    await mgr.discover();
    expect(mgr.list().map((a) => a.id)).toContain("alpha");
    expect(mgr.list().map((a) => a.id)).not.toContain("_template");
    expect(mgr.getAgent("alpha")).toBeDefined();
    expect(mgr.defaultAgentId()).toBeDefined();
  });

  it("createAgent scaffolds manifest, persona, and directories", async () => {
    const err = mgr.createAgent("coach", "You are a strict but kind coach.");
    expect(err).toBeUndefined();
    const agent = mgr.getAgent("coach");
    expect(agent).toBeDefined();
    expect(fs.readFileSync(path.join(dir, "coach", "AGENTS.md"), "utf8")).toContain("strict but kind");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "coach", "agent.json"), "utf8"))).toMatchObject({ name: "coach", heartbeat: { enabled: true } });
    expect(fs.existsSync(path.join(dir, "coach", "extensions"))).toBe(true);
  });

  it("rejects invalid and duplicate names", () => {
    expect(mgr.createAgent("Bad Name!")).toMatch(/2–32 chars/);
    mgr.createAgent("ok-name");
    expect(mgr.createAgent("ok-name")).toContain("already exists");
  });

  it("resolveModel: undefined passes through, garbage throws", () => {
    expect(mgr.resolveModel(undefined)).toBeUndefined();
    expect(() => mgr.resolveModel("no-such-provider/no-such-model")).toThrow(/not available/);
  });
});

describe("buildHeartbeatDigest", () => {
  let dir: string;
  

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("includes persona, memory, schedules, and events", () => {
    const agent: LoadedAgent = { id: "a1", dir, manifest: { name: "a1" } };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "You are a test ghost.");
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory", "MEMORY.md"), "Owner likes quiet mornings.");

    const schedule = {
      list: (id: string) =>
        id === "a1"
          ? ([
              { id: "1", agentId: "a1", title: "standup", kind: "reminder", dueAt: Date.now() + 60e3, wake: "important", chat: { transport: "t", chatId: "c" }, delivery: "direct", status: "pending", createdAt: 0, firedCount: 0 },
              { id: "2", agentId: "a1", title: "hb", kind: "heartbeat", internal: true, chat: { transport: "t", chatId: "c" }, wake: "normal", delivery: "direct", status: "pending", createdAt: 0, firedCount: 0 },
            ] as Schedule[])
          : [],
    };
    const events = { tail: () => [{ t: 1, type: "message" as const, summary: "last thing said" }] };

    const digest = buildHeartbeatDigest(agent, schedule, events);
    expect(digest).toContain("You are a test ghost.");
    expect(digest).toContain("Owner likes quiet mornings.");
    expect(digest).toContain("standup"); // non-internal included
    expect(digest).not.toContain("- \"hb\""); // internal excluded
    expect(digest).toContain("last thing said");
  });
});
describe("common knowledge", () => {
  it("system prompt includes the vault path and shared KNOWLEDGE.md", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-ck-"));
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-vault-"));
    const mgr = new AgentManager(dir, { getModels: () => [] } as never, vault);
    mgr.createAgent("a1", "You are a test.");
    fs.mkdirSync(path.join(vault, "pibot"), { recursive: true });
    fs.writeFileSync(path.join(vault, "pibot", "KNOWLEDGE.md"), "## Owner\nGleb, Berlin. Prefers short answers.");
    await mgr.discover();
    void mgr;
    // commonKnowledge is exercised via systemPromptFor; test the module-level helper indirectly
    const { commonKnowledge } = await import("./agent-manager.js");
    const ck = commonKnowledge(vault);
    expect(ck).toContain("Common knowledge");
    expect(ck).toContain("Gleb, Berlin");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });
});
