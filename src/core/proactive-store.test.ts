import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProactiveStore,
  parseCommitDue,
  summarize,
  type Commitment,
  type ProactiveEvent,
} from "./proactive-store.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-proactive-"));
}

const DAY = 86_400e3;

function commitment(over: Partial<Commitment> = {}): Omit<Commitment, "id" | "createdAt" | "status"> & { status?: Commitment["status"] } {
  return {
    agentId: "assistant",
    chat: { transport: "telegram", chatId: "42" },
    text: "send invoice to Anna",
    dueAt: Date.now() + 3 * DAY,
    origin: "explicit",
    ...over,
  };
}

function ev(over: Partial<ProactiveEvent> = {}): ProactiveEvent {
  return {
    ts: Date.now(),
    id: "evtest0001",
    agentId: "assistant",
    loop: "pilot",
    stage: "delivered",
    ...over,
  };
}

describe("ProactiveStore", () => {
  let dir: string;
  beforeEach(() => (dir = tmpDir()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips commitments and events across instances", () => {
    const s = new ProactiveStore(dir);
    const c = s.createCommitment(commitment());
    expect(c.id).toMatch(/^cm/);
    expect(c.status).toBe("active");
    expect(c.createdAt).toBeGreaterThan(0);
    s.appendEvent(ev({ commitmentId: c.id, stage: "delivered" }));

    const s2 = new ProactiveStore(dir);
    expect(s2.getCommitment(c.id)?.text).toBe("send invoice to Anna");
    expect(s2.events({ commitmentId: c.id })).toHaveLength(1);
  });

  it("updates commitment status and keeps closedAt via updateCommitment", () => {
    const s = new ProactiveStore(dir);
    const c = s.createCommitment(commitment());
    const done = s.updateCommitment(c.id, { status: "completed", closedAt: 1234 });
    expect(done?.status).toBe("completed");
    expect(done?.closedAt).toBe(1234);
    expect(new ProactiveStore(dir).getCommitment(c.id)?.status).toBe("completed");
  });

  it("filters commitments by agent, origin, status", () => {
    const s = new ProactiveStore(dir);
    s.createCommitment(commitment());
    s.createCommitment(commitment({ agentId: "coach", origin: "inferred" }));
    const all = s.commitments();
    expect(all).toHaveLength(2);
    expect(s.commitments({ agentId: "coach" })).toHaveLength(1);
    expect(s.commitments({ origin: "inferred" })).toHaveLength(1);
    expect(s.commitments({ origin: "inferred" })[0].agentId).toBe("coach");
    expect(s.commitments({ status: "active" })).toHaveLength(2);
    expect(s.commitments({ status: "missed" })).toHaveLength(0);
  });

  it("filters events by loop, agent, since", () => {
    const s = new ProactiveStore(dir);
    const now = Date.now();
    s.appendEvent(ev({ loop: "pilot" }));
    s.appendEvent(ev({ loop: "heartbeat", agentId: "coach", ts: now - 2 * DAY }));
    expect(s.events({ loop: "heartbeat" })).toHaveLength(1);
    expect(s.events({ agentId: "assistant" })).toHaveLength(1);
    expect(s.events({ since: now - DAY })).toHaveLength(1);
  });

  it("prunes events older than 90 days", () => {
    const s = new ProactiveStore(dir);
    s.appendEvent(ev({ ts: Date.now() - 91 * DAY, id: "oldone001" }));
    s.appendEvent(ev({ ts: Date.now() - 89 * DAY, id: "fresh0001" }));
    expect(s.prune()).toBe(1);
    const kept = s.events();
    expect(kept.map((e) => e.id)).toEqual(["fresh0001"]);
    // persisted too
    expect(new ProactiveStore(dir).events()).toHaveLength(1);
  });

  it("truncates commitment text to 160 chars", () => {
    const s = new ProactiveStore(dir);
    const c = s.createCommitment(commitment({ text: "x".repeat(300) }));
    expect(c.text.length).toBe(160);
  });
});

describe("parseCommitDue", () => {
  it("splits trailing 'by <when>'", () => {
    const r = parseCommitDue("send invoice to Anna by in 3d");
    expect(r).toBeDefined();
    expect(r!.text).toBe("send invoice to Anna");
    expect(r!.whenRaw).toBe("in 3d");
    expect(r!.dueAt).toBeGreaterThan(Date.now());
  });

  it("accepts 'by friday 18:00' and weekday forms", () => {
    const r = parseCommitDue("gym session by friday 18:00");
    expect(r).toBeDefined();
    expect(r!.text).toBe("gym session");
    expect(r!.whenRaw).toBe("friday 18:00");
  });

  it("returns undefined without a when", () => {
    expect(parseCommitDue("just text")).toBeUndefined();
    expect(parseCommitDue("")).toBeUndefined();
  });
});

