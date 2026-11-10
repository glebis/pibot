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
import { lockStorageDir, type StorageLock } from "./storage-lock.js";
import path from "node:path";
import { truncate } from "../core/util.js";
import { scanNumericClaims } from "../core/fact-check.js";
import { correctRelativeDateClaims } from "../core/relative-date-guard.js";
import { extractArtifactRefs } from "../core/task-reconcile.js";

export type LedgerStatus = "queued" | "running" | "done" | "partial" | "blocked" | "failed" | "cancelled";

/** Strongest proof of delivery obtained so far, weakest first. An API ack is NOT a same-peer
 *  readback, and neither is a human viewing the message (bd pibot-cida). */
export type DeliveryEvidence = "ack" | "readback" | "viewed";

/** Evidence that a task's output was actually delivered (bd pibot-zy70).
 *  A message id alone proves neither *where* the result landed nor *what* it was, so the
 *  receipt is a tuple: account/bot + peer (destination) + message id + media type, with the
 *  id namespace named explicitly (bd pibot-cida). */
export interface Delivery {
  /** id of the message that carried the result / final notice — only meaningful with `peer`
   *  and `idProtocol`, never comparable across different id namespaces */
  messageId?: number;
  /** actually delivered medium: "video_note" | "video" | "text" | … (undefined = only a text notice went out) */
  mediaType?: string;
  /** destination the receipt attests, as "transport:chatId"; absent = the destination is unverified */
  peer?: string;
  /** bot/account identity that performed the send */
  account?: string;
  /** message-id namespace ("bot_api", "mtproto", …) — ids from different protocols are never the same message */
  idProtocol?: string;
  /** strongest evidence obtained: an API ack is not a readback, and neither is a human viewing */
  evidence?: DeliveryEvidence;
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

/** The run stopped because it reached its hard deadline (not a cancellation or a work error).
 *  Lets the ledger distinguish a deadline reconciliation from an arbitrary failure (bd pibot-jiqv). */
export class TaskDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskDeadlineError";
  }
}

/**
 * An owner decision correlated to the task's canonical question channel (bd pibot-0xpf.5).
 * Only a real answer recorded by the owner (the question journal) may create authorization:
 * a sibling's relayed claim ("Gleb said yes") is prose, not authority. Persisted so a resumed
 * attempt or an executor handoff can inherit the decision instead of re-asking.
 *
 * The record is NEUTRAL: it preserves the exact question/options and the owner's exact answer.
 * `outcome` is structural (which declared option was chosen), never inferred by matching English
 * words — "No", "do not restore" and ordinary clarifying answers are never turned into approval.
 */
export type TaskDecisionOutcome = "approved" | "declined" | "answer";

export interface TaskDecision {
  /** exact owner-facing question / requested action */
  action: string;
  /** options as shown to the owner at decision time */
  options: string[];
  /** the selected option / free-text answer, verbatim */
  choice: string;
  /** index into `options`; -1 for free text */
  optionIndex: number;
  /** structural outcome: only "approved" authorizes the action */
  outcome: TaskDecisionOutcome;
  /** canonical question id (from the owner-question journal) */
  qid: string;
  /** stable, namespaced key for the logical question (see taskDecisionKey) */
  questionKey: string;
  /** ONLY the canonical owner answer channel may create authorization */
  source: "owner_question";
  /** owner chat the answer came from */
  ownerChatKey: string;
  answeredAt: number;
  /** agent that executes the authorized action */
  executor: string;
}

/**
 * Namespaced identity for one owner decision inside a task. A caller may not look up or replay
 * an arbitrary global journal key: every decision is scoped to the task AND the owner chat that
 * was asked. Distinct actions therefore cannot collide (a restore answer is never replayed for a
 * later delete/send question).
 */
export function taskDecisionKey(taskId: string, ownerChatKey: string, actionKey: string): string {
  return `task:${taskId}:owner:${ownerChatKey}:${actionKey}`;
}

/**
 * Post-run artifact readback (bd pibot-0xpf.5). Produced by the HOST reading the deliverable
 * back from disk after the run — never derived from the agent's bookkeeping text. A restore is
 * only verified when the contract names an artifact and this receipt proves it now exists.
 */
