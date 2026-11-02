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

  it("does not fire a job created while the wheel is disarmed, and fires it on arm", async () => {
    const deliver = vi.fn();
    const s = new Scheduler(dataDir, deliver);
    try {
      s.disarm();
      // An overdue job created during boot (heartbeat/brief/attend) must not fire against
      // a half-attached route table — that is the Oct 30 ScheduleRouteError self-pause.
      const job = s.create(makeJob({ dueAt: Date.now() - 1000 }));
      await new Promise((r) => setTimeout(r, 60));
      expect(deliver).not.toHaveBeenCalled();
      expect(s.get(job.id)?.status).toBe("pending");

      s.arm();
      await waitFor(() => deliver.mock.calls.length === 1);
      expect(s.get(job.id)?.status).toBe("done");
    } finally { s.stop(); }
  });

  it("keeps a resumed job pending until the wheel is armed", async () => {
    const deliver = vi.fn();
    const s = new Scheduler(dataDir, deliver);
    try {
      const job = s.create(makeJob({ dueAt: Date.now() + 60_000 }));
      job.status = "paused";
      job.pauseReason = "Delivery route needs repair: repair it";
      s.disarm();
      expect(s.resume(job.id)).not.toBeNull();
      await new Promise((r) => setTimeout(r, 60));
      expect(deliver).not.toHaveBeenCalled();
      s.arm();
      await waitFor(() => deliver.mock.calls.length === 1);
    } finally { s.stop(); }
  });

  it("never persists a synthetic transport as a schedule's chat", () => {
    const s = new Scheduler(dataDir, () => {});
    try {
      const job = s.create(makeJob({ chat: { transport: "agent", chatId: "task-t1" }, delivery: "agent" }));
      expect(job.chat).toEqual({ transport: "", chatId: "" });
      const internal: Schedule = {
        ...makeJob({ chat: { transport: "internal", chatId: "hb" }, internal: true }),
        id: "hb",
        status: "pending",
        createdAt: Date.now(),
        firedCount: 0,
      };
      expect(s.ensure(internal).chat).toEqual({ transport: "internal", chatId: "hb" });
    } finally { s.stop(); }
  });

  it("rejects creation when the host cannot resolve a delivery route", () => {
    const s = new Scheduler(dataDir, () => {});
    try {
      s.setRouteValidator(() => "No owned delivery chat; repair the destination before resuming.");
      expect(() => s.create(makeJob())).toThrow(/repair the destination/);
      expect(s.list()).toHaveLength(0);
    } finally { s.stop(); }
  });

  it.each([false, true])("pauses a lost route immediately without delivering or retrying (repeat=%s)", async (repeat) => {
    const deliver = vi.fn();
    const notice = vi.fn();
    const s = new Scheduler(dataDir, deliver, notice);
    try {
      const job = s.create(makeJob({ dueAt: Date.now() + 60000, ...(repeat ? { repeat: { everyMs: 3600000 } } : {}) }));
      s.setRouteValidator(() => "No owned delivery chat; repair the destination before resuming.");
      await (s as unknown as { fire: (job: Schedule) => Promise<void> }).fire(job);
      expect(job.status).toBe("paused");
      expect(job.deliveryAttempts).toBe(1);
      expect(job.pauseReason).toContain("repair the destination");
      expect(deliver).not.toHaveBeenCalled();
      expect(notice).toHaveBeenCalledTimes(1);
      expect(notice.mock.calls[0][1].kind).toBe("paused");
    } finally { s.stop(); }
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

  it("rejects agent-created recurring schedules below fifteen minutes", () => {
    const s = new Scheduler(dataDir, () => {});
    expect(() => s.create({ ...makeJob({ repeat: { everyMs: 60_000 } }) })).toThrow(/15 minutes/);
    expect(s.list()).toHaveLength(0);
    s.stop();
  });

  it("caps active agent-created schedules at twenty per agent", () => {
    const s = new Scheduler(dataDir, () => {});
    for (let i = 0; i < 20; i++) {
      s.create({ ...makeJob({ title: `job ${i}`, dueAt: Date.now() + 60_000 + i }) });
    }
    expect(() => s.create({ ...makeJob({ title: "job 21", dueAt: Date.now() + 120_000 }) })).toThrow(/20 active/);
    expect(s.list("a1")).toHaveLength(20);
    expect(() => s.create({ ...makeJob({ agentId: "a2", title: "other agent" }) })).not.toThrow();
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

  it("counts exhausted recurring occurrences and pauses after five consecutive failures", async () => {
    const notices: string[] = [];
    const SchedulerWithNotice = Scheduler as unknown as new (
      dir: string,
      fireCb: (job: Schedule, snoozed: boolean) => Promise<void>,
      noticeCb: (job: Schedule, event: { kind: string }) => Promise<void>,
    ) => Scheduler;
    const s = new SchedulerWithNotice(
      dataDir,
      async () => { throw new Error("credential revoked"); },
      async (_job, event) => { notices.push(event.kind); },
    );
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000, repeat: { everyMs: 15 * 60_000 } }) });
    const fire = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire.bind(s);

    for (let occurrence = 0; occurrence < 5; occurrence++) {
      for (let attempt = 0; attempt < 3; attempt++) await fire(job);
    }

    expect(job.status).toBe("paused");
    expect(job.deliveryAttempts).toBe(0);
    expect((job as Schedule & { consecutiveFailures?: number }).consecutiveFailures).toBe(5);
    expect(job.lastDeliveryError).toContain("credential revoked");
    expect(notices).toEqual(["first-failure", "paused"]);
    s.stop();
  });

  it("resets the consecutive failure streak after a successful recurring occurrence", async () => {
    let failing = true;
    const s = new Scheduler(dataDir, async () => {
      if (failing) throw new Error("temporary outage");
    });
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000, repeat: { everyMs: 15 * 60_000 } }) });
    const fire = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire.bind(s);
    await fire(job);
    await fire(job);
    await fire(job);
    expect((job as Schedule & { consecutiveFailures?: number }).consecutiveFailures).toBe(1);

    failing = false;
    await fire(job);

    expect((job as Schedule & { consecutiveFailures?: number }).consecutiveFailures).toBe(0);
    expect(job.deliveryAttempts).toBe(0);
    expect(job.lastDeliveryError).toBeUndefined();
    expect(job.status).toBe("pending");
    s.stop();
  });

  it("resumes an automatically paused schedule and keeps it visible", async () => {
    const s = new Scheduler(dataDir, async () => { throw new Error("offline"); });
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000, repeat: { everyMs: 15 * 60_000 } }) });
    const fire = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire.bind(s);
    for (let i = 0; i < 15; i++) await fire(job);

    const listIncludingPaused = (s.list as unknown as (agentId: string, opts: { includePaused: boolean }) => Schedule[])("a1", { includePaused: true });
    expect(listIncludingPaused.map((j) => j.id)).toContain(job.id);
    const resumed = (s as unknown as { resume: (id: string) => Schedule | null }).resume(job.id);
    expect(resumed?.status).toBe("pending");
    expect((resumed as Schedule & { consecutiveFailures?: number }).consecutiveFailures).toBe(0);
    s.stop();
  });

  it("stops retrying a failed one-shot forever", async () => {
    const notices: string[] = [];
    const s = new Scheduler(
      dataDir,
      async () => { throw new Error("chat unavailable"); },
      async (_job, event) => { notices.push(event.kind); },
    );
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000 }) });
    const fire = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire.bind(s);
    for (let attempt = 0; attempt < 5; attempt++) await fire(job);

    expect(job.status).toBe("paused");
    expect(job.deliveryAttempts).toBe(5);
    expect(notices).toEqual(["first-failure", "paused"]);
    s.stop();
  });

  it("records each occurrence's run id and the transport receipt, persisted across reload", async () => {
    const receipt = {
      messageId: 321, peer: "test:c1", account: "@testbot", idProtocol: "bot_api", evidence: "ack" as const,
    };
    const s = new Scheduler(dataDir, () => receipt);
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000 }) });
    const fire = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire.bind(s);
    await fire(job);

    expect(job.status).toBe("done");
    expect(job.lastRunId).toMatch(/^scrun_/);
    expect(job.lastAttemptAt).toBeTypeOf("number");
    expect(job.lastReceipt).toEqual(receipt);

    const runId = job.lastRunId;
    s.flush();
    s.stop();
    const restarted = new Scheduler(dataDir, () => {});
    expect(restarted.get(job.id)?.lastRunId).toBe(runId);
    expect(restarted.get(job.id)?.lastReceipt).toEqual(receipt);
    restarted.stop();
  });

  it("does not carry a previous occurrence's receipt into the next one", async () => {
    let calls = 0;
    const s = new Scheduler(dataDir, () => {
      calls += 1;
      return calls === 1 ? { messageId: 1, evidence: "ack" as const } : undefined;
    });
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000, repeat: { everyMs: 15 * 60_000 } }) });
    const fire = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire.bind(s);

    await fire(job);
    expect(job.lastReceipt?.messageId).toBe(1);
    const firstRunId = job.lastRunId;

    job.dueAt = Date.now() - 1;
    await fire(job);
    expect(calls).toBe(2);
    expect(job.lastRunId).toMatch(/^scrun_/);
    expect(job.lastRunId).not.toBe(firstRunId);
    // the second occurrence returned no receipt: an absent receipt is not a stale one
    expect(job.lastReceipt).toBeUndefined();
    s.stop();
  });

  it("retains an old paused schedule across restart", () => {
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob({ dueAt: Date.now() - 4 * 86400e3 }) });
    job.status = "paused";
    s.flush();
    s.stop();

    const restarted = new Scheduler(dataDir, () => {});
    expect(restarted.get(job.id)?.status).toBe("paused");
    restarted.stop();
  });

  it("cancels pending jobs", async () => {
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob() });
    expect(s.cancel(job.id)?.status).toBe("cancelled");
    expect(s.get(job.id)?.status).toBe("cancelled");
    expect(s.cancel("nope")).toBeNull();
    s.stop();
  });

  it("keeps a job cancelled when the cancel lands during a slow delivery", async () => {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const releaseP = new Promise<void>((r) => { release = r; });
    const fireCb = vi.fn(async () => { started(); await releaseP; });
    const s = new Scheduler(dataDir, fireCb);
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000, repeat: { dailyAt: "08:30" } }) });
    job.dueAt = Date.now() - 1; // overdue: fire manually
    const overdueDueAt = job.dueAt;

    const running = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire(job);
    await startedP;
    expect(s.cancel(job.id)?.status).toBe("cancelled");
    release();
    await running;

    // the cancel must win: no done-marking, no next-occurrence re-arm, no refire
    expect(s.get(job.id)?.status).toBe("cancelled");
    expect(job.firedCount).toBe(0);
    expect(job.dueAt).toBe(overdueDueAt); // success path must not advance a cancelled job
    expect(fireCb).toHaveBeenCalledTimes(1);
    s.flush();
    s.stop();

    let refired = 0;
    const restarted = new Scheduler(dataDir, () => { refired += 1; });
    expect(restarted.get(job.id)?.status).toBe("cancelled");
    restarted.rearm();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(refired).toBe(0);
    restarted.stop();
  });

  it("does not resurrect a cancelled job from a failing in-flight delivery", async () => {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const releaseP = new Promise<void>((_resolve, reject) => { release = () => reject(new Error("chat not found")); });
    const s = new Scheduler(dataDir, async () => { started(); await releaseP; });
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60_000, repeat: { dailyAt: "08:30" } }) });
    job.dueAt = Date.now() - 1;

    const running = (s as unknown as { fire: (j: Schedule) => Promise<void> }).fire(job);
    await startedP;
    s.cancel(job.id);
    release();
    await running;

    // old behavior: the failure path reset status to pending and re-armed a retry
    expect(s.get(job.id)?.status).toBe("cancelled");
    expect((job as Schedule & { deliveryAttempts?: number }).deliveryAttempts ?? 0).toBe(0);
    expect(job.dueAt).toBeLessThan(Date.now()); // retry ladder must not rewrite dueAt either
    s.flush();
    s.stop();

    let refired = 0;
    const restarted = new Scheduler(dataDir, () => { refired += 1; });
    restarted.rearm();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(refired).toBe(0);
    restarted.stop();
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
    s.create({ ...makeJob({ internal: true, repeat: { everyMs: 60 }, dueAt: Date.now() + 20 }) });
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

  it("closes stale one-shots missed by more than a day as missed, not as fired (bd pibot-awhs)", () => {
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
    const fired: string[] = [];
    const s = new Scheduler(dataDir, (job) => { fired.push(job.id); });
    // it must never fire late, and it must not claim to have fired
    expect(fired).toEqual([]);
    const job = s.get("old");
    expect(job?.status).toBe("done");
    expect(job?.outcome).toBe("missed");
    expect(job?.firedCount).toBe(0);
    expect(job?.missedAt).toBeGreaterThan(0);
    expect(s.recentMissed("a1").map((j) => j.id)).toEqual(["old"]);
    expect(s.list("a1")).toHaveLength(0); // still not pending
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

describe("fire durability (bd pibot-awhs)", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = tmpDir(); });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const onDisk = (): { jobs: Schedule[] } => JSON.parse(fs.readFileSync(path.join(dataDir, "schedules.json"), "utf8"));
  const jobOnDisk = (id: string): Schedule | undefined => onDisk().jobs.find((j) => j.id === id);

  it("writes the post-fire state to disk BEFORE the delivery callback runs", async () => {
    let during: Schedule | undefined;
    const s = new Scheduler(dataDir, (job) => {
      // read from INSIDE the delivery: the fire must already be durable
      during = jobOnDisk(job.id);
    });
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 20 }) });
    await waitFor(() => s.get(job.id)?.status === "done");
    // the claim is the only thing on disk while delivery is in flight
    expect(during?.firing).toBeDefined();
    expect(during?.firing?.firedCount).toBe(1);
    expect(during?.firing?.dueAtAtFire).toBe(during?.dueAt);
    s.stop();
  });

  it("never re-fires an already-delivered one-shot when the process dies mid-fire", () => {
    // A crashed process leaves exactly this: the claim on disk, nothing settled.
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60 }) });
    s.stop();
    const store = onDisk();
    const onDuty = store.jobs.find((j) => j.id === job.id)!;
    onDuty.firing = { claimedAt: Date.now(), dueAtAtFire: onDuty.dueAt, firedCount: 1 };
    fs.writeFileSync(path.join(dataDir, "schedules.json"), JSON.stringify(store));

    const refired: string[] = [];
    const reopened = new Scheduler(dataDir, (j) => void refired.push(j.id));
    expect(refired).toEqual([]); // THE BUG: this used to fire a second time
    const settled = reopened.get(job.id);
    expect(settled?.status).toBe("done");
    expect(settled?.outcome).toBe("fired");
    expect(settled?.firedCount).toBe(1);
    expect(settled?.firing).toBeUndefined();
    // and the settled state is on disk, so the next boot has nothing left to decide
    expect(jobOnDisk(job.id)?.firing).toBeUndefined();
    expect(jobOnDisk(job.id)?.outcome).toBe("fired");
    reopened.stop();
  });

  it("settles a repeat job's claimed occurrence to its next slot, not to a re-fire", () => {
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 60, repeat: { everyMs: 20 * 60_000 } }) });
    s.stop();
    const nextDueAt = job.dueAt + 20 * 60_000;
    const store = onDisk();
    const onDuty = store.jobs.find((j) => j.id === job.id)!;
    onDuty.firing = { claimedAt: Date.now(), dueAtAtFire: onDuty.dueAt, firedCount: 1, nextDueAt };
    fs.writeFileSync(path.join(dataDir, "schedules.json"), JSON.stringify(store));

    const refired: string[] = [];
    const reopened = new Scheduler(dataDir, (j) => void refired.push(j.id));
    const settled = reopened.get(job.id);
    expect(refired).toEqual([]);
    expect(settled?.status).toBe("pending");
    expect(settled?.firedCount).toBe(1);
    expect(settled?.dueAt).toBe(nextDueAt); // the claimed next occurrence, not a repeat
    expect(settled?.firing).toBeUndefined();
    reopened.stop();
  });

  it("reports a mid-fire job at boot instead of hiding the lost occurrence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 20 }) });
    s.stop();
    // plant a claim as a crashed process would leave it
    const store = onDisk();
    store.jobs.find((j) => j.id === job.id)!.firing = { claimedAt: Date.now(), dueAtAtFire: job.dueAt, firedCount: 1 };
    fs.writeFileSync(path.join(dataDir, "schedules.json"), JSON.stringify(store));

    const reopened = new Scheduler(dataDir, () => {});
    expect(warn.mock.calls.some((c) => String(c[0]).includes("mid-fire when the process stopped"))).toBe(true);
    expect(reopened.get(job.id)?.status).toBe("done");
    expect(reopened.get(job.id)?.outcome).toBe("fired");
    warn.mockRestore();
    reopened.stop();
  });

  it("keeps a repeat job's next occurrence durable across a clean stop", async () => {
    const s = new Scheduler(dataDir, () => {});
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 10, repeat: { everyMs: 20 * 60_000 } }) });
    await waitFor(() => (s.get(job.id)?.firedCount ?? 0) === 1);
    s.stop();

    const reopened = new Scheduler(dataDir, () => {});
    const stored = reopened.get(job.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.firedCount).toBe(1);
    expect(stored?.dueAt).toBeGreaterThan(Date.now()); // not the consumed occurrence
    expect(stored?.firing).toBeUndefined();
    reopened.stop();
  });

  it("persists a snooze set during a fire", async () => {
    const s = new Scheduler(dataDir, (job) => { s.snooze(job.agentId, Date.now() + 60_000, "during fire"); });
    const job = s.create({ ...makeJob({ dueAt: Date.now() + 10 }) });
    await waitFor(() => s.get(job.id)?.status === "done");
    s.stop();
    const reopened = new Scheduler(dataDir, () => {});
    expect(reopened.snoozeState("a1")?.until).toBeGreaterThan(Date.now());
    reopened.stop();
  });

  it("keeps a synchronous flush cheap for a 20-job set", () => {
    const s = new Scheduler(dataDir, () => {});
    for (let i = 0; i < 20; i++) s.create({ ...makeJob({ id: `perf${i}`, title: `job ${i}`, dueAt: Date.now() + (i + 1) * 60_000 }) });
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) s.flush();
    const perFlushMs = Number(process.hrtime.bigint() - started) / 1e6 / 20;
    // the budget the issue asks us to measure: a synchronous save on every fire
    expect(perFlushMs).toBeLessThan(15);
    s.stop();
  });
});
