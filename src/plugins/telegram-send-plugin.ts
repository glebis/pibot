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

export interface TelegramSendHooks {
  /**
   * Send a message as the agent's bot identity to an explicit
   * "transport:chatId" target (the bot must be able to reach it — Telegram
   * enforces access). Shared (non-dedicated) transports get a `[agentId]`
   * sender prefix, mirroring the host's proactive-delivery attribution.
   */
  send(agentId: string, chat: string, text: string): Promise<{ sent: number; targets: string[] }>;
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
              content: [{ type: "text", text: r.sent > 0 ? `Sent ✅ → ${r.targets.join(", ")}` : "Nothing sent — no reachable chat for that target." }],
              details: { sent: r.sent, targets: r.targets },
            };
          } catch (e) {
            return { content: [{ type: "text", text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }], details: { sent: 0, targets: [] } };
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