import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageCoalescer, type CoalescedTurn } from "./message-coalescer.js";

describe("MessageCoalescer", () => {
  let turns: CoalescedTurn[];
  let c: MessageCoalescer;

  beforeEach(() => {
    vi.useFakeTimers();
    turns = [];
    c = new MessageCoalescer(2500, MessageCoalescer.DEFAULT_MAX_PARTS, (turn) => turns.push(turn));
  });

  afterEach(() => {
    c.dispose();
    vi.useRealTimers();
  });

  it("buffers a single text and flushes it after the window", async () => {
    c.admit({ key: "tg:1", agentId: "assistant", text: "hello", messageId: 5 });
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2499);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(turns).toEqual([{ key: "tg:1", agentId: "assistant", text: "hello", reply: undefined, messageId: 5, parts: 1 }]);
  });

  it("joins rapid-fire texts with newline, keeps the first reply and last message id", async () => {
    c.admit({ key: "tg:1", agentId: "a", text: "one", reply: { messageId: 9, sender: "you", quoted: "root" }, messageId: 1 });
    c.admit({ key: "tg:1", agentId: "a", text: "two", messageId: 2 });
    c.admit({ key: "tg:1", agentId: "a", text: "three", messageId: 3 });
    await vi.advanceTimersByTimeAsync(2600);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("one\ntwo\nthree");
    expect(turns[0].reply).toEqual({ messageId: 9, sender: "you", quoted: "root" });
    expect(turns[0].messageId).toBe(3);
  });

  it("resets the window after every arrival", async () => {
    c.admit({ key: "k", agentId: "a", text: "one" });
    await vi.advanceTimersByTimeAsync(2000);
    c.admit({ key: "k", agentId: "a", text: "two" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(turns).toHaveLength(0); // only 2s since the last arrival
    await vi.advanceTimersByTimeAsync(600);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("one\ntwo");
  });

  it("keeps chats apart", async () => {
    c.admit({ key: "tg:1", agentId: "a", text: "one" });
    c.admit({ key: "tg:2", agentId: "b", text: "other" });
    await vi.advanceTimersByTimeAsync(2600);
    expect(turns).toHaveLength(2);
    expect(turns.find((t) => t.key === "tg:1")?.text).toBe("one");
    expect(turns.find((t) => t.key === "tg:2")?.text).toBe("other");
    expect(turns.find((t) => t.key === "tg:2")?.agentId).toBe("b");
  });

  it("force-flushes when maxParts is reached", () => {
    const tight = new MessageCoalescer(60_000, 3, (turn) => turns.push(turn));
    tight.admit({ key: "k", agentId: "a", text: "one" });
    tight.admit({ key: "k", agentId: "a", text: "two" });
    expect(turns).toHaveLength(0); // window not over, cap not reached
    tight.admit({ key: "k", agentId: "a", text: "three" });
    expect(turns).toHaveLength(1); // cap reached → immediate flush
    expect(turns[0].text).toBe("one\ntwo\nthree");
    // a later message starts a fresh buffer, not a dead timer
    tight.admit({ key: "k", agentId: "a", text: "four" });
    return vi.advanceTimersByTimeAsync(60_000).then(() => {
      expect(turns).toHaveLength(2);
      expect(turns[1].text).toBe("four");
      tight.dispose();
    });
  });

  it("dispose cancels pending flushes", async () => {
    c.admit({ key: "k", agentId: "a", text: "never sent" });
    c.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(turns).toHaveLength(0);
  });
});