export interface ArtifactReceipt {
  path: string;
  bytes: number;
  sha256: string;
  /** the host read the file back after the run — not an agent claim */
  evidence: "readback";
  /** what the readback proves: only that the declared path exists with these bytes, or that those
   *  bytes match a declared original hash. Without an original hash this is existence/content
   *  readback, never a claim of byte-exact restoration. */
  verification: "existence" | "byte-exact";
  verifiedAt: number;
  /** true when the bytes differ from a declared original hash: a reconstruction, not an exact restore */
  reconstructed?: boolean;
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
  /** destination the receipt must attest, as "transport:chatId"; defaults to chatKey (the origin
   *  chat). Set this when the owner deliberately asked for a DIFFERENT target (e.g. Saved
   *  Messages) — the completion gate must then prove THAT destination, not the origin. */
  expectedPeer?: string;
  /** bot account the receipt must attest (e.g. "@pibot") — optional cross-check (bd pibot-cida) */
  expectedAccount?: string;
  /** message-id namespace the receipt must attest ("bot_api" | "mtproto") — optional cross-check */
  expectedIdProtocol?: string;
  /** work lane: "dev" (pibot source work, pibot-dev's lane) vs "cross-agent" (owner-facing
   *  content/tooling tasks) — task-record-canon keeps the two from mixing (bd pibot-r47f) */
  lane?: "dev" | "cross-agent";
  /** id of the owner/source message that requested this task, when the caller knows it */
  sourceMessageId?: number;
  /** verifiable acceptance criteria — the gate a completed task must satisfy */
  acceptanceCriteria?: string;
  /** exact text the task must leave behind in `outputLocation` (bd pibot-cida: an append that was
   *  reported as done while the file was unchanged). Checked by the ledger against a readback the
   *  runner supplies AFTER writing; without that readback the task cannot be `done`. */
  expectedContent?: string;
  /** what would unblock/advance this task next (task-record-canon) */
  nextAction?: string;
  /** where the task's artifacts live on disk (absolute paths) */
  outputLocation?: string;
  /** private source files this task still needs (absolute paths, comma-separated). Recorded so
   *  a cleanup pass can tell a pending task's input from a disposable cache artifact
   *  (bd pibot-7bo) — the Voss audio was named only in prose and was gone before the retry. */
  inputLocations?: string;
  /** reference-only link to the tracker (Linear/beads) — the ledger stays authoritative */
  linearRef?: string;
  /** absolute path of the deliverable a restore/repair task must actually produce. When set,
   *  `done` requires a host readback of THAT file: nonempty bookkeeping text is not a restore
   *  (bd pibot-0xpf.5). Must be an absolute, non-symlink regular file. */
  expectedArtifactPath?: string;
  /** optional declared directory boundary for the readback (absolute). When set, a deliverable
   *  outside it is not read back, so a model-supplied path cannot wander outside the declared
   *  restore scope. */
  artifactScope?: string;
  /** optional exact sha256 of the original bytes. A different hash means the artifact was
   *  reconstructed, so completion stays partial and is labelled as reconstruction. */
  expectedArtifactSha256?: string;
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
  /** date-backed correction of relative wording that contradicted the absolute date (bd pibot-wr9m) */
  dateCheck?: { checked: number; inconsistent: number; corrected: boolean; blocked: boolean; failures: string[] };
  /** delivery receipt for the verified output (bd pibot-zy70) */
  delivery?: Delivery;
  /** readback of the written artifact, captured after the write: path + extracted text (bd pibot-cida) */
  readback?: ContentReadback;
  /** correlated delegate evidence appended after the run (bd pibot-jiqv). Append-only: a late
   *  result can prove usable work exists, but never turns a task into `done`. */
  evidence?: string;
  /** Compact usable reply and reported paths, protected from later context eviction. Delegate-reported, unverified. */
  usableReceipt?: string;
  /** structured proof that the stored evidence is usable output, not refusal/blocker prose.
   *  Presence of `evidence` alone must never justify a `partial` promotion. */
  evidenceUsable?: boolean;
  /** structured identity of the failure cause. Only a real deadline may reconcile evidence. */
  failure?: "deadline";
  /** owner decisions correlated to this task, persisted across resume/handoff (bd pibot-0xpf.5).
   *  Each entry is scoped by questionKey; a replay only reuses the SAME decision. */
  decisions?: TaskDecision[];
  /** host readback of the contracted deliverable, if the task declared one */
  artifact?: ArtifactReceipt;
  /** pi-durable task id, kept so cancel() works after a restart */
  durableId?: number;
}

/** What a runner reports after an artifact write: the file it touched, the text it found there on
 *  a fresh read, and whether that read happened after the write. The ledger never reads the file
 *  itself — the runtime owns file access — but it refuses to call an unread work product done. */
export interface ContentReadback {
  /** absolute path that was written and then read back */
  path: string;
  /** text the artifact contained on that read (the ledger looks for the expected addition in it) */
  text: string;
  /** true only when the read happened after the write in the same run (bd pibot-cida) */
  afterWrite: boolean;
}

export interface TaskRun extends LedgerTaskInput {
  taskId: string;
  attempt: number;
  /** true when an earlier attempt was cut off by a restart */
  resumed: boolean;
  signal: AbortSignal;
  /** owner decisions already recorded for this task: a resumed attempt must reuse them, not re-ask */
  decisions?: TaskDecision[];
}

/** A runner may report PARTIAL output it can prove (e.g. a correlated delegate result that
 *  arrived before the deadline). It must never be presented as task completion (bd pibot-jiqv). */
export interface TaskRunResult {
  text: string;
  /** host readback of a contracted restoration artifact, independent of expected-content proof */
  artifact?: Omit<ArtifactReceipt, "verifiedAt">;
  delivery?: Omit<Delivery, "deliveredAt">;
  status?: "partial";
  /** why the output is partial; shown in the ledger record */
  partialReason?: string;
  /** correlated evidence to persist with the record (bd pibot-jiqv); append-only, never done */
  evidence?: string;
  /** post-write readback of the artifact named in `outputLocation` (bd pibot-cida) */
  readback?: ContentReadback;
}

