import { describe, expect, it } from "vitest";
import { classifyTaskReply, isTaskLike, taskAckLine, taskAcksEnabled } from "./task-acks.js";

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
  it("formats description-first lines — threaded drops attribution, unthreaded keeps it", () => {
    expect(taskAckLine("accepted", "creator", "On it — will file it with sources.")).toBe(
      "🤝 **creator**: “On it — will file it with sources.”"
    );
    expect(taskAckLine("declined", "tax", "I can't take this on.", { from: "knower" })).toBe(
      "🚫 **tax** declined **knower**'s task: “I can't take this on.”"
    );
    expect(taskAckLine("completed", "knower", "Done — vault swept.", { from: "coach" })).toBe(
      "✅ **knower** completed **coach**'s task: “Done — vault swept.”"
    );
  });

  it("truncates long done-snippets", () => {
    const long = "x".repeat(200);
    const line = taskAckLine("accepted", "a", long);
    expect(line.length).toBeLessThan(200);
    expect(line.endsWith("…”")).toBe(true);
  });

  it("isTaskLike guards chatter-triggers", () => {
    expect(isTaskLike("Go ahead and")).toBe(false);
    expect(isTaskLike("ok")).toBe(false);
    expect(isTaskLike("file the Berlin takeaways with sources")).toBe(true);
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