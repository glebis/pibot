import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

const run = promisify(execFile);

async function icalAgenda(): Promise<string> {
  const { stdout } = await run("icalBuddy", ["-nc", "-nrd", "-n", "-ec", "events", "eventsToday+3"], { timeout: 10_000 });
  const text = stdout.trim();
  if (!text || text.startsWith("No events")) return "(no local events)";
  return text;
}

async function gwsAgenda(): Promise<string> {
  const { stdout } = await run("gws", ["calendar", "+agenda", "--days", "3", "--format", "table"], { timeout: 20_000 });
  return stdout.trim() || "(no google events)";
}

function line(label: string, r: PromiseSettledResult<string>): string {
  return `## ${label}\n${r.status === "fulfilled" ? truncate(r.value, 2500) : `(unavailable: ${truncate(String(r.reason?.message ?? r.reason), 120)})`}`;
}

/**
 * Shared plugin: time context. Gives agents read-only sight of the user's
 * calendar (local macOS via icalBuddy + Google via gws) so they can reason
 * about the moment, deadlines, and promises before scheduling anything.
 */
export function calendarPlugin(): InlineExtension {
  return {
    name: "calendar",
    factory: (pi) => {
      pi.registerTool({
        name: "calendar_today",
        label: "Calendar",
        description:
          "See the user's calendar for today + the next 3 days (macOS local + Google). Use before scheduling with deadlines, and to understand what 'today' looks like. Output is plain text; unavailable sources are marked.",
        parameters: Type.Object({}),
        async execute() {
          const [local, gcal] = await Promise.allSettled([icalAgenda(), gwsAgenda()]);
          const text = [line("macOS Calendar (next 4 days)", local), line("Google Calendar (next 3 days)", gcal)].join("\n\n");
          return { content: [{ type: "text", text }], details: {} };
        },
      });
    },
  };
}