import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function gwsListEmails(query: string = "is:unread", limit: number = 5): Promise<string> {
  const { stdout } = await run(
    "gws",
    ["gmail", "users", "messages", "list", "--params", JSON.stringify({ userId: "me", q: query, maxResults: limit }), "--format", "table"],
    { timeout: 20_000 }
  );
  return stdout.trim() || "(no emails found)";
}

async function gwsReadEmail(id: string): Promise<string> {
  const { stdout } = await run("gws", ["gmail", "users", "messages", "get", "--params", JSON.stringify({ userId: "me", id, format: "full" })], { timeout: 20_000 });
  return stdout.trim() || "(could not read email)";
}

/**
 * Shared plugin: Gmail.
 * Allows agents to triage and read emails via gws CLI.
 */
export function gmailPlugin(): InlineExtension {
  return {
    name: "gmail",
    factory: (pi) => {
      pi.registerTool({
        name: "gmail_list",
        label: "List Emails",
        description: "List recent emails (default: unread).",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search query (default: is:unread)" })),
          limit: Type.Optional(Type.Number({ description: "Max number of emails to list" })),
        }),
        async execute(_tcid, params) {
          const result = await gwsListEmails(params.query ?? "is:unread", params.limit ?? 5);
          return { content: [{ type: "text", text: result }], details: {} };
        }
      });
      pi.registerTool({
        name: "gmail_read",
        label: "Read Email",
        description: "Read a specific email's content by ID.",
        parameters: Type.Object({
          id: Type.String({ description: "Email ID" }),
        }),
        async execute(_tcid, params) {
          const result = await gwsReadEmail(params.id);
          return { content: [{ type: "text", text: result }], details: {} };
        },
      });
    },
  };
}
