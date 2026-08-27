import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

const SHARED_FILE = path.join(os.homedir(), "Brains", "brain", "pibot", "SHARED-FINDINGS.md");

export interface KnowledgePluginDeps {
  /** defaults to ~/Brains/brain/pibot/SHARED-FINDINGS.md */
  sharedFile?: string;
  agentId?: string;
}

/**
 * Shared plugin: contribute facts to the COMMON knowledge layer.
 * Appends (attributed) to SHARED-FINDINGS.md in the vault's pibot/ dir;
 * the owner or assistant curates those into KNOWLEDGE.md (injected into
 * every agent's prompt). The rest of the vault is read-only for agents.
 */
export function knowledgePlugin(deps: { sharedFile?: string; agentId?: string } = {}): InlineExtension {
  const sharedFile = deps.sharedFile ?? SHARED_FILE;

  return {
    name: "knowledge",
    factory: (pi) => {
      pi.registerTool({
        name: "knowledge_share",
        label: "Share knowledge",
        description:
          "Contribute a durable fact about the owner (preferences, habits, people, decisions) to the COMMON knowledge layer shared by all agents. Use for cross-agent facts, not private notes (those go to memory_save). Appended with your attribution; curated later.",
        parameters: Type.Object({
          fact: Type.String({ description: "The fact, one or two sentences, self-contained" }),
        }),
        async execute(_tcid, params) {
          try {
            fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
            if (!fs.existsSync(sharedFile)) {
              fs.writeFileSync(sharedFile, "# Shared findings (agent-contributed)\n\n");
            }
            const line = `- ${new Date().toISOString().slice(0, 10)} [${deps.agentId ?? "agent"}] ${params.fact.replace(/\n+/g, " ").trim()}\n`;
            fs.appendFileSync(sharedFile, line);
            return {
              content: [{ type: "text", text: "Shared with all agents — will appear in their context." }],
              details: { ok: true },
            };
          } catch (e) {
            return { content: [{ type: "text", text: `share failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });

      pi.registerTool({
        name: "knowledge_read",
        label: "Common knowledge",
        description: "Read the full common knowledge file (the same content that is injected into your prompt, plus curated additions).",
        parameters: Type.Object({}),
        async execute() {
          try {
            const raw = fs.readFileSync(sharedFile, "utf8").trim() || "(empty)";
            const knowledge = fs.existsSync(path.join(path.dirname(sharedFile), "KNOWLEDGE.md"))
              ? fs.readFileSync(path.join(path.dirname(sharedFile), "KNOWLEDGE.md"), "utf8")
              : "";
            return {
              content: [{ type: "text", text: truncate(`# KNOWLEDGE.md\n${knowledge}\n\n# SHARED-FINDINGS.md\n${raw}`, 4000) }],
              details: {},
            };
          } catch (e) {
            return { content: [{ type: "text", text: `(no common knowledge yet)` }], details: {} };
          }
        },
      });
    },
  };
}