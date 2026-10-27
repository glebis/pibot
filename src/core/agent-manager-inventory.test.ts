import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A freshly built session must expose the capability set the host ACTUALLY authorised
 * (bd pibot-4wq1). These tests drive the genuine `AgentManager.getOrCreateSession` with a
 * mocked SDK session object, so the inventory is captured where the host builds sessions —
 * not from a would-resolve helper with no runtime caller. Nothing here is a live/production
 * claim; no session, model, or grant is created outside the mocked build path.
 */

const { captured } = vi.hoisted(() => ({
  // "reflect": the mocked session reports the tools it was built with (a faithful SDK)
  // "narrow":  the mocked session reports a narrowed live tool set (proves a live read)
  // "none":    the mocked session exposes no introspection (missing-introspection case)
  captured: { mode: "reflect" as "reflect" | "narrow" | "none" },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getAgentDir: () => path.join(os.tmpdir(), "pibot-agent-dir-stub"),
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { open: vi.fn(() => ({})), create: vi.fn(() => ({})) },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    createAgentSession: vi.fn(async (opts: { tools?: string[] }) => {
      const built = [...(opts.tools ?? [])];
      const session: Record<string, unknown> = {
        sessionFile: undefined,
        prompt: async () => {},
        dispose() {},
        agent: { state: { messages: [] } },
      };
      if (captured.mode !== "none") {
        // mirrors the SDK's own accessor: the ACTUAL active tool names of the built session
        session.getActiveToolNames = () =>
          captured.mode === "narrow" ? built.filter((t) => t !== "dictionary_remove") : [...built];
      }
      return { session, modelFallbackMessage: undefined };
    }),
  };
});

const { AgentManager, formatSessionInventory } = await import("./agent-manager.js");

const schedulerStub = { register: vi.fn() } as never;

