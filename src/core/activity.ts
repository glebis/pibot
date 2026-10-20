/**
 * Process-wide registry of model turns in flight — every session.prompt() the
 * daemon starts, whatever started it (chat, heartbeat, tasks, memory, evolution…).
 * Read by the /processes admin page. A module singleton on purpose: the call
 * sites live in modules that share no deps object, and this is observability,
 * not control flow — losing an entry can never change behaviour.
 */

export type ActivityKind =
  | "chat" | "voice" | "scheduled" | "dead-letter"
  | "heartbeat" | "morning-brief" | "agent-message" | "handoff" | "handoff-brief"
  | "task" | "goal-judge" | "memory" | "evolution" | "persona-score";

export interface ActivityInput {
  kind: ActivityKind;
  /** short human description: the message, task title, or what the helper does */
  label: string;
  agentId?: string;
  chatKey?: string;
  /** the session running it — its bound model is read when the registry is listed */
  session?: unknown;
}

export interface Activity {
  id: number;
  kind: ActivityKind;
  label: string;
  agentId?: string;
  chatKey?: string;
  model?: string;
  startedAt: number;
}

const live = new Map<number, ActivityInput & { startedAt: number }>();
let seq = 0;

function modelOf(session: unknown): string | undefined {
  const m = (session as { model?: { provider?: string; id?: string } } | undefined)?.model;
  return m?.id ? (m.provider ? `${m.provider}/${m.id}` : m.id) : undefined;
}

/** Register a turn; call the returned function when it ends (idempotent). */
export function beginActivity(input: ActivityInput, now = Date.now()): () => void {
  const id = ++seq;
  live.set(id, { ...input, label: input.label.replace(/\s+/g, " ").trim().slice(0, 140), startedAt: now });
  return () => { live.delete(id); };
}

/** Run `work` registered as a live activity for its whole duration. */
export async function trackActivity<T>(input: ActivityInput, work: () => Promise<T>): Promise<T> {
  const end = beginActivity(input);
  try { return await work(); } finally { end(); }
}

/** Live activities, oldest first. */
export function liveActivities(): Activity[] {
  return [...live.entries()]
    .map(([id, a]) => ({ id, kind: a.kind, label: a.label, agentId: a.agentId, chatKey: a.chatKey, model: modelOf(a.session), startedAt: a.startedAt }))
    .sort((a, b) => a.startedAt - b.startedAt);
}
