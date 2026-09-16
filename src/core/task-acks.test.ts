import { describe, expect, it } from "vitest";
import { classifyTaskReply, taskAckLine, taskAcksEnabled } from "./task-acks.js";

describe("task-acks classifier", () => {
  it("detects implicit acceptance language", () => {
    expect(classifyTaskReply("On it — I'll file it right away.")).toBe("accepted");
    expect(classifyTaskReply("Will do, leave it with me.")).toBe("accepted");
    expect(classifyTaskReply("Adding it to my queue for tomorrow.")).toBe("accepted");
  });

  it("detects declines and gives them priority over other signals", () => {
    expect(classifyTaskReply("I can't take this on this week.")).toBe("declined");
    expect(classifyTaskReply("That's really better handled by tax — not my lane.")).toBe("declined");
    // decline wins even when an acceptance phrase also appears
    expect(classifyTaskReply("I'd love to, but I have to decline. On it next month maybe.")).toBe("declined");
  });

  it("detects completion", () => {
    expect(classifyTaskReply("Done — filed it properly with all sources.")).toBe("completed");
    expect(classifyTaskReply("Wrapped up, sent it over this morning.")).toBe("completed");
    // completion wins over acceptance phrasing
    expect(classifyTaskReply("It's done — I said on it yesterday.")).toBe("completed");
  });

  it("stays silent on non-task chatter", () => {
    expect(classifyTaskReply("Nice — the schema renders correctly now.")).toBeUndefined();
    expect(classifyTaskReply("Which account should I bill this to?")).toBeUndefined();
    expect(classifyTaskReply("")).toBeUndefined();
  });
});

describe("task-ack lines", () => {
  it("formats the passive confirmation line", () => {
    expect(taskAckLine("accepted", "creator", "knower", "file the Berlin takeaways\nwith sources")).toBe(
      "🤝 **creator** accepted a task from **knower** — “file the Berlin takeaways with sources”"
    );
    expect(taskAckLine("declined", "tax", "you", "audit my expenses")).toContain("🚫 **tax** declined");
    expect(taskAckLine("completed", "knower", "coach", "sweep the vault")).toContain("✅ **knower** completed");
  });

  it("truncates long task snippets", () => {
    const long = "x".repeat(200);
    const line = taskAckLine("accepted", "a", "b", long);
    expect(line.length).toBeLessThan(200);
    expect(line.endsWith("…”")).toBe(true);
  });
});

describe("task-acks gate", () => {
  it("defaults on, opts out explicitly", () => {
    expect(taskAcksEnabled(undefined)).toBe(true);
    expect(taskAcksEnabled({})).toBe(true);
    expect(taskAcksEnabled({ comms: {} })).toBe(true);
    expect(taskAcksEnabled({ comms: { taskAcks: false } })).toBe(false);
  });
});