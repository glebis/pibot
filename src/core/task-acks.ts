/**
 * task-acks — implicit task acceptance detection.
 *
 * When an agent receives a task (from a sibling agent via agent_message/agent_ask,
 * or from the owner in its chat) and its reply contains acceptance / decline /
 * completion language, a passive confirmation line lands in the agent's bot chat.
 *
 * Deterministic lexicon, no LLM calls. No match → no confirmation (silence is
 * the default; a miss is never a wrong claim).
 */

export type TaskAck = "accepted" | "declined" | "completed";

/** Ordered by specificity: a decline anywhere wins over a completion, which wins over an acceptance. */
const LEXICON: Array<{ ack: TaskAck; patterns: RegExp[] }> = [
  {
    ack: "declined",
    patterns: [
      /\bcan'?t take (this|it) on\b/i,
      /\bwon'?t be able to\b/i,
      /\bhave to decline\b/i,
      /\bdeclin(e|ed|ing)\b/i,
      /\bpass(ing)? on (this|that|it)\b/i,
      /\bnot my (area|domain|lane|field)\b/i,
      /\bbetter (handled|suited) by\b/i,
      /\bout of my (depth|scope)\b/i,
    ],
  },
  {
    ack: "completed",
    patterns: [
      /\b(done|completed|finished|wrapped up|taken care of)\b/i,
      /\b(file|filed) (it|that) (properly|for you|now)\b/i,
      /\bsent (it|that) over\b/i,
      /\bpushed (it|that) live\b/i,
    ],
  },
  {
    ack: "accepted",
    patterns: [
      /\bon (it|this)\b/i,
      /\bwill do\b/i,
      /\bgonna handle\b/i,
      /\bi'?ll (handle|take care of|take (this|it)|pick (this|it) up|take (this|it) on|file (it|that)|look into)\b/i,
      /\btaking (this|it) on\b/i,
      /\bleave it with me\b/i,
      /\byou got it\b/i,
      /\badding (it|this) to my (list|queue|backlog)\b/i,
      /\bconsider it (mine|handled)\b/i,
    ],
  },
];

/** Classify an agent reply as an implicit task ack; undefined when no signal. */
export function classifyTaskReply(reply: string): TaskAck | undefined {
  for (const { ack, patterns } of LEXICON) {
    if (patterns.some((re) => re.test(reply))) return ack;
  }
  return undefined;
}

const ICON: Record<TaskAck, string> = { accepted: "🤝", declined: "🚫", completed: "✅" };

/** The passive confirmation line. Description-first: what the agent actually said/did.
 *  Threaded (reply-to the original task message): the line needs no task context —
 *  `✅ **agent**: "what was done"`. Unthreaded (sibling tasks): attribution inline. */
export function taskAckLine(
  ack: TaskAck,
  agentId: string,
  doneSnippet: string,
  context?: { from?: string },
): string {
  const done = truncateOneLine(doneSnippet, 110);
  if (!context?.from) return `${ICON[ack]} **${agentId}**: “${done}”`;
  const fromLabel = context.from === "you" ? "your" : `**${context.from}**'s`;
  switch (ack) {
    case "accepted":
      return `🤝 **${agentId}** accepted ${fromLabel} task: “${done}”`;
    case "declined":
      return `🚫 **${agentId}** declined ${fromLabel} task: “${done}”`;
    case "completed":
      return `✅ **${agentId}** completed ${fromLabel} task: “${done}”`;
  }
}

function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Owner-chat guard: a handed task is at least a few words — trigger words
 *  ("go", "ok ahead") are conversation, not tasks, and must not ack. */
export function isTaskLike(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= 4;
}

/** Manifest gate — taskAcks default on; explicit false opts out. */
export function taskAcksEnabled(manifest: { comms?: { taskAcks?: boolean } } | undefined): boolean {
  return manifest?.comms?.taskAcks !== false;
}