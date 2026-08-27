import { describe, expect, it, vi } from "vitest";
import { QuestionBus, type QuestionSpec } from "./questions.js";
import type { ChatRef, Transport } from "./types.js";

const CHAT: ChatRef = { transport: "mock", chatId: "42" };

function spec(over: Partial<QuestionSpec> = {}): QuestionSpec {
  return { text: "Which account?", options: ["client", "personal", "own-account", "unsure"], ...over };
}

function makeBus(poll = false) {
  const pushed: Array<{ chatId: string; opts: { text: string; card?: { buttons: { label: string; action: string }[] } } }> = [];
  const pollSent: Array<{ chatId: string; question: string; options: string[]; pollId: string }> = [];
  const transport = {
    name: "mock",
    push: vi.fn(async (chatId: string, opts: never) => pushed.push({ chatId, opts })),
    sendPoll: poll
      ? vi.fn(async (chatId: string, question: string, options: string[]) => {
          const pollId = `poll_${pollSent.length + 1}`;
          pollSent.push({ chatId, question, options, pollId });
          return { pollId };
        })
      : undefined,
  };
  const bus = new QuestionBus({ getTransport: () => transport as never });
  return { bus, pushed, pollSent, transport };
}

describe("QuestionBus buttons", () => {
  it("delivers a card with one button per option and resolves on tap", async () => {
    const { bus, pushed } = makeBus();
    const promise = bus.ask("a1", CHAT, spec());
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const card = pushed[0].opts.card!;
    expect(card.buttons.map((b) => b.label)).toEqual(["client", "personal", "own-account", "unsure"]);
    expect(card.buttons[2].action).toMatch(/^q:q_[a-z0-9]+:2$/);

    expect(bus.resolveCallback(card.buttons[2].action)).toEqual({ choice: "own-account", index: 2, via: "button" });
    const answer = await promise;
    expect(answer).toEqual({ choice: "own-account", index: 2, via: "button" });
  });

  it("returns null when a question is already pending for the chat", async () => {
    const { bus } = makeBus();
    const first = bus.ask("a1", CHAT, spec());
    const second = await bus.ask("a1", CHAT, spec());
    expect(second).toBeNull();
    bus.resolveCallback("q:x:0"); // unknown qid ignored
    expect(bus.pendingCount()).toBe(1);
    // cleanup
    bus.answerViaText("mock:42", "client");
    await first;
  });

  it("numeric text answers map to options", async () => {
    const { bus } = makeBus();
    const promise = bus.ask("a1", CHAT, spec());
    expect(bus.answerViaText("mock:42", "3")).toBe(true);
    expect((await promise)?.choice).toBe("own-account");
  });

  it("free text becomes the answer", async () => {
    const { bus } = makeBus();
    const promise = bus.ask("a1", CHAT, spec());
    expect(bus.answerViaText("mock:42", "it's my landlord actually")).toBe(true);
    const a = await promise;
    expect(a?.choice).toBe("it's my landlord actually");
    expect(a?.index).toBe(-1);
  });

  it("times out gracefully", async () => {
    const { bus } = makeBus();
    const promise = bus.ask("a1", CHAT, spec({ timeoutMs: 50 }));
    const a = await promise;
    expect(a?.timedOut).toBe(true);
    expect(bus.pendingCount()).toBe(0);
  });

  it("unknown qid callbacks are ignored", async () => {
    const { bus } = makeBus();
    expect(bus.resolveCallback("q:doesnotexist:1")).toBeNull();
    expect(bus.resolveCallback("scd:xyz:ok")).toBeNull();
  });
});

describe("QuestionBus polls", () => {
  it("uses a poll for long lists and resolves on vote", async () => {
    const { bus, pollSent, pushed } = makeBus(true);
    const options = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const promise = bus.ask("a1", CHAT, spec({ options, poll: true }));
    await vi.waitFor(() => expect(pollSent).toHaveLength(1));
    expect(pollSent[0].options).toHaveLength(8);
    expect(pushed).toHaveLength(0); // no button card when polling
    expect(bus.resolvePoll(pollSent[0].pollId, 3)).toEqual({ choice: "d", index: 3, via: "poll" });
    expect(await promise).toEqual({ choice: "d", index: 3, via: "poll" });
  });

  it("poll votes resolve via the pollId returned by the transport", async () => {
    const { bus, pollSent } = makeBus(true);
    const promise = bus.ask("a1", CHAT, spec({ options: ["a", "b", "c", "d", "e", "f", "g", "h"], poll: true }));
    await vi.waitFor(() => expect(pollSent).toHaveLength(1));
    expect(bus.resolvePoll("unknown-poll", 0)).toBeNull();
    expect(bus.resolvePoll(pollSent[0].pollId, 6)).toEqual({ choice: "g", index: 6, via: "poll" });
    expect((await promise)?.choice).toBe("g");
  });

  it("falls back to buttons when the transport cannot poll", async () => {
    const { bus, pushed } = makeBus(false);
    const promise = bus.ask("a1", CHAT, spec({ options: ["a", "b", "c", "d", "e", "f", "g"], poll: true }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    bus.answerViaText("mock:42", "a");
    await promise;
  });
});