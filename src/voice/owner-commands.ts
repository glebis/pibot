import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Owner-only voice commands: `/call` rings the owner's phone as the current chat's agent
 * (after an explicit confirm tap), `/voicetest` hands back the private browser test page
 * preselected with that agent. Admin gating lives in commands.ts; this module re-checks
 * that a confirmed call still targets the chat that asked for it.
 */

/** States the phone control service may report for an attempt (mirrors scripts/voice-call.py). */
const CALL_STATES = new Set(['dispatching', 'accepted', 'authenticated', 'streaming', 'unknown', 'completed', 'rejected', 'denied']);
const PRIVATE_CHAT_KEY = /^telegram(?::[A-Za-z0-9_-]+)?:[1-9][0-9]{0,19}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TEST_URL = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})\/#token=([0-9a-f]{64})$/;
const CONFIRM_TTL_MS = 120_000;
const MAX_DURATION_S = 180;

export type CallOutcome =
  | { ok: true; attemptId: string; state: string }
  | { ok: false; reason: 'expired' | 'not_configured' | 'not_bound' | 'service_down' | 'unknown_outcome'; attemptId?: string };

export interface PhoneControl {
  /** Canonical voice bindings: a call may only target a chat the bridge can serve. */
  bindings(): Array<{ agentId: string; chatKey: string }>;
  /** POST one attempt to the phone service; undefined when no control token is configured. */
  dispatch?(attempt: { attemptId: string; agentId: string; chatKey: string; reason: string; maxDurationSeconds: number }): Promise<unknown>;
}

export interface VoiceOwnerCommandsOptions {
  phone?: PhoneControl;
  /** owner-only file the browser test launcher writes its private URL to */
  testUrlFile: string;
  clock?: () => number;
}

interface PendingCall { agentId: string; chatKey: string; expires: number }

export class VoiceOwnerCommands {
  private pending = new Map<string, PendingCall>();
  private clock: () => number;
  constructor(private opts: VoiceOwnerCommandsOptions) { this.clock = opts.clock ?? Date.now; }

  /** Whether /call can work for this chat at all (configured, bridge-bound). */
  callAvailability(agentId: string, chatKey: string): 'ok' | 'not_configured' | 'not_bound' {
    if (!this.opts.phone?.dispatch) return 'not_configured';
    if (!AGENT_ID.test(agentId) || !PRIVATE_CHAT_KEY.test(chatKey)) return 'not_bound';
    return this.opts.phone.bindings().some((b) => b.agentId === agentId && b.chatKey === chatKey) ? 'ok' : 'not_bound';
  }

  /** Arm a single-use confirmation; returns the token carried by the ✅ button. */
  armCall(agentId: string, chatKey: string): string {
    const now = this.clock();
    for (const [id, p] of this.pending) if (p.expires <= now) this.pending.delete(id);
    const id = randomBytes(9).toString('base64url');
    this.pending.set(id, { agentId, chatKey, expires: now + CONFIRM_TTL_MS });
    return id;
  }

  cancel(id: string, chatKey: string): boolean {
    const p = this.pending.get(id);
    if (!p || p.chatKey !== chatKey) return false;
    this.pending.delete(id);
    return true;
  }

  /** Consume a confirmation (one-shot, same chat, unexpired) and place the call. */
  async confirmCall(id: string, chatKey: string): Promise<CallOutcome> {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p || p.chatKey !== chatKey || p.expires <= this.clock()) return { ok: false, reason: 'expired' };
    const availability = this.callAvailability(p.agentId, p.chatKey);
    if (availability !== 'ok') return { ok: false, reason: availability };
    const attemptId = `manual-${randomUUID().replace(/-/g, '')}`;
    let receipt: unknown;
    try {
      receipt = await this.opts.phone!.dispatch!({ attemptId, agentId: p.agentId, chatKey: p.chatKey, reason: 'Explicit owner /call', maxDurationSeconds: MAX_DURATION_S });
    } catch (e) {
      // Refused connection = nothing was sent; anything else may have reached Twilio.
      return { ok: false, reason: (e as { code?: string }).code === 'ECONNREFUSED' ? 'service_down' : 'unknown_outcome', attemptId };
    }
    const r = receipt as { attemptId?: unknown; state?: unknown };
    if (r?.attemptId !== attemptId || typeof r.state !== 'string' || !CALL_STATES.has(r.state)) return { ok: false, reason: 'unknown_outcome', attemptId };
    return { ok: true, attemptId, state: r.state };
  }

  /** Private loopback test-page URL preselected with the agent, or undefined when the page isn't running. */
  testPageUrl(agentId: string): string | undefined {
    if (!AGENT_ID.test(agentId)) return undefined;
    let raw: string;
    try {
      const fd = fs.openSync(this.opts.testUrlFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 512) return undefined;
        raw = fs.readFileSync(fd, 'utf8').trim();
      } finally { fs.closeSync(fd); }
    } catch { return undefined; }
    if (!TEST_URL.test(raw)) return undefined;
    return `${raw}&agent=${encodeURIComponent(agentId)}`;
  }
}

/** Phone control over the local service (scripts/voice-call.py's endpoint), loopback only. */
export function httpPhoneControl(opts: { controlUrl: string; token: string; bindings: () => Array<{ agentId: string; chatKey: string }> }): PhoneControl {
  const url = new URL(opts.controlUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Phone control must be a loopback http URL');
  if (!/^[0-9a-f]{64}$/.test(opts.token)) throw new Error('Invalid phone control credential');
  return {
    bindings: opts.bindings,
    async dispatch(attempt) {
      const res = await fetch(new URL('/control/calls', url), {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(attempt),
        signal: AbortSignal.timeout(20_000),
      }).catch((e: unknown) => { throw (e as { cause?: unknown }).cause ?? e; });
      const text = await res.text();
      if (text.length > 65_536) throw new Error('response too large');
      return JSON.parse(text);
    },
  };
}
