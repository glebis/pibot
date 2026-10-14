import type { Transformer } from 'grammy';
export interface DurableTelegramIngress {
  captureBatch(updates: unknown[]): void;
  handle(update: unknown): Promise<boolean>;
}
/** Capture BEFORE grammY sees a batch or changes lastTriedUpdateId (including its stop request). */
export function captureBeforePollingCursor(ingress: DurableTelegramIngress): Transformer {
  return async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method === 'getUpdates' && result.ok && Array.isArray(result.result)) ingress.captureBatch(result.result);
    return result;
  };
}
