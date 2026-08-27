import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { QuestionAnswer, QuestionSpec } from "../core/questions.js";
import type { ChatRef } from "../core/types.js";

export type AskFn = (spec: QuestionSpec) => Promise<QuestionAnswer | null>;

export interface QuestionPluginDeps {
  chat: ChatRef;
  ask: AskFn;
}

interface AskResult {
  choice: string;
  index: number;
  via: string;
  timedOut: boolean;
}

/**
 * Shared plugin: structured questions with tappable answers.
 * The tool blocks until the user taps a button / votes / types an answer,
 * then returns the choice as the tool result.
 */
export function questionPlugin(deps: QuestionPluginDeps): InlineExtension {
  return {
    name: "question",
    factory: (pi) => {
      pi.registerTool({
        name: "ask_user",
        label: "Ask user",
        description: [
          `Ask the user a structured question. They answer by tapping a button (2–6 options) or a poll (7–10 options) — or by typing.`,
          `Use whenever a decision has clear discrete options (e.g. "client / personal / own-account / unsure"). One question at a time.`,
          `Always include an "unsure" option when the user might not know. Blocks until they answer or the timeout passes.`,
        ].join(" "),
        parameters: Type.Object({
          question: Type.String({ description: "Short, concrete question" }),
          options: Type.Array(Type.String({ description: "Short option label" }), { minItems: 2, maxItems: 10 }),
          timeoutMinutes: Type.Optional(Type.String({ description: "How long to wait (default 10m)" })),
        }),
        async execute(_tcid, params) {
          const options = params.options.map((o) => o.trim()).filter(Boolean);
          if (options.length < 2) {
            return { content: [{ type: "text", text: "ERROR: need at least 2 options." }], details: { choice: "", index: -1, via: "", timedOut: false } };
          }
          const timeoutMs = params.timeoutMinutes ? (parseFloat(params.timeoutMinutes) || 10) * 60e3 : undefined;
          const spec: QuestionSpec = {
            text: params.question,
            options,
            timeoutMs,
            poll: options.length > 6,
          };
          let res: QuestionAnswer | null = null;
          let err: string | null = null;
          try {
            res = await deps.ask(spec);
          } catch (e) {
            err = String(e);
          }
          const answered: QuestionAnswer | null = res !== null && !res.timedOut ? res : null;
          const details: AskResult = answered
            ? { choice: answered.choice, index: answered.index, via: answered.via, timedOut: false }
            : { choice: "", index: -1, via: "", timedOut: true };
          const text =
            err !== null
              ? `ERROR asking: ${err}`
              : !answered
                ? `No answer within the timeout — proceed with your best judgement; don't block on it.`
                : answered.index >= 0
                  ? `User chose: "${answered.choice}"`
                  : `User replied (free text): "${answered.choice}"`;
          return { content: [{ type: "text", text }], details };
        },
      });
    },
  };
}