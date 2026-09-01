import * as fs from "node:fs";
import * as path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncate } from "../core/util.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const READ_CHAR_LIMIT = 20_000;

export interface VaultPluginDeps {
  /** absolute path to the owner's Obsidian vault; the only accessible root */
  vaultDir: string;
  /** max bytes accepted by vault_read and vault_write */
  maxBytes?: number;
}

/**
 * Opt-in plugin: read/write files inside the owner's Obsidian vault.
 * The vault is otherwise read-only ground truth for agents; agents that are
 * granted the "vault-file" capability may also create notes there (e.g.
 * Sources/ saves, Daily note edits) — strictly scoped to the vault directory.
 */
export function vaultPlugin(deps: VaultPluginDeps): InlineExtension {
  const vaultDir = path.resolve(deps.vaultDir);
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  /**
   * Resolve a requested path against the vault and refuse anything that does
   * not stay strictly inside it — including `..` traversal, absolute paths
   * outside the vault, and symlink escapes (realpath of the nearest existing
   * ancestor catches symlinked directories; lstat catches symlinked leaves).
   * Returns the resolved absolute path, or null when refused.
   */
  const resolveInsideVault = (requested: string): string | null => {
    if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) return null;
    if (!fs.existsSync(vaultDir)) return null;
    const resolved = path.resolve(vaultDir, requested);
    const rel = path.relative(vaultDir, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const realVault = fs.realpathSync(vaultDir);
    const real = fs.realpathSync(probe);
    if (real !== realVault && !real.startsWith(realVault + path.sep)) return null;
    const leaf = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (leaf?.isSymbolicLink()) return null;
    return resolved;
  };

  const refuse = (reason: string) => ({ content: [{ type: "text" as const, text: `refused: ${reason}` }], details: { ok: false } });

  return {
    name: "vault-file",
    factory: (pi) => {
      pi.registerTool({
        name: "vault_read",
        label: "Read vault file",
        description:
          "Read a text file from the owner's Obsidian vault. Accepts vault-relative or absolute paths; the resolved path must stay inside the vault. Use for ground-truth personal context (notes, Sources/, Daily notes, templates).",
        parameters: Type.Object({
          path: Type.String({ description: "Path relative to the vault root (or absolute inside the vault), e.g. 'Sources/20260901-knowledge-graph-creator.md'" }),
        }),
        async execute(_tcid, params) {
          const target = resolveInsideVault(params.path);
          if (!target) return refuse("path must resolve to a file inside the vault");
          try {
            const stat = fs.statSync(target);
            if (!stat.isFile()) return refuse("not a file");
            if (stat.size > maxBytes) return refuse(`file is ${stat.size} bytes, vault_read caps at ${maxBytes}`);
            const raw = fs.readFileSync(target, "utf8");
            const text = raw.length > 20_000 ? `${truncate(raw, 20_000)}\n\n[truncated — read in sections via smaller files or ask the owner]` : raw;
            return { content: [{ type: "text", text }], details: { ok: true, path: path.relative(vaultDir, target) } };
          } catch (e) {
            return { content: [{ type: "text", text: `read failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });

      pi.registerTool({
        name: "vault_write",
        label: "Write vault file",
        description:
          "Create or overwrite a text file inside the owner's Obsidian vault (resolved path must stay inside the vault). Write only with owner intent or when following an established vault convention — match the existing note format exactly (e.g. Sources/YYYYMMDD-slug.md frontmatter, Daily/YYYYMMDD.md).",
        parameters: Type.Object({
          path: Type.String({ description: "Path relative to the vault root (or absolute inside the vault)" }),
          content: Type.String({ description: "Full file content to write (overwrites existing content)" }),
        }),
        async execute(_tcid, params) {
          const target = resolveInsideVault(params.path);
          if (!target) return refuse("path must resolve to a file inside the vault");
          const bytes = Buffer.byteLength(params.content, "utf8");
          if (bytes > maxBytes) return refuse(`content is ${bytes} bytes, vault_write caps at ${maxBytes}`);
          try {
            const leaf = fs.lstatSync(target, { throwIfNoEntry: false });
            if (leaf?.isDirectory()) return refuse("target is a directory");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, params.content, "utf8");
            return {
              content: [{ type: "text", text: `Wrote ${bytes} bytes to ${path.relative(vaultDir, target)}` }],
              details: { ok: true, path: path.relative(vaultDir, target), bytes },
            };
          } catch (e) {
            return { content: [{ type: "text", text: `write failed: ${String(e)}` }], details: { ok: false } };
          }
        },
      });
    },
  };
}