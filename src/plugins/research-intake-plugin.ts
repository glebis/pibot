import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChatRef } from "../core/types.js";
import type { QuestionSpec, QuestionAnswer } from "../core/questions.js";
import { ResearchWizard, type IntakeStore, type WizardQuestion } from "../core/research-intake.js";
import { truncate } from "../core/util.js";

export interface ResearchIntakePluginDeps {
  agentId: string;
  /** chat that owns the session this plugin instance is bound to */
  chat: ChatRef;
  /** QuestionBus hook (CapabilityContext.ask) — renders the wizard's questions in this chat */
  ask: (spec: QuestionSpec) => Promise<QuestionAnswer | null>;
  store: IntakeStore;
}

export function researchIntakePlugin(deps: ResearchIntakePluginDeps): InlineExtension {
  const { agentId, chat, ask, store } = deps;

  return {
    name: "research-intake",
    factory: (pi) => {
      pi.registerTool({
        name: "research_intake_run",
        label: "Research intake",
        description: [
          `Run a structured intake flow in the owner's chat: 3–5 sequential questions rendered with inline progress.`,
          `Each question has a kind: choice (options ≤5, or it auto-polls), confirm (yes/no), scale (1..max buttons), text (free text or voice note).`,
          `Optional questions show a Skip button; typed "skip" skips, "exit" aborts the flow. Answers persist and are returned as JSON.`,
        ].join(" "),
        parameters: Type.Object({
          flow: Type.String({ description: "Flow name, e.g. 'research-brief'" }),
          questions: Type.Array(
            Type.Object({
              key: Type.String({ description: "Stable answer key" }),
              question: Type.String({ description: "The question text" }),
              kind: Type.Union([Type.Literal("choice"), Type.Literal("confirm"), Type.Literal("scale"), Type.Literal("text")]),
              options: Type.Optional(Type.Array(Type.String(), { description: "choice options (≤5, skippable)" })),
              max: Type.Optional(Type.Number({ description: "scale upper bound, ≤6" })),
              required: Type.Optional(Type.Boolean({ description: "required questions cannot be skipped (default false)" })),
            }),
            { minItems: 3, maxItems: 5, description: "3–5 questions" }
          ),
          timeoutMinutes: Type.Optional(Type.Number({ description: "per-question timeout (default 10m)" })),
        }),
        async execute(_tcid, params) {
          try {
            const wizard = new ResearchWizard({
              ask: async (_chat, spec) =>
                (await ask(spec)) ?? { choice: "", index: -1, via: "button", timedOut: true },
              store,
              timeoutMs: params.timeoutMinutes ? params.timeoutMinutes * 60e3 : undefined,
            });
            const r = await wizard.run(
              agentId,
              chat,
              params.flow,
              params.questions as WizardQuestion[]
            );
            const stats = store.stats({ flow: params.flow });
            const text = `Intake ${r.status} (session ${r.sessionId})\n${JSON.stringify(r.answers)}\nflow stats: ${stats.answered} answered · ${stats.skipPct}% skipped · ${stats.avgLatencyMs}ms avg`;
            return { content: [{ type: "text", text: truncate(text, 2500) }], details: r };
          } catch (e) {
            return { content: [{ type: "text", text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }], details: {} };
          }
        },
      });
    },
  };
}