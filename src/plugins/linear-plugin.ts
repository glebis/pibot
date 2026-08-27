import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const LINEAR_CLI = `${process.env.HOME}/.agents/skills/linear/scripts/linear`;

async function linearList(query: string = ""): Promise<string> {
  const args = ["list", "--limit", "10"];
  if (query) args.push(query);
  const { stdout } = await run(LINEAR_CLI, args, { timeout: 30_000 });
  return stdout.trim() || "(no issues found)";
}

async function linearCreate(title: string, description: string): Promise<string> {
  const { stdout } = await run(LINEAR_CLI, ["create", title, "--team", "GLE", "--description", description], { timeout: 30_000 });
  return stdout.trim() || "(issue created)";
}

async function linearUpdate(id: string, status: string): Promise<string> {
  const { stdout } = await run(LINEAR_CLI, ["update", id, "--state", status], { timeout: 30_000 });
  return stdout.trim() || "(issue updated)";
}

/**
 * Shared plugin: Linear.
 * Allows agents to list, create, and update Linear issues via Linear CLI.
 */
export function linearPlugin(): InlineExtension {
  return {
    name: "linear",
    factory: (pi) => {
      pi.registerTool({
        name: "linear_list",
        label: "List Issues",
        description: "List Linear issues.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search query" })),
        }),
        async execute(_tcid, params) {
          const result = await linearList(params.query ?? "");
          return { content: [{ type: "text", text: result }], details: {} };
        },
      });
      pi.registerTool({
        name: "linear_create",
        label: "Create Issue",
        description: "Create a new Linear issue.",
        parameters: Type.Object({
          title: Type.String({ description: "Issue title" }),
          description: Type.String({ description: "Issue description" }),
        }),
        async execute(_tcid, params) {
          const result = await linearCreate(params.title, params.description);
          return { content: [{ type: "text", text: result }], details: {} };
        },
      });
      pi.registerTool({
        name: "linear_update",
        label: "Update Issue",
        description: "Update the status of a Linear issue.",
        parameters: Type.Object({
          id: Type.String({ description: "Issue ID (e.g. ENG-123)" }),
          status: Type.String({ description: "New status" }),
        }),
        async execute(_tcid, params) {
          const result = await linearUpdate(params.id, params.status);
          return { content: [{ type: "text", text: result }], details: {} };
        },
      });
    },
  };
}
