import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChatRef } from "../core/types.js";
import { parseWhen, truncate } from "../core/util.js";

/**
 * Shared plugin: measurable commitment capture for agent sessions. Captures are
 * ALWAYS proposed — the owner confirms (or dismisses) via the inline card before
 * the follow-through loop starts. Analytics distinguish explicit (/commit) from
 * inferred (this tool) commitments.
 */
export interface CommitmentPluginEngine {
  captureInferred(
    agentId: string,
    chat: ChatRef,
    text: string,
    dueAt: number
  ): { commitment?: { id: string }; reply: string };
  listCommitments(agentId: string): Array<{ id: string; text: string; status: string; dueAt: number; origin: string }>;
  cancelCommitment(id: string): boolean;
}

export interface CommitmentPluginDeps {
  agentId: string;
  /** chat that owns the session this plugin instance is bound to */
  chat: ChatRef;
  engine: CommitmentPluginEngine;
}

export function commitmentPlugin(deps: CommitmentPluginDeps): InlineExtension {
  const { agentId, chat, engine } = deps;

  return {
    name: "commitments",
    factory: (pi) => {
      pi.registerTool({
        name: "commitment_capture",
        label: "Propose commitment",
        description: [
          `Capture a commitment the owner just made ("I'll send the report by Friday") as a measurable follow-through item.`,
          `It is only PROPOSED: the owner gets a confirm/dismiss card and the loop starts only after they confirm — never assume it is tracked.`,
          `Use when the owner states a concrete deliverable with a time bound. Do not propose vague intentions.`,
        ].join(" "),
        parameters: Type.Object({
          text: Type.String({ description: 'The commitment, e.g. "send invoice to Anna"' }),
          deadline: Type.String({ description: 'When it must be done: "friday 18:00", "tomorrow 9am", "in 3d"' }),
        }),
        async execute(_toolCallId, params) {
          const parsed = parseWhen(params.deadline);
          if (!parsed) {
            return {
              content: [{ type: "text", text: `ERROR: could not understand deadline "${params.deadline}". Ask the user for a clearer time.` }],
              details: { commitmentId: "" },
            };
          }
          const r = engine.captureInferred(agentId, chat, truncate(params.text.trim(), 300), parsed.dueAt);
          return { content: [{ type: "text", text: r.reply }], details: { commitmentId: r.commitment?.id ?? "" } };
        },
      });

      pi.registerTool({
        name: "commitment_list",
        label: "List commitments",
        description: "List your tracked commitments (measurable follow-through items), soonest first.",
        parameters: Type.Object({}),
        async execute() {
          const items = engine.listCommitments(agentId);
          if (!items.length) return { content: [{ type: "text", text: "No tracked commitments." }], details: {} };
          const lines = items.map(
            (c) => `- [${c.id}] ${c.text} — ${new Date(c.dueAt).toISOString()} · ${c.status} · ${c.origin}`
          );
          return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
        },
      });

      pi.registerTool({
        name: "commitment_cancel",
        label: "Cancel commitment",
        description: "Cancel one of your tracked commitments by id (see commitment_list).",
        parameters: Type.Object({
          id: Type.String({ description: "Commitment id, prefixes allowed" }),
        }),
        async execute(_tcid, params) {
          const ok = engine.cancelCommitment(params.id);
          return { content: [{ type: "text", text: ok ? `Cancelled ${params.id}.` : `No cancellable commitment matching "${params.id}".` }], details: {} };
        },
      });
    },
  };
}