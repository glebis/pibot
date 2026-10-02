// Pi Durable satellite — first prototype (bead pibot-icv).
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
}

type OpenedHarness = Awaited<ReturnType<typeof Harness.open>>;
type RootConversation = Awaited<ReturnType<OpenedHarness["root"]>>;

export async function openSatellite(opts: SatelliteOptions): Promise<Satellite> {
  const storage = opts.storageDir
    ? await openNodeJsonlStorage(opts.storageDir, BACKGROUND_CONTEXT)
    : new MemoryStorage();

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
    return answerText(harness, root, settled);
  }

  return { ask, resume: () => harness.resume(), harness, root };
}

/** Extract the assistant text of a settled submission's answer entry. */
async function answerText(
  harness: OpenedHarness,
  root: RootConversation,
  settled: SettledSubmissionRecord,
): Promise<string> {
  if (settled.status === "unanswered" || !settled.answer) {
    throw new Error(`satellite submission ${settled.id} did not answer: ${settled.status}${"reason" in settled ? ` — ${String(settled.reason)}` : ""}`);
  }
  const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
  void harness;
  for (const e of page.items) {
    if (String(e.id) === String(settled.answer)) return entryText(e);
  }
  // fall back: newest assistant entry
  const last = page.items.filter((e) => entryText(e)).at(-1);
  if (last) return entryText(last);
  throw new Error(`satellite answer entry ${settled.answer} not found in transcript`);
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