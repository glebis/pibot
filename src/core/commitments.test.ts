import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager.js";
import { EventLog } from "./events.js";
import { Scheduler } from "./scheduler.js";
import { ProactiveStore, parseCommitDue } from "./proactive-store.js";
import { CommitmentEngine, precheckAt, commitmentCard, nudgeCard } from "./commitments.js";
import type { Card, Schedule } from "./types.js";
import type { Commitment } from "./proactive-store.js";

const DAY = 86_400e3;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-cm-"));
}

interface Harness {
  dir: string;
  store: ProactiveStore;
  scheduler: Scheduler;
  events: EventLog;
  pushChat: ReturnType<typeof vi.fn>;
  deliverToAgent: ReturnType<typeof vi.fn>;
  engine: CommitmentEngine;
  now: number;
  manifest: { proactive?: { pilot?: boolean; dailyBudget?: number } };
}

function makeEngine(opts: {
  pilot?: boolean;
  dailyBudget?: number;
  suggestNextAction?: (agentId: string, text: string) => Promise<string>;
  now?: number;
}): Harness {
  const dir = tmpDir();
  const manifest = { name: "assistant", proactive: { pilot: opts.pilot !== false, ...(opts.dailyBudget != null ? { dailyBudget: opts.dailyBudget } : {}) } };
  const agents = { getAgent: (id: string) => ({ id, dir: path.join(dir, id), manifest }) } as unknown as AgentManager;
  const store = new ProactiveStore(dir);
  const scheduler = new Scheduler(path.join(dir, "data"), () => {});
  const events = new EventLog(dir);
  const pushChat = vi.fn(async (_chat: { transport: string; chatId: string }, _text: string, _card?: Card) => true);
  const deliverToAgent = vi.fn(async (_agentId: string, _text: string, _card?: Card) => true);
  const now = opts.now ?? Date.now();
  const engine = new CommitmentEngine({
    agents,
    scheduler,
    events,
    store,
    bot: { pushChat, deliverToAgent },
    suggestNextAction: opts.suggestNextAction,
    now: () => now,
  });
  return { dir, store, scheduler, events, pushChat, deliverToAgent, engine, now, manifest };
}

function jobsFor(h: Harness, groupId: string): Schedule[] {
  return h.scheduler.list("assistant", { includePaused: true }).filter((j) => j.groupId === groupId);
}


function mustCommit(r: { commitment?: Commitment; reply: string }): Commitment {
  const c = r.commitment;
  if (!c) throw new Error("capture produced no commitment");
  return c;
}

