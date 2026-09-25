// ─── /goal — a bounded autonomy loop ────────────────────────────────────────
//
// Mirrors the reference implementation on this machine (Hermes' hermes_cli/goals.py):
// an objective plus an evidence-based COMPLETION CONTRACT, a judge that says
// done | continue | wait after each turn, and a bounded continuation loop.
//
// What this file owns: the state shape, the prompt blocks, the verdict parse and
// every bound. What it deliberately does NOT own: the loop itself (bot.ts drives
// it) and the decision to spend a model call — both are visible at the call site.
//
// Bounds are the point of the design, not an afterthought: an autonomous loop is
// the one feature that can spend money while nobody is watching.

/** Structured completion contract — what makes "done" evidence-based. */
export type GoalContract = {
  /** the observable end state */
  outcome?: string;
  /** how completion is checked (a command, a file, a reply) */
  verification?: string;
  /** rules that must hold while working */
  constraints?: string;
  /** what must not be touched or changed */
  boundaries?: string;
  /** explicit stop condition for the loop */
  stopWhen?: string;
};

export type GoalVerdict = "done" | "continue" | "wait";

export type GoalState = {
  objective: string;
  contract: GoalContract;
  status: "active" | "paused" | "done";
  turnsUsed: number;
  maxTurns: number;
  createdAt: number;
  lastTurnAt: number;
  lastVerdict?: GoalVerdict;
  lastReason?: string;
  /** consecutive unparseable judge replies — auto-pause before this drains a budget */
  parseFailures: number;
  /** criteria added mid-loop; both the judge and the continuation see them */
  subgoals: string[];
};

export const GOAL_MAX_TURNS_DEFAULT = 8;
export const GOAL_MAX_PARSE_FAILURES = 3;
/** Judge replies are one JSON line; keep the snippet small so the prompt stays cheap. */
export const GOAL_REPLY_SNIPPET = 1_500;

export function newGoal(objective: string, opts: { maxTurns?: number; now?: number; contract?: GoalContract } = {}): GoalState {
  const now = opts.now ?? Date.now();
  return {
    objective: objective.trim(),
    contract: opts.contract ?? {},
    status: "active",
    turnsUsed: 0,
    maxTurns: Math.max(1, Math.min(opts.maxTurns ?? GOAL_MAX_TURNS_DEFAULT, 50)),
    createdAt: now,
    // creation counts as the first turn boundary: without it, the very message that
    // SET the goal looks like newer steering and vetoes the loop before it starts
    lastTurnAt: now,
    parseFailures: 0,
    subgoals: [],
  };
}

/** A contract is "drafted" when at least the outcome is known. */
export function hasContract(state: GoalState): boolean {
  return Boolean(state.contract?.outcome || state.contract?.verification);
}

/** The compact block appended to a turn's prompt. Suffix, so internal-prefix detection is untouched. */
export function renderGoalBlock(state: GoalState): string {
  const lines = [`[goal] ${state.objective}`, `progress: turn ${state.turnsUsed + 1} of ${state.maxTurns}`];
  const c = state.contract ?? {};
  if (c.outcome) lines.push(`outcome: ${c.outcome}`);
  if (c.verification) lines.push(`verification: ${c.verification}`);
  if (c.constraints) lines.push(`constraints: ${c.constraints}`);
  if (c.boundaries) lines.push(`boundaries: ${c.boundaries}`);
  if (state.subgoals.length) lines.push(`extra criteria:\n${state.subgoals.map((s, i) => `- ${i + 1}. ${s}`).join("\n")}`);
  lines.push(
    "Work the next concrete step toward this goal, then report what you did in one or two sentences. " +
      "If the goal is fully satisfied, say so explicitly — the loop stops on evidence, not on optimism.",
  );
  return lines.join("\n");
}

