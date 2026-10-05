import { describe, expect, it, vi } from "vitest";
import { makeBot } from "./bot.test.js";

describe("silent turns — a turn that produces no text must not leave the owner guessing", () => {
  // Sep 18 incident: a genuine question to pibot-dev ran 14 tool calls and ended on a
  // reasoning-only terminal message. Nothing was pushed, no error, no log line — the
  // owner's chat simply stayed silent and looked like a dead bot.
  const userTurn = { role: "user", content: [{ type: "text", text: "[Fri, Sep 18, 2026, 3:55 PM]\n\nanalyse the whole flow" }] };
  const reasoningOnly = { role: "assistant", content: [{ type: "thinking", thinking: "weighing options…" }], stopReason: "stop" };
  const toolCallOnly = { role: "assistant", content: [{ type: "toolCall", name: "read", args: {} }], stopReason: "toolUse" };
  const narrated = { role: "assistant", content: [{ type: "text", text: "Now the Telegram transport:" }], stopReason: "toolUse" };

  function wire(t: ReturnType<typeof makeBot>, messages: unknown[], opts: { recovers?: boolean } = {}) {
    // bot's own session-event listener: only wiring the subscription here lets the
    // agent_end handler (the real pushing code) see the recovery turn
    let listener: ((ev: unknown) => void) | null = null;
    (t.agents.getOrCreateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      agent: { state: { messages } },
      prompt: t.promptSpy.mockImplementation(async (p: unknown) => {
        if (String(p).includes("[silent-turn]") && opts.recovers !== false) {
          // a real model answers the nudge with a short summary; the session appends
          // it and fires agent_end exactly like the pi runtime does
          messages.push({ role: "assistant", content: [{ type: "text", text: "Summary: rerouted the fanout logic." }], stopReason: "stop" });
          listener?.({ type: "agent_end", messages: [...messages], willRetry: false });
        }
      }),
      setModel: vi.fn(async () => {}),
      subscribe: vi.fn((cb: (ev: unknown) => void) => {
        listener = cb;
        return () => {};
      }),
      isStreaming: false,
    } as never);
    (t.cascade.chainFor as ReturnType<typeof vi.fn>).mockReturnValue(["ollama/test"]);
    (t.cascade.firstHealthy as ReturnType<typeof vi.fn>).mockReturnValue("ollama/test");
  }

  it("self-corrects: after a silent turn it re-prompts once for the missing text", async () => {
    const t = makeBot();
    const messages = [userTurn, narrated, toolCallOnly, reasoningOnly];
    wire(t, messages);
    await t.bot.promptAgent(t.transport, "42", "assistant", "analyse the whole flow");
    // two prompts total: the original turn + one bounded self-correction nudge
    expect(t.promptSpy).toHaveBeenCalledTimes(2);
    const nudge = String(t.promptSpy.mock.calls[1][0]);
    expect(nudge).toContain("[silent-turn] Internal:");
    // the recovery text reaches the chat, and no fallback warning is needed
    expect(t.transport.pushed.some((p) => p.opts.text.includes("Summary: rerouted"))).toBe(true);
    expect(t.transport.pushed.some((p) => p.opts.text.includes("without a reply"))).toBe(false);
  });

  it("the nudge is internal: it does not count as owner traffic and can not recurse", async () => {
    const t = makeBot();
    // never recovers → the guard runs a second time; the nudge prompt must not
    // re-enter the recovery logic (exactly one extra attempt, then the warning)
    wire(t, [userTurn, toolCallOnly], { recovers: false });
    await t.bot.promptAgent(t.transport, "42", "assistant", "analyse the whole flow");
    expect(t.promptSpy).toHaveBeenCalledTimes(2);
    const nudge = String(t.promptSpy.mock.calls[1]?.[0] ?? "");
    expect(nudge).toContain("[silent-turn] Internal:"); // internal prefix survives the time envelope
  });

  it("after the nudge still ends on nothing, the fallback warning goes out (last resort)", async () => {
    const t = makeBot();
    const turn = { role: "user", content: [{ type: "text", text: "[Fri, Sep 18]\n\nanalyse" }] };
    wire(t, [turn, toolCallOnly, reasoningOnly], { recovers: false });
    await t.bot.promptAgent(t.transport, "42", "assistant", "analyse the whole flow");
    expect(t.transport.pushed.some((p) => p.opts.text.includes("without a reply"))).toBe(true);
  });

  it("stays quiet when the terminal message does carry a reply", async () => {
    const t = makeBot();
    const replied = { role: "assistant", content: [{ type: "text", text: "Here is the analysis." }], stopReason: "stop" };
    wire(t, [userTurn, replied]);
    await t.bot.promptAgent(t.transport, "42", "assistant", "analyse the whole flow");
    expect(t.promptSpy).toHaveBeenCalledTimes(1); // no nudge on a normal turn
    expect(t.transport.pushed.some((p) => p.opts.text.includes("without a reply"))).toBe(false);
  });

  it("counts only the current turn's tool calls, not the whole session", async () => {
    const t = makeBot();
    const olderTurn = { role: "user", content: [{ type: "text", text: "[Thu, Sep 17, 2026]\n\nearlier ask" }] };
    const olderTools = [
      { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "toolCall", name: "read" }], stopReason: "toolUse" },
    ];
    wire(t, [olderTurn, ...olderTools, userTurn, toolCallOnly, reasoningOnly], { recovers: false });
    await t.bot.promptAgent(t.transport, "42", "assistant", "analyse the whole flow");
    const warning = t.transport.pushed.find((p) => p.opts.text.includes("without a reply"));
    expect(warning?.opts.text).toContain("1 tool call"); // not the older turn's 2
  });
});