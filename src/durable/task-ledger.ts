// Durable background-task ledger (bead pibot-e9t) — the only module that touches pi-durable for tasks.
//
// Each task is a pi-durable checkpointed job: run → work → notify → terminal. The ledger
// document (one per harness) is the owner-visible index: every state change is committed
// together with the task's checkpoint, so list/status never disagree with the job.
//
// Exactly-once intent: start() with the same requestId returns the existing task.
// Crash recovery: re-entering `work` for an attempt that already started means the
// process died mid-run. The next attempt is told so (its agent session still holds
// what the interrupted attempt did); after MAX_ATTEMPTS it fails instead of looping.

import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineDoc, defineExtension, defineTask, type JsonObject } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { truncate } from "../core/util.js";
import { scanNumericClaims } from "../core/fact-check.js";

export type LedgerStatus = "queued" | "running" | "done" | "partial" | "blocked" | "failed" | "cancelled";

/** Evidence that a task's output was actually delivered (bd pibot-zy70). */
export interface Delivery {
  /** id of the Telegram message that carried the result / final notice */
  messageId?: number;
  /** actually delivered medium: "video_note" | "video" | "text" | … (undefined = only a text notice went out) */
  mediaType?: string;
  deliveredAt?: number;
}

/** A runner could not proceed because a prerequisite is missing (tool, credential, provider) —
 *  distinct from a plain failure so the ledger can record a blocker instead of a bogus retry loop. */
export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

export interface LedgerTaskInput {
  agentId: string;
  /** owner chat the task was requested from; the result is posted there */
  chatKey: string;
  title: string;
  instructions: string;
  /** owner-chosen tool names for the run (from a voice call); omitted = the agent's full set */
  allowedTools?: string[];
  /** per-task hard stop in minutes; omitted = config default. Persisted with the task so
   *  retries/resumes keep the same ceiling. Clamped in runLedgerTask: ≥1min, ≤8h ceiling. */
  timeoutMinutes?: number;
  /** medium the owner explicitly asked for (e.g. "video_note"); set only when delivery of that
   *  medium is part of the expected output — then `done` requires the receipt to match it. */
  expectedMedia?: string;
  /** work lane: "dev" (pibot source work, pibot-dev's lane) vs "cross-agent" (owner-facing
   *  content/tooling tasks) — task-record-canon keeps the two from mixing (bd pibot-r47f) */
  lane?: "dev" | "cross-agent";
  /** id of the owner/source message that requested this task, when the caller knows it */
  sourceMessageId?: number;
  /** verifiable acceptance criteria — the gate a completed task must satisfy */
  acceptanceCriteria?: string;
  /** what would unblock/advance this task next (task-record-canon) */
  nextAction?: string;
  /** where the task's artifacts live on disk (absolute paths) */
  outputLocation?: string;
  /** reference-only link to the tracker (Linear/beads) — the ledger stays authoritative */
  linearRef?: string;
}

export interface LedgerEntry extends LedgerTaskInput {
  id: string;
  status: LedgerStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  result?: string;
  error?: string;
  /** set when the runner asked for a specific medium but the delivered one differed/unverified */
  blocker?: string;
  /** programmatic arithmetic check of the result's numeric claims (bd pibot-wr9m) */
  factCheck?: { checked: number; inconsistent: number; failures: string[] };
  /** delivery receipt for the verified output (bd pibot-zy70) */
  delivery?: Delivery;
  /** pi-durable task id, kept so cancel() works after a restart */
  durableId?: number;
}

export interface TaskRun extends LedgerTaskInput {
  taskId: string;
  attempt: number;
  /** true when an earlier attempt was cut off by a restart */
  resumed: boolean;
  signal: AbortSignal;
}

export interface TaskRunner {
  /** do the work; resolves with the owner-facing result text — or a result plus a delivery receipt
   *  (message id and actual media type) so completion can be verified against expected output */
  run(task: TaskRun): Promise<string | { text: string; delivery?: Omit<Delivery, "deliveredAt"> }>;
  /** post a message to the owner chat (at-least-once: a crash right after posting may repeat it;
   *  may return a receipt with the sent message id) */
  notify(chatKey: string, text: string): Promise<Delivery | void>;
}

