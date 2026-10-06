import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * Session auto-compaction for pibot agents, modelled on the `pi-auto-compact`
 * pi extension (percent threshold + `ctx.compact()`, Pi's own summarizer and
 * session format).
 *
 * Why pibot needs its own: Pi compacts above `contextWindow - reserveTokens`, and
 * pibot declares the ollama cloud models with a 1M window while the cascade's
 * fallback peers really accept ~163k. On 2026-10-05 that gap let one run reach
 * ~512k tokens before anything fired: every call failed with a context overflow
 * and the owner saw a silent turn instead of an answer.
 *
 * Two trigger points:
 *  - `input` while the agent is idle: project `tokens + the incoming message` and
 *    compact BEFORE the prompt is sent. Nothing is interrupted, so nothing has to
 *    be resumed. Prompts queued into a live run (`streamingBehavior` set) are left
 *    alone: `ctx.compact()` aborts the running turn, which would drop its work.
 *  - `turn_end` between tool batches of a live run: the only place a long run can
 *    be caught. This one does abort the run, so exactly one bounded resume is queued
 *    afterwards to finish what the compaction interrupted.
 *
 * It is deliberately not fail-closed: a hard compaction failure is logged and the
 * prompt proceeds. Swallowing the owner's message would reproduce the very silence
 * this exists to prevent, and the cascade already triages the context error that follows.
 */

export interface AutoCompactConfig {
  enabled: boolean;
  /** Percent of the active model's declared context window at which to compact. */
  threshold: number;
}

export const DEFAULT_AUTO_COMPACT: AutoCompactConfig = { enabled: true, threshold: 78 };

/**
 * Legal window: [30, 98]. Below 30 the summary would exceed what compaction can
 * actually drop and every prompt burns a round trip on "Nothing to compact";
 * at 99 there is no headroom left for compaction itself.
 */
export const MIN_THRESHOLD = 30;
export const MAX_THRESHOLD = 98;

export const AUTO_COMPACT_CONFIG_FILE = "auto-compact.json";

/** Errors that mean "the context is already as small as it gets" — not failures. */
const SOFT_COMPACT_ERRORS = ["Nothing to compact", "Already compacted"];

/** Prefix keeps the resume out of goal judging and dead-letter replay (see INTERNAL_PROMPT_PREFIXES). */
export const COMPACTION_RESUME_PREFIX = "[compaction-resume]";

const RESUME_TEXT =
  `${COMPACTION_RESUME_PREFIX} The context was compacted mid-run. Continue the unfinished work from the compaction ` +
  `summary — do not repeat completed steps, and do not mention compaction, models, or this instruction.`;

/**
 * Read `<dataDir>/auto-compact.json`, falling back to `fallback` (last known good)
 * when the file is missing or unreadable, so a torn write never silently disables
 * compaction. Values outside the legal window are clamped, not discarded.
 */
export function readAutoCompactConfig(dataDir: string, fallback: AutoCompactConfig = DEFAULT_AUTO_COMPACT): AutoCompactConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dataDir, AUTO_COMPACT_CONFIG_FILE), "utf8"));
  } catch {
    return fallback;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const source = raw as Partial<AutoCompactConfig>;
  const threshold =
    typeof source.threshold === "number" && Number.isFinite(source.threshold)
      ? Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.round(source.threshold)))
      : fallback.threshold;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled,
    threshold,
  };
}

export interface AutoCompactDeps {
  /** pibot data dir holding auto-compact.json (global, shared by all agents). */
  dataDir: string;
  /** per-agent event log sink */
  log: (summary: string) => void;
}

function isSoftCompactionError(error: Error): boolean {
  return SOFT_COMPACT_ERRORS.some((message) => error.message.includes(message));
}

/** Usage worth acting on, or undefined when tokens are unknown (e.g. right after a compaction). */
function validUsage(ctx: ExtensionContext): { tokens: number; contextWindow: number } | undefined {
  try {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return undefined;
    return { tokens: usage.tokens, contextWindow: usage.contextWindow };
  } catch {
    // A stale ctx (session replaced under us) is not worth breaking a turn over.
    return undefined;
  }
}