describe("CommitmentEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captureExplicit: active commitment + pre-check & deadline jobs sharing a group", () => {
    const h = makeEngine({ now: 1_700_000_000_000 });
    const due = h.now + 3 * DAY;
    const { reply, commitment: c } = h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "send invoice to Anna", due);
    if (!c) throw new Error("no commitment");
    expect(c.status).toBe("active");
    expect(c.origin).toBe("explicit");
    expect(c.groupId).toMatch(/^cmg/);
    expect(reply).toContain(c.id);
    const jobs = jobsFor(h, c.groupId!);
    expect(jobs).toHaveLength(2);
    const stages = jobs.map((j) => j.detail).sort();
    expect(stages).toEqual([`cm:${c.id}:deadline`, `cm:${c.id}:precheck`].sort());
    expect(jobs.every((j) => j.kind === "commitment" && j.delivery === "direct")).toBe(true);
    expect(jobs.find((j) => j.detail === `cm:${c.id}:deadline`)!.dueAt).toBe(due);
    expect(jobs.find((j) => j.detail === `cm:${c.id}:precheck`)!.dueAt).toBe(due - DAY);
  });

  it("captureExplicit with tight deadline: pre-check lands at the midpoint", () => {
    const h = makeEngine({ now: 1_700_000_000_000 });
    const due = h.now + 6 * 3600e3;
    const c = mustCommit(h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "call back Sam", due));
    const pre = jobsFor(h, c.groupId!).find((j) => j.detail === `cm:${c.id}:precheck`)!;
    expect(pre.dueAt).toBeGreaterThanOrEqual(h.now + 5 * 60e3);
    expect(pre.dueAt).toBeLessThan(due);
  });

  it("onFire pre-check pushes the card and records delivered", () => {
    const h = makeEngine({ now: 1_700_000_000_000 });
    const c = mustCommit(h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "send invoice", h.now + 3 * DAY));
    const job = jobsFor(h, c.groupId!).find((j) => j.detail === `cm:${c.id}:precheck`)!;
    return h.engine.onFire(job).then(() => {
      expect(h.pushChat).toHaveBeenCalledTimes(1);
      const [, text, card] = h.pushChat.mock.calls[0];
      expect(text).toContain("send invoice");
      expect(card.buttons.map((b: { action: string }) => b.action)).toEqual([
        `cm:${c.id}:track`,
        `cm:${c.id}:block`,
        `cm:${c.id}:reneg:1d`,
        `cm:${c.id}:reneg:3d`,
        `cm:${c.id}:reneg:7d`,
        `cm:${c.id}:cancel`,
      ]);
      expect(h.store.events({ commitmentId: c.id }).some((e) => e.stage === "delivered")).toBe(true);
    });
  });

  it("action flow: track → acted; block → one follow-up with suggestion; done → completed + rating card", async () => {
    const h = makeEngine({
      now: 1_700_000_000_000,
      suggestNextAction: async () => "Draft the invoice template now.",
    });
    const c = mustCommit(h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "send invoice", h.now + 3 * DAY));
    expect(await h.engine.handleAction(`cm:${c.id}:track`, "42")).toContain("On track");
    expect(h.store.events({ commitmentId: c.id }).filter((e) => e.stage === "acted")).toHaveLength(1);

    await h.engine.handleAction(`cm:${c.id}:block`, "42");
    const followUp = h.pushChat.mock.calls.find((call) => String(call[1]).includes("invoice template"));
    expect(followUp).toBeDefined();
    // one follow-up only: a second block tap is refused
    const second = await h.engine.handleAction(`cm:${c.id}:block`, "42");
    expect(second).toMatch(/already|once/i);

    expect(await h.engine.handleAction(`cm:${c.id}:done`, "42")).toContain("Done");
    expect(h.store.getCommitment(c.id)?.status).toBe("completed");
    // deadline job cancelled with the group
    expect(jobsFor(h, c.groupId!).every((j) => j.status === "cancelled")).toBe(true);
    // final rating card
    const last = h.pushChat.mock.calls.at(-1);
    expect(last![2].buttons.map((b: { action: string }) => b.action)).toEqual([`cm:${c.id}:rate:up`, `cm:${c.id}:rate:down`]);
  });

  it("not-yet at deadline → missed; +1d → renegotiated with active successor", async () => {
    const h = makeEngine({ now: 1_700_000_000_000 });
    const c = mustCommit(h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "ship the post", h.now + 2 * DAY));
    await h.engine.handleAction(`cm:${c.id}:notyet`, "42");
    expect(h.store.getCommitment(c.id)?.status).toBe("missed");

    const c2 = mustCommit(h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "ship the other thing", h.now + 2 * DAY));
    const before = h.now;
    expect(await h.engine.handleAction(`cm:${c2.id}:reneg:1d`, "42")).toContain("new id");
    expect(h.store.getCommitment(c2.id)?.status).toBe("renegotiated");
    const all = h.store.commitments({ agentId: "assistant" });
    const successor = all.find((x) => x.id !== c.id && x.id !== c2.id)!;
    expect(successor.status).toBe("active");
    expect(successor.dueAt).toBe(before + DAY); // offsets push from the tap moment
    expect(jobsFor(h, c.groupId!).every((j) => j.status === "cancelled")).toBe(true);
    expect(jobsFor(h, successor.groupId!).length).toBeGreaterThan(0);
  });

  it("inferred capture: proposed, no jobs, confirm starts the loop, dismiss records rejection", async () => {
    const h = makeEngine({ now: 1_700_000_000_000 });
    const c1 = mustCommit(h.engine.captureInferred("assistant", { transport: "telegram", chatId: "42" }, "book the dentist", h.now + 5 * DAY));
    expect(c1.status).toBe("proposed");
    expect(h.deliverToAgent.mock.calls[0]?.[1] ?? "").toMatch(/follow-through loop/i);
    expect(jobsFor(h, c1.groupId!)).toHaveLength(0);
    // confirmation card was pushed
    expect(h.deliverToAgent).toHaveBeenCalledTimes(1);

    expect(h.engine.confirm(c1.id)).toBe(true);
    expect(h.store.getCommitment(c1.id)?.status).toBe("active");
    expect(jobsFor(h, c1.groupId!).length).toBe(2);
    expect(h.store.events({ commitmentId: c1.id }).some((e) => e.stage === "confirmed")).toBe(true);

    const c2b = mustCommit(h.engine.captureInferred("assistant", { transport: "telegram", chatId: "42" }, "water the plants", h.now + 2 * DAY));
    expect(h.engine.dismiss(c2b.id)).toBe(true);
    expect(h.store.getCommitment(c2b.id)?.status).toBe("dismissed");
    expect(h.store.events({ commitmentId: c2b.id }).some((e) => e.stage === "dismissed")).toBe(true);
  });

  it("daily budget: over-budget onFire skips the push and records skipped", () => {
    const h = makeEngine({ now: 1_700_000_000_000, dailyBudget: 1 });
    const a = mustCommit(h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "first commitment", h.now + 2 * DAY));
    const b = mustCommit(h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "second commitment", h.now + 2 * DAY));
    const jobA = jobsFor(h, a.groupId!).find((j) => j.detail === `cm:${a.id}:precheck`)!;
    const jobB = jobsFor(h, b.groupId!).find((j) => j.detail === `cm:${b.id}:precheck`)!;
    const p0 = h.pushChat.mock.calls.length;
    return h.engine.onFire(jobA).then(async () => {
      expect(h.pushChat.mock.calls.length).toBe(p0 + 1);
      await h.engine.onFire(jobB);
      expect(h.pushChat.mock.calls.length).toBe(p0 + 1); // budget consumed — second skipped
      expect(h.store.events({ commitmentId: b.id }).some((e) => e.stage === "skipped" && e.outcome === "budget:over")).toBe(true);
    });
  });

  it("pilot disabled: capture is refused politely, nothing stored", () => {
    const h = makeEngine({ now: 1_700_000_000_000, pilot: false });
    const r = h.engine.captureExplicit("assistant", { transport: "telegram", chatId: "42" }, "send invoice", h.now + DAY);
    expect(r.commitment).toBeUndefined();
    expect(r.reply).toMatch(/pilot/i);
    expect(h.store.commitments()).toHaveLength(0);
  });

  it("syncPilotGovernance: scorecard job follows the pilot toggle", () => {
    const h = makeEngine({ now: 1_700_000_000_000 });
    h.engine.syncPilotGovernance("assistant");
    h.engine.syncPilotGovernance("assistant"); // idempotent
    const jobs = h.scheduler.list("assistant", { includePaused: true }).filter((j) => j.detail === "cm:scorecard:fire");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].internal).toBe(true);
    expect(jobs[0].repeat?.weekdays).toEqual([1]);

    h.manifest.proactive!.pilot = false;
    h.engine.syncPilotGovernance("assistant");
    expect(h.scheduler.list("assistant", { includePaused: true }).filter((j) => j.detail === "cm:scorecard:fire").every((j) => j.status === "cancelled")).toBe(true);
  });

  it("deliverHeartbeatSpeak logs a heartbeat-loop delivery only when it resolved", () => {
    const h = makeEngine({ now: 1_700_000_000_000 });
    h.engine.deliverHeartbeatSpeak("assistant", true);
    h.engine.deliverHeartbeatSpeak("assistant", false);
    const hb = h.store.events({ loop: "heartbeat" });
    expect(hb).toHaveLength(2);
    expect(hb.filter((e) => e.stage === "delivered")).toHaveLength(1);
    expect(hb.find((e) => e.stage === "skipped")?.outcome).toBe("push:failed");
  });
});

