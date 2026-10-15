import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBot } from "./bot.test.js";

// Rapid-fire texts (forwards, split messages) must combine into ONE agent turn
// instead of queueing one turn per message. Bead pibot-2dh, modeled on Verity's
// message_buffer.py; the window lives in config.messageBufferMs (PIBOT_BUFFER_MS).

const PROMPT_MS = 250;
const promptOf = (spy: { mock: { calls: unknown[][] } }, i = 0): string => String(spy.mock.calls[i][0]);

function makeCoalesceBot(windowMs = PROMPT_MS) {
  return makeBot(undefined, { messageBufferMs: windowMs });
}

describe("burst message combining", () => {
  let t: ReturnType<typeof makeCoalesceBot>;

  beforeEach(() => {
    vi.useFakeTimers();
    t = makeCoalesceBot();
  });

  afterEach(() => {
    vi.useRealTimers();
    t.bot.stop().catch(() => { /* flush timers are disposed in stop() */ });
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it("waits for the window, then prompts once with the burst joined", async () => {
    await t.transport.say("first part", 11);
    await t.transport.say("second part", 12);
    await t.transport.say("third part", 13);
    expect(t.promptSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROMPT_MS + 10);
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    const prompt = promptOf(t.promptSpy);
    expect(prompt).toContain("first part");
    expect(prompt).toContain("second part");
    expect(prompt).toContain("third part");
  });

  it("single message turns once, after only the window", async () => {
    await t.transport.say("just one", 21);
    expect(t.promptSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROMPT_MS + 10);
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
  });

  it("slash commands bypass the buffer even mid-burst", async () => {
    await t.transport.say("some context");
    await t.transport.say("/help");
    expect(t.transport.pushed.some((p) => p.opts.text.includes("/agents"))).toBe(true); // answered immediately
    await vi.advanceTimersByTimeAsync(PROMPT_MS + 10);
    expect(t.promptSpy).toHaveBeenCalledTimes(1); // only the buffered text prompts
    expect(promptOf(t.promptSpy)).not.toContain("/help");
  });

  it("a voice transcript joins texts that follow", async () => {
    await t.transport.say("typed question");
    await t.transport.sayMedia({ kind: "voice", filePath: "/tmp/x.ogg" });
    expect(t.stt.transcribe).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROMPT_MS + 10);
    expect(t.promptSpy).toHaveBeenCalledTimes(1);
    const prompt = promptOf(t.promptSpy);
    expect(prompt).toContain("typed question");
    expect(prompt).toContain("spoken words");
  });

  it("messageBufferMs 0 keeps every message its own immediate turn", async () => {
    vi.useRealTimers();
    t = makeCoalesceBot(0);
    await t.transport.say("one", 41);
    await t.transport.say("two", 42);
    expect(t.promptSpy).toHaveBeenCalledTimes(2);
    expect(promptOf(t.promptSpy, 0)).toContain("one");
    expect(promptOf(t.promptSpy, 1)).toContain("two");
  });
});