export interface TaskRunner {
  /** do the work; resolves with the owner-facing result text — or a result plus a delivery receipt
   *  (message id and actual media type) and/or host artifact readback so completion can be
   *  verified against expected output */
  run(task: TaskRun): Promise<string | TaskRunResult>;
  /** post a message to the owner chat (at-least-once: a crash right after posting may repeat it;
   *  may return a receipt with the sent message id) */
  notify(chatKey: string, text: string): Promise<Delivery | void>;
}

/** bd attention budget: the owner’s chat sees the verdict and the deliverable pointers;
 *  the full operational memo stays in the ledger. Deterministic cap, not model manners. */
export function ownerReport(head: string, text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 4 && text.length <= 420) return `${head}\n\n${text}`;
  const keep = lines.slice(0, 4).join("\n").trimEnd();
  return `${head}\n\n${keep}\n\n… full report is in the task log (${lines.length} lines).`;
}
export interface TaskLedger {
  start(input: LedgerTaskInput, requestId?: string): Promise<LedgerEntry>;
  /** Return the newest active task for an agent/chat, if any. */
  latestActive(agentId: string, chatKey: string): Promise<LedgerEntry | undefined>;
  /**
   * Update a task's canonical record fields (task-record-canon, bd pibot-r47f):
   * nextAction / outputLocation / inputLocations. scoped to the owning agent; only
   * pending/running (and blocked) tasks accept record updates — finished tasks are history.
   */
  updateRecord(id: string, agentId: string, patch: { nextAction?: string; outputLocation?: string; inputLocations?: string }): Promise<LedgerEntry | undefined>;
  get(id: string): Promise<LedgerEntry | undefined>;
  /**
   * Append correlated delegate evidence to a task WITHOUT marking it done and WITHOUT
   * re-notifying the owner (bd pibot-jiqv). Only a `cause: "deadline"` append may promote a
   * terminal `failed` entry to `partial`; any other cause and every other status keep their
   * outcome semantics (a cancellation stays cancelled).
   */
  appendEvidence(id: string, evidence: string, opts?: { cause?: "deadline" | "late"; usable?: boolean }): Promise<LedgerEntry | undefined>;
  list(filter: { agentId: string; chatKey?: string }): Promise<LedgerEntry[]>;
  /**
   * Persist an owner decision correlated to this task (bd pibot-0xpf.5). Host-only: call it only
   * with an answer from the canonical owner-question journal, never from a sibling's relayed claim.
   * The questionKey must be namespaced to THIS task and owner chat. First decision per questionKey
   * wins; a resumed attempt inherits the recorded decisions instead of re-asking the owner.
   */
  recordDecision(id: string, agentId: string, decision: TaskDecision): Promise<LedgerEntry | undefined>;
  /** true when an abort was requested for a live task */
  cancel(id: string): Promise<boolean>;
  /** the whole ledger document, for the offline compaction path (bd pibot-b708) */
  exportSnapshot(): Promise<LedgerSnapshot>;
  /** write a whole document value into an EMPTY ledger in one commit (bd pibot-b708) */
  importSnapshot(value: LedgerSnapshot): Promise<void>;
  close(): Promise<void>;
}

export const MAX_ATTEMPTS = 2;
export const MAX_ACTIVE_PER_AGENT = 5;
const KEEP_FINISHED = 200;
const RESULT_CHARS = 4000;
const EVIDENCE_CHARS = 4000;
const EVIDENCE_TOTAL_CHARS = 6000;
const EVIDENCE_TRUNCATED = "[earlier evidence truncated]";
const RECEIPT_CHARS = 1500;

function compactUsableReceipt(note: string): string {
  // The collector's formatted report begins with provenance and a gate; keep the actual
  // reply body even when it has no path. Never cut a path in the middle.
  const body = note.split("\n").map((line) => line.trim()).filter((line) => line
    && !/^Delegate .+ returned (?:a reply|context\/refusal\/blocker)/.test(line)
    && !/^(?:Remaining gate:|Paths reported by the delegate|Reported paths)/.test(line)).join(" ") || note.trim();
  const excerpt = body.length > 800 ? `${body.slice(0, 797)}...` : body;
  let receipt = excerpt;
  let omitted = false;
  for (const ref of extractArtifactRefs(note)) {
    const next = `${receipt.includes("\nReported paths") ? ", " : "\nReported paths (unverified): "}${ref}`;
    if (receipt.length + next.length + 22 > RECEIPT_CHARS) { omitted = true; break; }
    receipt += next;
  }
  if (omitted) receipt += " (more paths omitted)";
  return receipt;
}

function recoveredNotice(receipt: string): string {
  const paths = receipt.split("\n").find((line) => line.startsWith("Reported paths"));
  const summary = receipt.split("\n")[0].slice(0, 180);
  return `Correlated delegate reply (unverified): ${summary}${paths ? `\n${paths}` : ""}\nRemaining gate: confirm filing and delivery; do not repeat delegate work without checking the reported result.`;
}

/** Append one note without duplicating it and keep the stored evidence bounded (bd pibot-jiqv). */
function appendBoundedEvidence(existing: string | undefined, note: string): string {
  const base = existing ?? "";
  if (!note || base.includes(note)) return base;
  const next = base ? `${base}\n\n${note}` : note;
  if (next.length <= EVIDENCE_TOTAL_CHARS) return next;
  return `${EVIDENCE_TRUNCATED}\n${next.slice(-(EVIDENCE_TOTAL_CHARS - EVIDENCE_TRUNCATED.length - 1))}`;
}

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
  | { phase: "work"; attempt: number;
      /** owner decisions read from the durable entry at attempt start (bd pibot-0xpf.5) */
      decisions?: TaskDecision[] }
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