/** What /goal prints. */
export function renderGoalStatus(state: GoalState | undefined): string {
  if (!state) return "No goal set. Set one: /goal <objective>  ·  /goal draft <objective>";
  const c = state.contract ?? {};
  const lines = [
    `🎯 **${state.status}** — ${state.objective}`,
    `progress: ${state.turnsUsed}/${state.maxTurns} turns${state.contract && hasContract(state) ? "" : " · no contract yet (/goal draft)"}`,
  ];
  if (c.outcome) lines.push(`• outcome: ${c.outcome}`);
  if (c.verification) lines.push(`• verification: ${c.verification}`);
  if (c.constraints) lines.push(`• constraints: ${c.constraints}`);
  if (c.boundaries) lines.push(`• boundaries: ${c.boundaries}`);
  if (state.subgoals.length) lines.push(`• extra criteria: ${state.subgoals.join(" · ")}`);
  if (state.lastVerdict) lines.push(`last judge: ${state.lastVerdict}${state.lastReason ? ` — ${state.lastReason}` : ""}`);
  return lines.join("\n");
}

/** The judge prompt: does the last reply show the goal is met? */
export function buildJudgePrompt(state: GoalState, lastReply: string): string {
  const c = state.contract ?? {};
  return [
    "You judge whether an agent's goal is complete. Be strict and evidence-based.",
    "",
    `GOAL: ${state.objective}`,
    c.outcome ? `OUTCOME (what must be true when done): ${c.outcome}` : "",
    c.verification ? `VERIFICATION (how completion is checked): ${c.verification}` : "",
    c.boundaries ? `BOUNDARIES: ${c.boundaries}` : "",
    c.stopWhen ? `STOP WHEN: ${c.stopWhen}` : "",
    state.subgoals.length ? `ADDITIONAL CRITERIA the judge must consider:\n${state.subgoals.map((s, i) => `- ${i + 1}. ${s}`).join("\n")}` : "",
    "",
    "THE AGENT'S LAST REPLY:",
    lastReply.slice(0, GOAL_REPLY_SNIPPET),
    "",
    "Verdicts:",
    '- done — the goal is fully satisfied and the reply shows it.',
    '- continue — not done, and there is a concrete next step the agent can take alone.',
    '- wait — not done, but progress needs something external (the owner, a build, a person).',
    'Reply with ONE line of JSON only: {"verdict":"done|continue|wait","reason":"<one sentence>"}',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Tolerant parse — a judge that mumbles must not look like a verdict. */
export function parseGoalVerdict(raw: string): { verdict: GoalVerdict; reason: string } | null {
  const match = (raw ?? "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
    const verdict = String(parsed.verdict ?? "").trim().toLowerCase();
    if (verdict !== "done" && verdict !== "continue" && verdict !== "wait") return null;
    return { verdict, reason: String(parsed.reason ?? "").trim().slice(0, 300) };
  } catch {
    return null;
  }
}

/** Pure transition: apply a verdict (or a parse failure) to the state. */
export function advanceGoal(state: GoalState, outcome: { verdict: GoalVerdict; reason: string } | null, now = Date.now()): GoalState {
  const turnsUsed = state.turnsUsed + 1;
  if (!outcome) {
    const parseFailures = state.parseFailures + 1;
    return {
      ...state,
      turnsUsed,
      parseFailures,
      lastTurnAt: now,
      status: parseFailures >= GOAL_MAX_PARSE_FAILURES ? "paused" : state.status,
      lastReason: parseFailures >= GOAL_MAX_PARSE_FAILURES ? `auto-paused: ${parseFailures} unreadable judge replies` : state.lastReason,
    };
  }
  return {
    ...state,
    turnsUsed,
    parseFailures: 0,
    lastTurnAt: now,
    lastVerdict: outcome.verdict,
    lastReason: outcome.reason,
    status: outcome.verdict === "done" ? "done" : state.status,
  };
}

export type ContinueDecision =
  | { continue: true }
  | { continue: false; reason: "not_active" | "budget_exhausted" | "owner_steering" | "snoozed" | "no_new_work" };

/**
 * Every reason NOT to keep going: an inactive goal, snooze, or the turn budget.
 *
 * Steering is deliberately NOT a stop. When the owner speaks mid-goal, that message
 * IS the next step (promptAgent is sequential, so the loop cannot race it) and the
 * loop resumes from their turn. Blocking instead would kill the goal every time the
 * owner said anything — the opposite of steering.
 */
export function shouldContinue(
  state: GoalState | undefined,
  opts: { snoozed?: boolean; lastOwnerMessageAt?: number; lastAutoTurnAt?: number; now?: number } = {},
): ContinueDecision {
  if (!state || state.status !== "active") return { continue: false, reason: "not_active" };
  const now = opts.now ?? Date.now();
  // a snoozed rhythm means "don't interrupt"; the goal waits rather than dying
  if (opts.snoozed) return { continue: false, reason: "snoozed" };
  if (state.turnsUsed >= state.maxTurns) return { continue: false, reason: "budget_exhausted" };
  // an auto-turn that has not been judged yet must not stack another one
  if (opts.lastAutoTurnAt && now - opts.lastAutoTurnAt < 1_000) return { continue: false, reason: "no_new_work" };
  return { continue: true };
}

// ─── the two model calls (draft a contract, judge a reply) ───────────────────

export type GoalIO = {
  draftContract(objective: string): Promise<GoalContract | null>;
  judge(state: GoalState, lastReply: string): Promise<{ verdict: GoalVerdict; reason: string } | null>;
};

const DRAFT_SYSTEM =
  "You turn a plain-language objective into a completion contract that makes 'done' checkable. " +
  "Reply with ONLY a JSON object: {\"outcome\":\"...\",\"verification\":\"...\",\"constraints\":\"...\",\"boundaries\":\"...\",\"stop_when\":\"...\"}. " +
  "Keep every field under 200 characters, concrete and observable. Omit a field you cannot infer.";

const JUDGE_SYSTEM = "You are a strict completion judge. Reply with one line of JSON and nothing else.";

/** Build the default IO on cheap ephemeral sessions (same shape as ambiguity/evolution). */
export async function createLlmGoalIO(deps: {
  modelRuntime: unknown;
  model: unknown;
  cwd?: string;
}): Promise<GoalIO> {
  const { DefaultResourceLoader, createAgentSession, SessionManager, SettingsManager, getAgentDir } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const cwd = deps.cwd ?? process.cwd();
  const run = async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt,
    });
    await loader.reload();
    const session = (
      await createAgentSession({
        cwd,
        agentDir: getAgentDir(),
        modelRuntime: deps.modelRuntime as never,
        model: deps.model as never,
        thinkingLevel: "off",
        tools: [],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      })
    ).session;
    try {
      await session.prompt(userPrompt);
      const msgs = (session.agent.state.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      return (last?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join(" ");
    } finally {
      try {
        session.dispose();
      } catch {
        /* ephemeral */
      }
    }
  };

  return {
    async draftContract(objective: string): Promise<GoalContract | null> {
      try {
        const raw = await run(DRAFT_SYSTEM, `Objective: ${objective.slice(0, 1_000)}`);
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        const pick = (k: string): string | undefined => {
          const v = String(parsed[k] ?? parsed[k.replace(/[A-Z]/g, (m) => m.toLowerCase())] ?? "").trim();
          return v ? v.slice(0, 200) : undefined;
        };
        const contract: GoalContract = {
          outcome: pick("outcome"),
          verification: pick("verification"),
          constraints: pick("constraints"),
          boundaries: pick("boundaries"),
          stopWhen: pick("stop_when") ?? pick("stopWhen"),
        };
        return hasContract({ ...newGoal(objective), contract }) ? contract : null;
      } catch {
        return null;
      }
    },
    async judge(state: GoalState, lastReply: string) {
      try {
        return parseGoalVerdict(await run(JUDGE_SYSTEM, buildJudgePrompt(state, lastReply)));
      } catch {
        return null;
      }
    },
  };
}