describe("built-session capability inventory (bd pibot-4wq1)", () => {
  let dir: string;
  let mgr: InstanceType<typeof AgentManager>;
  const manifestFile = () => path.join(dir, "alpha", "agent.json");
  const build = (chatKey = "telegram:1") =>
    mgr.getOrCreateSession("alpha", chatKey, { transport: "telegram", chatId: chatKey.split(":")[1] }, schedulerStub);

  beforeEach(async () => {
    captured.mode = "reflect";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-am-inv-"));
    mgr = new AgentManager(dir, { getModels: () => [] } as never, undefined, undefined, dir);
    mgr.createAgent("alpha");
    // memory + dictionary are available on this host; commitments needs ctx.commitments → unavailable
    fs.writeFileSync(
      manifestFile(),
      JSON.stringify({ name: "alpha", capabilities: ["memory", "dictionary", "commitments"] }, null, 2),
    );
    await mgr.discover();
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("captures the actual authorised ids and the session's live active tools at build", async () => {
    await build();
    const inv = mgr.sessionInventory("alpha", "telegram:1")!;
    expect(inv.sessionKey).toBe("alpha::telegram:1");
    expect(inv.evidence).toBe("live-session");
    expect(inv.capabilities).toEqual(["memory", "dictionary"]);
    expect(inv.unavailable).toEqual(["commitments"]);
    expect(inv.activeTools).toEqual(["memory_save", "memory_recall", "dictionary_add", "dictionary_list", "dictionary_remove"]);
    expect(inv.authorisedTools).toEqual(inv.activeTools);
    expect(inv.activeTools).not.toContain("commitment_capture"); // an unavailable grant is never exposed
    expect(inv.capabilityContext).toContain("memory_save");
    expect(inv.stale).toBe(false);
    expect(inv.builtManifestSha).toBe(mgr.manifestSha("alpha"));
    expect(formatSessionInventory(inv)).toContain("[session-inventory live-session]");
  });

  it("reads the session's LIVE tool names, not merely the set the build requested", async () => {
    captured.mode = "narrow";
    await build();
    const inv = mgr.sessionInventory("alpha", "telegram:1")!;
    expect(inv.evidence).toBe("live-session");
    expect(inv.activeTools).toEqual(["memory_save", "memory_recall", "dictionary_add", "dictionary_list"]);
    expect(inv.authorisedTools).toContain("dictionary_remove"); // requested by the build, absent from the live session
  });

  it("a one-field manifest patch leaves the OLD inventory stale until a real rebuild", async () => {
    await build();
    const before = mgr.sessionInventory("alpha", "telegram:1")!;
    expect(mgr.updateManifest("alpha", { description: "calmer mornings" }).ok).toBe(true);

    const stale = mgr.sessionInventory("alpha", "telegram:1")!;
    expect(stale.stale).toBe(true);
    expect(stale.currentManifestSha).not.toBe(stale.builtManifestSha);
    expect(stale.capabilities).toEqual(before.capabilities); // snapshot preserved, never silently refreshed
    expect(stale.activeTools).toEqual(before.activeTools);
    expect(stale.unavailable).toEqual(before.unavailable);
    expect(mgr.isSessionStale("alpha", "telegram:1")).toBe(true);
  });

  it("a rebuild yields the correct preserved authorised ids/tools and no unavailable grant", async () => {
    await build();
    mgr.updateManifest("alpha", { description: "calmer mornings" });
    await mgr.resetSession("alpha", "telegram:1", { transport: "telegram", chatId: "1" }, schedulerStub);
    expect(mgr.sessionInventory("alpha", "telegram:1")).toBeUndefined(); // reset clears the inventory

    await build();
    const rebuilt = mgr.sessionInventory("alpha", "telegram:1")!;
    expect(rebuilt.stale).toBe(false);
    expect(rebuilt.capabilities).toEqual(["memory", "dictionary"]);
    expect(rebuilt.activeTools).toEqual(["memory_save", "memory_recall", "dictionary_add", "dictionary_list", "dictionary_remove"]);
    expect(rebuilt.unavailable).toEqual(["commitments"]);
    expect(rebuilt.activeTools).not.toContain("commitment_capture");
  });

  it("a refreshed session exposes a newly authorised capability", async () => {
    await build();
    expect(mgr.sessionInventory("alpha", "telegram:1")!.capabilities).toEqual(["memory", "dictionary"]);
    expect(mgr.updateManifest("alpha", { capabilities: ["memory", "dictionary", "commitments", "calendar-read"] }).ok).toBe(true);
    await mgr.resetSession("alpha", "telegram:1", { transport: "telegram", chatId: "1" }, schedulerStub);
    await build();
    const inv = mgr.sessionInventory("alpha", "telegram:1")!;
    expect(inv.capabilities).toEqual(["memory", "dictionary", "calendar-read"]);
    expect(inv.activeTools).toContain("calendar_today");
    expect(inv.unavailable).toEqual(["commitments"]); // still not granted, still recorded
  });

  it("marks missing introspection explicitly unknown — never a false live claim", async () => {
    captured.mode = "none";
    await build();
    const inv = mgr.sessionInventory("alpha", "telegram:1")!;
    expect(inv.evidence).toBe("unknown");
    expect(inv.activeTools).toBeNull();
    expect(inv.capabilities).toEqual(["memory", "dictionary"]); // the authorised set is still recorded
    expect(formatSessionInventory(inv)).toContain("active tools unknown");
    expect(formatSessionInventory(inv)).not.toContain("live-session");
  });

  it("keeps each session's snapshot independent — rebuilding one never refreshes another", async () => {
    await build("telegram:1");
    await build("telegram:2");
    mgr.updateManifest("alpha", { description: "changed" });
    await mgr.resetSession("alpha", "telegram:1", { transport: "telegram", chatId: "1" }, schedulerStub);
    await build("telegram:1");
    expect(mgr.sessionInventory("alpha", "telegram:1")!.stale).toBe(false);
    expect(mgr.sessionInventory("alpha", "telegram:2")!.stale).toBe(true);
  });

  it("reports no inventory for a session that was never built", () => {
    expect(mgr.sessionInventory("alpha", "telegram:9")).toBeUndefined();
  });
});
