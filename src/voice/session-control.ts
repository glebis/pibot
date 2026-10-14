import { AsyncLocalStorage } from 'node:async_hooks';

/** One owner of PiBot's mutable per-session turn state, including recursive goal turns. */
export class CanonicalTurnGate {
  private active = new Map<string, symbol>();
  private tails = new Map<string, Promise<void>>();
  private context = new AsyncLocalStorage<Map<string, symbol>>();
  busy(key: string): boolean { return this.tails.has(key) || this.active.has(key); }
  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const held = this.context.getStore()?.get(key);
    if (held && this.active.get(key) === held) return action();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(key, tail);
    await previous;
    const token = Symbol(key);
    this.active.set(key, token);
    const ctx = new Map(this.context.getStore()); ctx.set(key, token);
    try { return await this.context.run(ctx, action); }
    finally { this.active.delete(key); release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
  tryRun<T>(key: string, action: () => Promise<T>): Promise<T> | undefined {
    if (this.busy(key)) return undefined;
    return this.run(key, action);
  }
}
export interface BotVoiceInput {
  agentId: string; chatKey: string; text: string;
  onApprovalRequired?: () => void;
  onOutput?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}
export interface BotVoiceResult {
  status: 'completed' | 'no_reply' | 'busy' | 'denied' | 'failed' | 'detached';
  text?: string;
}
export interface ActiveVoiceTurn { input: BotVoiceInput; replies: string[]; detached: boolean }
