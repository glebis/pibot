import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

export interface CommsHooks {
  /** deliver a message into another agent's session; returns that agent's reply text */
  askAgent(fromAgentId: string, toAgentId: string, text: string, timeoutMs?: number): Promise<string>;
  /** list available sibling agents */
  listAgents(): Array<{ id: string; description?: string }>;
}

export interface AgentCommsPluginDeps {
  agentId: string;
  /** provided by the host (PiBot) — routes through inter-agent sessions */
  askAgent: (from: string, to: string, text: string, timeoutMs?: number) => Promise<string>;
  listAgents: () => Array<{ id: string; description?: string }>;
}

/**
 * Shared plugin: agent-to-agent messaging.
 * - agent_message: fire-and-forget delivery into a sibling agent's session
 * - agent_ask: blocking question — the sibling's reply comes back as the result
 * - agent_list: who exists
 */
export function agentCommsPlugin(deps: AgentCommsPluginDeps): InlineExtension {
  return {
    name: "agent-comms",
    factory: (pi) => {
      pi.registerTool({
        name: "agent_message",
        label: "Message agent",
        description:
          "Send a message to a sibling agent (fire-and-forget). They will read it in their own session and act on it. Use for coordination that doesn't need an immediate answer.",
        parameters: Type.Object({
          to: Type.String({ description: "Target agent id (e.g. 'tax')" }),
          text: Type.String({ description: "The message" }),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: Record<string, unknown>;
          if (params.to === deps.agentId) {
            text = "That's you — just think it.";
            details = { ok: false };
          } else {
            try {
              await deps.askAgent(deps.agentId, params.to, params.text);
              text = `Delivered to **${params.to}**.`;
              details = { ok: true };
            } catch (e) {
              text = `delivery failed: ${truncate(String(e), 160)}`;
              details = { ok: false };
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });

      pi.registerTool({
        name: "agent_ask",
        label: "Ask agent",
        description:
          "Ask a sibling agent a question and wait for their answer (blocking, up to the timeout). Use for delegation that needs a response — e.g. ask 'tax' about a deadline. Do not use for urgent user-facing things.",
        parameters: Type.Object({
          to: Type.String({ description: "Target agent id" }),
          question: Type.String({ description: "The question" }),
          timeoutMinutes: Type.Optional(Type.String({ description: "Wait limit (default 10m)" })),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: Record<string, unknown>;
          if (params.to === deps.agentId) {
            text = "That's you — answer from your own knowledge.";
            details = { ok: false };
          } else {
            const timeoutMs = params.timeoutMinutes ? (parseFloat(params.timeoutMinutes) || 10) * 60e3 : undefined;
            try {
              const reply = await deps.askAgent(deps.agentId, params.to, params.question, timeoutMs);
              text = `**${params.to}** replied:\n${truncate(reply, 2500)}`;
              details = { reply };
            } catch (e) {
              text = `ask failed: ${truncate(String(e), 200)}`;
              details = { ok: false };
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });

      pi.registerTool({
        name: "agent_list",
        label: "List agents",
        description: "List sibling agents (id + description) you can message or ask.",
        parameters: Type.Object({}),
        async execute() {
          const others = deps.listAgents().filter((a) => a.id !== deps.agentId);
          if (!others.length) return { content: [{ type: "text", text: "No other agents." }], details: { count: 0 } };
          return {
            content: [{ type: "text", text: others.map((a) => `- **${a.id}** — ${a.description ?? "agent"}`).join("\n") }],
            details: { count: others.length },
          };
        },
      });
    },
  };
}