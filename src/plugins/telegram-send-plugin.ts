import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChatRef } from "../core/types.js";

export interface TelegramSendTarget {
  chat: string; // "transport:chatId"
  /** the transport belongs to this agent (its own bot identity) */
  dedicated: boolean;
  /** the agent currently owns this chat (is its bound agent) */
  owned: boolean;
}

/** Destination-aware delivery receipt returned by a send (bd pibot-cida). */
export interface TelegramSendReceipt {
  /** destination the receipt attests, as "transport:chatId" */
  peer: string;
  /** message id the API returned; only meaningful together with `idProtocol` */
  messageId?: number;
  /** delivered medium ("photo" | "document" | "video_note" | …) */
  mediaType?: string;
  /** id namespace ("bot_api" | "mtproto" | …) — ids from different protocols are never the same message */
  idProtocol?: string;
  /** bot/account identity that performed the send — never an agent id */
  account?: string;
  /** strongest evidence obtained: an API ack is not a readback, and neither is a human viewing */
  evidence?: "ack" | "readback" | "viewed";
}

export interface TelegramSendResult {
  sent: number;
  targets: string[];
  /** per-target receipts; absent/partial when the host has no message id to attest */
  receipts?: TelegramSendReceipt[];
}

export interface TelegramSendHooks {
  /**
   * Send a message as the agent's bot identity to an explicit
   * "transport:chatId" target (the bot must be able to reach it — Telegram
   * enforces access). Shared (non-dedicated) transports get a `[agentId]`
   * sender prefix, mirroring the host's proactive-delivery attribution.
   */
  send(agentId: string, chat: string, text: string): Promise<TelegramSendResult>;
  /** Chats this agent can currently reach, with ownership info. */
  chats(agentId: string): Array<{ chat: string; dedicated: boolean; owned: boolean }>;
}

export interface TelegramSendPluginDeps {
  agentId: string;
  /** the chat this session is bound to — default send target */
  chat: ChatRef;
  hooks: TelegramSendHooks;
}

/**
 * Human/agent-facing summary of a send that never overclaims (bd pibot-cida): it reports the
 * destination, medium and id namespace, and keeps an API acknowledgement distinct from a
 * same-peer readback or a human viewing. An id-less ack is explicitly "unverified", not "sent".
 */
function describeSend(r: TelegramSendResult): string {
  if (r.sent <= 0) return "Nothing sent — no reachable chat for that target.";
  const receipts = r.receipts ?? [];
  const withId = receipts.filter((x) => x.messageId !== undefined);
  const destinations = receipts.map((x) => x.peer).join(", ") || r.targets.join(", ");
  if (!withId.length) {
    return `Accepted by Telegram for ${destinations} but no message id came back — destination unverified, this is not proof of delivery.`;
  }
  const parts = withId.map((x) => {
    const bits = [`→ ${x.peer}`, `message ${x.messageId}`];
    if (x.mediaType) bits.push(x.mediaType);
    if (x.idProtocol) bits.push(`${x.idProtocol} id`);
    if (x.account) bits.push(`as ${x.account}`);
    // A receipt missing the account or the id namespace cannot prove which bot sent it or which
    // protocol the id belongs to — say so instead of implying a complete, verified delivery.
    const missing: string[] = [];
    if (!x.account) missing.push("account");
    if (!x.idProtocol) missing.push("id protocol");
    if (missing.length) bits.push(`incomplete (no ${missing.join("/")})`);
    return bits.join(" · ");
  });
  return `Sent ✅ ${parts.join("; ")} — API acknowledgement only, not a read or a human view.`;
}

/**
 * Ported from the pi-side `telegram-telethon` extension's send surface, adapted
 * to pibot: sends go through the host with the agent's BOT identity (no
 * Telethon/user-account access, no reads — bots cannot read chat history).
 */
export function telegramSendPlugin(deps: TelegramSendPluginDeps): InlineExtension {
  const { agentId, chat, hooks } = deps;
  return {
    name: "telegram-send",
    factory: (pi) => {
      pi.registerTool({
        name: "telegram_send",
        label: "Send Telegram",
        description: [
          "Send a Telegram message as this agent's bot identity.",
          "Default target is the chat you are talking in. `chat` targets another reachable chat as \"transport:chatId\" (e.g. \"telegram:42\", \"telegram:-1001234\"); delivery still depends on Telegram access (the bot must share that chat or be a member/admin there).",
          "Use for deliberate cross-posts — channels, groups, other chats. Regular conversation goes through your normal replies.",
        ].join(" "),
        parameters: Type.Object({
          text: Type.String({ description: "Message text (Telegram markdown)" }),
          chat: Type.Optional(Type.String({ description: 'Target chat as "transport:chatId" (e.g. "telegram:42"). Omit to send to the current chat.' })),
        }),
        async execute(_toolCallId, params) {
          const target = params.chat ?? `${chat.transport}:${chat.chatId}`;
          try {
            const r = await hooks.send(agentId, target, params.text);
            return {
              content: [{ type: "text", text: describeSend(r) }],
              details: { sent: r.sent, targets: r.targets, receipts: r.receipts ?? [] },
            };
          } catch (e) {
            return { content: [{ type: "text", text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }], details: { sent: 0, targets: [], receipts: [] } };
          }
        },
      });

      pi.registerTool({
        name: "telegram_chats",
        label: "Telegram chats",
        description: "List the Telegram chats this agent can currently post to (its own bot chats and owned chats), with ids usable as telegram_send targets.",
        parameters: Type.Object({}),
        async execute() {
          const list = hooks.chats(agentId);
          if (!list.length) {
            return { content: [{ type: "text", text: "No reachable Telegram chats yet — message the bot from the chat you want, then retry." }], details: { chats: [] } };
          }
          const lines = list.map((c) => `- ${c.chat}${c.dedicated ? " (own bot)" : ""}${c.owned ? "" : " (not owned — sends will carry a sender prefix)"}`);
          return { content: [{ type: "text", text: lines.join("\n") }], details: { chats: list } };
        },
      });
    },
  };
}