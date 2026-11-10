import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import type { LedgerEntry, TaskLedger } from "../durable/task-ledger.js";
import type { ChatRef } from "../core/types.js";
import { fmtWhen } from "../core/util.js";
import type { SttPolicy } from "../core/stt.js";
import { formatTranscriptionPlan, planTranscription, transcriptionPolicyMarker } from "../core/transcription-policy.js";

/** pi-durable instructions length cap; the mandatory policy head is reserved inside it. */
const INSTRUCTIONS_MAX = 8000;

/**
 * Reserve room for a mandatory head (the transcription policy marker + constraint) and
 * PREPEND it, so slicing to the cap can never drop it (bd pibot-0xpf.4 review: appending
 * the constraint then slicing to 8000 dropped the entire policy at max input length).
 */
function withMandatoryHead(body: string, head: string): string {
  if (!head) return body.slice(0, INSTRUCTIONS_MAX);
  const headText = `${head}\n\n`;
  if (headText.length >= INSTRUCTIONS_MAX) return headText.slice(0, INSTRUCTIONS_MAX);
  return headText + body.slice(0, INSTRUCTIONS_MAX - headText.length);
}

export interface TasksPluginDeps {
  ledger: TaskLedger;
  agentId: string;
  /** owner chat this session serves; task results are posted back here */
  chat: ChatRef;
  /** resource preflight (bd pibot-kdpg): disk/credential/lane-cap checks before expensive work */
  preflight?: {
    check(input: { lane?: "download" | "transcribe" | "render" | "delegate" }, acquire?: boolean): Promise<{ ok: boolean; issues: string[] }>;
    release(lane: "download" | "transcribe" | "render" | "delegate"): void;
  };
  /**
   * The agent's speech/transcription policy (bd pibot-0xpf.4), so a task that
   * declares audio work carries the duration-aware route in its durable
   * contract. Absent for agents without a speech policy.
   */
  transcription?: { policy?: SttPolicy; hostProviders?: readonly string[]; groqCredentialPresent?: boolean };
}

function splitLocations(value?: string): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** Inputs the record still points at that are no longer on disk (bd pibot-7bo). A missing
 *  source must be visible in the record instead of reading as an available path. */
function missingInputs(t: LedgerEntry): string[] {
  return splitLocations(t.inputLocations).filter((entry) => !fs.existsSync(entry));
}

function line(t: LedgerEntry): string {
  const tail = t.status === "done" ? ` — ${(t.result ?? "").slice(0, 160)}`
    : t.status === "partial" ? ` — ${(t.result ?? t.error ?? t.blocker ?? "").slice(0, 160)}`
    : t.status === "failed" ? ` — ${(t.error ?? t.blocker ?? "").slice(0, 160)}`
    : t.status === "blocked" ? ` — blocked: ${(t.blocker ?? "").slice(0, 160)}`
    : "";
  const missing = missingInputs(t);
  const canon = [
    t.lane ? `lane:${t.lane}` : "",
    t.nextAction ? `next: ${t.nextAction.slice(0, 120)}` : "",
    t.outputLocation ? `out: ${t.outputLocation.slice(0, 120)}` : "",
    t.inputLocations ? `in: ${t.inputLocations.slice(0, 120)}` : "",
    missing.length ? `INPUT MISSING: ${missing.slice(0, 3).join(", ")}` : "",
    t.usableReceipt ? `usable receipt (delegate-reported, unverified): ${t.usableReceipt.replace(/\n/g, " • ").slice(0, 360)}` : "",
    // The rolling evidence string may now hold only refusals even when an earlier usable
    // receipt survives. Never label the rolling string from the historical task-wide marker.
    t.evidence
      ? `${t.evidenceUsable && !t.usableReceipt ? "legacy mixed context" : "context"}: ${t.evidence.split("\n")[0].slice(0, 100)}`
      : "",
    t.linearRef ? `ref: ${t.linearRef}` : "",
    t.decisions?.length ? `decisions: ${t.decisions.map((d) => `${d.action.slice(0, 60)}=${d.outcome}:${d.choice.slice(0, 30)}`).join(", ")}` : "",
    t.artifact ? `artifact: ${t.artifact.path.slice(0, 120)} (${t.artifact.bytes}B readback, ${t.artifact.verification}${t.artifact.reconstructed ? ", reconstructed" : ""})` : "",
  ].filter(Boolean).join(" • ");
  return `${t.id} [${t.status}] "${t.title}" (started ${fmtWhen(t.createdAt)})${tail}${canon ? `\n    ${canon}` : ""}`;
}