describe("precheckAt", () => {
  it("defaults to dueAt minus lead when that is still ahead", () => {
    const now = 1_000_000;
    const due = now + 3 * DAY;
    expect(precheckAt(due, DAY, now - DAY, now)).toBe(due - DAY);
  });

  it("falls back to the midpoint when the lead has already passed", () => {
    const now = 1_000_000;
    const due = now + 6 * 3600e3;
    const at = precheckAt(due, DAY, now - DAY, now);
    expect(at).toBeGreaterThanOrEqual(now + 5 * 60e3);
    expect(at).toBeLessThan(due);
  });

  it("returns undefined when there is no room for a pre-check", () => {
    const now = 1_000_000;
    expect(precheckAt(now + 3 * 60e3, DAY, now - DAY, now)).toBeUndefined();
  });
});

describe("commitmentCard", () => {
  it("renders the confirmation card for proposed commitments", () => {
    const card = commitmentCard("confirm", { id: "cmX", text: "book dentist" } as never);
    expect(card.buttons.map((b) => b.action)).toEqual(["cm:cmX:confirm", "cm:cmX:dismiss"]);
  });
});
describe("nudge feedback (heartbeat cards)", () => {
  function makeNudgeHarness(opts: { pilot?: boolean; dailyBudget?: number } = {}) {
    const dir = tmpDir();
    const manifest = { name: "assistant", proactive: { pilot: opts.pilot !== false, ...(opts.dailyBudget != null ? { dailyBudget: opts.dailyBudget } : {}) } };
    const agents = { getAgent: (id: string) => ({ id, dir: path.join(dir, id), manifest }) } as unknown as AgentManager;
    const store = new ProactiveStore(dir);
    const scheduler = new Scheduler(path.join(dir, "data"), () => {});
    const events = new EventLog(dir);
    const escalate = vi.fn(async () => {});
    const pushChat = vi.fn(async () => true);
    const deliverToAgent = vi.fn(async () => true);
    const governor = { noteNudgeRating: vi.fn() };
    const snoozeSpy = vi.spyOn(scheduler, "snooze");
    const engine = new CommitmentEngine({
      agents, scheduler, events, store,
      bot: { pushChat, deliverToAgent, escalate },
      suggestNextAction: async () => "draft it",
      governor,
      now: () => 1_700_000_000_000,
    });
    return { store, scheduler, escalate, pushChat, governor, engine, events, snoozeSpy };
  }

  it("nudgeCard renders 👍/👎/🔎/later buttons carrying the nudge id", () => {
    const card = nudgeCard("nvpilot01");
    expect(card.buttons.map((b) => b.action)).toEqual([
      "nudge:nvpilot01:up",
      "nudge:nvpilot01:down",
      "nudge:nvpilot01:research",
      "nudge:nvpilot01:later",
    ]);
  });

  it("up/down ratings record acted events and drive the governor", async () => {
    const h = makeNudgeHarness();
    const ev = h.store.appendEvent({ agentId: "assistant", loop: "heartbeat", stage: "delivered", id: "nvpilot01" });
    expect(await h.engine.handleNudgeAction("nudge:nvpilot01:up", "42")).toContain("more of");
    expect(h.governor.noteNudgeRating).toHaveBeenCalledWith("assistant", true);
    await h.engine.handleNudgeAction("nudge:nvpilot01:down", "42");
    expect(h.governor.noteNudgeRating).toHaveBeenCalledWith("assistant", false);
    const acted = h.store.events({ commitmentId: "nvpilot01" }).filter((e) => e.stage === "acted");
    expect(acted.map((e) => e.outcome).sort()).toEqual(["rating:down", "rating:up"]);
    expect(acted.every((e) => e.loop === "heartbeat")).toBe(true);
  });

  it("research escalates to the agent; later snoozes the rhythm 2h", async () => {
    const h = makeNudgeHarness();
    h.store.appendEvent({ agentId: "assistant", loop: "heartbeat", stage: "delivered", id: "nvpilot02" });
    await h.engine.handleNudgeAction("nudge:nvpilot02:research", "42");
    expect(h.escalate).toHaveBeenCalledWith("assistant", expect.stringContaining("nvpilot02"));
    await h.engine.handleNudgeAction("nudge:nvpilot02:later", "42");
    expect(h.snoozeSpy).toHaveBeenCalledWith("assistant", expect.any(Number), "nudge later");
    const acted = h.store.events({ commitmentId: "nvpilot02" }).map((e) => e.outcome).sort();
    expect(acted).toEqual(["nudge:later", "nudge:research"]);
  });

  it("unknown nudge ids are refused", async () => {
    const h = makeNudgeHarness();
    expect(await h.engine.handleNudgeAction("nudge:nada0000:up", "42")).toMatch(/unknown/i);
    expect(h.governor.noteNudgeRating).not.toHaveBeenCalled();
  });
});
