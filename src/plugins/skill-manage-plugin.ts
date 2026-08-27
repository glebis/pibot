import * as fs from "node:fs";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";
import { validateSkillName } from "../core/evolution.js";

/**
 * Shared plugin: agents save their own workflows as skills mid-chat
 * (Hermes `skill_manage` idea, pibot-native). Writes into the agent's
 * own skills/ directory — picked up on the next session.
 */
export function skillManagePlugin(deps: { agentDir: string; agentId: string }): InlineExtension {
  const skillsDir = path.join(deps.agentDir, "skills");

  const skillPath = (name: string): string | null => {
    if (!validateSkillName(name)) return null;
    return path.join(skillsDir, name, "SKILL.md");
  };

  const frontmatter = (name: string, description: string): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n`;

  return {
    name: "skill-manage",
    factory: (pi) => {
      pi.registerTool({
        name: "skill_save",
        label: "Save skill",
        description:
          "Save a reusable workflow as a personal skill (SKILL.md). Use after completing something non-trivial you'd want to repeat: a multi-step process, a tricky fix, a ritual. Overwrites an existing skill with the same name.",
        parameters: Type.Object({
          name: Type.String({ description: "kebab-case skill name, e.g. 'weekly-review'" }),
          description: Type.String({ description: "One-line description with a trigger: 'Use when the user asks to …'" }),
          content: Type.String({ description: "Full markdown body: steps, references, gotchas. Max 15KB." }),
        }),
        async execute(_tcid, params) {
          const file = skillPath(params.name);
          if (!file) {
            return { content: [{ type: "text", text: "ERROR: invalid skill name (lowercase letters, digits, hyphens, 2–48 chars)." }], details: { name: "" } };
          }
          if (Buffer.byteLength(params.content, "utf8") > 15_000) {
            return { content: [{ type: "text", text: "ERROR: skill too large (max 15KB). Split it or compress." }], details: { name: "" } };
          }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, frontmatter(params.name, params.description) + params.content);
          return {
            content: [{ type: "text", text: `Skill saved: "${params.name}" — loads on your next session.` }],
            details: { name: params.name },
          };
        },
      });

      pi.registerTool({
        name: "skill_patch",
        label: "Patch skill",
        description: "Make a small, safe edit to one of your skills via exact find-and-replace. Preferred over full rewrites.",
        parameters: Type.Object({
          name: Type.String({ description: "Existing skill name" }),
          find: Type.String({ description: "Exact text to find" }),
          replace: Type.String({ description: "Replacement text (empty string deletes)" }),
        }),
        async execute(_tcid, params) {
          const file = skillPath(params.name);
          if (!file || !fs.existsSync(file)) {
            return { content: [{ type: "text", text: `No skill "${params.name}". Use skill_list.` }], details: { name: "" } };
          }
          const raw = fs.readFileSync(file, "utf8");
          if (!raw.includes(params.find)) {
            return { content: [{ type: "text", text: "ERROR: find-text not present in the skill — read it first with your read tool." }], details: { name: "" } };
          }
          fs.writeFileSync(file, raw.replace(params.find, params.replace));
          return { content: [{ type: "text", text: `Patched skill "${params.name}".` }], details: { name: params.name } };
        },
      });

      pi.registerTool({
        name: "skill_list",
        label: "List skills",
        description: "List your personal skills with their descriptions.",
        parameters: Type.Object({}),
        async execute() {
          if (!fs.existsSync(skillsDir)) {
            return { content: [{ type: "text", text: "No skills yet — save one with skill_save when you find a repeatable workflow." }], details: { count: 0 } };
          }
          const names = fs
            .readdirSync(skillsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .filter((e) => fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")));
          if (!names.length) {
            return { content: [{ type: "text", text: "No skills yet." }], details: { count: 0 } };
          }
          const lines = names.map((e) => {
            const raw = fs.readFileSync(path.join(skillsDir, e.name, "SKILL.md"), "utf8");
            const desc = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "(no description)";
            return `- ${e.name} — ${truncate(desc, 120)}`;
          });
          return { content: [{ type: "text", text: lines.join("\n") }], details: { count: names.length } };
        },
      });
    },
  };
}