/**
 * Durable background tasks: start_task / task_status / list_tasks / cancel_task.
 * The work runs as a separate turn of this agent (own session, full tools) on a
 * pi-durable ledger that survives restarts; the result is posted to this chat.
 */
export function tasksPlugin(deps: TasksPluginDeps): InlineExtension {
  const { ledger, agentId, chat, preflight, transcription } = deps;
  const chatKey = `${chat.transport}:${chat.chatId}`;
  const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

  return {
    name: "tasks",
    factory: (pi) => {
      pi.registerTool({
        name: "start_task",
        label: "Start task",
        description: "Start a background task that runs on its own (minutes, with your tools) and posts its result to this chat when done. Use for work that takes longer than a quick reply — research, drafting, multi-step tool work. Give self-contained instructions: the task does not see this conversation.",
        parameters: Type.Object({
          title: Type.String({ description: "Short title the owner will recognise, e.g. 'summarise this week's notes'" }),
          instructions: Type.String({ description: "Self-contained instructions with all needed context from this conversation" }),
          timeoutMinutes: Type.Optional(Type.Number({ description: "Hard runtime cap in minutes for this task (default 30, max 480). Set higher for long local media work — a two-hour video transcription needs ~90; fetching + transcribing media counts inside the cap." })),
          expectedMedia: Type.Optional(Type.String({ description: "Set ONLY when the owner explicitly requested one specific medium for the task output (e.g. 'video_note' for a Telegram video note). Then the task completes only when the actually delivered media matches; a mismatch records 'partial', not 'done'." })),
          expectedPeer: Type.Optional(Type.String({ description: 'Set ONLY when the owner explicitly asked the result to land somewhere OTHER than this chat: the destination as "transport:chatId" for a target this bot is already authorised to reach (e.g. "telegram:123456" for a reachable bot group/chat). The result medium is delivered THERE (never to this chat) and completion requires the receipt to attest THAT destination; an unreachable target is a precise blocker. A Saved Messages folder is NOT reachable through the Bot API — the same numeric user id there addresses a bot dialogue, not Saved Messages — so Saved Messages requires a separately authorised account/protocol route and stays unsupported here unless that route already exists.' })),
          expectedAccount: Type.Optional(Type.String({ description: "Set ONLY when the expected sending bot identity is known (e.g. '@pibot'); completion then requires the receipt to name it, so a different bot cannot stand in." })),
          expectedIdProtocol: Type.Optional(Type.String({ description: 'Set ONLY when the expected message-id namespace is known ("bot_api" | "mtproto"); completion then requires the receipt to name it.' })),
          lane: Type.Optional(Type.String({ description: "'dev' (pibot source work) or 'cross-agent' (owner-facing content/tooling) — keeps the two lanes separate in records" })),
          acceptanceCriteria: Type.Optional(Type.String({ description: "Verifiable criteria the task must satisfy (what 'done' means in checkable words)" })),
          expectedContent: Type.Optional(Type.String({ description: "Set when the deliverable is a specific addition to a file: the EXACT text that must end up in outputLocation. The task cannot complete as done unless the file is read back after the write and contains this text — a run that reports success without writing stays partial." })),
          outputLocation: Type.Optional(Type.String({ description: "Where artifacts live on disk (absolute paths, comma-separated if many)" })),
          inputLocations: Type.Optional(Type.String({ description: "Absolute paths of private source files this task still needs (comma-separated). Recorded so retention cleanup can protect pending-task inputs, and status reports any that went missing. Use for downloaded audio/video or other non-reproducible inputs." })),
          linearRef: Type.Optional(Type.String({ description: "Reference-only link to the tracker (e.g. Linear id)" })),
          expectedArtifactPath: Type.Optional(Type.String({ description: "Set for a restore/repair whose deliverable is a file: the absolute path that must exist after the run. Completion then requires a HOST readback of that exact file — a nonempty summary or ledger update is never accepted as a restore." })),
          artifactScope: Type.Optional(Type.String({ description: "Optional absolute directory boundary for the readback. A deliverable outside it is not read, so the path cannot wander outside the declared restore scope. Symlinks are rejected." })),
          expectedArtifactSha256: Type.Optional(Type.String({ description: "Set ONLY when the byte-exact sha256 of the original artifact is known. A different hash means the file was reconstructed, so the task stays partial and says so instead of claiming an exact restore. Without it, a successful readback is existence/content verification only." })),
          audioDurationSec: Type.Optional(Type.Number({ description: "Set ONLY when this task will transcribe audio: the media duration in seconds. The duration-aware transcription policy is then attached to the task's contract (<=15 min may run locally; >15 min must be Groq chunks of <=15 min, never WhisperKit)." })),
          audioDurationUnknown: Type.Optional(Type.Boolean({ description: "Set when the task transcribes audio whose duration could not be probed: the contract then mandates an ffprobe first, instead of assuming a duration." })),
        }),
        async execute(toolCallId, params) {
          try {
            const timeoutMinutes = params.timeoutMinutes && Number.isFinite(params.timeoutMinutes)
              ? Math.max(1, Math.min(480, Math.round(params.timeoutMinutes)))
              : undefined;

            // Duration-aware transcription policy travels INSIDE the durable task
            // contract (bd pibot-0xpf.4): the constraint is embedded in
            // `instructions`, so it survives the background handoff and any session
            // reset, and a blocked route refuses the task instead of starting work
            // that would silently substitute a disallowed provider. The marker +
            // constraint are PREPENDED and budgeted so the cap cannot drop them.
            let instructions = params.instructions.slice(0, INSTRUCTIONS_MAX);
            let audioRoute: string | undefined;
            if (transcription && (params.audioDurationSec !== undefined || params.audioDurationUnknown)) {
              const plan = planTranscription({
                durationSec: params.audioDurationUnknown ? null : params.audioDurationSec ?? null,
                policy: transcription.policy,
                hostProviders: transcription.hostProviders,
                groqCredentialPresent: transcription.groqCredentialPresent,
              });
              if (plan.route === "blocked") {
                return text(`REFUSED: ${plan.blocker} Nothing started.`, { refused: true, route: plan.route });
              }
              instructions = withMandatoryHead(params.instructions, `${transcriptionPolicyMarker(plan.route)}\n${plan.constraint}`);
              audioRoute = formatTranscriptionPlan(plan);
            }
            // pi-durable stores strict JSON: omit the key entirely when unset
            const cap = timeoutMinutes !== undefined ? { timeoutMinutes } : {};
            const expected = {
              ...(params.expectedMedia ? { expectedMedia: params.expectedMedia.slice(0, 40) } : {}),
              // An explicit different destination / account / id namespace is persisted with the task so
              // the ledger's gate and the runner both check the SAME expected target (bd pibot-cida review).
              ...(params.expectedPeer ? { expectedPeer: params.expectedPeer.slice(0, 160) } : {}),
              ...(params.expectedAccount ? { expectedAccount: params.expectedAccount.slice(0, 80) } : {}),
              ...(params.expectedIdProtocol ? { expectedIdProtocol: params.expectedIdProtocol.slice(0, 40) } : {}),
              // A restore/repair deliverable the ledger must verify by host readback (bd pibot-0xpf.5)
              ...(params.expectedArtifactPath ? { expectedArtifactPath: params.expectedArtifactPath.slice(0, 1000) } : {}),
              ...(params.artifactScope ? { artifactScope: params.artifactScope.slice(0, 1000) } : {}),
              ...(params.expectedArtifactSha256 ? { expectedArtifactSha256: params.expectedArtifactSha256.slice(0, 64) } : {}),
            };
            const canon = {
              ...(params.lane === "dev" ? { lane: "dev" as const } : params.lane === "cross-agent" ? { lane: "cross-agent" as const } : {}),
              ...(params.acceptanceCriteria ? { acceptanceCriteria: params.acceptanceCriteria.slice(0, 500) } : {}),
              // The exact addition the artifact must contain, checked against a post-write readback
              // (bd pibot-cida): "Task done" plus "Not saved" must never record as done.
              ...(params.expectedContent ? { expectedContent: params.expectedContent.slice(0, 1000) } : {}),
              ...(params.outputLocation ? { outputLocation: params.outputLocation.slice(0, 500) } : {}),
              ...(params.inputLocations ? { inputLocations: params.inputLocations.slice(0, 1000) } : {}),
              ...(params.linearRef ? { linearRef: params.linearRef.slice(0, 120) } : {}),
            };
            if (preflight) {
              // start-burst cap (bd pibot-kdpg): bounds SIMULTANEOUS task starts;
              // the ledger's own MAX_ACTIVE_PER_AGENT (5) bounds running tasks.
              let acquired = false;
              try {
                const acq = await preflight.check({ lane: "delegate" }, true);
                if (!acq.ok) {
                  return text(`REFUSED by resource preflight: ${acq.issues.join("; ")}. Fix / wait, then retry — nothing started.`, { refused: true });
                }
                acquired = true;
                const t = await ledger.start({ agentId, chatKey, title: params.title.slice(0, 120), instructions, ...cap, ...expected, ...canon }, `${agentId}:${toolCallId}`);
                return text(`Started task ${t.id} "${t.title}". It runs in the background; the result will be posted to this chat. Check it with task_status.${audioRoute ? `\n${audioRoute}` : ""}`, { taskId: t.id, ...(audioRoute ? { transcription: audioRoute } : {}) });
              } catch (error) {
                if (!acquired) return text(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
                throw error; // finally releases the slot; the ledger error surfaces
              } finally {
                if (acquired) preflight.release("delegate");
              }
            }
            const t = await ledger.start({ agentId, chatKey, title: params.title.slice(0, 120), instructions, ...cap, ...expected, ...canon }, `${agentId}:${toolCallId}`);
            return text(`Started task ${t.id} "${t.title}". It runs in the background; the result will be posted to this chat. Check it with task_status.${audioRoute ? `\n${audioRoute}` : ""}`, { taskId: t.id, ...(audioRoute ? { transcription: audioRoute } : {}) });
          } catch (error) {
            return text(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });
      pi.registerTool({
        name: "task_status",
        label: "Task status",
        description: "Status and result of one background task by id.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, params) {
          const t = await ledger.get(params.id);
          if (!t || t.agentId !== agentId) return text(`No task ${params.id} for this agent.`);
          const body = t.status === "done" ? `\n\nResult:\n${t.result ?? ""}`
            : t.status === "partial" ? `\n\nResult (partial):\n${(t.result ?? "").slice(0, 1500)}${t.result && t.result.length > 1500 ? "\n… (truncated; full result in the ledger)" : ""}\n\nReason: ${t.error ?? t.blocker ?? ""}`
            : t.status === "failed" ? `\n\nError: ${t.error ?? ""}`
            : t.status === "blocked" ? `\n\nBlocker: ${t.blocker ?? ""}`
            : "";
          const receipt = t.delivery ? `\n\nDelivery: ${t.delivery.mediaType ?? "text"}${t.delivery.messageId !== undefined ? ` (message ${t.delivery.messageId})` : ""}` : "";
          const usableReceipt = t.usableReceipt
            ? `\n\nCorrelated delegate usable receipt (delegate-reported, unverified):\n${t.usableReceipt}`
            : "";
          // Legacy marker-only records are readable, but their rolling text can contain a
          // refusal after eviction. Keep it as context unless a protected receipt exists.
          const evidence = t.evidence
            ? `\n\n${t.evidenceUsable && !t.usableReceipt ? "Legacy correlated delegate context (usability of retained text unknown)" : "Correlated delegate context (not independently usable output)"}:\n${t.evidence}`
            : "";
          const artifact = t.artifact
            ? `\n\nArtifact: ${t.artifact.path} (${t.artifact.bytes} bytes, ${t.artifact.evidence}, ${t.artifact.verification}${t.artifact.reconstructed ? ", reconstructed — not byte-exact" : ""})`
            : "";
          const decision = t.decisions?.length
            ? `\n\nOwner decisions: ${t.decisions.map((d) => `${d.action} = "${d.choice}" [${d.outcome}] (source ${d.source} ${d.qid}, executor ${d.executor})`).join("; ")}`
            : "";
          const missing = missingInputs(t);
          const inputWarning = missing.length
            ? `\n\n⚠ Inputs missing from disk: ${missing.join(", ")} — reacquire or replace them before resuming; this record no longer presents them as available.`
            : "";
          return text(`${line(t)}; attempts ${t.attempts}${body}${receipt}${usableReceipt}${evidence}${artifact}${decision}${inputWarning}`, { status: t.status });
        },
      });
      pi.registerTool({
        name: "list_tasks",
        label: "List tasks",
        description: "List this chat's background tasks, newest first (running ones and recent results).",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "default 10" })),
          lane: Type.Optional(Type.String({ description: "'dev' or 'cross-agent' — filter this lane only" })),
        }),
        async execute(_id, params) {
          const all = (await ledger.list({ agentId, chatKey })).filter((t) => !params.lane || t.lane === params.lane);
          if (!all.length) return text("No background tasks yet.");
          return text(all.slice(0, Math.max(1, Math.min(30, params.limit ?? 10))).map(line).join("\n"));
        },
      });
      pi.registerTool({
        name: "task_update",
        label: "Update task record",
        description: "Update a task's canonical record: next action, artifact output location and/or private input paths. Use after a blocker lands or an artifact is placed so the record stays authoritative.",
        parameters: Type.Object({
          id: Type.String(),
          nextAction: Type.Optional(Type.String({ description: "What would unblock/advance this task next" })),
          outputLocation: Type.Optional(Type.String({ description: "Absolute paths of the artifacts produced/deliverable" })),
          inputLocations: Type.Optional(Type.String({ description: "Absolute paths of private inputs this task still needs (comma-separated), so cleanup can protect them" })),
        }),
        async execute(_id, params) {
          try {
            const t = await ledger.updateRecord(params.id, agentId, {
              ...(params.nextAction ? { nextAction: params.nextAction.slice(0, 300) } : {}),
              ...(params.outputLocation ? { outputLocation: params.outputLocation.slice(0, 500) } : {}),
              ...(params.inputLocations ? { inputLocations: params.inputLocations.slice(0, 1000) } : {}),
            });
            if (!t) return text(`No task ${params.id} for this agent.`);
            return text(`Task record updated: ${t.id}.`);
          } catch (error) {
            return text(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });
      pi.registerTool({
        name: "cancel_task",
        label: "Cancel task",
        description: "Cancel a queued or running background task by id.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, params) {
          const t = await ledger.get(params.id);
          if (!t || t.agentId !== agentId) return text(`No task ${params.id} for this agent.`);
          return text((await ledger.cancel(params.id)) ? `Cancelling task ${t.id} "${t.title}".` : `Task ${t.id} is already ${t.status}.`);
        },
      });
    },
  };
}