export function autoCompactPlugin(deps: AutoCompactDeps): InlineExtension {
  return {
    name: "auto-compact",
    factory: (pi: ExtensionAPI) => {
      /** Last known good config; re-read before every decision so edits apply without a restart. */
      let config = readAutoCompactConfig(deps.dataDir);
      /** A compaction we started is still settling: never start a second one. */
      let compacting = false;
      /** False once we compacted at this pressure level; re-armed only when usage falls back under the threshold. */
      let armed = true;
      /** A compaction interrupted a turn that still had work to do. */
      let resumePending = false;
      /** Bumped on session start/shutdown so callbacks from a replaced session are ignored. */
      let generation = 0;

      /**
       * `ctx.compact()` is fire-and-forget: completion is only observable through
       * its callbacks (Pi invokes exactly one). Resolves to the failure, or null.
       */
      const compactAndWait = (ctx: ExtensionContext, gen: number): Promise<Error | null> =>
        new Promise<Error | null>((resolve) => {
          try {
            ctx.compact({
              onComplete: () => {
                if (gen === generation) compacting = false;
                resolve(null);
              },
              onError: (error) => {
                if (gen === generation) compacting = false;
                resolve(error);
              },
            });
          } catch (error) {
            if (gen === generation) compacting = false;
            resolve(error instanceof Error ? error : new Error(String(error)));
          }
        });

      pi.on("session_start", () => {
        generation++;
        compacting = false;
        armed = true;
        resumePending = false;
        config = readAutoCompactConfig(deps.dataDir, config);
      });

      pi.on("session_shutdown", () => {
        generation++;
        compacting = false;
        resumePending = false;
      });

      // Idle preflight: compact before the prompt is sent. Nothing is interrupted here.
      pi.on("input", async (event, ctx) => {
        config = readAutoCompactConfig(deps.dataDir, config);
        if (!config.enabled) return { action: "continue" as const };
        // Queued into a live run (steer/followUp): ctx.compact() would abort that run and drop its work.
        if (event.streamingBehavior !== undefined) return { action: "continue" as const };
        const usage = validUsage(ctx);
        if (!usage) return { action: "continue" as const };

        const content =
          event.images && event.images.length > 0
            ? [{ type: "text" as const, text: event.text }, ...event.images]
            : event.text;
        const projected = usage.tokens + estimateTokens({ role: "user", content, timestamp: Date.now() });
        const limit = usage.contextWindow * (config.threshold / 100);
        if (projected < limit) return { action: "continue" as const };

        const gen = generation;
        const percent = ((projected / usage.contextWindow) * 100).toFixed(1);
        deps.log(
          `compaction: projected context ${percent}% (>= ${config.threshold}%) before send — compacting first`,
        );
        compacting = true;
        const error = await compactAndWait(ctx, gen);
        if (gen !== generation) return { action: "continue" as const };
        if (error) {
          // Never "handled": that would swallow the owner's message and leave the chat silent.
          deps.log(
            isSoftCompactionError(error)
              ? `compaction: skipped before send — ${error.message}`
              : `compaction: failed before send — ${error.message}; sending the prompt anyway`,
          );
        } else {
          // Disarm: a compaction that worked drops usage well under the threshold, so the next
          // turn_end re-arms on its own. Without this, a run that is still over the line would
          // compact again immediately and burn a round trip on "Nothing to compact".
          armed = false;
        }
        return { action: "continue" as const };
      });

      // Between tool batches: the only place a long-running turn can be caught before
      // it walks past every model's real limit. This aborts the run, hence the resume.
      pi.on("turn_end", (event, ctx) => {
        config = readAutoCompactConfig(deps.dataDir, config);
        if (!config.enabled || compacting) return;
        const usage = validUsage(ctx);
        if (!usage) return;
        const limit = usage.contextWindow * (config.threshold / 100);
        if (usage.tokens < limit) {
          armed = true; // pressure released — allow the next compaction
          return;
        }
        if (!armed) return; // already compacted at this pressure level

        const continues =
          event.toolResults.length > 0 && !event.toolResults.some((result) => (result as { terminate?: boolean }).terminate === true);
        if (!continues) return; // the run is ending: the next prompt's preflight covers it

        armed = false;
        compacting = true;
        resumePending = true;
        const gen = generation;
        const percent = ((usage.tokens / usage.contextWindow) * 100).toFixed(1);
        deps.log(
          `compaction: context ${percent}% (>= ${config.threshold}%) after ${event.toolResults.length} tool result(s) — compacting between tool batches`,
        );
        try {
          ctx.compact({
            onComplete: () => {
              if (gen !== generation) return;
              compacting = false;
              if (!resumePending) return;
              resumePending = false;
              // One follow-up only: the compaction aborted the run, so nothing else will finish it.
              try {
                if (ctx.isIdle()) {
                  pi.sendUserMessage(RESUME_TEXT);
                  deps.log("compaction: queued one resume for the interrupted turn");
                } else {
                  // Something else is already driving the agent (queued owner message, goal loop).
                  // Its turn continues the work, so a second prompt here would be a duplicate.
                  deps.log("compaction: skipped the resume — the agent is already busy again");
                }
              } catch (error) {
                deps.log(
                  `compaction: could not queue the resume — ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
            onError: (error) => {
              if (gen !== generation) return;
              compacting = false;
              resumePending = false;
              // Pi mutexes compaction: a concurrent attempt is not a reason to resume into it.
              deps.log(`compaction: failed between tool batches — ${error.message}`);
            },
          });
        } catch (error) {
          compacting = false;
          resumePending = false;
          deps.log(`compaction: could not start — ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },
  };
}
