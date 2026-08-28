import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { applyPatch, EvolutionEngine, extractRecentProposals, validateSkillFile, validateSkillName, type EvolutionIO, type EvolutionProposal } from "./evolution.js";
import { EventLog } from "./events.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-evo-"));
}

describe("validateSkillName", () => {
  it("accepts kebab-case names", () => {
    expect(validateSkillName("weekly-review")).toBe(true);
    expect(validateSkillName("a")).toBe(false);
    expect(validateSkillName("Bad_Name")).toBe(false);
    expect(validateSkillName("has--double")).toBe(false);
    expect(validateSkillName("ok-name-2")).toBe(true);
  });
});

describe("validateSkillFile", () => {
  const good = "# Title\n\n## Steps\n- do a\n- do b\n";
  it("accepts a well-formed skill", () => {
    expect(validateSkillFile("my-skill", "Use when the user asks for X", good).ok).toBe(true);
  });
  it("rejects short descriptions, oversize bodies, structureless bodies", () => {
    expect(validateSkillFile("my-skill", "short", good).ok).toBe(false);
    expect(validateSkillFile("my-skill", "Use when the user asks for X", "x".repeat(16_000)).ok).toBe(false);
    expect(validateSkillFile("my-skill", "Use when the user asks for X", "plain text with no structure").ok).toBe(false);
    expect(validateSkillFile("Bad!", "Use when the user asks for X", good).ok).toBe(false);
  });
});

describe("applyPatch", () => {
  it("applies unique replacements and rejects misses/ambiguity", () => {
    expect(applyPatch("hello world", "world", "there")).toEqual({ ok: true, result: "hello there" });
    expect(applyPatch("hello", "x", "y").ok).toBe(false);
    expect(applyPatch("a a", "a", "b").ok).toBe(false);
  });
});

describe("EvolutionEngine", () => {
  let dir: string;
  let agents: AgentManager;
  let events: EventLog;
  let io: EvolutionIO;
  let announced: string[];
  let engine: import("./evolution.js").EvolutionEngine;

  function makeProposal(over: Partial<EvolutionProposal> = {}): EvolutionProposal {
    return {
      mode: "create",
      skillName: "morning-brief",
      description: "Use when the user starts the day and wants a briefing.",
      content: "# Morning brief\n\n## Steps\n- greet\n- show schedules\n",
      rationale: "test rationale",
      probes: [{ task: "give me a morning brief", criteria: "responds with a brief" }],
      ...over,
    };
  }

  beforeEach(() => {
    dir = tmpDir();
    agents = new AgentManager(dir, { getModels: () => [] } as never);
    agents.createAgent("assistant");
    events = new EventLog(dir);
    announced = [];
    io = {
      propose: vi.fn(async () => ({
        mode: "create" as const,
        skillName: "morning-brief",
        description: "Use when the user starts the day and wants a briefing.",
        content: "# Morning brief\n\n## Steps\n- greet\n- list schedule\n",
        rationale: "keeps mornings smooth",
        probes: [{ task: "morning brief please", criteria: "short structured brief" }],
      })),
      runProbe: vi.fn(async () => "Here is your brief: 1) greet 2) schedule."),
      judge: vi.fn(async () => 5),
    };
    engine = new EvolutionEngine({ agents, modelRuntime: {} as never, events, dataDir: dir, host: { announce: async (id, t) => { announced.push(`${id}:${t}`); } }, io });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("promotes a passing proposal to the live skills dir and cleans staging", async () => {
    const report = await engine.evolve("assistant", "mornings");
    expect(report.ok).toBe(true);
    expect(report.promoted).toBe(true);
    const live = path.join(dir, "assistant", "skills", "morning-brief", "SKILL.md");
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.readFileSync(live, "utf8")).toContain("Morning brief");
    expect(engine.staged("assistant")).toEqual([]);
    expect(announced.length).toBe(1);
    expect(announced[0]).toContain("morning-brief");
  });

  it("stays staged when probes score low", async () => {
    (io.judge as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    const report = await engine.evolve("assistant", "mornings");
    expect(report.staged).toBe(true);
    expect(engine.staged("assistant")).toEqual(["morning-brief"]);
    expect(fs.existsSync(path.join(dir, "assistant", "skills", "morning-brief", "SKILL.md"))).toBe(false);
  });

  it("manual promote moves a staged candidate", async () => {
    (io.judge as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    await engine.evolve("assistant", "mornings");
    expect(engine.promote("assistant", "morning-brief")).toBe(true);
    expect(engine.staged("assistant")).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "assistant", "skills", "morning-brief", "SKILL.md"))).toBe(true);
  });

  it("gates reject invalid proposals before staging", async () => {
    (io.propose as ReturnType<typeof vi.fn>).mockResolvedValue({
      mode: "create",
      skillName: "Bad Name",
      description: "Use when…",
      content: "body",
      rationale: "x",
      probes: [{ task: "t", criteria: "c" }],
    });
    const report = await engine.evolve("assistant", "g");
    expect(report.ok).toBe(false);
    expect(report.errors?.join(" ")).toContain("invalid skill name");
    expect(engine.staged("assistant")).toHaveLength(0);
  });

  it("gates reject patching a nonexistent skill", async () => {
    (io.propose as ReturnType<typeof vi.fn>).mockResolvedValue({
      mode: "patch",
      skillName: "ghost-skill",
      description: "Use when x happens during the day.",
      find: "a",
      replace: "b",
      rationale: "x",
      probes: [{ task: "t", criteria: "c" }],
    });
    const report = await engine.evolve("assistant", "g");
    expect(report.ok).toBe(false);
    expect(report.errors?.join(" ")).toContain("does not exist");
  });

  it("enforces the daily budget unless forced", async () => {
    let n = 0;
    (io.propose as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      n++;
      return makeProposal({ skillName: `skill-${n}`, description: "Use when the daily budget is being tested.", content: "# S\n\n## Steps\n- a\n- b\n" });
    });
    for (let i = 0; i < 4; i++) await engine.evolve("assistant", "g", { force: true });
    const blocked = await engine.evolve("assistant", "g");
    expect(blocked.ok).toBe(false);
    expect(blocked.summary).toContain("budget");
    const forced = await engine.evolve("assistant", "g", { force: true });
    expect(forced.ok).toBe(true);
  });

  it("reject handles staged skills", async () => {
    (io.judge as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    await engine.evolve("assistant", "mornings");
    expect(engine.reject("assistant", "morning-brief")).toBe(true);
    expect(engine.staged("assistant")).toHaveLength(0);
  });
});
describe("extractRecentProposals", () => {
  it("pulls deduplicated titles from evolution events", () => {
    const entries = [
      { type: "system", summary: 'evolution: create "morning-brief" staged, probes [4, 5]' },
      { type: "system", summary: 'evolution: create "morning-brief" staged, probes [4, 5]' },
      { type: "system", summary: "evolution: promoted skill morning-brief" },
      { type: "message", summary: "hello" },
    ];
    expect(extractRecentProposals(entries)).toEqual(["morning-brief"]);
  });
});