/**
 * Why an expected-medium delivery is not yet verifiable (bd pibot-cida). The receipt must name the
 * delivered medium, a valid message id, a destination, a MEANINGFUL bot account and the id
 * namespace — the MHT case showed a message id that actually lived in a different dialogue than the
 * one claimed, and an agent id is not a bot identity. The expected destination is explicit
 * (`expectedPeer`, defaulting to the origin chat), so a deliberately different target is checked
 * against ITSELF, never hardcoded to the origin. The wording stays a gap statement ("not verified"),
 * never an assertion that nothing arrived.
 */
function describeDeliveryGap(
  delivery: Omit<Delivery, "deliveredAt"> | undefined,
  input: Pick<LedgerTaskInput, "chatKey" | "agentId" | "expectedPeer" | "expectedAccount" | "expectedIdProtocol">,
  expect: string,
  validMessageId: boolean,
): string | undefined {
  if (!delivery) return `requested ${expect} but the delivery was not verified (no media receipt)`;
  if (delivery.mediaType !== expect) {
    return delivery.mediaType
      ? `requested ${expect} but delivered ${delivery.mediaType}`
      : `requested ${expect} but the delivery was not verified (no media type in the receipt)`;
  }
  if (!validMessageId) return `requested ${expect} but delivery has no valid message ID`;
  const expectedPeer = input.expectedPeer ?? input.chatKey;
  if (!delivery.peer) return `requested ${expect} but the receipt names no destination (destination unverified)`;
  if (delivery.peer !== expectedPeer) return `requested ${expect} but delivered to ${delivery.peer} instead of ${expectedPeer}`;
  if (!delivery.account) return `requested ${expect} but the receipt names no sending account (account unverified)`;
  if (delivery.account === input.agentId) {
    return `requested ${expect} but the receipt's account is the agent id "${input.agentId}", not a bot account (account unverified)`;
  }
  if (input.expectedAccount && delivery.account !== input.expectedAccount) {
    return `requested ${expect} but sent as ${delivery.account} instead of ${input.expectedAccount}`;
  }
  if (!delivery.idProtocol) return `requested ${expect} but the receipt names no id namespace (id protocol unverified)`;
  if (input.expectedIdProtocol && delivery.idProtocol !== input.expectedIdProtocol) {
    return `requested ${expect} but the receipt used id protocol ${delivery.idProtocol} instead of ${input.expectedIdProtocol}`;
  }
  return undefined;
}