describe("summarize", () => {
  const now = 1_000_000_000_000;

  function store(events: ProactiveEvent[], commitments: Commitment[]): { events: ProactiveEvent[]; commitments: Commitment[] } {
    return { events, commitments };
  }

  it("counts delivered per filter and computes seen/acted percentages", () => {
    const cid = "cmABC123";
    const events = [
      ev({ ts: now - DAY, id: "e1", commitmentId: cid, loop: "pilot", stage: "delivered" }),
      ev({ ts: now - DAY + 1000, id: "e2", commitmentId: cid, loop: "pilot", stage: "seen" }),
      ev({ ts: now - DAY + 2000, id: "e3", commitmentId: cid, loop: "pilot", stage: "acted", outcome: "precheck:on-track" }),
      ev({ ts: now - DAY, id: "e4", loop: "heartbeat", stage: "delivered" }),
    ];
    const s = summarize(store(events, []), { since: now - 2 * DAY, now });
    expect(s.delivered).toBe(2); // both loops
    const pilotOnly = summarize(store(events, []), { since: now - 2 * DAY, now, loop: "pilot" });
    expect(pilotOnly.delivered).toBe(1);
    expect(pilotOnly.seenPct).toBe(100);
    expect(pilotOnly.actedPct).toBe(100);
    expect(pilotOnly.seenPct).toBeGreaterThanOrEqual(pilotOnly.actedPct);
  });

  it("counts delivered with no seen after 48h as ignored", () => {
    const events = [ev({ ts: now - 3 * DAY, id: "e1", stage: "delivered" })];
    const s = summarize(store(events, []), { since: now - 5 * DAY, now });
    expect(s.delivered).toBe(1);
    expect(s.ignored).toBe(1);
    expect(s.seenPct).toBe(0);
    expect(s.noisePct).toBe(100);
  });

  it("does not count fresh undelivered-seen messages as ignored before 48h", () => {
    const events = [ev({ ts: now - 3 * 3600e3, id: "e1", stage: "delivered" })];
    const s = summarize(store(events, []), { since: now - 5 * DAY, now });
    expect(s.ignored).toBe(0);
  });

  it("completion % counts completed vs completed+missed; origin split works", () => {
    const nowMs = Date.now();
    const commitments = [
      { id: "cm1", agentId: "assistant", chat: { transport: "t", chatId: "1" }, text: "a", dueAt: nowMs, origin: "explicit" as const, status: "completed" as const, createdAt: nowMs },
      { id: "cm2", agentId: "assistant", chat: { transport: "t", chatId: "1" }, text: "b", dueAt: nowMs, origin: "explicit" as const, status: "missed" as const, createdAt: nowMs },
      { id: "cm3", agentId: "assistant", chat: { transport: "t", chatId: "1" }, text: "c", dueAt: nowMs, origin: "inferred" as const, status: "proposed" as const, createdAt: nowMs },
      { id: "cm4", agentId: "assistant", chat: { transport: "t", chatId: "1" }, text: "d", dueAt: nowMs, origin: "inferred" as const, status: "active" as const, createdAt: nowMs, confirmedAt: nowMs },
    ];
    const s = summarize(store([], commitments), { since: nowMs - DAY, now: nowMs });
    expect(s.completedPct).toBe(50); // 1 completed / 2 closed (completed+missed)
    expect(s.explicitCount).toBe(2);
    expect(s.inferredCount).toBe(2);
    // 1 confirmed of 2 inferred that were ever proposed (1 still awaiting, 1 confirmed)
    expect(s.confirmRate).toBe(50);
  });

  it("helpfulness = share of ratings that are up; down ratings feed noise", () => {
    const nowMs = Date.now();
    const commitments = [
      { id: "cm1", agentId: "a", chat: { transport: "t", chatId: "1" }, text: "a", dueAt: nowMs, origin: "explicit" as const, status: "completed" as const, createdAt: nowMs, rating: "up" as const },
      { id: "cm2", agentId: "a", chat: { transport: "t", chatId: "1" }, text: "b", dueAt: nowMs, origin: "explicit" as const, status: "missed" as const, createdAt: nowMs, rating: "down" as const },
      { id: "cm3", agentId: "a", chat: { transport: "t", chatId: "1" }, text: "c", dueAt: nowMs, origin: "explicit" as const, status: "completed" as const, createdAt: nowMs, rating: "up" as const },
    ];
    const s = summarize(store([], commitments), { since: nowMs - DAY, now: nowMs });
    expect(s.helpfulPct).toBe(67); // 2/3 up, rounded
    expect(s.noisePct).toBeGreaterThanOrEqual(33);
  });
});
describe("summarize nudge ratings", () => {
  const now = Date.now();
  it("helpful% counts heartbeat nudge 👍/👎 events (no commitmentId), not just commitments", () => {
    const events = [
      ev({ ts: now - 3600e3, id: "nv01", loop: "heartbeat", stage: "delivered" }),
      ev({ ts: now - 3000e3, id: "nv02", loop: "heartbeat", stage: "delivered" }),
      ev({ ts: now - 2000e3, id: "a1", commitmentId: "nv01", loop: "heartbeat", stage: "acted", outcome: "rating:up" }),
      ev({ ts: now - 1000e3, id: "a2", commitmentId: "nv02", loop: "heartbeat", stage: "acted", outcome: "rating:down" }),
      ev({ ts: now - 900e3, id: "a3", loop: "pilot", stage: "acted", outcome: "rating:up" }),
    ];
    const s = summarize({ events, commitments: [] }, { since: now - 86_400e3, now });
    expect(s.helpfulPct).toBe(67); // 2 up (nudge + pilot) of 3 rated nudges
  });
});
