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

  it("truncates at a word boundary — never mid-word", () => {
    const long = "Understood — thanks for the correction. I'll mirror relay-triggered acks and statuses back here when I'm the visible relay and it is all done properly.";
    const line = taskAckLine("completed", "researcher", long, { from: "pibot-dev" });
    expect(line.length).toBeLessThan(200);
    expect(line.endsWith("…”")).toBe(true);
    // the character before the ellipsis must end a complete word, not a fragment
    const beforeEllipsis = line.slice(0, -2).slice(-12);
    expect(beforeEllipsis.split(" ").pop()!.length).toBeGreaterThan(1);
    expect(line).not.toContain("the visi…”");
  });

  it("isTaskLike guards chatter-triggers", () => {
    expect(isTaskLike("Go ahead and")).toBe(false);
    expect(isTaskLike("ok")).toBe(false);
    expect(isTaskLike("file the Berlin takeaways with sources")).toBe(true);
  });

  it("isTaskLike strict requires task shape, not just length", () => {
    // imperative + explicit request shapes pass
    expect(isTaskLike("file the Berlin takeaways with sources", true)).toBe(true);
    expect(isTaskLike("please fix the deploy today", true)).toBe(true);
    expect(isTaskLike("Let's work on the messages", true)).toBe(true);
    expect(isTaskLike("can you check the dashboard", true)).toBe(true);
    expect(isTaskLike("I need you to update the vault", true)).toBe(true);
    // leading emoji/bracket noise is stripped before the shape probe
    expect(isTaskLike("🚀 ship the release notes", true)).toBe(true);
    // statements, questions, and relayed chatter are conversation — no ack
    expect(isTaskLike("this seems like technical info that I don't understand", true)).toBe(false);
    expect(isTaskLike("received this in creator, [17. Sep 2026 at 17:54:19]: [pibot-dev] Rotation serviced, mtime proven:", true)).toBe(false);
    expect(isTaskLike("what changed since yesterday?", true)).toBe(false);
    // non-strict keeps the plain word-count behavior
    expect(isTaskLike("received this in creator, [17. Sep 2026 at 17:54:19]: rotation", false)).toBe(true);
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