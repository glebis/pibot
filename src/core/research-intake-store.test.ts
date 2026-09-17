import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntakeStore, type IntakeRecord } from "./research-intake.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-intake-"));
}

function answered(over: Partial<NonNullable<IntakeRecord["answers"][number]>> = {}): NonNullable<IntakeRecord["answers"][number]> {
  return { key: "topic", question: "Which topics?", kind: "choice", value: "metrics", modality: "button", skipped: false, latencyMs: 4200, ts: Date.now(), ...over };
}

describe("IntakeStore", () => {
  let dir: string;
  beforeEach(() => (dir = tmpDir()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips sessions across instances", () => {
    const s = new IntakeStore(dir);
    const sess = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "research-brief", ["topic", "depth"]);
    expect(sess.id).toMatch(/^in/);
    expect(sess.status).toBe("active");
    expect(sess.answers).toEqual([]);

    const s2 = new IntakeStore(dir);
    expect(s2.get(sess.id)?.flow).toBe("research-brief");
    expect(s2.get(sess.id)?.pendingKeys).toEqual(["topic", "depth"]);
  });

  it("records answers with modality + latency and tracks pending keys", () => {
    const s = new IntakeStore(dir);
    const sess = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "research-brief", ["topic", "depth"]);
    s.recordAnswer(sess.id, "topic", { value: "metrics", modality: "button", skipped: false, latencyMs: 4200 });
    const after = s.get(sess.id)!;
    expect(after.answers).toHaveLength(1);
    expect(after.pendingKeys).toEqual(["depth"]);
    s.recordAnswer(after.id, "depth", { value: "deep", modality: "voice", skipped: false, latencyMs: 12000 });
    expect(s.get(sess.id)!.pendingKeys).toEqual([]);
  });

  it("skipped answers record the skip, not a value", () => {
    const s = new IntakeStore(dir);
    const sess = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "research-brief", ["topic"]);
    s.recordAnswer(sess.id, "topic", { modality: "none", skipped: true, latencyMs: 30000 });
    expect(s.get(sess.id)!.answers[0]).toMatchObject({ skipped: true, value: undefined, modality: "none" });
  });

  it("finishSession sets status + finishedAt; exit marks skipped", () => {
    const s = new IntakeStore(dir);
    const sess = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "research-brief", ["a"]);
    s.finishSession(sess.id, "completed");
    expect(s.get(sess.id)!.status).toBe("completed");
    expect(s.get(sess.id)!.finishedAt).toBeGreaterThan(0);
    const s2 = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "research-brief", ["a"]);
    s.finishSession(s2.id, "skipped");
    expect(s.get(s2.id)!.status).toBe("skipped");
  });

  it("stats: skip %, modality split, avg latency per flow", () => {
    const s = new IntakeStore(dir);
    const a = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "research-brief", ["topic", "depth"]);
    s.recordAnswer(a.id, "topic", { value: "metrics", modality: "button", skipped: false, latencyMs: 2000 });
    s.recordAnswer(a.id, "depth", { modality: "none", skipped: true, latencyMs: 30000 });
    s.finishSession(a.id, "completed");
    const b = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "research-brief", ["topic"]);
    s.recordAnswer(b.id, "topic", { value: "deep", modality: "voice", skipped: false, latencyMs: 10000 });
    s.finishSession(b.id, "completed");

    const st = s.stats({ agentId: "assistant" });
    expect(st.sessions).toBe(2);
    expect(st.answers).toBe(3);
    expect(st.answered).toBe(2);
    expect(st.skipped).toBe(1);
    expect(st.skipPct).toBe(33); // 1 skipped of 3 recorded answers
    expect(st.modalitySplit).toEqual({ button: 1, voice: 1 });
    expect(st.avgLatencyMs).toBe(6000); // answered only: (2000+10000)/2
  });

  it("stats honors since + flow filters", () => {
    const s = new IntakeStore(dir);
    const old = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "research-brief", ["a"]);
    s.finishSession(old.id, "completed");
    const fresh = s.createSession("assistant", { transport: "telegram", chatId: "42" }, "other-flow", ["x"]);
    s.finishSession(fresh.id, "completed");
    const st = s.stats({ since: fresh.createdAt - 1, flow: "other-flow" });
    expect(st.sessions).toBe(1);
    expect(st.perFlow["other-flow"]).toBe(1);
  });
});