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
/** Appended to every live voice turn: the chat stays locked while a turn runs, so keep turns short. */
export const VOICE_CALL_DIRECTIVE = "[Live voice call: the owner hears your reply spoken and is waiting. Answer in 1–3 short spoken sentences, within about 15 seconds. Links, code and files cannot be spoken — name them in one short spoken sentence and put the details into your reply text: whatever your reply holds beyond the spoken part is delivered to the Telegram chat the call started from. For anything slower — research, asking another agent, multi-step tool work — call start_task if you have it and say the result will arrive in the chat; otherwise say you'll follow up there. Only the tools the owner enabled for this call are available. Ask clarifying questions out loud, not with buttons.]";

export interface BotVoiceInput {
  agentId: string; chatKey: string; text: string;
  /** owner-chosen tools for this call (names); undefined = the agent's full set, [] = talk only */
  allowedTools?: string[];
  onApprovalRequired?: () => void;
  onOutput?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}
export interface BotVoiceResult {
  status: 'completed' | 'no_reply' | 'busy' | 'denied' | 'failed' | 'detached';
  text?: string;
}
/** The agent's tools in a chat, grouped by the capability that provides them. */
export interface VoiceToolGroup { id: string; tools: Array<{ name: string; description: string }> }

export interface ActiveVoiceTurn { input: BotVoiceInput; replies: string[]; detached: boolean }
