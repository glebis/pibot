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

  it("does not fire the same overdue job twice while delivery is still running", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fireCb = vi.fn(async () => blocked);
    const s = new Scheduler(dataDir, fireCb);
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000 }) });
    job.dueAt = Date.now() - 1;

    const first = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire(job);
    await waitFor(() => fireCb.mock.calls.length === 1);
    s.rearm(job.id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fireCb).toHaveBeenCalledTimes(1);
    release();
    await first;
    s.stop();
  });

  it("persists a failed delivery as pending and retries it later", async () => {
    const s = new Scheduler(dataDir, async () => { throw new Error("transport offline"); });
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000 }) });
    await (s as unknown as { fire: (job: Schedule) => Promise<void> }).fire(job);
    const retry = s.get(job.id)! as Schedule & { deliveryAttempts?: number; lastDeliveryError?: string };
    expect(retry.status).toBe("pending");
    expect(retry.deliveryAttempts).toBe(1);
    expect(retry.lastDeliveryError).toContain("transport offline");
    expect(retry.dueAt).toBeGreaterThan(Date.now());
    s.flush();
    s.stop();

    let delivered = 0;
    const restartedScheduler = new Scheduler(dataDir, () => { delivered += 1; });
    const restored = restartedScheduler.get(job.id) as Schedule & { deliveryAttempts?: number };
    expect(restored.status).toBe("pending");
    expect(restored.deliveryAttempts).toBe(1);
    restored.dueAt = Date.now();
    restartedScheduler.rearm(restored.id);
    await waitFor(() => delivered === 1);
    expect(restartedScheduler.get(job.id)?.status).toBe("done");
    restartedScheduler.stop();
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
    const job = s.create({ ...makeJob({ repeat: { dailyAt: "09:00" }, dueAt: Date.now() + 20 }) });
    // fire it manually
    (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire(s.get(job.id)!);
    // next occurrence = the next 09:00 local (today or tomorrow depending on the clock)
    await waitFor(() => {
      const due = s.get(job.id)?.dueAt ?? 0;
      const d = new Date(due);
      return d.getHours() === 9 && d.getMinutes() === 0 && due > Date.now() - 60e3;
    });
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

  it("matches pending cards for sub-bot transport names containing colons", () => {
    const s = new Scheduler(dataDir, () => {});
    const mine = s.create({ ...makeJob({ cardPending: true, chat: { transport: "telegram:assistant", chatId: "123" } }) });
    expect(s.takePendingCards("a1", "telegram:assistant:123").map((job) => job.id)).toEqual([mine.id]);
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
describe("Scheduler night-snooze capping", () => {
  it("caps snoozes at the wake time (end of quiet hours)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-cap-"));
    const s = new Scheduler(dir, () => {});
    // 22:00 + 12h snooze → would end at 10:00, capped at 08:00
    const at22 = new Date(); at22.setHours(22, 0, 0, 0);
    const capAt = new Date(at22); capAt.setDate(capAt.getDate() + 1); capAt.setHours(8, 0, 0, 0);
    const st = s.snooze("a1", at22.getTime() + 12 * 3600e3, "night", capAt.getTime());
    expect(st.until).toBe(capAt.getTime());
    s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("daytime snoozes are not capped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-cap-"));
    const s = new Scheduler(dir, () => {});
    const now = Date.now();
    const st = s.snooze("a1", now + 2 * 3600e3, "day", now + 10 * 3600e3);
    expect(st.until).toBe(now + 2 * 3600e3);
    s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Scheduler MAX_TIMEOUT chaining", () => {
  const MAX_TIMEOUT = 2 ** 31 - 1;

  it("chains timer for jobs beyond MAX_TIMEOUT and fires at correct time", async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-max-"));
    try {
      const fired: string[] = [];
      const s = new Scheduler(dir, (job) => void fired.push(job.id));
      const now = Date.now();
      const thirtyDays = 30 * 86400e3;
      const job = s.create({ ...makeJob({ dueAt: now + thirtyDays }) });

      expect(fired).toHaveLength(0);

      // Timer should be set to MAX_TIMEOUT first, not full 30d — advancing just before cap must not fire
      await vi.advanceTimersByTimeAsync(MAX_TIMEOUT - 1000);
      expect(fired).toHaveLength(0);

      // Crossing MAX_TIMEOUT boundary triggers chaining, still not due (remainder ≈5.2d)
      await vi.advanceTimersByTimeAsync(1000);
      expect(fired).toHaveLength(0);

      // Advance remainder to reach 30d total
      const remainder = thirtyDays - MAX_TIMEOUT;
      await vi.advanceTimersByTimeAsync(remainder);
      // flush any pending microtasks from fire()
      await Promise.resolve();

      expect(fired).toHaveLength(1);
      expect(fired[0]).toBe(job.id);
      expect(s.get(job.id)?.status).toBe("done");

      s.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("clears chained timer on cancel", async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-max-cancel-"));
    try {
      const fired: string[] = [];
      const s = new Scheduler(dir, (job) => void fired.push(job.id));
      const now = Date.now();
      const job = s.create({ ...makeJob({ dueAt: now + 30 * 86400e3 }) });
      s.cancel(job.id);
      await vi.advanceTimersByTimeAsync(30 * 86400e3);
      expect(fired).toHaveLength(0);
      s.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
