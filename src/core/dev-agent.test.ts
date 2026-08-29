import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendStageLog,
  devAgentEnabled,
  DEV_AGENT_ID,
  devManifest,
  evaluateStageGate,
  scaffoldDevAgent,
  stageLogPath,
  type CheckResult,
} from "./dev-agent.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-dev-"));
}

const GREEN: CheckResult = { ok: true, summary: "clean" };
const RED: CheckResult = { ok: false, summary: "3 errors" };

describe("dev agent env gate", () => {
  it("is off by default", () => {
    expect(devAgentEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(devAgentEnabled({ PIBOT_DEV_AGENT: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(devAgentEnabled({ PIBOT_DEV_AGENT: "nope" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("accepts 1/true/yes/on", () => {
    for (const v of ["1", "true", "YES", "On"]) {
      expect(devAgentEnabled({ PIBOT_DEV_AGENT: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });
});

describe("dev manifest", () => {
  it("is react-only: no heartbeat, no evolution, bash allowed, repo workspace", () => {
    const m = devManifest();
    expect(m.name).toBe(DEV_AGENT_ID);
    expect(m.heartbeat?.enabled).toBe(false);
    expect(m.evolution?.enabled).toBe(false);
    expect(m.tools).toContain("bash");
    expect(m.workspace).toBe("repo");
  });
});

describe("scaffoldDevAgent", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds agent.json + AGENTS.md once, then is a no-op", () => {
    const first = scaffoldDevAgent(dir);
    expect(first.created).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, DEV_AGENT_ID, "agent.json"), "utf8"));
    expect(manifest.heartbeat.enabled).toBe(false);
    expect(manifest.workspace).toBe("repo");
    const persona = fs.readFileSync(path.join(dir, DEV_AGENT_ID, "AGENTS.md"), "utf8");
    expect(persona).toContain("dev_stage");
    expect(persona).toContain("NEVER");

    const second = scaffoldDevAgent(dir);
    expect(second.created).toBe(false);

    // never overwrites an existing agent with the same name
    fs.mkdirSync(path.join(dir, "other"), { recursive: true });
    expect(scaffoldDevAgent(dir).dir).toBe(path.join(dir, DEV_AGENT_ID));
  });
});

describe("evaluateStageGate", () => {
  it("passes only when typecheck AND tests are green", () => {
    expect(evaluateStageGate(GREEN, GREEN).ok).toBe(true);
    expect(evaluateStageGate(RED, GREEN).ok).toBe(false);
    expect(evaluateStageGate(RED, GREEN).reason).toContain("typecheck");
    expect(evaluateStageGate(GREEN, RED).ok).toBe(false);
    expect(evaluateStageGate(GREEN, RED).reason).toContain("tests");
    expect(evaluateStageGate(RED, RED).reason).toContain("typecheck");
  });
});

describe("stage log", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes jsonl entries and is readable back", () => {
    appendStageLog(dir, { ts: 1, commit: "a1", title: "t", rationale: "r", files: ["src/x.ts"] });
    appendStageLog(dir, { ts: 2, commit: "b2", title: "t2", rationale: "r2", files: [] });
    const lines = fs.readFileSync(stageLogPath(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ commit: "b2" });
  });
});