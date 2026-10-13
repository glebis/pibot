import * as fs from "node:fs";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";
import { validateSkillName } from "../core/evolution.js";

const STAGED_NOTICE =
  "Staged for owner review — it becomes active only after the owner promotes it in the dashboard (Review changes).";

/**
 * Shared plugin: agents propose their own workflows as skills mid-chat
 * (Hermes `skill_manage` idea, pibot-native).
 *
 * SECURITY: nothing here ever writes a live skill. Live skills are loaded as
 * instructions by every future session, so a prompt-injected page must not be
 * able to plant one. Proposals go to `skills/.staging/<name>/SKILL.md` — the same
 * place evolution stages candidates — and the owner promotes them from the
 * dashboard review queue (EvolutionEngine.promote).
 */
export function skillManagePlugin(deps: { agentDir: string; agentId: string }): InlineExtension {
  const agentRoot = path.resolve(deps.agentDir);
  const skillsDir = path.join(agentRoot, "skills");

  /**
   * Resolve skills/<parts…> under the agent dir, refusing any symlinked component
   * (mirrors evolution's safeSkillPath; lexical traversal is impossible because
   * every part is a validated name or a fixed literal).
   */
  const safePath = (...parts: string[]): string | null => {
    let current = agentRoot;
    for (const part of ["skills", ...parts]) {
      if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\")) return null;
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
    }
    return current;
  };

  const stagedFile = (name: string): string | null => (validateSkillName(name) ? safePath(".staging", name, "SKILL.md") : null);
  const liveFile = (name: string): string | null => (validateSkillName(name) ? safePath(name, "SKILL.md") : null);

  const readIfFile = (file: string | null): string | undefined => {
    if (!file) return undefined;
    try {
      return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };

  // Single-line: a newline would let the description smuggle extra frontmatter keys.
  const frontmatter = (name: string, description: string): string =>
    `---\nname: ${name}\ndescription: ${description.replace(/\s*[\r\n]+\s*/g, " ").trim()}\n---\n\n`;

  const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: { name: "" } });

  return {
    name: "skill-manage",
    factory: (pi) => {
      pi.registerTool({
        name: "skill_save",
        label: "Propose skill",
        description:
          "Propose a reusable workflow as a personal skill (SKILL.md). Use after completing something non-trivial you'd want to repeat: a multi-step process, a tricky fix, a ritual. The skill is only STAGED for owner review — it does not become active until the owner promotes it in the dashboard (Review changes). Re-saving a staged name replaces the staged proposal. Never tell the user the skill is already active.",
        parameters: Type.Object({
          name: Type.String({ description: "kebab-case skill name, e.g. 'weekly-review'" }),
          description: Type.String({ description: "One-line description with a trigger: 'Use when the user asks to …'" }),
          content: Type.String({ description: "Full markdown body: steps, references, gotchas. Max 15KB." }),
        }),
        async execute(_tcid, params) {
          if (!validateSkillName(params.name)) {
            return err("ERROR: invalid skill name (lowercase letters, digits, hyphens, 2–48 chars).");
          }
          if (Buffer.byteLength(params.content, "utf8") > 15_000) {
            return err("ERROR: skill too large (max 15KB). Split it or compress.");
          }
          const file = stagedFile(params.name);
          if (!file) return err("ERROR: skills staging path is not safe (symlink) — refusing to write.");
          fs.mkdirSync(path.dirname(file), { recursive: true });
          // the sidecar belongs to a previous (evolution) candidate with different content
          const sidecar = safePath(".staging", params.name, ".backlog.json");
          if (sidecar) fs.rmSync(sidecar, { force: true });
          fs.writeFileSync(file, frontmatter(params.name, params.description) + params.content);
          return {
            content: [{ type: "text", text: `Skill "${params.name}" proposed. ${STAGED_NOTICE}` }],
            details: { name: params.name, staged: true },
          };
        },
      });

      pi.registerTool({
        name: "skill_patch",
        label: "Propose skill patch",
        description:
          "Propose a small edit to one of your skills via exact find-and-replace. Preferred over full rewrites. The live skill is never modified: the patched copy is STAGED for owner review (applied on top of the staged copy if one exists, else the live one) and becomes active only after the owner promotes it in the dashboard (Review changes).",
        parameters: Type.Object({
          name: Type.String({ description: "Existing skill name" }),
          find: Type.String({ description: "Exact text to find" }),
          replace: Type.String({ description: "Replacement text (empty string deletes)" }),
        }),
        async execute(_tcid, params) {
          if (!validateSkillName(params.name)) return err(`No skill "${params.name}". Use skill_list.`);
          const target = stagedFile(params.name);
          if (!target) return err("ERROR: skills staging path is not safe (symlink) — refusing to write.");
          const raw = readIfFile(target) ?? readIfFile(liveFile(params.name));
          if (raw === undefined) return err(`No skill "${params.name}". Use skill_list.`);
          if (!params.find || !raw.includes(params.find)) {
            return err("ERROR: find-text not present in the skill — read it first with your read tool.");
          }
          const patched = raw.replace(params.find, () => params.replace);
          if (Buffer.byteLength(patched, "utf8") > 16_000 && patched.length > raw.length) {
            return err("ERROR: patched skill would exceed the size budget (~15KB). Compress it.");
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, patched);
          return {
            content: [{ type: "text", text: `Patch to skill "${params.name}" proposed. ${STAGED_NOTICE}` }],
            details: { name: params.name, staged: true },
          };
        },
      });

      pi.registerTool({
        name: "skill_list",
        label: "List skills",
        description: "List your personal skills with their descriptions: live ones, plus proposals marked \"(staged, awaiting review)\".",
        parameters: Type.Object({}),
        async execute() {
          const describe = (raw: string) => truncate(raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "(no description)", 120);
          const lines: string[] = [];
          let count = 0;
          const dirs = (dir: string | null, skip: (n: string) => boolean): string[] => {
            if (!dir) return [];
            try {
              return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !skip(e.name)).map((e) => e.name);
            } catch {
              return [];
            }
          };
          for (const name of dirs(safePath(), (n) => n.startsWith("."))) {
            const raw = readIfFile(liveFile(name));
            if (raw === undefined) continue;
            lines.push(`- ${name} — ${describe(raw)}`);
            count++;
          }
          let staged = 0;
          for (const name of dirs(safePath(".staging"), (n) => !validateSkillName(n))) {
            const raw = readIfFile(stagedFile(name));
            if (raw === undefined) continue;
            lines.push(`- ${name} (staged, awaiting review) — ${describe(raw)}`);
            staged++;
          }
          if (!lines.length) {
            return { content: [{ type: "text", text: "No skills yet — propose one with skill_save when you find a repeatable workflow (it is staged for owner review)." }], details: { count: 0, staged: 0 } };
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details: { count, staged } };
        },
      });
    },
  };
}
