// Pi Durable satellite — PROTOTYPE, no production caller (bead pibot-icv, pibot-8ptd).
//
// Decision 2026-10-29 (bd pibot-8ptd): the phase-1 "daemon-owned satellite" goal is RETIRED —
// see docs/durable-satellite-decision.md. Nothing in the daemon opens a satellite; the only
// caller is scripts/durable-satellite.mts. The durable properties this was meant to prove
// (checkpoint/resume, exactly-once by requestId, crash-safe delivery) now live in the
// existing pi-coding-agent stack instead: src/durable/task-ledger.ts (background tasks),
// src/core/delivery-ledger.ts (outbound Telegram), src/core/question-store.ts (owner
// questions), src/core/scheduler.ts (reminder fires). The gap that keeps this a prototype is
// capability surface, not durability: this harness registers ONE read-only tool
// (list_workspace) where a pibot agent has 28 capability definitions / 89 tools.
//
// One durable harness owning one SQLite/JSONL storage: every model call and
// tool run is a checkpointed task, so the satellite survives its process dying
// (reopen the same storage + resume()) and re-submissions with the same
// requestId are exactly-once — the retry gets the original run, never a second.
//
// Deliberately THIN: pibot core stays on pi-coding-agent 1.0. This module is
// the seam where a real provider, the Telegram transport surface, and the
// workshop box attach later.

import * as fs from "node:fs";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type CredentialStore, type Provider } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { lockStorageDir, type StorageLock } from "./storage-lock.js";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { SettledSubmissionRecord } from "@earendil-works/pi-durable";

/** The satellite's first real tool: bounded listing of its own workspace. */
function listWorkspaceTool(workspaceDir: string) {
  return defineTool({
    name: "list_workspace",
    description: "List the files in the satellite's workspace directory (names only, bounded to 200)",
    parameters: Type.Object({}),
    replay: "safe", // read-only: a rerun after a crash is fine
    execute: async () => {
      const names = fs
        .readdirSync(workspaceDir)
        .filter((n) => !n.startsWith("."))
        .slice(0, 200);
      return { content: [{ type: "text", text: `WS-CONTENTS: ${names.length ? names.join(", ") : "(empty workspace)"}` }] };
    },
  });
}

export interface SatelliteOptions {
  /** pi-ai provider (faux in tests; a real provider in production wiring) */
  provider: Provider;
  /** directory the satellite may inspect via list_workspace */
  workspaceDir: string;
  /** storage directory; omit for in-memory (tests) */
  storageDir?: string;
  /** credentials so provider auth resolves (shared pi auth store in production) */
  credentials?: CredentialStore;
  /** working directory handed to the conversation's execution environment */
  cwd?: string;
  /** override which provider model the satellite's root conversation uses (default: first) */
  modelId?: string;
}

export interface Satellite {
  ask(content: string, requestId?: string): Promise<string>;
  resume(): void;
  /** low-level access for forks/configure (kept for the next prototype steps) */
  readonly harness: OpenedHarness;
  readonly root: RootConversation;
  /** close the harness and release the storage lock */
  close(): Promise<void>;
}

type OpenedHarness = Awaited<ReturnType<typeof Harness.open>>;
type RootConversation = Awaited<ReturnType<OpenedHarness["root"]>>;

export async function openSatellite(opts: SatelliteOptions): Promise<Satellite> {
  // A satellite is by design a SECOND durable harness. It must never share a storage
  // directory with the daemon's task ledger: the JSONL backend does not lock, so two
  // writers interleave commits (bd pibot-cea8).
  const lock: StorageLock | undefined = opts.storageDir ? lockStorageDir(opts.storageDir, { label: "durable satellite" }) : undefined;
  let storage;
  try {
    storage = opts.storageDir
      ? await openNodeJsonlStorage(opts.storageDir, BACKGROUND_CONTEXT)
      : new MemoryStorage();
  } catch (e) {
    lock?.release();
    throw e;
  }

  const models = createModels({ credentials: opts.credentials });
  models.setProvider(opts.provider);

  const registry = createRegistry();
  // tools live in a named extension: "an extension is a named bundle of tools" —
  // installing a bare registration silently selects nothing
  registry.install(defineExtension({ name: "satellite-tools", tools: [listWorkspaceTool(opts.workspaceDir)] }));

  const harness = await Harness.open(storage, {
    models,
    registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
  }, BACKGROUND_CONTEXT);
  const model = opts.modelId
    ? opts.provider.getModels().find((m) => m.id === opts.modelId)
    : opts.provider.getModels()[0];
  if (!model) throw new Error(`satellite provider exposes no model ${opts.modelId ?? "(first)"}`);
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: opts.provider.id, modelId: model.id },
      cwd: opts.cwd ?? opts.workspaceDir,
      // a bare registry is not auto-selected: the conversation must opt into tools
      tools: [listWorkspaceTool(opts.workspaceDir)],
    },
  });

  async function ask(content: string, requestId?: string): Promise<string> {
    const settled: SettledSubmissionRecord = await (
      await root.submit(requestId ? { type: "input", content, requestId } : { type: "input", content }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    return answerText(root, settled);
  }

  // Extensions/registry are installed and the root conversation is open: now it is
  // safe to restart work a previous process left unfinished. resume() only flips
  // the scheduler on and kicks it, so repeat calls (the public `resume`) are harmless.
  harness.resume();

  /** Release the harness and the storage-directory lock. */
  async function close(): Promise<void> {
    try {
      await harness.close(BACKGROUND_CONTEXT);
    } finally {
      lock?.release();
    }
  }

  return { ask, resume: () => harness.resume(), harness, root, close };
}

/** Extract the assistant text of a settled submission's answer entry. */
async function answerText(root: RootConversation, settled: SettledSubmissionRecord): Promise<string> {
  if (settled.status === "unanswered" || !settled.answer) {
    throw new Error(`satellite submission ${settled.id} did not answer: ${settled.status}${"reason" in settled ? ` — ${String(settled.reason)}` : ""}`);
  }
  // EntryQuery bounds are inclusive, so min === max === answer id is an exact lookup
  // (no paging, no "newest assistant entry" guess that could return an older turn).
  const page = await root.entries(
    { minEntryId: settled.answer, maxEntryId: settled.answer },
    1,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const entry = page.items.find((e) => String(e.id) === String(settled.answer));
  if (!entry) {
    throw new Error(`satellite submission ${settled.id}: answer entry ${String(settled.answer)} not found in transcript`);
  }
  return entryText(entry);
}

/** Entries carry their messages on `model` (array for assistant entries, single for user). */
function entryText(entry: unknown): string {
  const e = entry as { model?: unknown };
  const messages = Array.isArray(e.model) ? e.model : e.model ? [e.model] : [];
  return messages
    .map((m) => (Array.isArray(m?.content) ? m.content : []))
    .flat()
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("")
    .trim();
}