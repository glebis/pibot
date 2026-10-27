import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, resolveAgentCapabilitySet, systemPromptFor } from "./agent-manager.js";
import type { CapabilityContext, CapabilityDefinition } from "./capabilities.js";
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

  it("repairs permissions on discovered runtime agent directories", async () => {
    const agentDir = path.join(dir, "existing");
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify({ name: "existing" }));
    fs.chmodSync(agentDir, 0o755);

    await mgr.discover();

    expect(fs.statSync(agentDir).mode & 0o777).toBe(0o700);
  });

  it("createAgent scaffolds manifest, persona, and directories", async () => {
    const err = mgr.createAgent("coach", "You are a strict but kind coach.");
    expect(err).toBeUndefined();
    const agent = mgr.getAgent("coach");
    expect(agent).toBeDefined();
    expect(fs.readFileSync(path.join(dir, "coach", "AGENTS.md"), "utf8")).toContain("strict but kind");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "coach", "agent.json"), "utf8"))).toMatchObject({ name: "coach", heartbeat: { enabled: true } });
    expect(fs.existsSync(path.join(dir, "coach", "extensions"))).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "coach")).mode & 0o777).toBe(0o700);
  });

  it("createAgent scaffolds the memory baseline (MEMORY.md + notes dir)", async () => {
    mgr.createAgent("alpha");
    expect(fs.existsSync(path.join(dir, "alpha", "memory", "MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "alpha", "memory", "notes"))).toBe(true);
    expect(fs.statSync(path.join(dir, "alpha", "memory", "MEMORY.md")).mode & 0o777).toBe(0o600);
  });

  it("discover backfills the memory baseline for legacy agents without touching existing memory", async () => {
    const agentDir = path.join(dir, "legacy");
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "memory", "MEMORY.md"), "# my curated memory");
    fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify({ name: "legacy" }));

    await mgr.discover();

    expect(fs.existsSync(path.join(agentDir, "memory", "notes"))).toBe(true);
    expect(fs.readFileSync(path.join(agentDir, "memory", "MEMORY.md"), "utf8")).toBe("# my curated memory");
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

  it("keeps repo-scoped developer agents in the source checkout when runtime agents are external", () => {
    const repo = path.join(dir, "source-checkout");
    const externalAgent = path.join(os.homedir(), ".local", "share", "pibot", "agents", "pibot-dev");
    const externalMgr = new AgentManager(dir, { getModels: () => [] } as never, undefined, repo);
    expect(externalMgr.workspaceFor({ dir: externalAgent, manifest: { workspace: "repo" } })).toBe(repo);
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

describe("agent capability integration", () => {
  it("makes tool use, confirmation, refusal, and source attribution explicit", () => {
    const prompt = systemPromptFor(
      { id: "a1", dir: "/tmp/a1", manifest: { name: "a1" } } as LoadedAgent,
      "/tmp/vault",
      "calendar_create is available and requires confirmation.",
    );
    expect(prompt).toContain("use its tool instead of claiming it is unavailable");
    expect(prompt).toContain("prose is not confirmation");
    expect(prompt).toContain("Policy refusals are terminal");
    expect(prompt).toContain("name the source");
  });

  it("does not grant generic filesystem tools to ordinary agents by default", () => {
    const context = {
      agent: { id: "a1", dir: "/tmp/a1", manifest: { name: "a1" } },
      workspace: "/tmp/a1", vaultDir: "/tmp/vault", scheduler: {}, chat: { transport: "test", chatId: "1" },
    } as unknown as CapabilityContext;
    expect(resolveAgentCapabilitySet(context, []).sessionTools).toEqual([]);
  });

  it("derives loaded tools and prompt text from the same available registry set", () => {
    const available: CapabilityDefinition = {
      id: "available", defaultEnabled: false, tools: ["available_tool"], prompt: "available_tool is usable.",
      create: () => ({ name: "available", factory: vi.fn() }),
    };
    const unavailable: CapabilityDefinition = {
      id: "unavailable", defaultEnabled: false, tools: ["missing_tool"], prompt: "missing_tool is usable.",
      available: () => false, create: () => ({ name: "missing", factory: vi.fn() }),
    };
    const context = {
      agent: { id: "a1", dir: "/tmp/a1", manifest: { name: "a1", tools: ["read"], capabilities: ["available", "unavailable"] } },
      workspace: "/tmp/a1", vaultDir: "/tmp/vault", scheduler: {}, chat: { transport: "test", chatId: "1" },
    } as unknown as CapabilityContext;
    const set = resolveAgentCapabilitySet(context, [available, unavailable]);
    expect(set.sessionTools).toEqual(["read", "available_tool"]);
    expect(set.systemPrompt).toContain("available_tool is usable");
    expect(set.systemPrompt).not.toContain("missing_tool is usable");
    expect(set.unavailable).toEqual(["unavailable"]);
  });

  it("does not pass a capability tool named in the legacy SDK tools list without selecting its capability", () => {
    const definition: CapabilityDefinition = {
      id: "mail", defaultEnabled: false, tools: ["mail_read"], prompt: "mail_read is usable.",
      create: () => ({ name: "mail", factory: vi.fn() }),
    };
    const context = {
      agent: { id: "a1", dir: "/tmp/a1", manifest: { name: "a1", tools: ["read", "mail_read"], capabilities: [] } },
      workspace: "/tmp/a1", vaultDir: "/tmp/vault", scheduler: {}, chat: { transport: "test", chatId: "1" },
    } as unknown as CapabilityContext;
    const set = resolveAgentCapabilitySet(context, [definition]);
    expect(set.sessionTools).toEqual(["read"]);
    expect(set.systemPrompt).not.toContain("mail_read is usable");
  });
});

describe("scrubbedBashTool", () => {
  it("runs commands without host secrets but keeps PATH and PI_*", async () => {
    const { scrubbedBashTool } = await import("./agent-manager.js");
    process.env.FAKE_API_KEY = "s3cret";
    try {
      const tool = scrubbedBashTool(process.cwd());
      expect(tool.name).toBe("bash");
      const r = await tool.execute("id", { command: "env" }, undefined, undefined, {
        cwd: process.cwd(), thinkingLevel: "off", model: { provider: "p", id: "m" },
        sessionManager: { getSessionId: () => "sid", getSessionFile: () => undefined },
      } as never);
      const out = (r.content[0] as { text: string }).text;
      expect(out).not.toContain("s3cret");
      expect(out).not.toContain("FAKE_API_KEY");
      expect(out).toMatch(/^PATH=/m);
      expect(out).toMatch(/^PI_SESSION_ID=sid/m);
    } finally {
      delete process.env.FAKE_API_KEY;
    }
  });
});

describe("live capability refresh — session staleness (bd: pibot-3w03)", () => {
  let dir: string;
  let mgr: AgentManager;

  beforeEach(() => {
    dir = tmpDir();
    mgr = new AgentManager(dir, { getModels: () => [] } as never);
    mgr.createAgent("alpha");
    fs.writeFileSync(
      path.join(dir, "alpha", "agent.json"),
      JSON.stringify({ name: "alpha", model: "anthropic/claude-opus-4-6", providers: ["anthropic"], capabilities: ["memory"] }),
    );
    return mgr.discover();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const file = () => path.join(dir, "alpha", "agent.json");

  it("flags stale only when the on-disk manifest differs from the build-time fingerprint", async () => {
    expect(mgr.isSessionStale("alpha")).toBe(false); // nothing built yet
    mgr.noteSessionBuilt("alpha");
    expect(mgr.isSessionStale("alpha")).toBe(false); // manifest unchanged on disk
    const m = JSON.parse(fs.readFileSync(file(), "utf8"));
    m.capabilities = [...(m.capabilities ?? []), "speech"];
    fs.writeFileSync(file(), JSON.stringify(m, null, 2));
    expect(mgr.isSessionStale("alpha")).toBe(true); // capability grant landed on disk
    mgr.noteSessionBuilt("alpha");
    expect(mgr.isSessionStale("alpha")).toBe(false);
  });

  it("an identical-byte rewrite (mtime-only refresh) never counts as stale", async () => {
    mgr.noteSessionBuilt("alpha");
    const before = fs.readFileSync(file(), "utf8");
    fs.writeFileSync(file(), before); // same bytes, fresh mtime (bl_raqq2k-style refresh)
    expect(mgr.isSessionStale("alpha")).toBe(false);
  });

  it("rebuilding hydrates the manifest from disk — new caps land without a restart", async () => {
    const m = JSON.parse(fs.readFileSync(file(), "utf8"));
    m.capabilities = ["memory", "speech"];
    fs.writeFileSync(file(), JSON.stringify(m, null, 2));
    (mgr as unknown as { refreshAgentFromDisk(id: string): LoadedAgent }).refreshAgentFromDisk("alpha");
    expect(mgr.getAgent("alpha")!.manifest.capabilities).toContain("speech");
  });

  it("a deleted or unreadable manifest never flags stale (fail-safe session keep)", () => {
    mgr.noteSessionBuilt("alpha");
    fs.renameSync(file(), file() + ".bak");
    expect(mgr.isSessionStale("alpha")).toBe(false);
    fs.renameSync(file() + ".bak", file());
  });
});

describe("manifest field-level updates + real capability inventory (bd pibot-4wq1)", () => {
  let dir: string;
  let mgr: AgentManager;
  const file = () => path.join(dir, "alpha", "agent.json");
  const disk = () => JSON.parse(fs.readFileSync(file(), "utf8"));

  // A scoped registry keeps the resolution deterministic: no plugin construction,
  // and "commitments" stands in for a capability this host cannot provide.
  const REGISTRY: readonly CapabilityDefinition[] = [
    { id: "memory", defaultEnabled: true, tools: ["memory_save"], create: () => ({ name: "memory", factory: () => {} }) },
    { id: "tasks", defaultEnabled: true, tools: ["start_task"], create: () => ({ name: "tasks", factory: () => {} }) },
    { id: "commitments", defaultEnabled: true, tools: ["commitment_capture"], available: () => false, create: () => ({ name: "commitments", factory: () => {} }) },
  ];

  beforeEach(async () => {
    dir = tmpDir();
    mgr = new AgentManager(dir, { getModels: () => [] } as never);
    mgr.createAgent("alpha");
    fs.writeFileSync(
      file(),
      JSON.stringify(
        {
          name: "alpha",
          model: "anthropic/claude-opus-4-6",
          providers: ["anthropic"],
          capabilities: ["memory", "tasks", "commitments"],
          speech: { sttProviders: ["whisperkit", "groq"], allowExternalStt: true },
          heartbeat: { enabled: true, interval: "45m" },
        },
        null,
        2,
      ),
    );
    await mgr.discover();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("changes only the patched field, preserving grants, providers and policy", () => {
    const r = mgr.updateManifest("alpha", { description: "calmer mornings" });
    expect(r.ok).toBe(true);
    expect(r.diff!.changed).toEqual(["description"]);
    expect(r.diff!.added).toEqual({});
    expect(r.diff!.removed).toEqual({});
    const m = disk();
    expect(m.capabilities).toEqual(["memory", "tasks", "commitments"]);
    expect(m.providers).toEqual(["anthropic"]);
    expect(m.speech).toEqual({ sttProviders: ["whisperkit", "groq"], allowExternalStt: true });
    expect(m.heartbeat).toEqual({ enabled: true, interval: "45m" });
  });

  it("a nested one-field patch preserves unrelated sibling keys on disk", () => {
    const r = mgr.updateManifest("alpha", { speech: { allowExternalStt: false } });
    expect(r.ok).toBe(true);
    expect(r.diff!.changed).toEqual(["speech"]);
    const m = disk();
    expect(m.speech).toEqual({ sttProviders: ["whisperkit", "groq"], allowExternalStt: false });
    // the untouched nested object keeps its own siblings
    expect(m.heartbeat).toEqual({ enabled: true, interval: "45m" });
  });

  it("refuses a capability replacement that would silently drop tasks and commitments", () => {
    const r = mgr.updateManifest("alpha", { capabilities: ["memory"] });
    expect(r.ok).toBe(false);
    expect(r.diff!.removed).toEqual({ capabilities: ["tasks", "commitments"] });
    expect(r.error).toMatch(/acknowledgement/);
    expect(disk().capabilities).toEqual(["memory", "tasks", "commitments"]);
  });

  it("applies an acknowledged removal and reports it as an explicit diff", () => {
    const r = mgr.updateManifest("alpha", { capabilities: ["memory", "tasks"] }, { acknowledgeRemovals: ["commitments"] });
    expect(r.ok).toBe(true);
    expect(r.diff!.removed).toEqual({ capabilities: ["commitments"] });
    expect(disk().capabilities).toEqual(["memory", "tasks"]);
  });

  it("refuses a stale write (compare-and-swap) so a concurrent edit is not clobbered", () => {
    const built = mgr.updateManifest("alpha", { description: "first" });
    const staleSha = built.sha!;
    const other = disk();
    other.description = "someone else";
    fs.writeFileSync(file(), JSON.stringify(other, null, 2));
    const refused = mgr.updateManifest("alpha", { description: "second" }, { expectedSha: staleSha });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/compare-and-swap/);
    expect(disk().description).toBe("someone else");
    const ok = mgr.updateManifest("alpha", { description: "second" }, { expectedSha: mgr.manifestSha("alpha")! });
    expect(ok.ok).toBe(true);
    expect(disk().description).toBe("second");
  });

  it("leaves the live session stale after an update so the new grant is actually re-resolved", () => {
    mgr.noteSessionBuilt("alpha");
    expect(mgr.isSessionStale("alpha")).toBe(false);
    const r = mgr.updateManifest("alpha", { capabilities: ["memory", "tasks", "commitments", "speech"] });
    expect(r.ok).toBe(true);
    expect(r.diff!.added).toEqual({ capabilities: ["speech"] });
    expect(mgr.isSessionStale("alpha")).toBe(true);
  });

  it("refuses to overwrite a manifest that is not a JSON object", () => {
    fs.writeFileSync(file(), "{ not json");
    const r = mgr.updateManifest("alpha", { description: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a JSON object/);
    expect(fs.readFileSync(file(), "utf8")).toBe("{ not json");
  });

  it("resolves a would-resolve inventory from the refreshed manifest, not the file text", () => {
    const ctx = {
      workspace: dir,
      vaultDir: dir,
      scheduler: {},
      chat: { transport: "test", chatId: "1" },
    } as unknown as Omit<CapabilityContext, "agent">;

    const before = mgr.resolveAgentInventory("alpha", ctx, REGISTRY)!;
    expect(before.requested).toEqual(["memory", "tasks", "commitments"]);
    expect(before.capabilities).toEqual(["memory", "tasks"]); // commitments is unavailable on this host
    expect(before.unavailable).toEqual(["commitments"]);
    expect(before.tools).toEqual(["memory_save", "start_task"]);
    // it is a would-resolve computation, not proof of a live session
    expect(before.resolved).toBe(true);
    expect(before.sessionBuilt).toBe(false);
    expect(before.sessionStale).toBe(false);
    expect(before.sessionActive).toBe(false);

    mgr.updateManifest("alpha", { capabilities: ["memory"] }, { acknowledgeRemovals: ["tasks", "commitments"] });

    const after = mgr.resolveAgentInventory("alpha", ctx, REGISTRY)!;
    expect(after.requested).toEqual(["memory"]);
    expect(after.capabilities).toEqual(["memory"]);
    expect(after.unavailable).toEqual([]);
    expect(after.tools).toEqual(["memory_save"]);
  });

  it("reports session built/stale/active state so an inventory is never mistaken for a live session", () => {
    const ctx = { workspace: dir, vaultDir: dir, scheduler: {}, chat: { transport: "test", chatId: "1" } } as unknown as Omit<CapabilityContext, "agent">;
    mgr.noteSessionBuilt("alpha");
    const built = mgr.resolveAgentInventory("alpha", ctx, REGISTRY)!;
    expect(built.sessionBuilt).toBe(true);
    expect(built.sessionStale).toBe(false);

    mgr.updateManifest("alpha", { description: "changed" });
    const stale = mgr.resolveAgentInventory("alpha", ctx, REGISTRY)!;
    expect(stale.sessionBuilt).toBe(true);
    expect(stale.sessionStale).toBe(true); // a real rebuild is required before a session holds the new grants
  });

  it("reports an unknown agent rather than inventing a manifest", () => {
    expect(mgr.updateManifest("ghost", { description: "x" })).toMatchObject({ ok: false });
    expect(mgr.resolveAgentInventory("ghost", {} as never, REGISTRY)).toBeUndefined();
  });
});
