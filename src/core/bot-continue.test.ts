import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeBot } from "./bot.test.js";

describe("/continue", () => {
  let t: ReturnType<typeof makeBot>;
  beforeEach(() => { t = makeBot(); });
  afterEach(() => { fs.rmSync(t.dir, { recursive: true, force: true }); });

  it("sends a continue prompt to the current chat agent", async () => {
    await t.transport.say("/continue");
    expect(t.promptSpy).toHaveBeenCalledWith(
      expect.stringContaining("continue"),
      expect.objectContaining({ streamingBehavior: "followUp" })
    );
  });

  it("pushes a Continue button on goal pause notices via goalCard", async () => {
    const { goalCard } = await import("./goals.js");
    const card = goalCard({ status: "paused", objective: "x", turnsUsed: 1, maxTurns: 3, subgoals: [], lastVerdict: "wait", lastReason: "waiting on build" } as never);
    expect(card?.buttons.map((b) => b.label)).toContain("▶️ Continue");
  });

  it("continue button action routes like the command", async () => {
    await t.bot.handleAction(t.transport, "42", "continue");
    expect(t.promptSpy).toHaveBeenCalledWith(expect.stringContaining("continue"), expect.anything());
    expect(String(await t.bot.handleAction(t.transport, "42", "continue"))).toContain("ontinuing");
  });
});