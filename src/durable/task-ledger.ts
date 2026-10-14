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

export type LedgerStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface LedgerTaskInput {
  agentId: string;
  /** owner chat the task was requested from; the result is posted there */
  chatKey: string;
  title: string;
  instructions: string;
}

export interface LedgerEntry extends LedgerTaskInput {
  id: string;
  status: LedgerStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  result?: string;
  error?: string;
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
  /** do the work; resolves with the owner-facing result text */
  run(task: TaskRun): Promise<string>;
  /** post a message to the owner chat (at-least-once: a crash right after posting may repeat it) */
  notify(chatKey: string, text: string): Promise<void>;
}

export interface TaskLedger {
  start(input: LedgerTaskInput, requestId?: string): Promise<LedgerEntry>;
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
  | { phase: "notify"; ok: boolean; text: string };

const active = (s: LedgerStatus) => s === "queued" || s === "running";

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
        let ok = true;
        let text: string;
        try {
          text = (await runner.run({ ...input, taskId: ledgerId, attempt, resumed: attempt > 1, signal: rt.signal })).trim() || "(finished without a summary)";
        } catch (error) {
          if (rt.signal.aborted) throw error; // cancelled or shutting down: the abort protocol / resume owns the outcome
          ok = false;
          text = error instanceof Error ? error.message : String(error);
        }
        text = text.slice(0, RESULT_CHARS);
        await rt.commit(async (tx) => {
          const entry = (await ledgerDoc(tx, rt.conversationId)).tasks[ledgerId];
          if (entry) Object.assign(entry, ok ? { status: "done", result: text } : { status: "failed", error: text }, { updatedAt: now() });
          return { status: "running", checkpoint: { phase: "notify", ok, text } };
        }, ctx);
      },
      notify: async (task, rt, ctx) => {
        const { ok, text } = task.state.checkpoint;
        const head = ok ? `✅ Task done: **${task.input.title}**` : `⚠️ Task failed: **${task.input.title}**`;
        await runner.notify(task.input.chatKey, `${head}\n\n${text}`).catch((e) => rt.report(e));
        await rt.commit(async (tx) => {
          prune(await ledgerDoc(tx, rt.conversationId));
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
      return Object.values((await snapshot()).tasks)
        .filter((t) => t.agentId === agentId && (!chatKey || t.chatKey === chatKey))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    async cancel(id) {
      const entry = (await snapshot()).tasks[id];
      if (!entry?.durableId || !active(entry.status)) return false;
      await harness.abortTask(entry.durableId as never, C);
      return true;
    },
    async close() {
      await harness.close(C);
    },
  };
}
