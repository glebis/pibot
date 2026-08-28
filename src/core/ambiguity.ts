/**
 * Ouroboros-style ambiguity gate: score how clear a draft persona is before
 * creating the agent, and generate follow-up questions for the vague parts.
 *
 * Ambiguity = 1 - (goal*0.4 + constraints*0.3 + success*0.3)
 * The gate: score > threshold → ask the generated follow-ups first.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, truncate } from "./util.js";

export interface AmbiguityResult {
  /** 0 = crystal clear, 1 = pure guesswork */
  score: number;
  /** follow-up questions for the vague dimensions (max 2) */
  questions: string[];
  dimensions: { goal: number; constraints: number; success: number };
}

export const AMBIGUITY_THRESHOLD = 0.45;

/** Pure: weighted ambiguity from dimension scores (Ouroboros formula) */
export function computeAmbiguity(dims: { goal: number; constraints: number; success: number }): number {
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const clarity = clamp(dims.goal) * 0.4 + clamp(dims.constraints) * 0.3 + clamp(dims.success) * 0.3;
  return 1 - clarity;
}

const SYSTEM = `You are a spec-quality gate for personal AI agents. Score the DRAFT persona below on three dimensions (0.0-1.0):
- goal: is what this agent should DO specific and unambiguous?
- constraints: are the boundaries (what it must never do, scope limits) defined?
- success: would two people agree on what a good response looks like?

Then, if the score is above 0.35, write up to 2 follow-up questions that would most reduce ambiguity.
Reply with ONLY a JSON object: {"goal": n, "constraints": n, "success": n, "questions": ["...", "..."]}`;

/** Score a draft persona via a cheap ephemeral session */
export async function scorePersonaAmbiguity(
  personaText: string,
  opts: { modelRuntime: ModelRuntime; model?: ReturnType<ModelRuntime["getModel"]>; cwd?: string }
): Promise<AmbiguityResult> {
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd ?? process.cwd(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: SYSTEM,
  });
  await loader.reload();

  const session = (
    await createAgentSession({
      cwd: opts.cwd ?? process.cwd(),
      agentDir: getAgentDir(),
      modelRuntime: opts.modelRuntime,
      model: opts.model,
      thinkingLevel: "off",
      tools: [],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(opts.cwd ?? process.cwd()),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    })
  ).session;

  let result: AmbiguityResult = {
    score: 0.3,
    questions: [],
    dimensions: { goal: 0.8, constraints: 0.6, success: 0.6 },
  };
  try {
    await session.prompt(`Score this draft persona:\n\n${personaText.slice(0, 3000)}`);
    const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    const last = [...msgs].reverse().find((m) => m.role === "assistant");
    const raw = (last?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join(" ");
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { goal?: number; constraints?: number; success?: number; questions?: string[] };
      const dims = { goal: Number(parsed.goal) || 0, constraints: Number(parsed.constraints) || 0, success: Number(parsed.success) || 0 };
      result = { score: computeAmbiguity(dims), questions: (parsed.questions ?? []).slice(0, 2), dimensions: dims };
    }
  } catch {
    /* scoring failure = proceed with defaults */
  } finally {
    try {
      session.dispose();
    } catch {
      /* ignore */
    }
  }
  return result;
}

/** Persist the refined persona + ambiguity report next to the agent for auditability */
export function saveAmbiguityReport(agentDir: string, personaText: string, result: AmbiguityResult, answers: string[]): void {
  const dir = path.join(agentDir, "ambiguity");
  fs.mkdirSync(dir, { recursive: true });
  const entry = {
    date: new Date().toISOString(),
    score: Number(result.score.toFixed(3)),
    dimensions: result.dimensions,
    questions: result.questions,
    answers,
  };
  fs.writeFileSync(path.join(dir, "last-gate.json"), JSON.stringify(entry, null, 2) + "\n");
  void personaText;
}