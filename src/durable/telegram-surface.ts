// Telegram surface for the Pi Durable satellite: chat messages become exactly-once
// satellite submissions, and settled answers are pushed back into the chat.
//
// The surface is deliberately transport-agnostic (anything with onMessage/push) —
// production wires the real TelegramTransport; tests use fakes. A crash between
// submit and answer loses nothing: the harness checkpoints the task, and the same
// chat+message requestId replays instead of re-running.

import type { PushOptions, Transport } from "../core/types.js";

/** The sliver of the satellite the surface needs (openSatellite returns a superset). */
export interface SatelliteLike {
  ask(content: string, requestId?: string): Promise<string>;
}

export interface TelegramSurface {
  dispose(): void;
}

export function attachTelegramSurface(opts: { transport: Transport; satellite: SatelliteLike }): TelegramSurface {
  const { transport: t, satellite } = opts;
  let disposed = false;

  const onMessage = async (text: string, chatId: string, _reply?: unknown, messageId?: number): Promise<void> => {
    if (disposed || !text.trim()) return;
    const requestId = `telegram:${chatId}:${messageId ?? Date.now()}`;
    try {
      const answer = await satellite.ask(text, requestId);
      await t.push(chatId, { text: answer } satisfies PushOptions);
    } catch (e) {
      await t.push(chatId, { text: `⚠️ satellite failed to answer: ${(e as Error).message}` }).catch(() => {});
    }
  };

  t.onMessage(async (text, chatId, reply, messageId) => {
    await onMessage(text, chatId, reply, messageId).catch((e) => console.error("[durable-surface] message error:", e));
  });

  return {
    dispose() {
      disposed = true;
    },
  };
}