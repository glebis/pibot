// ─── Goal execution-method discovery (bd pibot-0xpf.1) ──────────────────────
//
// On 2026-10-24 a `/goal` that named an execution method (`cmd acp`) burned its
// whole turn budget reporting an "undefined command" while the real work proceeded
// under a different interpretation. The command's absence was a claim, never an
// independent check — and "not found in the repo" was treated as "invented".
//
// This module separates the four facts that were conflated, and validates them
// BEFORE turns are spent:
//
//   identity    — what the method is (e.g. `cmd` = Command Code via ACP)
//   provenance  — where that is known from (a local skill or doc)
//   installation— whether a binary is actually resolvable on PATH
//   permission  — whether THIS agent is allowed to use it
//
// Identification is deliberately CONSERVATIVE (the review on 2026-10-26): a goal's
// prose is full of nouns that are not prerequisites. Only an execution method that
// is (a) a KNOWN command name or (b) written with explicit executable syntax is a
// candidate — so "use evidence", "with examples", a backticked entity name, or a
// forbidden method listed in `boundaries` never becomes a phantom blocker.
// A candidate is excused only when it resolves; an unrelated installed tool never
// excuses a required one.
//
// Discovery is injected as a `MethodProbe` so the classification stays pure and
// testable; `createLocalMethodProbe` is the read-only production implementation —
// it stats PATH and greps bounded local docs, and never installs or executes.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ExecutionMethod {
  /** the method as written, e.g. "cmd acp" */
  named: string;
  /** the binary to look up, e.g. "cmd" */
  command: string;
  /** trailing tokens treated as arguments, e.g. ["acp"] */
  args: string[];
  /** introduced by an explicit alternative ("or"/"either") to the previous method */
  alternative: boolean;
}

export type MethodBlockerReason =
  /** the command is neither on PATH nor known from any local doc/skill */
  | "unknown_method"
  /** a local doc/skill describes it but the binary is not present on PATH */
  | "not_on_path"
  /** the binary is present but this agent is not permitted to use it */
  | "not_permitted";

export interface GoalMethodBlocker {
  /** stable id so an identical blocker is never recorded or reported twice */
  id: string;
  method: ExecutionMethod;
  reason: MethodBlockerReason;
  /** one owner-facing sentence */
  detail: string;
  /** where the method is documented, when discovery found it */
  provenance?: string;
}

export interface MethodProbe {
  /** resolve a bare command name on PATH → absolute path, or null. May throw; treated as null. */
  which(command: string): string | null;
  /** local skills/docs that mention the candidate → paths, best first. May throw; treated as empty. */
  docs(candidate: string): string[];
  /** is this agent permitted to use the command? Absent = no permission model. Throws → not permitted. */
  permitted?(command: string): boolean;
}

export type MethodResolution =
  | { status: "none" }
  | { status: "resolved"; method: ExecutionMethod; resolvedPath: string; provenance?: string }
  | { status: "blocked"; method: ExecutionMethod; blocker: GoalMethodBlocker };

/** Structural view of a contract — avoids importing goals.ts and any runtime cycle. */
export interface MethodSource {
  outcome?: string;
  verification?: string;
  constraints?: string;
  /** NOT scanned: boundary text lists what must NOT be touched, i.e. forbidden methods */
  boundaries?: string;
  stopWhen?: string;
}

// ─── what actually counts as a method ───────────────────────────────────────

/**
 * Commands a goal is allowed to depend on. A curated allowlist — not a heuristic —
 * is what keeps ordinary prose ("use evidence", "with examples", a backticked noun)
 * from becoming a prerequisite. Grew from the tools this repo and its agents
 * actually invoke; a genuinely new command must be added here (or written as an
 * explicit path) before it can gate a goal.
 */