/** Collapse whitespace runs so a wrapped/indented note still matches the requested text. */
function normalizeContent(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** How many times the requested addition occurs in the readback (whitespace-insensitive). */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Why a requested content addition is not proven to be in the artifact (bd pibot-cida).
 *
 * The Nov 4 creator task asked to append one sentence to a note, the agent answered "Task
 * done" and "Not saved", and the ledger still recorded `done` because the ONLY completion
 * gate was the delivery receipt: `acceptanceCriteria` was prose nobody evaluated. The gate
 * below is deliberately narrow and mechanical — when the caller names the expected text AND
 * the artifact path, completion requires a readback taken AFTER the write that actually holds
 * that text. A run that could not write says so and stays `partial`; a run that wrote records
 * the addition once, and the readback proves it is still there (no duplicate append).
 *
 * Wording is a gap statement ("not verified"), never an assertion that nothing happened.
 */
function describeContentGap(
  expect: string,
  outputLocation: string | undefined,
  readback: ContentReadback | undefined,
): string | undefined {
  const wanted = normalizeContent(expect);
  if (!wanted) return undefined;
  const where = outputLocation?.split(",")[0]?.trim() || "the output artifact";
  if (!readback) return `expected the artifact to contain the requested addition, but no readback of ${where} was supplied (content unverified)`;
  if (!readback.afterWrite) return `expected the artifact to contain the requested addition, but the readback of ${readback.path} did not happen after the write (content unverified)`;
  if (outputLocation && readback.path.trim() !== where) {
    return `expected the requested addition in ${where}, but the readback names ${readback.path} (content unverified)`;
  }
  if (!normalizeContent(readback.text).includes(wanted)) {
    return `expected the requested addition in ${readback.path}, but the text read back does not contain it (write not proven)`;
  }
  // Exactly once: a retry that appends the same sentence again has changed the note twice, and
  // "records the addition once under the same task" is part of what completion means.
  const occurrences = countOccurrences(normalizeContent(readback.text), wanted);
  if (occurrences > 1) {
    return `expected the requested addition in ${readback.path} once, but the text read back contains it ${occurrences} times (duplicate append)`;
  }
  return undefined;
}

/**
 * Why a contracted restore/repair deliverable is not verified (bd pibot-0xpf.5). The receipt is a
 * HOST readback of the exact path after the run. Bookkeeping text — “ledger updated”, “restore
 * pending”, a nonempty summary — never satisfies it, and a different hash is labelled a
 * reconstruction rather than a byte-exact restore.
 */
function describeArtifactGap(
  artifact: Omit<ArtifactReceipt, "verifiedAt"> | undefined,
  input: Pick<LedgerTaskInput, "expectedArtifactPath" | "expectedArtifactSha256">,
): string | undefined {
  const expected = input.expectedArtifactPath!.trim();
  if (!artifact) {
    return `requested restore of "${expected}" but no post-run readback verified the file (bookkeeping text is not a restored artifact)`;
  }
  if (artifact.evidence !== "readback") {
    return `requested restore of "${expected}" but the receipt is not a host readback`;
  }
  if (artifact.path !== expected) return `requested restore of "${expected}" but the readback attested "${artifact.path}"`;
  if (!(artifact.bytes > 0)) return `requested restore of "${expected}" but the file read back empty`;
  if (input.expectedArtifactSha256 && artifact.sha256 !== input.expectedArtifactSha256) {
    return `requested restore of "${expected}" but the readback is a reconstruction (sha256 ${artifact.sha256}) rather than the byte-exact original (expected ${input.expectedArtifactSha256})`;
  }
  return undefined;
}

function prune(doc: LedgerDoc): void {
  const finished = Object.values(doc.tasks).filter((t) => !active(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const old of finished.slice(KEEP_FINISHED)) {
    delete doc.tasks[old.id];
    for (const [rid, tid] of Object.entries(doc.requests)) if (tid === old.id) delete doc.requests[rid];
  }
}

  /** A ledger directory that cannot be read. Owner-visible and fatal to the task subsystem,
   *  never papered over by reopening onto empty state. */
export class LedgerUnreadableError extends Error {
  readonly dir: string;
  constructor(dir: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `The task ledger in ${dir} could not be read: ${detail}. ` +
        `Do not delete it silently — inspect main.jsonl and its sidecars, or move the directory aside to start a fresh ledger.`,
      { cause: cause instanceof Error ? cause : undefined },
    );
    this.name = "LedgerUnreadableError";
    this.dir = dir;
  }
}

/** Snapshot of the whole ledger document, as the daemon would read it (bd pibot-b708). */
export interface LedgerSnapshot {
  tasks: Record<string, LedgerEntry>;
  requests: Record<string, string>;
}

/**
 * Rebuild a ledger directory so its marker log holds ONE commit instead of history
 * (bd pibot-b708). The backend has no compaction: `reclaimSidecars()` prunes doc-/task-
 * sidecars but main.jsonl markers are append-only, and `document.retire` only empties a
 * retired doc's sidecar. So the supported way to shrink it is to write the current
 * document value into a fresh directory and swap.
 *
 * The caller is responsible for quiescence — this function takes the directory lock, and
 * therefore fails loudly if a live writer holds it, but it cannot know whether an
 * unfinished task would be lost; that check belongs to the caller (see
 * `compactTaskLedger` in ./compact-ledger.ts).
 */
export async function rewriteLedgerStorage(opts: {
  storageDir: string;
  stagingDir: string;
  label?: string;
}): Promise<{ tasks: number; requests: number }> {
  // Read the current document through the ordinary open path, then close it so the
  // directory is free — the read lock is released before the staging ledger is built.
  const source = await openTaskLedger({ runner: { run: async () => "", notify: async () => undefined }, storageDir: opts.storageDir, label: `${opts.label ?? "compaction"} (read)` });
  let snapshot: LedgerSnapshot;
  try {
    snapshot = (await source.exportSnapshot()) as LedgerSnapshot;
  } finally {
    await source.close();
  }

  const target = await openTaskLedger({
    runner: { run: async () => "", notify: async () => undefined },
    storageDir: opts.stagingDir,
    label: `${opts.label ?? "compaction"} (write)`,
  });
  try {
    await target.importSnapshot(snapshot);
  } finally {
    await target.close();
  }
  return { tasks: Object.keys(snapshot.tasks ?? {}).length, requests: Object.keys(snapshot.requests ?? {}).length };
}

export async function openTaskLedger(opts: { runner: TaskRunner; storageDir?: string; now?: () => number; label?: string }): Promise<TaskLedger> {
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
          // Carry the accepted owner decisions from the durable entry into this attempt so a
          // resumed run inherits them instead of re-asking (bd pibot-0xpf.5).
          return { status: "running", checkpoint: { phase: "work", attempt, ...(entry?.decisions?.length ? { decisions: entry.decisions } : {}) } };
        }, ctx);
      },
      work: async (task, rt, ctx) => {
        const { attempt, decisions } = task.state.checkpoint;
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
        let artifact: Omit<ArtifactReceipt, "verifiedAt"> | undefined;
        let runnerPartial: string | undefined;
        let runnerEvidence: string | undefined;
        let readback: ContentReadback | undefined;
        let deadlineFailure = false;
        try {
          const raw = await runner.run({ ...input, taskId: ledgerId, attempt, resumed: attempt > 1, signal: rt.signal, ...(decisions?.length ? { decisions } : {}) });
          // A runner may return a bare string or a correlated result receipt
          if (typeof raw === "string") {
            text = raw.trim();
          } else {
            text = raw.text.trim();
            delivery = raw.delivery;
            readback = raw.readback;
            artifact = raw.artifact;
            // Correlated evidence proves usable PARTIAL output, never task completion (bd pibot-jiqv).
            if (raw.status === "partial") runnerPartial = raw.partialReason ?? "the run returned a correlated partial result before it stopped";
            runnerEvidence = raw.evidence;
          }
          // Empty output is not a successful result: record an explicit failure
          // rather than delivering a fabricated success summary.
          if (!text) throw new Error("Task finished without a result summary");
        } catch (error) {
          if (rt.signal.aborted) throw error; // cancelled or shutting down: the abort protocol / resume owns the outcome
          ok = false;
          text = error instanceof Error ? error.message : String(error);
          if (error instanceof BlockedError) final = "blocked";
          // Only a real deadline may reconcile evidence into `partial`; an arbitrary work
          // failure keeps its failed semantics (bd pibot-jiqv review).
          else if (error instanceof TaskDeadlineError) deadlineFailure = true;
        }
        const validMessageId = typeof delivery?.messageId === "number" && Number.isSafeInteger(delivery.messageId) && delivery.messageId > 0;
        const deliveryProblem = ok && expect ? describeDeliveryGap(delivery, input, expect, validMessageId) : undefined;
        // A contracted restore is complete only when the HOST read the artifact back; bookkeeping
        // text can never satisfy it (bd pibot-0xpf.5).
        const artifactProblem = ok && input.expectedArtifactPath ? describeArtifactGap(artifact, input) : undefined;
        if (deliveryProblem || artifactProblem) {
          // Verified-completion gate (bd pibot-zy70) made destination/account-aware (bd pibot-cida):
          // when the owner asked for a specific medium, `done` requires the receipt to name that same
          // medium, the intended destination, a real bot account and the id namespace — a message id
          // alone is not proof. The same discipline applies to a contracted artifact.
          final = "partial";
        }
        if (runnerPartial) final = "partial";
        // Content gate (bd pibot-cida): a task that asks for a specific addition to a specific
        // artifact must prove it by reading the file back AFTER writing it. Reported success is
        // not proof — the Nov 4 case answered "Task done" and "Not saved" and still completed.
        const contentExpect = ok ? task.input.expectedContent?.trim() || undefined : undefined;
        const contentProblem = contentExpect
          ? describeContentGap(contentExpect, task.input.outputLocation, readback)
          : undefined;
        if (contentProblem) final = "partial";
        const resultChars = text.length;
        text = text.slice(0, RESULT_CHARS);
        // Relative-date wording (bd pibot-wr9m): rewrite mis-stated relative words from the absolute
        // date they sit beside rather than appending a warning to a reminder that still reads false.
        // If the wording cannot be safely rewritten, fail safe — the result is not presented as done.
        const dateGuard = ok ? correctRelativeDateClaims(text, { now: now() }) : undefined;
        if (dateGuard && dateGuard.inconsistent > 0 && dateGuard.corrected) text = dateGuard.text;
        if (dateGuard?.blocked) final = "partial";
        // Programmatic fact-check of numeric claims (bd pibot-wr9m): only mechanical
        // arithmetic, only on work results (error texts are not claim prose).
        const factCheck = ok ? scanNumericClaims(text) : { checked: 0, inconsistent: 0, failures: [] as string[] };
        if (factCheck.inconsistent > 0) {
          text += `\n\n⚠️ fact-check: ${factCheck.inconsistent} of ${factCheck.checked} numeric claim(s) inconsistent — e.g. "${truncate(factCheck.failures[0], 80)}"`;
        }
        // Disclose the cap instead of silently cutting a long result (bd pibot-wcp0): a
        // consumer that cannot see truncation asks for ad hoc remainder slices.
        if (resultChars > RESULT_CHARS) {
          text += `\n\n[truncated: showing the first ${RESULT_CHARS} of ${resultChars} characters — request the remaining range from this task's output artifact]`;
        }
        await rt.commit(async (tx) => {
          const entry = (await ledgerDoc(tx, rt.conversationId)).tasks[ledgerId];
          if (entry) {
            if (factCheck.checked > 0) entry.factCheck = factCheck;
            if (dateGuard && dateGuard.inconsistent > 0) {
              entry.dateCheck = { checked: dateGuard.checked, inconsistent: dateGuard.inconsistent, corrected: dateGuard.corrected, blocked: dateGuard.blocked, failures: dateGuard.failures };
            }
            if (artifact) entry.artifact = { ...filterUndefined(artifact), verifiedAt: now() };
            // Merge evidence the runner reported, and evidence appended concurrently while the
            // task was still `running` (a late reply can land before this terminal commit).
            if (deadlineFailure) entry.failure = "deadline";
            // A readback that fails the content gate stays on the record as the reason, so the
            // owner can see WHAT was read instead of a generic "output only partly delivered".
            if (readback && contentExpect) {
              entry.readback = { path: readback.path, text: readback.text.slice(0, 800), afterWrite: readback.afterWrite };
            }
            if (runnerEvidence) {
              entry.evidence = appendBoundedEvidence(entry.evidence, runnerEvidence);
              entry.evidenceUsable = true; // report() only returns usable replies
              entry.usableReceipt = compactUsableReceipt(runnerEvidence);
            }
            if (final === "blocked") Object.assign(entry, { status: "blocked", blocker: text }, { updatedAt: now() });
            else if (final === "partial") {
              const mismatch = deliveryProblem
                ?? artifactProblem
                ?? contentProblem
                ?? runnerPartial
                ?? (dateGuard?.blocked ? "relative date wording contradicted the absolute date and could not be corrected safely" : "output only partly delivered");
              Object.assign(entry, { status: "partial", error: mismatch, result: text, updatedAt: now() });
            } else if (ok) Object.assign(entry, { status: "done", result: text }, { updatedAt: now() });
            else if (deadlineFailure && entry.usableReceipt) {
              // Evidence arrived as the deadline stopped the run. Keep the result partial (never
              // done) and say only that filing/delivery is unconfirmed — not that work failed.
              final = "partial";
              text = recoveredNotice(entry.usableReceipt);
              Object.assign(entry, { status: "partial", error: "the deadline stopped the run; correlated delegate evidence exists and filing/delivery is still unconfirmed", result: text, updatedAt: now() });
            } else Object.assign(entry, { status: "failed", error: text }, { updatedAt: now() });
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
          receipt = await runner.notify(task.input.chatKey, ownerReport(head, text));
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
            // Delivery receipt (bd pibot-zy70, destination/account-aware in bd pibot-cida): the
            // result's message id/type/destination come from the runner's own receipt (the media
            // send) when it exists; otherwise from the notice push. A receipt field the transport did
            // NOT attest stays unset — a missing destination/account/namespace is recorded as
            // unverified, never manufactured from the requested chat (bd pibot-cida review). Keys with
            // no evidence stay unset (strict JSON).
            const noticeReceipt = typeof receipt === "object" ? (receipt as Delivery) : undefined;
            const d: Delivery = { deliveredAt: now() };
            if (delivery) {
              if (delivery.messageId !== undefined) d.messageId = delivery.messageId;
              if (delivery.peer !== undefined) d.peer = delivery.peer;
              if (delivery.mediaType !== undefined) d.mediaType = delivery.mediaType;
              if (delivery.account !== undefined) d.account = delivery.account;
              if (delivery.idProtocol !== undefined) d.idProtocol = delivery.idProtocol;
              if (delivery.evidence !== undefined) d.evidence = delivery.evidence;
            } else if (noticeReceipt?.messageId !== undefined) {
              d.messageId = noticeReceipt.messageId;
              if (noticeReceipt.peer !== undefined) d.peer = noticeReceipt.peer;
              if (noticeReceipt.mediaType !== undefined) d.mediaType = noticeReceipt.mediaType;
              if (noticeReceipt.account !== undefined) d.account = noticeReceipt.account;
              if (noticeReceipt.idProtocol !== undefined) d.idProtocol = noticeReceipt.idProtocol;
              if (noticeReceipt.evidence !== undefined) d.evidence = noticeReceipt.evidence;
            }
            if (d.messageId !== undefined && d.evidence === undefined) d.evidence = "ack";
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
  // One owner per ledger directory (bd pibot-cea8): the JSONL backend has no lock of its
  // own, so a second writer — the satellite script pointed at the live directory, or a
  // second daemon — would interleave commits and corrupt the task index.
  const lock: StorageLock | undefined = opts.storageDir
    ? lockStorageDir(opts.storageDir, { label: `task-ledger ${opts.label ?? "pibot"}`, onStaleTakeover: (holder) => console.warn(`[task-ledger] took over a stale storage lock in ${opts.storageDir} from pid ${holder?.pid ?? "?"}`) })
    : undefined;
  let storage;
  try {
    storage = opts.storageDir ? await openNodeJsonlStorage(opts.storageDir, C) : new MemoryStorage();
  } catch (e) {
    // Corruption is a hard stop, never a silent reopen onto a rewritten ledger: the
    // owner has to see that the task index needs repair (bd pibot-cea8).
    lock?.release();
    throw new LedgerUnreadableError(opts.storageDir!, e);
  }
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  try {
    harness = await Harness.open(storage, {
      models: createModels(), // the ledger never calls a model; agents do the work through the runner
      registry,
      onReport: (e) => console.warn("[task-ledger]", e instanceof Error ? e.message : e),
    }, C);
  } catch (e) {
    lock?.release();
    throw new LedgerUnreadableError(opts.storageDir!, e);
  }
  const root = await harness.root(C);
  harness.resume();

  const snapshot = async () => ((await harness.snapshot(Ledger, root.id, C)) ?? { tasks: {}, requests: {} }) as unknown as LedgerDoc;
  const listTasks = async ({ agentId, chatKey }: { agentId: string; chatKey?: string }): Promise<LedgerEntry[]> =>
    Object.values((await snapshot()).tasks)
      .filter((t) => t.agentId === agentId && (!chatKey || t.chatKey === chatKey))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);

  return {
    async start(input, requestId) {
      // A restore contract names a real file on disk. Validate the identity up front so a
      // model-supplied relative/ambiguous path can never become a host readback target.
      if (input.expectedArtifactPath !== undefined) {
        const artifact = input.expectedArtifactPath.trim();
        if (!artifact || artifact.includes("\0") || !path.isAbsolute(artifact)) {
          throw new Error("expectedArtifactPath must be a non-empty absolute path");
        }
        if (input.artifactScope !== undefined) {
          const scope = input.artifactScope.trim();
          if (!scope || scope.includes("\0") || !path.isAbsolute(scope)) {
            throw new Error("artifactScope must be a non-empty absolute path");
          }
          const rel = path.relative(path.resolve(scope), path.resolve(artifact));
          if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`expectedArtifactPath "${artifact}" is outside the declared artifactScope "${scope}"`);
          }
        }
      }
      if (input.expectedArtifactSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.expectedArtifactSha256)) {
        throw new Error("expectedArtifactSha256 must be a 64-character hex digest");
      }
      if (input.expectedArtifactPath !== undefined) {
        // Store the canonical absolute paths so the readback receipt is comparable to the contract.
        input = {
          ...input,
          expectedArtifactPath: path.resolve(input.expectedArtifactPath.trim()),
          ...(input.artifactScope !== undefined ? { artifactScope: path.resolve(input.artifactScope.trim()) } : {}),
        };
      }
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
    async appendEvidence(id, evidence, opts = {}) {
      const note = evidence.trim().slice(0, EVIDENCE_CHARS);
      if (!note) return undefined;
      await root.commit(async (tx) => {
        const doc = await ledgerDoc(tx, root.id);
        const task = doc.tasks[id];
        if (!task) return undefined;
        const before = task.evidence;
        // Dedupe INSIDE the transaction so two concurrent late replies cannot both append.
        task.evidence = appendBoundedEvidence(task.evidence, note);
        if (task.evidence === before) return undefined; // duplicate or empty: no status change
        if (opts.usable === true) {
          task.evidenceUsable = true;
          task.usableReceipt = compactUsableReceipt(note);
        }
        // Promote only when BOTH sides attest a deadline: the record itself failed by deadline,
        // and the caller's cause is a deadline. A refusal-only append never promotes, an
        // arbitrary failure is never relabeled, and a cancelled/done outcome is never rewritten.
        if (opts.cause === "deadline" && opts.usable === true && task.usableReceipt && task.status === "failed" && task.failure === "deadline") {
          task.status = "partial";
          task.blocker = "the deadline stopped the run; correlated delegate evidence exists and filing/delivery is still unconfirmed";
          delete task.error; // stale generic timeout must not mask the reconciled reason
          task.result = recoveredNotice(task.usableReceipt!);
        }
        task.updatedAt = now();
        return undefined;
      }, C);
      return (await snapshot()).tasks[id];
    },
    async recordDecision(id, agentId, decision) {
      // Only a real owner answer may authorize: reject a relayed/forged source outright.
      if (decision.source !== "owner_question") throw new Error("only a canonical owner answer can record a task decision");
      if (!decision.action.trim() || !decision.choice.trim() || !decision.qid.trim() || !decision.questionKey.trim()) {
        throw new Error("invalid owner decision provenance");
      }
      // A caller may not substitute its own key for the canonical question id.
      if (decision.qid === decision.questionKey) throw new Error("owner decision needs the canonical question id, not a substituted key");
      // Replay identity must be scoped to THIS task and owner chat, never a global journal lookup.
      if (!decision.questionKey.startsWith(`task:${id}:owner:`)) {
        throw new Error(`owner decision questionKey must be namespaced to task "${id}" and its owner chat`);
      }
      if (!Array.isArray(decision.options) || !Number.isSafeInteger(decision.optionIndex) || decision.optionIndex < -1 || decision.optionIndex >= decision.options.length) {
        throw new Error("invalid owner decision option contract");
      }
      if (decision.optionIndex >= 0 && decision.choice !== decision.options[decision.optionIndex]) {
        throw new Error("owner decision choice does not match the declared option");
      }
      let found = false;
      await root.commit(async (tx) => {
        const doc = await ledgerDoc(tx, root.id);
        const entry = doc.tasks[id];
        if (!entry || entry.agentId !== agentId || !active(entry.status)) return undefined;
        // First decision per logical question wins: a retried/late record cannot overwrite it,
        // and a decision for a DIFFERENT action can never replay this one.
        const decisions = entry.decisions ?? [];
        if (!decisions.some((d) => d.questionKey === decision.questionKey)) {
          decisions.push({ ...decision, answeredAt: decision.answeredAt || now() });
          entry.decisions = decisions;
          entry.updatedAt = now();
        }
        found = true;
        return undefined;
      }, C);
      return found ? (await snapshot()).tasks[id] : undefined;
    },
    async exportSnapshot() {
      return (await snapshot()) as unknown as LedgerSnapshot;
    },
    /**
     * Write a whole document value into a FRESH ledger in one commit (bd pibot-b708).
     * Refuses a ledger that already has history: this is a rebase, not a merge.
     */
    async importSnapshot(value) {
      const existing = await snapshot();
      if (Object.keys(existing.tasks).length || Object.keys(existing.requests).length) {
        throw new Error("importSnapshot target already holds a ledger; compaction must write into an empty directory");
      }
      await root.commit(async (tx) => {
        const doc = await ledgerDoc(tx, root.id);
        doc.tasks = structuredClone(value.tasks ?? {});
        doc.requests = structuredClone(value.requests ?? {});
        return undefined;
      }, C);
    },
    async close() {
      try {
        await harness.close(C);
      } finally {
        lock?.release();
      }
    },
  };
}
