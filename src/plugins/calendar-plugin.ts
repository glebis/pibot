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

async function gwsCreateEvent(summary: string, start: string, end: string): Promise<string> {
  const { stdout } = await run("gws", ["calendar", "+insert", "--summary", summary, "--start", start, "--end", end], { timeout: 20_000 });
  return stdout.trim() || "(event created)";
}

async function gwsDeleteEvent(id: string): Promise<string> {
  const { stdout } = await run("gws", ["events", "delete", "--params", JSON.stringify({ eventId: id })], { timeout: 20_000 });
  return stdout.trim() || "(event deleted)";
}

async function gwsMoveEvent(id: string, start: string, end: string): Promise<string> {
  const { stdout } = await run("gws", ["calendar", "events", "patch", "--params", JSON.stringify({ eventId: id }), "--json", JSON.stringify({ start: { dateTime: start }, end: { dateTime: end } })], { timeout: 20_000 });
  return stdout.trim() || "(event updated)";
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
      pi.registerTool({
        name: "calendar_create_event",
        label: "Create Event",
        description: "Create a new event on your Google Calendar via gws.",
        parameters: Type.Object({
          summary: Type.String({ description: "Title of the event" }),
          start: Type.String({ description: "Start time (ISO 8601)" }),
          end: Type.String({ description: "End time (ISO 8601)" }),
        }),
        async execute(_tcid, params) {
          const result = await gwsCreateEvent(params.summary, params.start, params.end);
          return { content: [{ type: "text", text: result }], details: {} };
        },
      });
      pi.registerTool({
        name: "calendar_delete_event",
        label: "Delete Event",
        description: "Delete an event from your Google Calendar via gws.",
        parameters: Type.Object({
          id: Type.String({ description: "Event ID" }),
        }),
        async execute(_tcid, params) {
          const result = await gwsDeleteEvent(params.id);
          return { content: [{ type: "text", text: result }], details: {} };
        },
      });
      pi.registerTool({
        name: "calendar_move_event",
        label: "Move/Update Event",
        description: "Update the start/end time of an event on your Google Calendar via gws.",
        parameters: Type.Object({
          id: Type.String({ description: "Event ID" }),
          start: Type.String({ description: "New start time (ISO 8601)" }),
          end: Type.String({ description: "New end time (ISO 8601)" }),
        }),
        async execute(_tcid, params) {
          const result = await gwsMoveEvent(params.id, params.start, params.end);
          return { content: [{ type: "text", text: result }], details: {} };
        },
      });
    },
  };
}