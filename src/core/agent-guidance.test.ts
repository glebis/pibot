import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRIFT_ANTI_PATTERNS, FAILURE_SIGNAL_RULE, OUTCOME_HONESTY } from "./agent-guidance.js";

const templatesDir = fileURLToPath(new URL("../../agents/_template/", import.meta.url));

describe("agent guidance fragments (bd pibot-yit)", () => {
  it("names the failure-signal escalation rule and its classifications", () => {
    expect(FAILURE_SIGNAL_RULE).toContain("retried once");
    expect(FAILURE_SIGNAL_RULE).toMatch(/transient/);
    expect(FAILURE_SIGNAL_RULE).toMatch(/structural/);
    expect(FAILURE_SIGNAL_RULE).toMatch(/drift/);
  });

  it("names every drift anti-pattern", () => {
    for (const pattern of ["task-queue mode", "report mode", "permission mode", "amnesia", "identity collapse"]) {
      expect(DRIFT_ANTI_PATTERNS).toContain(pattern);
    }
  });
});

describe("agent guidance fragments (bd pibot-9qg)", () => {
  it("names the three outcome-honesty tiers", () => {
    for (const tier of ["solved", "best_effort", "blocked_with_evidence"]) {
      expect(OUTCOME_HONESTY).toContain(tier);
    }
  });
});

describe("scaffolding templates", () => {
  it("carry the same operating discipline into new agents", () => {
    const heartbeat = fs.readFileSync(path.join(templatesDir, "HEARTBEAT.md"), "utf8");
    const persona = fs.readFileSync(path.join(templatesDir, "AGENTS.md"), "utf8");
    for (const text of [heartbeat, persona]) {
      expect(text).toContain("Failure-signal escalation");
      expect(text).toContain("Outcome honesty");
      expect(text).toContain("task-queue mode");
    }
  });
});
