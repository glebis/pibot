// ─── Console redaction boundary ─────────────────────────────────────────────
//
// daemon.log IS stdout/stderr (see the launchd plist's StandardOutPath), and the
// daemon logs through console.* in 60+ places — including error objects from
// grammy/node-fetch whose stack text carries `https://api.telegram.org/bot<id>:
// <token>/sendMessage`. Scrubbing the console is therefore the single choke
// point that keeps every sink clean, including the ones nobody remembered.
//
// Install it before anything else in the entry point: a log line written before
// installation cannot be un-leaked.

import { format } from "node:util";
import { redactSecrets } from "./redact.js";

const LEVELS = ["log", "info", "warn", "error", "debug", "trace"] as const;
type Level = (typeof LEVELS)[number];

let installed = false;

/**
 * Wrap a console so every argument is rendered exactly as Node would (so stacks
 * and object output look unchanged) and then scrubbed. Rendering through
 * `util.format` is deliberate: it is what console.log uses internally, and it
 * means nested Error messages and object fields are covered, not just the
 * top-level string arguments.
 */
export function installLogRedaction(target: Console = console): void {
  if (installed) return;
  installed = true;
  const patched = target as unknown as Record<Level, (...args: unknown[]) => void>;
  for (const level of LEVELS) {
    const original = patched[level];
    if (typeof original !== "function") continue;
    const bound = original.bind(target);
    patched[level] = (...args: unknown[]) => {
      try {
        bound(redactSecrets(format(...(args as [unknown, ...unknown[]]))));
      } catch {
        // A log line must never be lost to the scrubber, and never crash a caller.
        try {
          bound(...(args as [unknown, ...unknown[]]));
        } catch {
          /* nothing sensible left to do */
        }
      }
    };
  }
}

/** Test seam: forget that installation happened. */
export function resetLogRedactionForTests(): void {
  installed = false;
}
