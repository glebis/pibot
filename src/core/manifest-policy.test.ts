import { describe, expect, it } from "vitest";
import { diffManifest, planManifestPatch, sha256Hex } from "./manifest-policy.js";
import type { AgentManifest } from "./types.js";

const base: AgentManifest = {
  name: "alpha",
  description: "keeps mornings calm",
  model: "anthropic/claude-opus-4-6",
  providers: ["anthropic"],
  capabilities: ["memory", "tasks", "commitments"],
  speech: { sttProviders: ["whisperkit", "groq"], allowExternalStt: true },
  heartbeat: { enabled: true, interval: "45m" },
};

describe("diffManifest", () => {
  it("reports list additions, removals and untouched fields", () => {
    const next: AgentManifest = { ...base, capabilities: ["memory", "speech"] };
    const diff = diffManifest(base, next);
    expect(diff.changed).toEqual(["capabilities"]);
    expect(diff.added).toEqual({ capabilities: ["speech"] });
    expect(diff.removed).toEqual({ capabilities: ["tasks", "commitments"] });
    expect(diff.preserved).toContain("speech");
    expect(diff.preserved).toContain("providers");
  });
});

describe("planManifestPatch", () => {
  it("changes only the patched field and preserves every other authorised field", () => {
    const plan = planManifestPatch(base, { description: "quieter mornings" });
    expect(plan.ok).toBe(true);
    expect(plan.diff.changed).toEqual(["description"]);
    expect(plan.diff.added).toEqual({});
    expect(plan.diff.removed).toEqual({});
    expect(plan.manifest).toMatchObject({
      description: "quieter mornings",
      capabilities: ["memory", "tasks", "commitments"],
      providers: ["anthropic"],
      speech: { sttProviders: ["whisperkit", "groq"], allowExternalStt: true },
      heartbeat: { enabled: true, interval: "45m" },
    });
  });

  it("merges a nested one-field patch and preserves unrelated sibling keys", () => {
    const plan = planManifestPatch(base, { speech: { allowExternalStt: false } });
    expect(plan.ok).toBe(true);
    expect(plan.diff.changed).toEqual(["speech"]);
    expect(plan.manifest?.speech).toEqual({ sttProviders: ["whisperkit", "groq"], allowExternalStt: false });
  });

  it("preserves deeper siblings of a nested patch too", () => {
    const withProactive: AgentManifest = { ...base, proactive: { pilot: true, dailyBudget: 3, precheckLead: "12h" } };
    const plan = planManifestPatch(withProactive, { proactive: { dailyBudget: 5 } });
    expect(plan.ok).toBe(true);
    expect(plan.manifest?.proactive).toEqual({ pilot: true, dailyBudget: 5, precheckLead: "12h" });
  });

  it("deletes a nested key only when the patch sets that key to undefined", () => {
    const plan = planManifestPatch(base, { speech: { sttProviders: undefined } });
    expect(plan.ok).toBe(true);
    expect(plan.manifest?.speech).toEqual({ allowExternalStt: true });
  });

  it("clears a field only when the patch sets it to undefined", () => {
    const plan = planManifestPatch(base, { model: undefined });
    expect(plan.ok).toBe(true);
    expect(plan.manifest && "model" in plan.manifest).toBe(false);
    expect(plan.manifest?.capabilities).toEqual(["memory", "tasks", "commitments"]);
  });

  it("refuses a capability replacement that would silently drop grants", () => {
    const plan = planManifestPatch(base, { capabilities: ["memory"] });
    expect(plan.ok).toBe(false);
    expect(plan.manifest).toBeUndefined();
    expect(plan.diff.removed).toEqual({ capabilities: ["tasks", "commitments"] });
    expect(plan.error).toMatch(/without explicit acknowledgement/);
    expect(plan.error).toContain("tasks");
  });

  it("applies an acknowledged removal and still reports it as an explicit diff", () => {
    const plan = planManifestPatch(base, { capabilities: ["memory", "tasks"] }, { acknowledgeRemovals: ["commitments"] });
    expect(plan.ok).toBe(true);
    expect(plan.diff.removed).toEqual({ capabilities: ["commitments"] });
    expect(plan.manifest?.capabilities).toEqual(["memory", "tasks"]);
  });

  it("guards tools and providers removals the same way", () => {
    const current: AgentManifest = { ...base, tools: ["read", "bash"], providers: ["anthropic", "openai"] };
    const refused = planManifestPatch(current, { providers: ["anthropic"] });
    expect(refused.ok).toBe(false);
    expect(refused.diff.removed).toEqual({ providers: ["openai"] });
    const allowed = planManifestPatch(current, { providers: ["anthropic"] }, { acknowledgeRemovals: ["openai"] });
    expect(allowed.ok).toBe(true);
  });

  it("never widens access on its own — a list is only as large as the patch says", () => {
    const plan = planManifestPatch(base, { capabilities: ["memory", "tasks", "commitments"] });
    expect(plan.ok).toBe(true);
    expect(plan.diff.changed).toEqual([]);
    expect(plan.manifest?.capabilities).toEqual(["memory", "tasks", "commitments"]);
  });

  it("allows an explicit grant without an acknowledgement", () => {
    const plan = planManifestPatch(base, { capabilities: [...base.capabilities!, "speech"] });
    expect(plan.ok).toBe(true);
    expect(plan.diff.added).toEqual({ capabilities: ["speech"] });
    expect(plan.diff.removed).toEqual({});
  });

  it("refuses a write when the manifest changed since it was read (compare-and-swap)", () => {
    const stale = planManifestPatch(base, { description: "x" }, { expectedSha: "aaaa", currentSha: "bbbb" });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/compare-and-swap/);
    const fresh = planManifestPatch(base, { description: "x" }, { expectedSha: "same", currentSha: "same" });
    expect(fresh.ok).toBe(true);
  });
});

describe("sha256Hex", () => {
  it("is stable and sensitive to a single byte", () => {
    expect(sha256Hex("{}")).toBe(sha256Hex("{}"));
    expect(sha256Hex("{}")).not.toBe(sha256Hex("{ }"));
  });
});
