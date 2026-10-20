import { describe, expect, it } from "vitest";
import { beginActivity, liveActivities, trackActivity } from "./activity.js";

describe("activity registry", () => {
  it("lists a tracked call only while it runs, with the session's bound model", async () => {
    let release!: () => void;
    const session = { model: { provider: "openai-codex", id: "gpt-6.1-sol" } };
    const running = trackActivity({ kind: "heartbeat", label: "heartbeat   tick", agentId: "knower", session }, () => new Promise<void>((r) => { release = r; }));
    expect(liveActivities()).toEqual([expect.objectContaining({ kind: "heartbeat", label: "heartbeat tick", agentId: "knower", model: "openai-codex/gpt-6.1-sol" })]);
    release();
    await running;
    expect(liveActivities()).toEqual([]);
  });

  it("drops the entry even when the call throws", async () => {
    await expect(trackActivity({ kind: "memory", label: "distil" }, async () => { throw new Error("429"); })).rejects.toThrow("429");
    expect(liveActivities()).toEqual([]);
  });

  it("lists oldest first and ends idempotently", () => {
    const a = beginActivity({ kind: "chat", label: "first" }, 1000);
    const b = beginActivity({ kind: "task", label: "second" }, 2000);
    expect(liveActivities().map((x) => x.label)).toEqual(["first", "second"]);
    a(); a(); b();
    expect(liveActivities()).toEqual([]);
  });
});