const KNOWN_COMMANDS = new Set(
  (
    "cmd herdr pytest python python3 pip pip3 uv poetry node npm npx pnpm yarn bun deno " +
    "tsx tsc vitest jest mocha eslint prettier biome stylelint rollup esbuild vite " +
    "git gh glab make cmake bazel ninja gradle mvn cargo rustc go ruby bundle gem rake " +
    "php composer java kotlinc swift xcodebuild docker docker-compose podman kubectl helm helmfile " +
    "terraform terragrunt ansible ansible-playbook aws gcloud az doctl flyctl heroku " +
    "curl wget httpie jq yq rg ag fd fzf tree bat sed awk gawk perl shellcheck shfmt " +
    "ffmpeg ffprobe imagemagick convert magick pandoc mdbook latex pdflatex xelatex tectonic " +
    "sphinx mkdocs hugo jekyll sqlite3 psql mysql mongosh redis-cli " +
    "ssh scp rsync tar gzip gunzip zip unzip brew apt apt-get yum dnf snap nix " +
    "openssl gpg sqlite swaks deno nvm corepack task just lowdown"
  ).split(/\s+/),
);

/** Explicit executable syntax — a deliberate path reference, not prose ("and/or" must not qualify). */
function isPathLike(token: string): boolean {
  return /^(?:\.\/|\.\.\/|\/)/.test(token) || /\/[^/\s]*\.[a-z0-9]+$/i.test(token);
}

const STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "its", "it", "my", "your", "our",
  "their", "his", "her", "one", "same", "new", "old", "local", "current", "existing",
  "above", "below", "following", "given", "only", "first", "next", "then", "them",
  "and", "or", "to", "for", "into", "from", "on", "in", "at", "by", "as", "of",
]);

