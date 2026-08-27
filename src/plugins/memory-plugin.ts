import * as fs from "node:fs";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureDir, slug, truncate } from "../core/util.js";

/**
 * Shared plugin: persistent memory as plain files inside the agent's directory.
 * The agent can also read/write `memory/` directly with its file tools —
 * this plugin adds structured capture + recall on top.
 */
export function memoryPlugin(deps: { agentDir: string }): InlineExtension {
  const memoryDir = path.join(deps.agentDir, "memory");
  const notesDir = path.join(memoryDir, "notes");

  return {
    name: "memory",
    factory: (pi) => {
      pi.registerTool({
        name: "memory_save",
        label: "Save memory",
        description: "Persist a memory as a markdown note in your long-term memory directory. Use for facts, preferences, decisions, people, anything worth remembering across sessions.",
        parameters: Type.Object({
          title: Type.String({ description: "Short title, e.g. 'coffee preferences'" }),
          content: Type.String({ description: "The memory itself, in full sentences" }),
          tags: Type.Optional(Type.String({ description: "Comma-separated tags, e.g. 'preferences, food'" })),
        }),
        async execute(_tcid, params) {
          ensureDir(notesDir);
          const date = new Date().toISOString().slice(0, 10);
          const file = path.join(notesDir, `${date}-${slug(params.title)}.md`);
          if (fs.existsSync(file)) return { content: [{ type: "text", text: `A note titled "${params.title}" already exists for today — update it with your write tool instead.` }], details: { file } };
          const tags = (params.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
          const body = [
            "---",
            `title: ${params.title}`,
            tags.length ? `tags: [${tags.join(", ")}]` : null,
            `created: ${new Date().toISOString()}`,
            "---",
            "",
            params.content,
            "",
          ].filter((l) => l !== null).join("\n");
          fs.writeFileSync(file, body);
          return { content: [{ type: "text", text: `Saved to memory: ${path.basename(file)}` }], details: { file } };
        },
      });

      pi.registerTool({
        name: "memory_recall",
        label: "Recall memory",
        description: "Search your long-term memory notes. Returns the most relevant notes with excerpts.",
        parameters: Type.Object({
          query: Type.String({ description: "What to look for" }),
          limit: Type.Optional(Type.String({ description: "Max notes to return (default 5)" })),
        }),
        async execute(_tcid, params) {
          const results = recall(memoryDir, params.query, Number(params.limit) || 5);
          if (!results.length) {
            return { content: [{ type: "text", text: `No memories match "${params.query}".` }], details: {} };
          }
          const text = results.map((r) => `### ${r.title}\n${r.excerpt}\n(from ${r.file})`).join("\n\n");
          return { content: [{ type: "text", text }], details: {} };
        },
      });
    },
  };
}

interface RecallResult {
  file: string;
  title: string;
  excerpt: string;
}

function recall(memoryDir: string, query: string, limit: number): RecallResult[] {
  if (!fs.existsSync(memoryDir)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) files.push(p);
    }
  };
  walk(memoryDir);

  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const scored: Array<{ file: string; title: string; score: number; excerpt: string }> = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const lower = raw.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const hits = lower.split(t).length - 1;
      if (hits > 0) score += hits + (lower.includes(`title: ${t}`) ? 2 : 0);
    }
    if (score === 0) continue;
    scored.push({
      file: path.basename(file),
      title: (raw.match(/^title:\s*(.+)$/m)?.[1] ?? path.basename(file, ".md")).trim(),
      score,
      excerpt: excerptAround(raw, terms[0] ?? ""),
    });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ file, title, excerpt }) => ({ file, title, excerpt }));
}

function excerptAround(content: string, term: string): string {
  const idx = content.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return truncate(content.replace(/^---[\s\S]*?---\n*/, "").trim(), 300);
  const start = Math.max(0, idx - 150);
  return truncate(content.slice(start, start + 350).replace(/\s+/g, " ").trim(), 350);
}