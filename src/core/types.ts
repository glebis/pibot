// ─── Shared types for pibot core ────────────────────────────────────────────

export interface ChatRef {
  transport: string;
  chatId: string;
}

export type ScheduleKind = "reminder" | "task" | "note" | "subject" | "heartbeat" | "promise" | "evolution" | "custom";

export interface ScheduleRepeat {
  /** Fire again this many ms after each fire */
  everyMs?: number;
  /** Daily recurrence at HH:MM local time */
  dailyAt?: string;
  /** Weekly recurrence on weekdays (0=Sunday … 6=Saturday), optionally at dailyAt time */
  weekdays?: number[];
}

export interface Schedule {
  id: string;
  agentId: string;
  chat: ChatRef;
  title: string;
  detail?: string;
  kind: ScheduleKind;
  dueAt: number;
  repeat?: ScheduleRepeat;
  /** important items pierce snooze */
  wake: "normal" | "important";
  /** direct: host formats the ping. agent: full agent session composes it */
  delivery: "direct" | "agent";
  status: "pending" | "done" | "cancelled";
  /** bot should show an inline card (✅ / +10m / +1h / Cancel) after the agent's turn */
  cardPending?: boolean;
  createdAt: number;
  firedCount: number;
  /** internal jobs (heartbeat rhythm) are invisible to the user */
  internal?: boolean;
  /** jobs sharing a groupId cancel together (promise + its pre-check) */
  groupId?: string;
}

export interface CardButton {
  label: string;
  /** opaque action string routed back via transport.onAction */
  action: string;
}

export interface Card {
  text: string;
  buttons: CardButton[];
}

export interface PushOptions {
  text: string;
  card?: Card;
}

export interface Transport {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Send a message (and optional button card) to a chat */
  push(chatId: string, opts: PushOptions): Promise<void>;
  /** System-level error notice (agent crashed, bad model, …) */
  notifyError(chatId: string, message: string): Promise<void>;
  onMessage(cb: (text: string, chatId: string) => Promise<void>): void;
  /** cb may return a short toast string for Telegram callback feedback */
  onAction(cb: (action: string, chatId: string) => Promise<string | void>): void;
  /** Show "typing…" while the agent works (optional) */
  setTyping?(chatId: string, on: boolean): void;
  /** Structured question as a native poll (optional; returns its poll id) */
  sendPoll?(chatId: string, question: string, options: string[]): Promise<{ pollId: string }>;
  /** Poll votes (optional) */
  onPollAnswer?(cb: (pollId: string, optionIndex: number, voterId: string) => Promise<void>): void;
}

// ─── Agent manifest (agents/<name>/agent.json) ──────────────────────────────

export interface HeartbeatConfig {
  enabled: boolean;
  /** e.g. "45m", "2h" */
  interval: string;
  /** "same" | model id like "anthropic/claude-haiku-4-5" */
  model?: string;
  quietHours?: { from: string; to: string };
}

export interface AgentManifest {
  name: string;
  description?: string;
  /** pi model shorthand: "sonnet:medium", "anthropic/claude-…", or omit for first available */
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** built-in + custom tool names; default excludes bash (safer for remote chats) */
  tools?: string[];
  heartbeat?: HeartbeatConfig;
  /** goal-driven skill self-evolution (Hermes-style propose → gate → eval → apply) */
  evolution?: { enabled?: boolean; interval?: string; model?: string };
}

export const DEFAULT_AGENT_TOOLS = ["read", "write", "edit", "grep", "find", "ls"];

export function defaultManifest(name: string): AgentManifest {
  return {
    name,
    description: "A pibot agent",
    heartbeat: {
      enabled: true,
      interval: "45m",
      model: "same",
      quietHours: { from: "23:00", to: "08:00" },
    },
  };
}