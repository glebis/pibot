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

/** The passive confirmation line.
 *  Threaded (reply-to the original task message) lines quote what the agent
 *  actually said — the thread carries the task context. Unthreaded lines quote
 *  the HANDED TASK text instead — owner's own words or the sibling brief: the
 *  reply went back to its recipient already, and quoting meta-reply chatter
 *  with no task context reads as if the reply were the task
 *  (`✅ x completed your task: "You're right to raise…"`). Snippets truncate at
 *  a word boundary. */
export function taskAckLine(
  ack: TaskAck,
  agentId: string,
  snippet: string,
  context?: { from?: string },
): string {
  const quote = truncateOneLine(snippet, 130);
  if (!context?.from) return `${ICON[ack]} **${agentId}**: “${quote}”`;
  const fromLabel = context.from === "you" ? "your" : `**${context.from}**'s`;
  switch (ack) {
    case "accepted":
      return `🤝 **${agentId}** accepted ${fromLabel} task: “${quote}”`;
    case "declined":
      return `🚫 **${agentId}** declined ${fromLabel} task: “${quote}”`;
    case "completed":
      return `✅ **${agentId}** completed ${fromLabel} task: “${quote}”`;
  }
}

/** Word-boundary truncation: never cuts mid-word — partial words read as noise,
 *  e.g. `…when I'm the visi…`. Falls back to a hard cut when there is no space. */
function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  const head = (sp >= max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!?—–-]+$/, "");
  return `${head}…`;
}

/** Explicit request shapes that read as tasks even in question form
 *  ("can you fix the deploy?"). Matched against the first few words. */
const REQUEST_PATTERNS: RegExp[] = [
  /^(let'?s|lets)\b/i,
  /^(please|pls|plz|kindly)\b/i,
  /^(can|could|would|will) you\b/i,
  /^(can u)\b/i,
  /^i (need|want) you to\b/i,
  /^need you to\b/i,
  /^(help me|quick favor|quick ask|small favor|one favor)\b/i,
  /^(task|todo|action item)s?:/i,
];

/** Imperative verbs that plausibly start a handed task ("fix the bug").
 *  Deliberately conservative: anything not listed is a silent miss, never a
 *  wrong claim. */
const TASK_VERBS: ReadonlySet<string> = new Set([
  "fix", "add", "update", "write", "create", "build", "make", "send", "check",
  "run", "test", "deploy", "implement", "review", "translate", "clean",
  "refactor", "install", "configure", "generate", "draft", "summarize", "find",
  "look", "take", "file", "wire", "migrate", "bump", "revert", "stage",
  "commit", "publish", "ship", "research", "prepare", "schedule", "remind",
  "sync", "import", "export", "download", "upload", "rename", "delete",
  "remove", "redo", "verify", "prove", "show", "deliver", "render", "rewrite",
  "rebuild", "rerun", "route", "append", "cull", "audit", "sweep", "fetch",
  "grab", "handle", "sort", "record", "transcribe", "catalogue", "catalog",
  "polish", "design", "relist", "relay", "answer", "reply", "explain",
  "list", "read", "open", "pop", "push", "pull", "apply", "replay", "reset",
]);

/** Owner-chat guard: a handed task is at least a few words — trigger words
 *  ("go", "ok ahead") are conversation, not tasks, and must not ack.
 *  strict (owner-handed turns) additionally requires task shape: statements and
 *  questions ("this seems confusing", "received this in creator…", "what
 *  changed?") are conversation — an explanatory reply to them must not ack, and
 *  the completion lexicon would fire on a word like "finished" inside quoted
 *  discussion. A miss means no line at all (silence is the default). */
export function isTaskLike(text: string, strict = false): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (!strict) return true;
  // strip leading non-letter noise (emoji, brackets, timestamps) then probe shape
  const head = text.trim().replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 80);
  if (REQUEST_PATTERNS.some((re) => re.test(head))) return true;
  const first = (head.split(/\s+/)[0] ?? "").replace(/[^\p{L}]/gu, "").toLowerCase();
  return TASK_VERBS.has(first);
}

/** Manifest gate — taskAcks default on; explicit false opts out. */
export function taskAcksEnabled(manifest: { comms?: { taskAcks?: boolean } } | undefined): boolean {
  return manifest?.comms?.taskAcks !== false;
}