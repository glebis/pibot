import { describe, expect, it, vi } from "vitest";
import {
  askChoice,
  askConfirm,
  askScale,
  askText,
  type AskFn,
  type IntakeAnswer,
} from "./research-intake.js";
import type { QuestionAnswer, QuestionSpec } from "./questions.js";

const CHAT = { transport: "telegram", chatId: "42" };

/** Fake QuestionBus.ask — records specs, replays canned answers. */
function fakeAsk(answer: Partial<QuestionAnswer> = {}): { ask: AskFn; specs: QuestionSpec[] } {
  const specs: QuestionSpec[] = [];
  const ask: AskFn = vi.fn(async (_chat, spec: QuestionSpec): Promise<QuestionAnswer> => {
    specs.push(spec);
    return { choice: "3", index: 2, via: "button", ...answer };
  });
  return { ask, specs };
}

describe("research-intake primitives", () => {
  it("askChoice forwards text+options", async () => {
    const f = fakeAsk();
    const a = await askChoice(f.ask, CHAT, "Which topics matter?", ["metrics", "privacy", "cost"], { timeoutMs: 60e3 });
    expect(f.specs[0]).toEqual({ text: "Which topics matter?", options: ["metrics", "privacy", "cost"], timeoutMs: 60e3, poll: undefined });
    expect(a.value).toBe("3");
    expect(a.raw.via).toBe("button");
  });

  it("askConfirm returns a boolean", async () => {
    const f = fakeAsk({ index: 0, choice: "Yes" });
    const a = await askConfirm(f.ask, CHAT, "Ship the pilot now?");
    expect(f.specs[0].options).toEqual(["Yes", "No"]);
    expect(a.value).toBe(true);
  });

  it("askScale renders 1..N as numbered buttons and returns a number", async () => {
    const f = fakeAsk({ index: 3, choice: "4" });
    const a = await askScale(f.ask, CHAT, "How useful was this?", 5);
    expect(f.specs[0].options).toEqual(["1", "2", "3", "4", "5"]);
    expect(a.value).toBe(4);
  });

  it("askText sends a cardless question; any reply becomes free text", async () => {
    const f = fakeAsk({ choice: "about 2 hours", index: -1, via: "text" });
    const a = await askText(f.ask, CHAT, "How long did the intake take?");
    expect(f.specs[0].options).toEqual([]);
    expect(a.value).toBe("about 2 hours");
  });

  it("records the answer modality (button vs poll vs text)", async () => {
    const f = fakeAsk({ via: "poll" });
    const a = await askChoice(f.ask, CHAT, "big list?", Array.from({ length: 7 }, (_, i) => `o${i}`));
    expect(a.modality).toBe("poll");
    const g = fakeAsk({ via: "text", choice: "spoken", index: -1 });
    const b = await askText(g.ask, CHAT, "open question");
    expect(b.modality).toBe("text");
  });

  it("times-out questions surface as skipped with no value", async () => {
    const f = fakeAsk({ timedOut: true, index: -1, choice: "" });
    const a: IntakeAnswer<boolean> = await askConfirm(f.ask, CHAT, "still there?");
    expect(a.value).toBeUndefined();
    expect(a.skipped).toBe(true);
    expect(a.modality).toBe("button");
  });
});