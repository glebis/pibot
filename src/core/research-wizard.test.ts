import { describe, expect, it, vi } from "vitest";
import { ResearchWizard, type WizardQuestion } from "./research-intake.js";
import { IntakeStore } from "./research-intake.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CHAT = { transport: "telegram", chatId: "42" };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-wiz-"));
}

type AskCall = { chat: unknown; spec: { text: string; options: string[]; poll?: boolean } };
type Canned = { choice?: string; index?: number; via?: "button" | "text" | "poll"; timedOut?: boolean; replaced?: boolean };

/** Scripted ask: pops canned QuestionAnswers in order; records the specs sent. */
function scriptedAsk(canned: Canned[]) {
  const calls: AskCall[] = [];
  const ask = vi.fn(async (_chat: unknown, spec: { text: string; options: string[] }) => {
    calls.push({ chat: _chat, spec });
    const c = canned[calls.length - 1] ?? { choice: "", index: -1, timedOut: true, via: "button" as const };
    return { choice: c.choice ?? "", index: c.index ?? -1, via: c.via ?? "button", ...c };
  });
  return { ask, calls };
}

const Q: WizardQuestion[] = [
  { key: "topic", question: "Which topics matter?", kind: "choice", options: ["metrics", "privacy", "cost"], required: true },
  { key: "depth", question: "How deep?", kind: "scale", max: 5, required: false },
  { key: "notes", question: "Anything else?", kind: "text", required: false },
];

function makeWizard(now: number = 1_700_000_000_000) {
  const dir = tmpDir();
  const store = new IntakeStore(dir);
  const { ask, calls } = scriptedAsk([]);
  const wizard = new ResearchWizard({ ask, store, now: () => now });
  return { wizard, store, ask, calls, dir };
}

describe("ResearchWizard", () => {
  it("runs 3-5 questions in order with inline progress prefixes and records answers", async () => {
    const dir = tmpDir();
    const store = new IntakeStore(dir);
    const { ask, calls } = scriptedAsk([
      { choice: "metrics", index: 0, via: "button" },
      { choice: "4", index: 3, via: "button" },
      { choice: "none", index: -1, via: "text" },
    ]);
    const wizard = new ResearchWizard({ ask, store, now: () => 1_700_000_000_000 });
    const r = await wizard.run("assistant", CHAT, "research-brief", Q);
    expect(r.status).toBe("completed");
    expect(r.answers).toEqual({ topic: "metrics", depth: 4, notes: "none" });
    expect(calls[0].spec.text).toContain("(1/3)");
    expect(calls[1].spec.text).toContain("(2/3)");
    expect(calls[2].spec.text).toContain("(3/3)");
    const rec = store.get(r.sessionId)!;
    expect(rec.status).toBe("completed");
    expect(rec.answers.map((a) => a.key)).toEqual(["topic", "depth", "notes"]);
    expect(rec.answers[0]).toMatchObject({ kind: "choice", modality: "button", skipped: false });
    expect(rec.answers[1]).toMatchObject({ kind: "scale", value: 4 });
  });

  it("optional questions carry a Skip button; typed skip skips without value", async () => {
    const dir = tmpDir();
    const store = new IntakeStore(dir);
    const { ask, calls } = scriptedAsk([
      { choice: "privacy", index: 1, via: "button" },
      { choice: "skip", index: -1, via: "text" }, // typed "skip" on the scale
    ]);
    const wizard = new ResearchWizard({ ask, store, now: () => 1_700_000_000_000 });
    const r = await wizard.run("assistant", CHAT, "research-brief", Q);
    expect(r.status).toBe("completed");
    expect(r.answers).toEqual({ topic: "privacy", depth: undefined, notes: undefined });
    // Skip button appended to optional questions (options ≤5 → stays inline)
    expect(calls[1].spec.options).toContain("Skip");
    const rec = store.get(r.sessionId)!;
    expect(rec.answers[1]).toMatchObject({ key: "depth", skipped: true, modality: "text" });
    expect(calls[2].spec.text).toContain("(3/3)"); // the flow continues past a skip
  });

  it("typed 'exit' stops the flow; status skipped, remaining questions unasked", async () => {
    const dir = tmpDir();
    const store = new IntakeStore(dir);
    const { ask, calls } = scriptedAsk([
      { choice: "metrics", index: 0, via: "button" },
      { choice: "exit", index: -1, via: "text" },
    ]);
    const wizard = new ResearchWizard({ ask, store, now: () => 1_700_000_000_000 });
    const r = await wizard.run("assistant", CHAT, "research-brief", Q);
    expect(r.status).toBe("skipped");
    expect(calls).toHaveLength(2); // the third question is never sent
    expect(store.get(r.sessionId)!.status).toBe("skipped");
  });

  it("rejects flows longer than 5 questions", async () => {
    const dir = tmpDir();
    const { ask } = scriptedAsk([]);
    const wizard = new ResearchWizard({ ask, store: new IntakeStore(dir) });
    const six: WizardQuestion[] = Array.from({ length: 6 }, (_, i) => ({ key: `q${i}`, question: `q${i}?`, kind: "text" as const, required: false }));
    await expect(wizard.run("assistant", CHAT, "flow", six)).rejects.toThrow(/3[–-]5 questions/i);
  });

  it("required questions re-ask on skip attempts; timeout → skipped", async () => {
    const dir = tmpDir();
    const store = new IntakeStore(dir);
    const { ask, calls } = scriptedAsk([
      { timedOut: true, index: -1 }, // the required lead question times out
    ]);
    const wizard = new ResearchWizard({ ask, store, now: () => 1_700_000_000_000 });
    const r = await wizard.run("assistant", CHAT, "research-brief", [
      { key: "topic", question: "Which?", kind: "choice", options: ["a", "b"], required: true },
      ...Q.slice(1, 2),
      ...Q.slice(2),
    ]);
    expect(calls).toHaveLength(1); // timeout ends the run (no re-ask loop)
    expect(r.status).toBe("skipped");
    expect(store.get(r.sessionId)!.answers[0]).toMatchObject({ key: "topic", skipped: true, modality: "none" });
  });
});