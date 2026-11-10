import { describe, expect, it } from "vitest";
import { formatRecoveryDelegation, missingPrerequisiteMessage, validateRecoveryEnvelope } from "./recovery-envelope.js";

// bd pibot-0xpf.6: recovery carries original intent, canonical ID, paths and scope —
// never reconstructed from a refusal quote or invented.
describe("recovery envelope (bd pibot-0xpf.6)", () => {
  it("validates a complete envelope and renders the delegation text", () => {
    const v = validateRecoveryEnvelope({
      taskId: "tmw9g1wu99zlj",
      originalRequest: "which browser automation tool did I ask about on Saturday?",
      paths: ["Sources/20261105-video-editing-skills-landscape.md"],
      scope: "vault root (live files; hidden/symlinks excluded)",
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const text = formatRecoveryDelegation(v.envelope);
    expect(text).toContain("task tmw9g1wu99zlj");
    expect(text).toContain("which browser automation tool did I ask about");
    expect(text).toContain("Sources/20261105-video-editing-skills-landscape.md");
    expect(text).toContain("Do not ask the owner to repeat it");
  });

  it("reports the exact missing prerequisite instead of inventing the request", () => {
    const missing = validateRecoveryEnvelope({ taskId: "t1", scope: "vault", paths: [] });
    expect(missing).toEqual({ ok: false, reason: "missing-original-request" });
    if (missing.ok) throw new Error("expected missing");
    expect(missingPrerequisiteMessage(missing)).toContain("original owner request");
    expect(missingPrerequisiteMessage(missing)).toContain("bounded clarification");
  });

  it("refuses to invent a canonical task id (would risk duplicate search/task)", () => {
    const v = validateRecoveryEnvelope({ originalRequest: "q", scope: "vault" });
    expect(v).toEqual({ ok: false, reason: "missing-task-id" });
    if (v.ok) throw new Error("expected missing");
    expect(missingPrerequisiteMessage(v)).toContain("duplicate");
  });

  it("refuses without a recorded scope so coverage caveats are never dropped", () => {
    expect(validateRecoveryEnvelope({ taskId: "t", originalRequest: "q" })).toEqual({ ok: false, reason: "missing-scope" });
  });

  it("keeps coverage caveats explicit in the delegation", () => {
    const v = validateRecoveryEnvelope({
      taskId: "t",
      originalRequest: "q",
      scope: "Sources/",
      coverageCaveats: ["live files, not an index", "concurrent edits are not a consistent snapshot"],
      paths: [],
    });
    if (!v.ok) throw new Error("expected ok");
    expect(formatRecoveryDelegation(v.envelope)).toContain("live files, not an index");
  });
});
