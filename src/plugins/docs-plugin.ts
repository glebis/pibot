import * as fs from "node:fs";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

const DEFAULT_MAX_BYTES = 512 * 1024;
const READ_CHAR_LIMIT = 24_000;
const LIST_ENTRY_LIMIT = 400;

export interface DocsPluginDeps {
  /** absolute path to the docs site source; the only accessible root */
  docsDir: string;
  /** max bytes accepted by docs_read */
  maxBytes?: number;
  /** Participant access: published content/docs and public only, never repository files. */
  publicOnly?: boolean;
}

/**
 * Opt-in plugin: read-only file access to a public docs site source tree
 * (e.g. the agency-docs course content). Unlike vault-file there is no
 * write tool — this tree is shared with course participants, so the agent
 * can read it to answer questions but never modify it.
 */
export function docsPlugin(deps: DocsPluginDeps): InlineExtension {
  const docsDir = path.resolve(deps.docsDir);
  const contentRoot = path.basename(docsDir) === "docs" && path.basename(path.dirname(docsDir)) === "content";
  const publicText = new Set([".md", ".mdx", ".txt", ".json", ".html", ".htm", ".csv", ".ics", ".xml", ".yaml", ".yml"]);
  const publishedPath = (relative: string, directory: boolean): boolean => {
    if (!deps.publicOnly) return true;
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.some((part) => part.startsWith("."))) return false;
    if (!contentRoot && relative !== "" && relative !== "content" &&
        relative !== "content/docs" && !relative.startsWith(`content${path.sep}docs${path.sep}`) &&
        relative !== "public" && !relative.startsWith(`public${path.sep}`)) return false;
    return directory || publicText.has(path.extname(relative).toLowerCase());
  };
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  /**
   * Resolve a requested path against the docs root and refuse anything that
   * does not stay strictly inside it — including `..` traversal, absolute
   * paths outside the root, and symlink escapes (same discipline as the
   * vault plugin: realpath of nearest existing ancestor + lstat leaf check).
   */
  const resolveInsideDocs = (requested: string): string | null => {
    if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) return null;
    if (requested === "." || requested === "./") return docsDir;
    if (!fs.existsSync(docsDir)) return null;
    const resolved = path.resolve(docsDir, requested);
    const rel = path.relative(docsDir, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    if (!publishedPath(rel, true)) return null;
    if (deps.publicOnly) {
      let ancestor = docsDir;
      for (const part of rel.split(path.sep)) {
        ancestor = path.join(ancestor, part);
        if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
      }
    }
    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const realRoot = fs.realpathSync(docsDir);
    const real = fs.realpathSync(probe);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    const leaf = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (leaf?.isSymbolicLink()) return null;
    return resolved;
  };

  const refuse = (reason: string) => ({ content: [{ type: "text" as const, text: `refused: ${reason}` }], details: { ok: false } });

  return {
    name: "docs-file",
    factory: (pi) => {
      pi.registerTool({
        name: "docs_read",
        label: "Read docs file",
        description:
          "Read a text file from the shared docs site source (course content: schedule, meetings, materials, library). Accepts docs-relative or absolute paths; the resolved path must stay inside the docs root. Read-only.",
        parameters: Type.Object({
          path: Type.String({ description: "Path relative to the docs root (or absolute inside it), e.g. 'content/docs/goal-driven-ai-01/meetings/01.mdx'" }),
        }),
        async execute(_tcid, params) {
          const target = resolveInsideDocs(params.path);
          if (!target) return refuse("path must resolve to a file inside the docs root");
          try {
            const stat = fs.statSync(target);
            if (!stat.isFile()) return refuse("not a file");
            if (!publishedPath(path.relative(docsDir, target), false)) return refuse("only published text content is accessible");
            if (stat.size > maxBytes) return refuse(`file is ${stat.size} bytes, docs_read caps at ${maxBytes}`);
            const raw = fs.readFileSync(target, "utf8");
            const text = raw.length > READ_CHAR_LIMIT ? `${truncate(raw, READ_CHAR_LIMIT)}\n\n[truncated — read in sections]` : raw;
            return { content: [{ type: "text", text }], details: { ok: true, path: path.relative(docsDir, target) } };
          } catch (e) {
            return { content: [{ type: "text", text: `read failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });

      pi.registerTool({
        name: "docs_list",
        label: "List docs directory",
        description:
          "List a directory in the shared docs site source (file and folder names only). Use to discover what course content exists before reading. Read-only.",
        parameters: Type.Object({
          path: Type.String({ description: "Directory path relative to the docs root (or absolute inside it); empty or '.' lists the root" }),
        }),
        async execute(_tcid, params) {
          const requested = params.path?.trim() || ".";
          const target = resolveInsideDocs(requested === "." ? "./" : requested);
          if (!target) return refuse("path must resolve to a directory inside the docs root");
          try {
            if (!fs.statSync(target).isDirectory()) return refuse("not a directory");
            const entries = fs.readdirSync(target, { withFileTypes: true }).filter((entry) => {
              if (!deps.publicOnly) return true;
              if (entry.isSymbolicLink()) return false;
              return publishedPath(path.relative(docsDir, path.join(target, entry.name)), entry.isDirectory());
            });
            const lines = entries.slice(0, LIST_ENTRY_LIMIT).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
            const suffix = entries.length > LIST_ENTRY_LIMIT ? `\n… (${entries.length - LIST_ENTRY_LIMIT} more)` : "";
            return { content: [{ type: "text", text: lines.join("\n") + suffix }], details: { ok: true, path: path.relative(docsDir, target), count: entries.length } };
          } catch (e) {
            return { content: [{ type: "text", text: `list failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });
    },
  };
}