export interface TaskLedger {
  start(input: LedgerTaskInput, requestId?: string): Promise<LedgerEntry>;
  /** Return the newest active task for an agent/chat, if any. */
  latestActive(agentId: string, chatKey: string): Promise<LedgerEntry | undefined>;
  /**
   * Update a task's canonical record fields (task-record-canon, bd pibot-r47f):
   * nextAction / outputLocation. scoped to the owning agent; only pending/running
   * (and blocked) tasks accept record updates — finished tasks are history.
   */
  updateRecord(id: string, agentId: string, patch: { nextAction?: string; outputLocation?: string }): Promise<LedgerEntry | undefined>;
  get(id: string): Promise<LedgerEntry | undefined>;
  list(filter: { agentId: string; chatKey?: string }): Promise<LedgerEntry[]>;
  /** true when an abort was requested for a live task */
  cancel(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export const MAX_ATTEMPTS = 2;
export const MAX_ACTIVE_PER_AGENT = 5;
const KEEP_FINISHED = 200;
const RESULT_CHARS = 4000;

interface LedgerDoc {
  tasks: Record<string, LedgerEntry>;
  /** requestId → task id, for idempotent start() */
  requests: Record<string, string>;
}

// Stored as plain JSON; LedgerDoc is the typed view (optional fields are omitted, never undefined).
const Ledger = defineDoc<JsonObject>({
  kind: "pibot.task-ledger",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ tasks: {}, requests: {} }),
});
type DocTx = { doc(token: typeof Ledger, id: never): Promise<JsonObject> };
const ledgerDoc = async (tx: unknown, conversationId: unknown) =>
  (await (tx as DocTx).doc(Ledger, conversationId as never)) as unknown as LedgerDoc;

type Checkpoint =
  | { phase: "run"; attempts: number }
  | { phase: "work"; attempt: number }
  | { phase: "notify"; ok: boolean; text: string;
      /** post-work verdict carried into the notice. Older checkpoints predate `final`
       *  (treated from `ok`); the `partial` verdict is always an explicit newer commit. */
      final?: "done" | "partial" | "failed" | "blocked";
      /** delivery receipt returned by run(), kept for the notify-phase entry update */
      delivery?: Omit<Delivery, "deliveredAt">;
};

const active = (s: LedgerStatus) => s === "queued" || s === "running";