const COMMAND_TOKEN = /^[a-z0-9][a-z0-9._+-]*$/i;
const TRIM_TAIL = /[.,;:!?"')\]]+$/;
/** One command (optionally a `./`/`../`/`/` path) plus at most one arg — "cmd acp" yes, "cmd acp and the rest" no. */
const METHOD_PHRASE = String.raw`((?:\.{0,2}\/)?[a-z0-9][\w.\/-]*(?:\s+[a-z0-9][\w.\/-]*)?)`;
const METHOD_VERB = new RegExp(`\\b(?:use|uses|using|used|via|through|run|runs|running|invoke|invokes|invoking|call|calls|calling|execute|executes|executing|launch|launches|launching|with)\\s+${METHOD_PHRASE}`, "gi");
const DOLLAR = new RegExp(`\\$\\s+${METHOD_PHRASE}`, "g");
const BACKTICK = /`([^`\n]{1,80})`/g;
/** "no cmd", "do not use cmd", "without cmd" — a forbidden method is not a prerequisite. */
const NEGATION = /(?:^|[^\p{L}])(?:no|not|never|don'?t|doesn'?t|avoid|without|instead\s+of|rather\s+than|except|excluding|не|без)\s*$/iu;

function clean(token: string): string {
  return token.trim().replace(TRIM_TAIL, "");
}

function toMethod(phrase: string): ExecutionMethod | null {
  const tokens = phrase.trim().split(/\s+/).map(clean).filter(Boolean);
  if (!tokens.length) return null;
  const command = tokens[0];
  const pathLike = isPathLike(command);
  if (!pathLike && (!COMMAND_TOKEN.test(command) || STOPWORDS.has(command.toLowerCase()))) return null;
  if (!pathLike && !KNOWN_COMMANDS.has(command.toLowerCase())) return null;
  const args = tokens.slice(1, 4).filter((t) => t && !STOPWORDS.has(t.toLowerCase()));
  // A path is a filesystem reference: its case is significant on case-sensitive
  // volumes, so it is preserved verbatim (the review caught a lowercased
  // "./Scripts/Build.sh" that could never resolve on Linux). Bare command names
  // are lowercased so they match the curated allowlist.
  const resolvedCommand = pathLike ? command : command.toLowerCase();
  return { named: [command, ...args].join(" "), command: resolvedCommand, args, alternative: false };
}

/**
 * Every execution method referenced by a goal — from explicit `$`/backtick syntax and
 * from "use/using/via/run/…" phrases, but ONLY when the token is a known command or an
 * explicit path. `boundaries` is never scanned: it names what must NOT be used.
 * A method introduced after "or"/"either" carries `alternative: true`; every other
 * method is required. Duplicates collapse to the first occurrence.
 */
export function extractExecutionMethods(objective: string, contract?: MethodSource): ExecutionMethod[] {
  const sources = [objective, contract?.outcome, contract?.verification, contract?.constraints].filter(
    (s): s is string => Boolean(s),
  );
  const out: ExecutionMethod[] = [];
  const seen = new Set<string>();
  for (const text of sources) {
    const hits: { start: number; end: number; method: ExecutionMethod }[] = [];
    const consider = (raw: string, index: number): void => {
      const before = text.slice(Math.max(0, index - 24), index);
      if (NEGATION.test(before)) return;
      const method = toMethod(raw);
      if (method) hits.push({ start: index, end: index + raw.length, method });
    };
    for (const m of text.matchAll(BACKTICK)) consider(m[1], m.index ?? 0);
    for (const m of text.matchAll(DOLLAR)) consider(m[1], m.index ?? 0);
    for (const m of text.matchAll(METHOD_VERB)) consider(m[1], m.index ?? 0);
    hits.sort((a, b) => a.start - b.start);
    let prevEnd = -1;
    for (const hit of hits) {
      const connective = prevEnd >= 0 ? text.slice(prevEnd, hit.start) : "";
      prevEnd = hit.end;
      const method = { ...hit.method, alternative: /\b(?:or|either)\b/i.test(connective) };
      if (seen.has(method.named)) continue;
      seen.add(method.named);
      out.push(method);
    }
  }
  return out;
}

/** Consecutive methods joined by an explicit alternative are one requirement; everything else is required. */
function groupsOf(methods: ExecutionMethod[]): ExecutionMethod[][] {
  const groups: ExecutionMethod[][] = [];
  for (const method of methods) {
    if (!method.alternative || !groups.length) groups.push([method]);
    else groups[groups.length - 1].push(method);
  }
  return groups;
}

function safeWhich(probe: MethodProbe, command: string): string | null {
  try {
    return probe.which(command) ?? null;
  } catch {
    return null;
  }
}

function safeDocs(probe: MethodProbe, candidate: string): string[] {
  try {
    return probe.docs(candidate) ?? [];
  } catch {
    return [];
  }
}

/** Absent permission model → allowed. A throwing check fails CLOSED (never grant access by accident). */
function safePermitted(probe: MethodProbe, command: string): boolean {
  if (!probe.permitted) return true;
  try {
    return probe.permitted(command) === true;
  } catch {
    return false;
  }
}

function makeBlocker(method: ExecutionMethod, resolvedPath: string | null, provenance: string | undefined): GoalMethodBlocker {
  if (resolvedPath) {
    return {
      id: `method:${method.command}:not_permitted`,
      method,
      reason: "not_permitted",
      detail: `${method.named} is installed (${resolvedPath}) but this agent is not permitted to use it`,
      ...(provenance ? { provenance } : {}),
    };
  }
  if (provenance) {
    return {
      id: `method:${method.command}:not_on_path`,
      method,
      reason: "not_on_path",
      detail: `${method.named} is documented (${provenance}) but not resolvable on PATH`,
      provenance,
    };
  }
  return {
    id: `method:${method.command}:unknown_method`,
    method,
    reason: "unknown_method",
    detail: `no local doc, skill or PATH binary resolves "${method.named}"`,
  };
}

export function methodBlockerSignature(blocker: GoalMethodBlocker): string {
  return blocker.id;
}

/**
 * Classify the goal's execution methods against discovery.
 *
 * Semantics — required-all, alternative-any: a goal is workable only when EVERY
 * requirement group resolves. "use A and B" needs both; "use A or B" is satisfied by
 * either. The FIRST unsatisfied group yields the single tracked blocker, so an
 * unrelated installed tool never excuses a missing one and "not found" is never
 * collapsed into "invented".
 */
export function validateGoalMethods(
  objective: string,
  contract: MethodSource | undefined,
  probe: MethodProbe,
): MethodResolution {
  const methods = extractExecutionMethods(objective, contract);
  if (!methods.length) return { status: "none" };

  let firstBlocked: { method: ExecutionMethod; blocker: GoalMethodBlocker } | undefined;
  let firstResolved: { method: ExecutionMethod; resolvedPath: string; provenance?: string } | undefined;

  for (const group of groupsOf(methods)) {
    let groupResolved: { method: ExecutionMethod; resolvedPath: string; provenance?: string } | undefined;
    let groupBlocker: { method: ExecutionMethod; blocker: GoalMethodBlocker } | undefined;
    for (const method of group) {
      const provenance = safeDocs(probe, method.named)[0];
      const resolvedPath = safeWhich(probe, method.command);
      if (resolvedPath && safePermitted(probe, method.command)) {
        groupResolved = { method, resolvedPath, ...(provenance ? { provenance } : {}) };
        break;
      }
      if (!groupBlocker) groupBlocker = { method, blocker: makeBlocker(method, resolvedPath, provenance) };
    }
    if (groupResolved) {
      if (!firstResolved) firstResolved = groupResolved;
    } else if (!firstBlocked) {
      firstBlocked = groupBlocker;
    }
  }

  if (firstBlocked) return { status: "blocked", method: firstBlocked.method, blocker: firstBlocked.blocker };
  return { status: "resolved", ...firstResolved! };
}

// ─── production probe: bounded, read-only PATH + doc discovery ───────────────

/** The filesystem seam the production probe uses — injectable so tests never touch the real disk. */
export interface MethodProbeFs {
  isFile(p: string): boolean;
  isDirectory(p: string): boolean;
  isExecutable(p: string): boolean;
  listDir(p: string): string[];
  readText(p: string): string | null;
}

function nodeFs(): MethodProbeFs {
  return {
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    isExecutable: (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    listDir: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    readText: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  };
}

export interface LocalMethodProbeOptions {
  /** directories to search for a binary; defaults to `process.env.PATH`. */
  pathDirs?: string[];
  /** roots scanned for a doc/skill mentioning the candidate; empty = no doc discovery. */
  docRoots?: string[];
  /** filesystem seam; defaults to node:fs (read-only operations only). */
  fs?: MethodProbeFs;
  /** this agent's permission check for a command; absent = no permission model. */
  permitted?(command: string): boolean;
  /** bounds on doc discovery so a scan can never walk the whole disk. */
  maxDocFiles?: number;
  maxDocBytes?: number;
  maxDocDepth?: number;
}

const DOC_EXT = /\.(?:md|mdx|txt|json|ya?ml)$/i;

/**
 * Read-only production probe. `which` stats the PATH directories (never spawns the
 * binary) and requires the executable bit; `docs` greps a bounded set of local files
 * for a mention. No install, no execution, no network.
 */
export function createLocalMethodProbe(opts: LocalMethodProbeOptions = {}): MethodProbe {
  const fsx = opts.fs ?? nodeFs();
  const injectedDirs = opts.pathDirs;
  const docRoots = opts.docRoots ?? [];
  const maxFiles = opts.maxDocFiles ?? 200;
  const maxBytes = opts.maxDocBytes ?? 64_000;
  const maxDepth = opts.maxDocDepth ?? 3;

  return {
    which(command: string): string | null {
      if (!command) return null;
      if (/[\\/]/.test(command)) return fsx.isExecutable(command) ? command : null;
      const dirs = injectedDirs ?? (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
      for (const dir of dirs) {
        const candidate = path.join(dir, command);
        if (fsx.isExecutable(candidate)) return candidate;
      }
      return null;
    },
    docs(candidate: string): string[] {
      const needle = candidate.toLowerCase();
      const hits: string[] = [];
      let budget = maxFiles;
      const walk = (dir: string, depth: number): void => {
        if (budget <= 0 || depth > maxDepth) return;
        for (const entry of fsx.listDir(dir)) {
          if (budget <= 0) return;
          const full = path.join(dir, entry);
          if (fsx.isDirectory(full)) {
            walk(full, depth + 1);
            continue;
          }
          if (!fsx.isFile(full) || !DOC_EXT.test(entry)) continue;
          budget--;
          const text = fsx.readText(full);
          if (text && text.length <= maxBytes && text.toLowerCase().includes(needle)) hits.push(full);
        }
      };
      for (const root of docRoots) walk(root, 0);
      return hits;
    },
    ...(opts.permitted ? { permitted: opts.permitted } : {}),
  };
}
