import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "./scheduler.js";
import type { ChatRef, Schedule, ScheduleKind } from "./types.js";

const CHAT: ChatRef = { transport: "test", chatId: "c1" };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-test-"));
}

function makeJob(over: Partial<Schedule> = {}): Omit<Schedule, "id" | "createdAt" | "firedCount" | "status"> {
  return {
    agentId: "a1",
    chat: CHAT,
    title: "test item",
    kind: "reminder" as ScheduleKind,
    dueAt: Date.now() + 40,
    wake: "normal",
    delivery: "direct",
    ...over,
  };
}

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Scheduler", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("fires a one-shot job and marks it done", async () => {
    const fired: string[] = [];
    const s = new Scheduler(dataDir, (job) => void fired.push(job.id));
    const job = s.create({ ...makeJob(), dueAt: Date.now() + 30 });
    await waitFor(() => fired.length === 1);
    expect(fired[0]).toBe(job.id);
    expect(s.get(job.id)?.status).toBe("done");
    s.stop();
  });

  it("cancels pending jobs", async () => {
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob() });
    expect(s.cancel(job.id)?.status).toBe("cancelled");
    expect(s.get(job.id)?.status).toBe("cancelled");
    expect(s.cancel("nope")).toBeNull();
    s.stop();
  });

  it("reschedules jobs", async () => {
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000 }) });
    const newDue = Date.now() + 120_000;
    s.reschedule(job.id, newDue);
    expect(s.get(job.id)?.dueAt).toBe(newDue);
    s.stop();
  });

  it("supports id-prefix lookup", () => {
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob() });
    expect(s.get(job.id.slice(0, 4))?.id).toBe(job.id);
    s.stop();
  });

  it("defers normal jobs until snooze ends", async () => {
    const fired: Array<{ id: string; snoozed: boolean }> = [];
    const s = new Scheduler(dataDir, (job, snoozed) => void fired.push({ id: job.id, snoozed }));
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 30 }) });
    s.snooze("a1", Date.now() + 150, "test");
    await waitFor(() => fired.length === 1, 3000);
    expect(fired[0].id).toBe(job.id);
    expect(fired[0].snoozed).toBe(false);
    s.stop();
  });

  it("lets important jobs pierce snooze with a flag", async () => {
    const fired: Array<{ id: string; snoozed: boolean }> = [];
    const s = new Scheduler(dataDir, (job, snoozed) => void fired.push({ id: job.id, snoozed }));
    s.snooze("a1", Date.now() + 60_000, "test");
    s.create({ ...makeJob({ wake: "important", dueAt: Date.now() + 30 }) });
    await waitFor(() => fired.length === 1);
    expect(fired[0].snoozed).toBe(true);
    s.stop();
  });

  it("skips internal heartbeat jobs while snoozed without deferring", async () => {
    const fired: string[] = [];
    const s = new Scheduler(dataDir, (job) => void fired.push(job.id));
    s.snooze("a1", Date.now() + 60_000);
    s.create({ ...makeJob({ kind: "heartbeat", internal: true, repeat: { everyMs: 3600e3 }, dueAt: Date.now() + 30 }) });
    await new Promise((r) => setTimeout(r, 120));
    expect(fired).toHaveLength(0);
    const job = s.list("a1")[0];
    // next fire pushed past snooze end
    expect(job.dueAt).toBeGreaterThan(Date.now() + 55_000);
    s.stop();
  });

  it("recurs everyMs jobs from fire time", async () => {
    const fired: number[] = [];
    const s = new Scheduler(dataDir, () => void fired.push(Date.now()));
    s.create({ ...makeJob({ repeat: { everyMs: 60 }, dueAt: Date.now() + 20 }) });
    await waitFor(() => fired.length >= 3, 3000);
    expect(fired[1] - fired[0]).toBeGreaterThanOrEqual(50);
    expect(s.list()).toHaveLength(1); // still pending
    s.stop();
  });

  it("recurs dailyAt jobs", async () => {
    const s = new Scheduler(dataDir, () => {});
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const job = s.create({ ...makeJob({ repeat: { dailyAt: "09:00" }, dueAt: Date.now() + 20 }) });
    // fire it manually
    (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire(s.get(job.id)!);
    await waitFor(() => s.get(job.id)?.dueAt === tomorrow.getTime());
    s.stop();
  });

  it("persists jobs and snooze across restarts", () => {
    let s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 3600e3 }) });
    s.snooze("a1", Date.now() + 7200e3, "sleep");
    s.flush();
    s.stop();

    s = new Scheduler(dataDir, () => {});
    expect(s.get(job.id)?.title).toBe("test item");
    expect(s.snoozeState("a1")?.until).toBeGreaterThan(Date.now());
    s.stop();
  });

  it("drops stale one-shots missed by more than a day on boot", () => {
    const file = path.join(dataDir, "schedules.json");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        jobs: [
          { id: "old", agentId: "a1", chat: CHAT, title: "old", kind: "reminder", dueAt: Date.now() - 3 * 86400e3, wake: "normal", delivery: "direct", status: "pending", createdAt: Date.now(), firedCount: 0 },
        ],
      })
    );
    const s = new Scheduler(dataDir, () => {});
    expect(s.get("old")).toBeUndefined();
    s.stop();
  });

  it("drains pending cards exactly once, filtered by agent and chat", () => {
    const s = new Scheduler(dataDir, () => {});
    const mine = s.create({ ...makeJob({ cardPending: true }) });
    s.create({ ...makeJob({ cardPending: true, agentId: "other" }) });
    s.create({ ...makeJob({ cardPending: true, chat: { transport: "test", chatId: "other" } }) });

    const drained = s.takePendingCards("a1", "test:c1");
    expect(drained.map((j) => j.id)).toEqual([mine.id]);
    expect(s.takePendingCards("a1", "test:c1")).toHaveLength(0);
    s.stop();
  });

  it("unsnooze reports whether anything was snoozed", () => {
    const s = new Scheduler(dataDir, () => {});
    expect(s.unsnooze("a1")).toBe(false);
    s.snooze("a1", Date.now() + 1000);
    expect(s.unsnooze("a1")).toBe(true);
    s.stop();
  });

  it("lists pending jobs sorted by dueAt", () => {
    const s = new Scheduler(dataDir, () => {});
    const b = s.create({ ...makeJob({ dueAt: Date.now() + 2000 }) });
    const a = s.create({ ...makeJob({ dueAt: Date.now() + 1000 }) });
    expect(s.list().map((j) => j.id)).toEqual([a.id, b.id]);
    s.stop();
  });
});