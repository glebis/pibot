import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

/** Explicit audience/delivery intent for an inter-agent call (bd pibot-jq9m).
 *  "internal" (the default): pure coordination — nothing reaches the owner chat,
 *  no acceptance ack, no reply push, no task ack there.
 *  "owner": an owner-facing delegated deliverable — acceptance, the final reply,
 *  and late results are delivered to the origin chat exactly once.
 *  Never inferred from chat origin, agent identity or message content keywords. */
export type DeliveryAudience = "internal" | "owner";

export interface CommsHooks {
  /** deliver a message into another agent's session; returns that agent's reply text.
   *  originChat: the chat the delegating agent is bound to — used only when the
   *  audience is "owner"; internal calls never touch it.
   *  intent distinguishes a blocking `agent_ask` from a fire-and-forget `agent_message`
   *  so a task-scoped host wrapper records only real ask replies (bd pibot-jiqv). */
  askAgent(fromAgentId: string, toAgentId: string, text: string, timeoutMs?: number, originChat?: { transport: string; chatId: string }, intent?: "ask" | "message", audience?: DeliveryAudience): Promise<string>;
  /** handoff: package this agent's context + deliver to the target; returns the target's ack */
  handoffContext(fromAgentId: string, toAgentId: string, note?: string, originChat?: { transport: string; chatId: string }): Promise<string>;
  /** list available sibling agents */
  listAgents(): Array<{ id: string; description?: string }>;
}

export interface AgentCommsPluginDeps {
  agentId: string;
  /** chat that owns the session this plugin instance is bound to — origin for status routing */
  chat: { transport: string; chatId: string };
  /** provided by the host (PiBot) — routes through inter-agent sessions */
  askAgent: CommsHooks["askAgent"];
  handoffContext: CommsHooks["handoffContext"];
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
          "Send a message to a sibling agent (fire-and-forget). They will read it in their own session and act on it. Use for coordination that doesn't need an immediate answer. Internal coordination never posts to the user's chat; set audience 'owner' only when the user explicitly asked for the delegated result in their own chat.",
        parameters: Type.Object({
          to: Type.String({ description: "Target agent id (e.g. 'tax')" }),
          text: Type.String({ description: "The message" }),
          audience: Type.Optional(Type.Union([Type.Literal("internal"), Type.Literal("owner")], { description: "Delivery audience: 'internal' (default) stays agent-only; 'owner' also delivers the reply to the user's chat. Use 'owner' only for explicit user-requested delegated deliverables." })),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: Record<string, unknown>;
          if (params.to === deps.agentId) {
            text = "That's you — just think it.";
            details = { ok: false };
          } else {
            try {
              await deps.askAgent(deps.agentId, params.to, params.text, undefined, deps.chat, "message", params.audience);
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
          "Ask a sibling agent a question and wait for their answer (blocking, up to the timeout). Use for delegation that needs a response — e.g. ask 'tax' about a deadline. Do not use for urgent user-facing things. The answer returns to you here; it is NOT posted to the user's chat unless audience is 'owner' — set that only when the user explicitly requested the delegated deliverable.",
        parameters: Type.Object({
          to: Type.String({ description: "Target agent id" }),
          question: Type.String({ description: "The question" }),
          timeoutMinutes: Type.Optional(Type.String({ description: "Wait limit (default 10m)" })),
          audience: Type.Optional(Type.Union([Type.Literal("internal"), Type.Literal("owner")], { description: "Delivery audience: 'internal' (default) returns to you only; 'owner' also delivers the reply to the user's chat. Use 'owner' only for explicit user-requested delegated deliverables." })),
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
              const reply = await deps.askAgent(deps.agentId, params.to, params.question, timeoutMs, deps.chat, "ask", params.audience);
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
        name: "handoff",
        label: "Handoff to agent",
        description:
          "Hand this conversation to another agent: they receive a distilled task brief (task, context, artifacts, next step) built from your thread. In a shared chat the conversation itself moves — the user's next message reaches them. In your own sub-bot chat only the context moves; tell the user how to reach the target.",
        parameters: Type.Object({
          to: Type.String({ description: "Target agent id" }),
          note: Type.Optional(Type.String({ description: "One-line summary of what matters right now" })),
        }),
        async execute(_tcid, params) {
          let text: string;
          let details: Record<string, unknown>;
          if (params.to === deps.agentId) {
            text = "That's you.";
            details = { ok: false };
          } else {
            try {
              const reply = await deps.handoffContext(deps.agentId, params.to, params.note, deps.chat);
              text = `Handed off to **${params.to}**. They have the context now.\n${truncate(reply, 300)}`;
              details = { ok: true };
            } catch (e) {
              text = `handoff failed: ${truncate(String(e), 200)}`;
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