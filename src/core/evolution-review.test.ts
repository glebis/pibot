import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { EvolutionEngine } from "./evolution.js";
import { EventLog } from "./events.js";

const content = "---\nname: sample-skill\ndescription: Use when testing a reviewed candidate.\n---\n# Candidate\n- verify recipient\n";

describe("evolution admin review safety", () => {
  let dir: string;
  let engine: EvolutionEngine;
  let events: EventLog;
  let skills: string;
  const stage = (name = "sample-skill", text = content) => {
    const target = path.join(skills, ".staging", name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), text);
    return target;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-review-"));
    const agents = new AgentManager(dir, { getModels: () => [] } as never);
    agents.createAgent("assistant");
    agents.createAgent("coach");
    skills = path.join(dir, "assistant", "skills");
    events = new EventLog(dir);
    engine = new EvolutionEngine({ agents, events, modelRuntime: {} as never, dataDir: dir,
      host: { announce: vi.fn(async () => {}) }, io: {} as never });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("compares actual installed content and returns only recorded matching evolution events", () => {
    stage();
    fs.mkdirSync(path.join(skills, "sample-skill"), { recursive: true });
    fs.writeFileSync(path.join(skills, "sample-skill", "SKILL.md"), "installed body");
    events.log("assistant", "system", "evolution: promoted skill sample-skill");
    events.log("assistant", "system", "evolution: promoted skill sample-skill-extra");
    events.log("assistant", "message", "user mentioned sample-skill");
    const review = engine.reviewDetail("assistant", "sample-skill")!;
    expect(review.currentContent).toBe("installed body");
    expect(review.content).toBe(content);
    expect(review.history).toHaveLength(1);
    expect(review.history[0].summary).toBe("evolution: promoted skill sample-skill");
    expect(engine.reviewDetail("coach", "sample-skill")).toBeUndefined();
  });

  it("archives all sidecars, drops stale decision tokens and restores after listing the durable archive", () => {
    const staged = stage();
    fs.writeFileSync(path.join(staged, ".backlog.json"), JSON.stringify({ ids: ["backlog-1"] }));
    const token = engine.reviewToken("assistant", "sample-skill");
    const receipt = engine.archive("assistant", "sample-skill")!;
    expect(receipt).toMatch(/^[a-f0-9]{24}$/);
    expect(engine.staged("assistant")).toEqual([]);
    expect(engine.resolveReviewToken(token)).toBeUndefined();
    const archived = engine.archivedDetail("assistant");
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ archiveId: receipt, content, closesBacklog: ["backlog-1"] });
    expect(engine.restore("coach", "sample-skill", receipt)).toBe(false);
    expect(engine.restore("assistant", "another-skill", receipt)).toBe(false);
    expect(engine.restore("assistant", "sample-skill", receipt)).toBe(true);
    expect(engine.archivedDetail("assistant")).toEqual([]);
    expect(engine.reviewDetail("assistant", "sample-skill")!.history.at(-1)!.summary).toContain("restored");
    expect(fs.readFileSync(path.join(staged, ".backlog.json"), "utf8")).toContain("backlog-1");
    expect(engine.restore("assistant", "sample-skill", receipt)).toBe(false);
  });

  it("refuses Undo when a newer proposal is staged and keeps both candidates intact", () => {
    stage();
    const receipt = engine.archive("assistant", "sample-skill")!;
    stage("sample-skill", "newer proposal");
    expect(engine.restore("assistant", "sample-skill", receipt)).toBe(false);
    expect(engine.stagedContent("assistant", "sample-skill")).toBe("newer proposal");
    expect(engine.archivedDetail("assistant")[0].content).toBe(content);
  });

  it("keeps archived probe evidence unchanged when the same skill is proposed again", () => {
    stage();
    events.log("assistant", "system", 'evolution: create "sample-skill" staged, probes [2, 3]');
    const receipt = engine.archive("assistant", "sample-skill")!;
    stage();
    events.log("assistant", "system", 'evolution: patch "sample-skill" staged, probes [5]');
    expect(engine.archivedDetail("assistant")[0]).toMatchObject({ archiveId: receipt, scores: [2, 3] });
    expect(engine.stagedDetail("assistant")[0].scores).toEqual([5]);
  });

  it("will not promote through an existing backup symlink", () => {
    stage();
    const live = path.join(skills, "sample-skill");
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "SKILL.md"), "installed body");
    const external = path.join(dir, "external-backup");
    fs.writeFileSync(external, "keep me");
    fs.symlinkSync(external, path.join(live, "SKILL.md.bak"));
    expect(engine.promote("assistant", "sample-skill")).toBe(false);
    expect(fs.readFileSync(external, "utf8")).toBe("keep me");
    expect(engine.currentContent("assistant", "sample-skill")).toBe("installed body");
    expect(engine.stagedContent("assistant", "sample-skill")).toBe(content);
  });

  it("reject now preserves the proposal in the recoverable archive", () => {
    stage();
    expect(engine.reject("assistant", "sample-skill")).toBe(true);
    expect(engine.archivedDetail("assistant")[0].content).toBe(content);
  });

  it("rejects traversal names, malformed receipts and unknown agents without reading or mutating files", () => {
    stage();
    for (const name of ["../sample-skill", "sample-skill/../../state", "sample-skill\\..", ".staging", ""]) {
      expect(engine.stagedContent("assistant", name)).toBeUndefined();
      expect(engine.currentContent("assistant", name)).toBeUndefined();
      expect(engine.reviewDetail("assistant", name)).toBeUndefined();
      expect(engine.promote("assistant", name)).toBe(false);
      expect(engine.archive("assistant", name)).toBeUndefined();
      expect(engine.restore("assistant", name, "a".repeat(24))).toBe(false);
    }
    expect(engine.staged("unknown")).toEqual([]);
    expect(engine.archivedDetail("unknown")).toEqual([]);
    expect(engine.restore("assistant", "sample-skill", "../receipt")).toBe(false);
    expect(engine.stagedContent("assistant", "sample-skill")).toBe(content);
  });

  it("does not follow candidate, installed, archive or file symlinks outside skills", () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "SKILL.md"), "private outside text");
    fs.mkdirSync(path.join(skills, ".staging"), { recursive: true });
    fs.symlinkSync(outside, path.join(skills, ".staging", "sample-skill"));
    fs.symlinkSync(outside, path.join(skills, "sample-skill"));
    fs.symlinkSync(outside, path.join(skills, ".archive"));
    expect(engine.stagedContent("assistant", "sample-skill")).toBeUndefined();
    expect(engine.currentContent("assistant", "sample-skill")).toBeUndefined();
    expect(engine.archive("assistant", "sample-skill")).toBeUndefined();
    expect(engine.promote("assistant", "sample-skill")).toBe(false);
    expect(engine.archivedDetail("assistant")).toEqual([]);
    expect(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8")).toBe("private outside text");
    const staged = stage("another-skill");
    fs.unlinkSync(path.join(staged, "SKILL.md"));
    fs.symlinkSync(path.join(outside, "SKILL.md"), path.join(staged, "SKILL.md"));
    expect(engine.stagedContent("assistant", "another-skill")).toBeUndefined();
    expect(engine.stagedDetail("assistant")).toEqual([]);
  });
});