/** drop keys with undefined values — pi-durable stores strict JSON (bd pibot-zy70) */
function filterUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function prune(doc: LedgerDoc): void {
  const finished = Object.values(doc.tasks).filter((t) => !active(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const old of finished.slice(KEEP_FINISHED)) {
    delete doc.tasks[old.id];
    for (const [rid, tid] of Object.entries(doc.requests)) if (tid === old.id) delete doc.requests[rid];
  }
}

export async function openTaskLedger(opts: { runner: TaskRunner; storageDir?: string; now?: () => number }): Promise<TaskLedger> {
  const now = opts.now ?? Date.now;
  const runner = opts.runner;

  const AgentTask = defineTask<LedgerTaskInput & { ledgerId: string }, Checkpoint, string>({
    name: "pibot.agent-task",
    version: 1,
    initial: () => ({ phase: "run", attempts: 0 }),
    phases: {
      run: async (task, rt, ctx) => {
        const attempt = task.state.checkpoint.attempts + 1;
        await rt.commit(async (tx) => {
          const doc = await ledgerDoc(tx, rt.conversationId);
          const entry = doc.tasks[task.input.ledgerId];
          if (attempt > MAX_ATTEMPTS) {
            const text = `Interrupted by restarts ${MAX_ATTEMPTS} times; not retried again. Check what it already did, then start it again if needed.`;
            if (entry) Object.assign(entry, { status: "failed", error: text, updatedAt: now() });
            return { status: "running", checkpoint: { phase: "notify", ok: false, text } };
          }
          if (entry) Object.assign(entry, { status: "running", attempts: attempt, updatedAt: now() });
          return { status: "running", checkpoint: { phase: "work", attempt } };
        }, ctx);
      },
      work: async (task, rt, ctx) => {
        const { attempt } = task.state.checkpoint;
        // A durable mark per attempt: finding it already set means this attempt was cut off mid-run.
        if (await rt.memo<boolean>(`started-${attempt}`, ctx)) {
          await rt.commit(() => ({ status: "running", checkpoint: { phase: "run", attempts: attempt } }), ctx);
          return;
        }
        await rt.memo(`started-${attempt}`, true, ctx);
        // shutting down or cancelled before the work began: never hand a dead signal to the runner
        if (rt.signal.aborted) throw new Error("task invocation ended before it started");
        const { ledgerId, ...input } = task.input;
        const expect = task.input.expectedMedia?.trim() || undefined;
        let ok = true;
        let text: string;
        let final: "done" | "partial" | "failed" | "blocked" = "done";
        let delivery: Omit<Delivery, "deliveredAt"> | undefined;
        try {
          const raw = await runner.run({ ...input, taskId: ledgerId, attempt, resumed: attempt > 1, signal: rt.signal });
          // A runner may return a bare string or a { text, delivery } receipt
          text = (typeof raw === "string" ? raw : raw.text).trim();
          delivery = typeof raw === "string" ? undefined : raw.delivery;
          // Empty output is not a successful result: record an explicit failure
          // rather than delivering a fabricated success summary.
          if (!text) throw new Error("Task finished without a result summary");
        } catch (error) {
          if (rt.signal.aborted) throw error; // cancelled or shutting down: the abort protocol / resume owns the outcome
          ok = false;
          text = error instanceof Error ? error.message : String(error);
          if (error instanceof BlockedError) final = "blocked";
        }
        if (ok && expect && (!delivery || delivery.mediaType !== expect)) {
          // Verified-completion gate (bd pibot-zy70): when the owner asked for a specific
          // medium, `done` requires the receipt to name that same medium.
          final = "partial";
        }
        text = text.slice(0, RESULT_CHARS);
        // Programmatic fact-check of numeric claims (bd pibot-wr9m): only mechanical
        // arithmetic, only on work results (error texts are not claim prose).
        const factCheck = ok ? scanNumericClaims(text) : { checked: 0, inconsistent: 0, failures: [] as string[] };
        if (factCheck.inconsistent > 0) {
          text += `\n\n⚠️ fact-check: ${factCheck.inconsistent} of ${factCheck.checked} numeric claim(s) inconsistent — e.g. "${truncate(factCheck.failures[0], 80)}"`;
        }
        await rt.commit(async (tx) => {
          const entry = (await ledgerDoc(tx, rt.conversationId)).tasks[ledgerId];
          if (entry) {
            if (factCheck.checked > 0 && factCheck !== undefined) entry.factCheck = factCheck;
            if (final === "blocked") Object.assign(entry, { status: "blocked", blocker: text }, { updatedAt: now() });
            else if (final === "partial") {
              const mismatch = expect ?
                (delivery?.mediaType ? `requested ${expect} but delivered ${delivery.mediaType}` : `requested ${expect} but the delivery was not verified (no media receipt)`) : "output only partly delivered";
              Object.assign(entry, { status: "partial", error: mismatch, result: text, updatedAt: now() });
            } else if (ok) Object.assign(entry, { status: "done", result: text }, { updatedAt: now() });
            else Object.assign(entry, { status: "failed", error: text }, { updatedAt: now() });
          }
          return { status: "running", checkpoint: { phase: "notify", ok, text, final, ...(delivery !== undefined && Object.entries(delivery).some(([, v]) => v !== undefined) ? { delivery: filterUndefined(delivery) } : {}) } };
        }, ctx);
      },
      notify: async (task, rt, ctx) => {
        const { ok, text, final = ok ? "done" : "failed", delivery } = task.state.checkpoint;
        const head = final === "blocked" ? `🛑 Task blocked: **${task.input.title}**`
          : final === "partial" ? `🟡 Task partial: **${task.input.title}**`
          : ok ? `✅ Task done: **${task.input.title}**`
          : `⚠️ Task failed: **${task.input.title}**`;
        let receipt: Delivery | void;
        try {
          receipt = await runner.notify(task.input.chatKey, `${head}\n\n${text}`);
        } catch (e) {
          // The owner never saw the result, so the ledger must not claim done (bd pibot-zy70).
          // rt.report keeps the harness retry semantics; the entry stops saying ✅.
          await rt.commit(async (tx) => {
            const entry = (await ledgerDoc(tx, rt.conversationId)).tasks[task.input.ledgerId];
            if (entry && entry.status === "done") Object.assign(entry, { status: "partial", blocker: `delivery failed: ${truncate(e instanceof Error ? e.message : String(e), 200)}`, updatedAt: now() });
            return { status: "running", checkpoint: task.state.checkpoint };
          }, ctx);
          rt.report(e);
          return;
        }
        await rt.commit(async (tx) => {
          const doc = await ledgerDoc(tx, rt.conversationId);
          const entry = doc.tasks[task.input.ledgerId];
          if (entry && (final === "done" || final === "partial")) {
            // Delivery receipt (bd pibot-zy70): the result's message id comes from the runner's
            // own receipt (the media send), falling back to the notice push id for text results;
            // media type from the runner; keys with no evidence stay unset (strict JSON).
            const d: Delivery = { deliveredAt: now() };
            if (delivery?.messageId !== undefined) d.messageId = delivery.messageId;
            else if (typeof receipt === "object" && receipt?.messageId !== undefined) d.messageId = receipt.messageId;
            if (delivery?.mediaType !== undefined) d.mediaType = delivery.mediaType;
            entry.delivery = d;
          }
          prune(doc);
          return { status: "terminal", outcome: ok ? { status: "completed", result: text } : { status: "failed", error: { message: text } } };
        }, ctx);
      },
    },
    abort: async (task, rt, ctx) => {
      await rt.commit(async (tx) => {
        const entry = (await ledgerDoc(tx, rt.conversationId)).tasks[task.input.ledgerId];
        if (entry && active(entry.status)) Object.assign(entry, { status: "cancelled", updatedAt: now() });
        return { status: "terminal", outcome: { status: "aborted", reason: "cancelled by owner" } };
      }, ctx);
      await runner.notify(task.input.chatKey, `✖ Task cancelled: **${task.input.title}**`).catch((e) => rt.report(e));
    },
  });

  const registry = createRegistry();
  registry.install(defineExtension({ name: "pibot-task-ledger", tasks: [AgentTask] }));
  const storage = opts.storageDir ? await openNodeJsonlStorage(opts.storageDir, C) : new MemoryStorage();
  const harness = await Harness.open(storage, {
    models: createModels(), // the ledger never calls a model; agents do the work through the runner
    registry,
    onReport: (e) => console.warn("[task-ledger]", e instanceof Error ? e.message : e),
  }, C);
  const root = await harness.root(C);
  harness.resume();

  const snapshot = async () => ((await harness.snapshot(Ledger, root.id, C)) ?? { tasks: {}, requests: {} }) as unknown as LedgerDoc;
  const listTasks = async ({ agentId, chatKey }: { agentId: string; chatKey?: string }): Promise<LedgerEntry[]> =>
    Object.values((await snapshot()).tasks)
      .filter((t) => t.agentId === agentId && (!chatKey || t.chatKey === chatKey))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);

  return {
    async start(input, requestId) {
      let id = "";
      await root.commit(async (tx) => {
        const doc = await ledgerDoc(tx, root.id);
        const existing = requestId ? doc.requests[requestId] : undefined;
        if (existing && doc.tasks[existing]) { id = existing; return; }
        const live = Object.values(doc.tasks).filter((t) => t.agentId === input.agentId && active(t.status)).length;
        if (live >= MAX_ACTIVE_PER_AGENT) throw new Error(`${input.agentId} already has ${live} active tasks; wait for one to finish or cancel one`);
        id = `t${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const at = now();
        doc.tasks[id] = { ...input, id, status: "queued", createdAt: at, updatedAt: at, attempts: 0 };
        if (requestId) doc.requests[requestId] = id;
        const taskId = await tx.createTask(AgentTask, { ...input, ledgerId: id }, { ownership: { kind: "conversation" } });
        doc.tasks[id].durableId = Number(taskId);
      }, C);
      return (await snapshot()).tasks[id];
    },
    async get(id) {
      return (await snapshot()).tasks[id];
    },
    async list({ agentId, chatKey }) {
      return listTasks({ agentId, chatKey });
    },
    async latestActive(agentId, chatKey) {
      // Task keys are appended at creation; status updates do not change their
      // insertion order. Pick the newest created active task, not the one whose
      // status happened to update most recently.
      return Object.values((await snapshot()).tasks)
        .filter((t) => t.agentId === agentId && t.chatKey === chatKey && active(t.status))
        .at(-1);
    },
    async cancel(id) {
      const entry = (await snapshot()).tasks[id];
      if (!entry?.durableId || !active(entry.status)) return false;
      await harness.abortTask(entry.durableId as never, C);
      return true;
    },
    async updateRecord(id, agentId, patch) {
      const entry = (await snapshot()).tasks[id];
      if (!entry || entry.agentId !== agentId || !active(entry.status)) return undefined;
      await root.commit(async (tx) => {
        const doc = await ledgerDoc(tx, root.id);
        const task = doc.tasks[id];
        if (task) Object.assign(task, patch, { updatedAt: now() });
        return undefined;
      }, C);
      return (await snapshot()).tasks[id];
    },
    async close() {
      await harness.close(C);
    },
  };
}
