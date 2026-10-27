import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { childEnv } from "../core/child-env.js";
import { truncate } from "../core/util.js";
import { appendExecTrace, searchExecTrace, readExecArtifact, type ExecTraceInput } from "./exec-trace.js";

const execFileAsync = promisify(execFile);

export const EXEC_TIMEOUT_MS = 600_000;
export const EXEC_MAX_OUTPUT = 64_000;

/** One allowed flag for an entry that uses strict flag allowlisting. */
export interface ExecAllowFlag {
  /** exact flag as written, e.g. "--skip-download" or "-f". Short flags never take an attached value or get combined. */
  flag: string;
  /** flag consumes a value (either `--flag value` or, for long flags, `--flag=value`) */
  takesValue?: boolean;
  /** value must fully match this (REQUIRED for value-taking flags; a value-taking flag without it is refused) */
  valueRe?: RegExp;
}

/** Result of an entry-specific validator: refuse with an error, or run with (possibly rewritten) args. */
export type ExecValidateResult = { error: string } | { args: string[] };

/** One allowlist entry: a pinned binary plus optional argument constraints. */
export interface ExecAllowEntry {
  /** command name as the agent would write it (resolved via PATH at call time) */
  bin: string;
  /** if set: argv[1..] must START with exactly these literal args (after tilde expansion) */
  pin?: string[];
  /** arg patterns refused for this entry (defense in depth; prefer allowFlags) */
  denyArgRe?: RegExp[];
  /** if set: the first non-pin argument that looks like a file path must resolve under this dir */
  requireScriptUnder?: string;
  /** if set: remaining args after the pin must be EXACTLY ONE https URL starting with one of these prefixes */
  urlsUnder?: string[];
  /**
   * STRICT mode. If set, every arg after the pin must be an allowed flag, the value of a value-taking
   * allowed flag (validated by valueRe), or a positional matching allowPositionalRe. Anything else is refused.
   */
  allowFlags?: ExecAllowFlag[];
  /** positionals (non-dash args) must match this; with allowFlags set and this unset, NO positionals are allowed */
  allowPositionalRe?: RegExp;
  /** number of positionals required (default: min 0, max unlimited) */
  positionals?: { min?: number; max?: number };
  /** custom validator run on the args after the pin; may rewrite them (e.g. canonicalize a script path) */
  validate?: (rest: string[], deps: ExecPluginDeps) => ExecValidateResult;
}

const SAFE_VALUE = /^[A-Za-z0-9,._*-]+$/;
const YT_FORMAT = /^[A-Za-z0-9+,\/\[\]=!*^.:()_@-]+$/;
const YT_PRINT = /^[A-Za-z0-9_%().:|,\s-]+$/; // "|" allowed: plain separator data in --print templates ("A | B")
/** yt-dlp `-o [TYPES:]TEMPLATE` type prefixes (subtitle:, infojson:, pl_thumbnail:, …) — the template after them may be absolute. */
const YT_TYPE_PREFIX = /^[a-z_]+:/i;
/** Workspace dirs whose contents another tool trusts as code: osascript runs scripts/, the daemon loads extensions/. */
const YT_PROTECTED_DIRS = new Set(["scripts", "extensions", "skills"]);
/** Static shape gate for -o/--output values (full path policy is enforced per-agent in validateYtDlp). */
const YT_TEMPLATE_SHAPE = (v: string): boolean => v.length > 0 && !v.includes("\0") && !v.startsWith("-");

/** realpath the deepest existing ancestor of `p` and rejoin the (possibly nonexistent) tail — symlink-safe canonicalization. */
function canonicalize(p: string): string | null {
  let probe = path.resolve(p);
  let tail = "";
  for (;;) {
    try {
      return tail ? path.join(fs.realpathSync(probe), tail) : fs.realpathSync(probe);
    } catch {
      /* does not exist (yet) — climb to the nearest existing ancestor */
    }
    tail = path.join(path.basename(probe), tail);
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
}

/**
 * yt-dlp -o/--output: the resolved path must land under the agent's workspace or agent dir
 * (canonical, symlinks followed — the intended "download into my working dir" use). No type
 * prefixes (subtitle:, … — their template may be absolute), nothing into dirs trusted as code
 * (scripts/, extensions/, skills/).
 */
function ytOutputOk(v: string, deps: ExecPluginDeps): boolean {
  if (!YT_TEMPLATE_SHAPE(v)) return false;
  if (YT_TYPE_PREFIX.test(v)) return false;
  const resolved = canonicalize(path.resolve(deps.workspace, resolveTilde(v)));
  if (!resolved) return false;
  const roots = [deps.workspace, deps.agentDir].map((r) => {
    try {
      return fs.realpathSync(path.resolve(r));
    } catch {
      return path.resolve(r);
    }
  });
  const root = roots.find((r) => resolved === r || resolved.startsWith(r + path.sep));
  if (!root) return false;
  const first = path.relative(root, resolved).split(path.sep)[0] ?? "";
  return !YT_PROTECTED_DIRS.has(first.toLowerCase());
}

/** yt-dlp path policy for -o/--output (both "-o V" and "--output=V" forms). */
function validateYtDlp(rest: string[], deps: ExecPluginDeps): ExecValidateResult {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.startsWith("--output=") ? arg.indexOf("=") : -1;
    const value = eq > 0 ? arg.slice(eq + 1) : arg === "-o" || arg === "--output" ? rest[++i] : undefined;
    if (value === undefined) continue;
    if (!ytOutputOk(value, deps)) {
      return { error: "refused: yt-dlp -o/--output must write under the agent's workspace or agent dir (no type prefixes, not into scripts/extensions/skills) — this value is not allowed" };
    }
  }
  return { args: rest };
}
const GH_JQ = /^[A-Za-z0-9_.\[\]-]+$/;
const GH_ENDPOINT = /^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._\/-]*)?(\?[A-Za-z0-9=&_.-]*)?$/;
const GH_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Build a RegExp-like valueRe from a predicate (keeps ExecAllowFlag declarative). */
function predicateRe(fn: (v: string) => boolean): RegExp {
  return { test: (v: string) => fn(v) } as unknown as RegExp;
}

/**
 * osascript: argv[1] must be a script FILE under <agentDir>/scripts (realpath-resolved, must exist, regular file).
 * No flags are accepted before it, so -e (inline script), -i, -l (language switch, e.g. JavaScript) are all refused.
 * Args after the script path are passed to the script as its argv. The path is rewritten to the realpath so the
 * checked file is the one executed.
 * NOTE: this is only safe if the agent CANNOT write into <agentDir>/scripts with its own tools (write/edit/exec).
 * That is verified separately by the lead; scripts there can run arbitrary `do shell script`.
 */
function validateOsascript(rest: string[], deps: ExecPluginDeps): ExecValidateResult {
  if (rest.length === 0) return { error: "refused: osascript requires a script file under the agent's scripts/ dir as its first argument" };
  const first = rest[0];
  if (first.startsWith("-")) return { error: "refused: osascript flags (-e, -i, -l, ...) are not allowed — pass a script file from scripts/ first" };
  let scriptsDir: string;
  let real: string;
  try {
    scriptsDir = fs.realpathSync(path.join(path.resolve(deps.agentDir), "scripts"));
    real = fs.realpathSync(resolveTilde(first));
    if (!fs.statSync(real).isFile()) return { error: "refused: osascript script must be a regular file" };
  } catch {
    return { error: "refused: osascript script must exist under the agent's scripts/ dir" };
  }
  if (!real.startsWith(scriptsDir + path.sep)) return { error: `refused: osascript script must live under ${scriptsDir}` };
  return { args: [real, ...rest.slice(1)] };
}

/**
 * Vetted allowlist for the "exec" capability. Deliberately narrow:
 * - binaries are resolved at call time and the resolved path must match the entry (no PATH hijack)
 * - commands run via execFile argv — NO shell, so pipes/redirections/substitutions are inert
 * - python3 is pinned to the single youtube-transcript script (bare python3 = arbitrary code)
 * - osascript only runs script FILES under <agentDir>/scripts (see validateOsascript)
 * - yt-dlp, gh and curl use strict ALLOWLISTS of flags (denylists were bypassable: --downloader,
 *   --ffmpeg-location, --plugin-dirs, --config-locations, --cookies-from-browser, ...)
 *
 * yt-dlp allowed set (https URL positional(s) required): --skip-download, --write-subs, --write-auto-subs,
 *   --sub-langs/--sub-lang, --sub-format, --convert-subs (srt|vtt|ass|lrc), --list-subs, --dump-json/-j,
 *   --dump-single-json/-J, --print/-O (plain field/template), --no-playlist, --playlist-items, -f/--format,
 *   -x/--extract-audio, --audio-format, --no-warnings, -q/--quiet, --no-progress, -o/--output
 *   (paths under the agent's workspace or agent dir — see validateYtDlp).
 * gh: `gh api repos/<o>/<r>[/...]` with only --jq/-q, --paginate, -H "Accept: ..."; `gh repo view <o>/<r>` with
 *   only --json / --jq. No methods, fields, --input, --web.
 */
export const DEFAULT_EXEC_ALLOWLIST: ExecAllowEntry[] = [
  {
    bin: "yt-dlp",
    allowFlags: [
      { flag: "--skip-download" },
      { flag: "--write-subs" },
      { flag: "--write-auto-subs" },
      { flag: "--sub-langs", takesValue: true, valueRe: SAFE_VALUE },
      { flag: "--sub-lang", takesValue: true, valueRe: SAFE_VALUE },
      { flag: "--sub-format", takesValue: true, valueRe: SAFE_VALUE },
      { flag: "--convert-subs", takesValue: true, valueRe: /^(srt|vtt|ass|lrc)$/ },
      { flag: "--list-subs" },
      { flag: "--dump-json" },
      { flag: "-j" },
      { flag: "--dump-single-json" },
      { flag: "-J" },
      { flag: "--print", takesValue: true, valueRe: YT_PRINT },
      { flag: "-O", takesValue: true, valueRe: YT_PRINT },
      { flag: "--no-playlist" },
      { flag: "--playlist-items", takesValue: true, valueRe: /^[0-9,:-]+$/ },
      { flag: "-f", takesValue: true, valueRe: YT_FORMAT },
      { flag: "--format", takesValue: true, valueRe: YT_FORMAT },
      { flag: "-x" },
      { flag: "--extract-audio" },
      { flag: "--audio-format", takesValue: true, valueRe: /^(mp3|m4a|wav|opus|ogg|best)$/ },
      { flag: "--no-warnings" },
      { flag: "-q" },
      { flag: "--quiet" },
      { flag: "--no-progress" },
      { flag: "-o", takesValue: true, valueRe: predicateRe(YT_TEMPLATE_SHAPE) },
      { flag: "--output", takesValue: true, valueRe: predicateRe(YT_TEMPLATE_SHAPE) },
    ],
    allowPositionalRe: /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/\S*)?$/,
    positionals: { min: 1 },
    validate: (rest, deps) => validateYtDlp(rest, deps),
  },
  { bin: "whisperkit-cli" },
  { bin: "python3", pin: [path.join(os.homedir(), ".agents/skills/youtube-transcript/scripts/extract_transcript.py")] },
  { bin: "python3", pin: [path.join(os.homedir(), ".agents/skills/fathom/scripts/fetch.py")] },
  // Browserbase Fetch-API fallback (read-only browser-grade retrieval): pinned wrapper reads the
  // API key from Keychain itself (never argv/logs) and enforces free-tier caps locally
  // (1 concurrent, 40/day + 300/month counters, refuses if project usage can't be verified).
  { bin: "python3", pin: [path.join(os.homedir(), ".agents/skills/browserbase-fetch/scripts/bb_fetch.py")], allowPositionalRe: /^https:\/\//, positionals: { min: 1, max: 1 } },
  // Groq parts-transcription wrapper (free-tier pinned: key from 0600 file/Keychain at runtime,
  // 1 concurrent + 8 calls/day local caps, <=15-min owner rule, adaptive 22MB part sizing):
  { bin: "python3", pin: [path.join(os.homedir(), ".agents/skills/groq-parts/scripts/groq_parts.py")], allowPositionalRe: /^[^-]/, positionals: { min: 1, max: 1 } },
  // Groq key intake (native hidden dialog; stores to 0600 file / Keychain / sops-encrypted copy),
  // and a no-arg config-setter entry so the sops key path can be registered without shell:
  { bin: "python3", pin: [path.join(os.homedir(), ".agents/skills/groq-parts/scripts/groq_key_setup.py")] },
  // read-only GitHub fetches for link-saves (host-pinned curl; exactly one URL, so no extra flags like -o can ride along)
  { bin: "curl", pin: ["-sL", "--max-time", "15"], urlsUnder: ["https://api.github.com/", "https://github.com/", "https://raw.githubusercontent.com/"] },
  // arbitrary-https READ-ONLY GET (link-saves/fetches): pinned flags cap runtime, exactly one URL
  // positional so no -o/-K/-H/--data/--next can ride along and no body can be sent. GET only.
  { bin: "curl", pin: ["-sL", "--max-time", "20"], urlsUnder: ["https://"] },
  {
    bin: "gh",
    pin: ["repo", "view"],
    allowFlags: [
      { flag: "--json", takesValue: true, valueRe: /^[A-Za-z0-9,]+$/ },
      { flag: "--jq", takesValue: true, valueRe: GH_JQ },
    ],
    allowPositionalRe: GH_REPO,
    positionals: { min: 1, max: 1 },
  },
  {
    bin: "gh",
    pin: ["api"],
    allowFlags: [
      { flag: "--jq", takesValue: true, valueRe: GH_JQ },
      { flag: "-q", takesValue: true, valueRe: GH_JQ },
      { flag: "--paginate" },
      { flag: "-H", takesValue: true, valueRe: /^Accept: [A-Za-z0-9.+\/=-]+$/ },
      { flag: "--header", takesValue: true, valueRe: /^Accept: [A-Za-z0-9.+\/=-]+$/ },
    ],
    allowPositionalRe: predicateRe((v) => GH_ENDPOINT.test(v) && !v.includes("..")),
    positionals: { min: 1, max: 1 },
  },
  { bin: "afplay" },
  { bin: "osascript", validate: validateOsascript },
  // INTENTIONAL remote shell: ssh pinned to the fleet-configured mini aliases only. Remote commands are the
  // point; freedom inside the remote command is inherent to ssh and bounded only by the destination pin.
  { bin: "ssh", pin: ["pibot-mini"] },
  { bin: "ssh", pin: ["pibot-mini-alt"] },
];


/** Strict flag/positional check. Returns an error string or undefined. */
/** Strict flag/positional check (single pass: flag values are consumed, never counted as positionals). */
function checkAllowFlags(entry: ExecAllowEntry, rest: string[]): string | undefined {
  const flags = entry.allowFlags ?? [];
  let positionals = 0;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("-")) {
      const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      const def = flags.find((f) => f.flag === name);
      if (!def) return `refused: ${entry.bin} flag ${name} is not allowlisted`;
      if (!def.takesValue) {
        if (eq > 0) return `refused: ${entry.bin} flag ${name} takes no value`;
        continue;
      }
      let value: string;
      if (eq > 0) value = arg.slice(eq + 1);
      else if (i + 1 < rest.length) value = rest[++i];
      else return `refused: ${entry.bin} flag ${name} requires a value`;
      if (!def.valueRe || !def.valueRe.test(value)) return `refused: ${entry.bin} value for ${name} is not allowed`;
    } else {
      positionals++;
      if (!entry.allowPositionalRe || !entry.allowPositionalRe.test(arg)) return `refused: ${entry.bin} argument "${arg}" is not allowed`;
    }
  }
  const min = entry.positionals?.min ?? 0;
  const max = entry.positionals?.max ?? Infinity;
  if (positionals < min || positionals > max) return `refused: ${entry.bin} expects ${min === max ? min : `${min}-${max === Infinity ? "n" : max}`} positional argument(s)`;
  return undefined;
}

/** Pin-only entries (no allowFlags): every arg must be bare and positional-shaped — flag-like args are refused outright. */
function checkBarePositionals(entry: ExecAllowEntry, rest: string[]): string | undefined {
  let positionals = 0;
  for (const arg of rest) {
    if (arg.startsWith("-")) return `refused: ${entry.bin} flag-like argument "${arg}" is not allowed`;
    positionals++;
    if (!entry.allowPositionalRe || !entry.allowPositionalRe.test(arg)) return `refused: ${entry.bin} argument "${arg}" is not allowed`;
  }
  const min = entry.positionals?.min ?? 0;
  const max = entry.positionals?.max ?? Infinity;
  if (positionals < min || positionals > max) return `refused: ${entry.bin} expects ${min === max ? min : `${min}-${max === Infinity ? "n" : max}`} positional argument(s)`;
  return undefined;
}

export interface ExecPluginDeps {
  /** env var names (beyond the child-env base) passed to commands — manifest.envPassthrough */
  envPassthrough?: string[];
  /** cwd for executed commands (the agent's workspace) */
  workspace: string;
  /** the agent's own directory — osascript script files must live under it */
  agentDir: string;
  allowlist?: ExecAllowEntry[];
  timeoutMs?: number;
  maxOutput?: number;
}

interface Resolution {
  entry: ExecAllowEntry;
  argv: string[];
}

function resolveTilde(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Refuse args that read like shell syntax. execFile runs plain argv — metacharacters cannot
 * execute anything — but they usually mean the caller wrote a shell command line instead of an
 * argv, which silently does the wrong thing. Carve-out: a "|" sitting between spaces with a word
 * before it is plain template data in yt-dlp --print values ("%(title)s | %(channel)s") and is
 * allowed; pipes glued to words, pipes opening an element, and everything else (&&, ||, ;, `,$(
 * and any ">") are refused.
 */
function looksLikeShell(arg: string): boolean {
  if (/(^|\s)(&&|\|\||;|`|\$(?=\())/.test(arg)) return true;
  if (arg.includes(">")) return true;
  for (let i = 0; i < arg.length; i++) {
    if (arg[i] !== "|") continue;
    const prevSpace = i >= 2 && /\s/.test(arg[i - 1]) && !/\s/.test(arg[i - 2]);
    const nextSpace = i + 1 === arg.length || /\s/.test(arg[i + 1]);
    if (!(prevSpace && nextSpace)) return true;
  }
  return false;
}

export async function resolveExec(argv: string[], deps: ExecPluginDeps, allowlist: ExecAllowEntry[]): Promise<{ argv: string[]; cwd: string; error?: string }> {
  const cwd = path.resolve(deps.workspace);
  let constraintFailure: string | undefined;
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string" || argv[0].trim() === "") {
    return { argv: [], cwd, error: "argv must be a non-empty array with the command as the first element" };
  }
  if (argv.some((a) => typeof a !== "string")) return { argv: [], cwd, error: "all argv elements must be strings" };
  if (argv.some((a) => looksLikeShell(a))) {
    return { argv: [], cwd, error: "refused: shell metacharacters are not interpreted — commands run as plain argv" };
  }

  const requested = argv[0];
  let resolvedBin: string;
  try {
    resolvedBin = (await execFileAsync("/bin/sh", ["-c", `command -v -- ${JSON.stringify(requested)}`])).stdout.trim();
  } catch {
    return { argv: [], cwd, error: `command not found: ${requested}` };
  }
  if (!resolvedBin || !fs.existsSync(resolvedBin)) return { argv: [], cwd, error: `command not found: ${requested}` };

  // Resolve each distinct entry binary once per call (several entries share a bin;
  // one /bin/sh per entry made every call spawn ~15 shells).
  const resolvedEntries = new Map<string, string | null>();
  const resolveEntry = async (bin: string): Promise<string | null> => {
    if (!resolvedEntries.has(bin)) {
      try {
        resolvedEntries.set(bin, (await execFileAsync("/bin/sh", ["-c", `command -v -- ${JSON.stringify(bin)}`])).stdout.trim().split("\n")[0] || null);
      } catch {
        resolvedEntries.set(bin, null); // entry binary not installed on this host
      }
    }
    return resolvedEntries.get(bin)!;
  };

  for (const entry of allowlist) {
    // Cheap pre-filter: only entries whose bin name matches the request can resolve to the same file.
    if (path.basename(entry.bin) !== path.basename(requested) && path.basename(entry.bin) !== path.basename(resolvedBin)) continue;
    const entryResolved = await resolveEntry(entry.bin);
    if (!entryResolved || resolvedBin !== entryResolved) continue;

    const entryArgs = argv.slice(1);
    if (entry.denyArgRe && entryArgs.some((a) => entry.denyArgRe!.some((re) => re.test(a)))) {
      return { argv: [], cwd, error: `refused: ${entry.bin} invoked with a denied argument (command-execution flags are not allowed)` };
    }
    let rest = entryArgs;
    if (entry.pin && entry.pin.length > 0) {
      const pinned = entry.pin.map(resolveTilde);
      if (entryArgs.length < pinned.length || pinned.some((p, i) => resolveTilde(entryArgs[i]) !== p)) {
        constraintFailure = `refused: ${entry.bin} is pinned to ${pinned.join(" ")} — other invocations are not allowlisted`;
        continue;
      }
      rest = entryArgs.slice(pinned.length);
    }
    if (entry.requireScriptUnder && rest.length > 0) {
      const under = fs.realpathSync(path.resolve(entry.requireScriptUnder));
      const first = resolveTilde(rest[0]);
      const probe = fs.existsSync(first) ? fs.realpathSync(first) : path.resolve(first);
      if (probe !== under && !probe.startsWith(under + path.sep)) {
        constraintFailure = `refused: ${entry.bin} script must live under ${under}`;
        continue;
      }
    }
    if (entry.urlsUnder) {
      if (rest.length !== 1 || !entry.urlsUnder.some((u) => rest[0].startsWith(u))) {
        constraintFailure = `refused: ${entry.bin} allows exactly one https URL under ${entry.urlsUnder.join(" or ")}`;
        continue;
      }
    }
    if (entry.allowFlags) {
      const bad = checkAllowFlags(entry, rest);
      if (bad) {
        constraintFailure = bad;
        continue;
      }
    } else if (entry.allowPositionalRe || entry.positionals) {
      // pin-style entries without a flag allowlist still enforce positional shape/count
      const bad = checkBarePositionals(entry, rest);
      if (bad) {
        constraintFailure = bad;
        continue;
      }
    }
    let finalRest = rest;
    if (entry.validate) {
      const v = entry.validate(rest, deps);
      if ("error" in v) {
        constraintFailure = v.error;
        continue;
      }
      finalRest = v.args;
    }
    return { argv: [resolvedBin, ...entryArgs.slice(0, entryArgs.length - rest.length), ...finalRest], cwd };
  }
  return { argv: [], cwd, error: constraintFailure ?? `refused: "${requested}" is not on this agent's exec allowlist` };
}

export function execPlugin(deps: ExecPluginDeps): InlineExtension {
  const allowlist = deps.allowlist ?? DEFAULT_EXEC_ALLOWLIST;
  const timeoutMs = deps.timeoutMs ?? EXEC_TIMEOUT_MS;
  const maxOutput = deps.maxOutput ?? EXEC_MAX_OUTPUT;

  type ExecToolResult = { content: Array<{ type: "text"; text: string }>; details: { ok: boolean; exitCode: number | null; durationMs?: number } };
  const refuse = (reason: string): ExecToolResult => ({ content: [{ type: "text", text: `refused: ${reason}` }], details: { ok: false, exitCode: null } });

  return {
    name: "exec",
    factory: (pi) => {
      pi.registerTool({
        name: 'exec_audit_search', label: 'Search own execution audit',
        description: 'Find this agent’s recent execution metadata by exact task ID, call ID or YouTube URL (query parameters are never stored). Reads only the last 2 MiB, returns at most 20 entries. New calls only; not a search of old conversations.',
        parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }) }),
        async execute(_id, params) {
          try { return { content: [{ type: 'text', text: JSON.stringify(searchExecTrace(deps.agentDir, params.query)) }], details: { ok: true } }; }
          catch { return refuse('execution audit unavailable'); }
        },
      });
      pi.registerTool({
        name: 'exec_result_read', label: 'Read processing text artifact',
        description: 'Read UTF-8 text outputs only from your own runtime/artifacts directory. Supply a relative filename; no symlinks or traversal. Maximum 64 KiB, text formats only. Configure processing output there using an already allowlisted command; this tool does not authorize a previously refused command.',
        parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1000 }) }),
        async execute(_id, params) {
          try { return { content: [{ type: 'text', text: readExecArtifact(deps.agentDir, params.path) }], details: { ok: true } }; }
          catch { return refuse('artifact unavailable or outside the permitted text artifact boundary'); }
        },
      });
      pi.registerTool({
        name: "exec_run",
        label: "Run allowlisted command",
        description:
          "Run a command from this agent's vetted exec allowlist. Pass argv (array of strings, command first). NO shell: no pipes, redirections or substitutions — plain argv only. Binaries are resolved and matched against pinned entries; denied arguments (e.g. yt-dlp --exec, osascript -e) are refused. Long-running commands are capped by a timeout; output is truncated.",
        parameters: Type.Object({
          argv: Type.Array(Type.String({ description: "argument vector — command first, then arguments" }), { minItems: 1, maxItems: 64, description: "e.g. [\"yt-dlp\", \"--skip-download\", \"--list-subs\", URL]" }),
          taskId: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_:.-]{1,160}$', description: 'Task reference for audit lookup; metadata only, not authorization.' })),
        }),
        async execute(_tcid, params): Promise<ExecToolResult> {
          const started = Date.now();
          const trace = (outcome: ExecTraceInput['outcome'], reason?: string, exitCode?: number | null): boolean => {
            try { appendExecTrace(deps.agentDir, { callId: _tcid, taskId: params.taskId, argv: params.argv, outcome, reason, exitCode }); return true; }
            catch { return false; }
          };
          let resolved: Awaited<ReturnType<typeof resolveExec>>;
          try { resolved = await resolveExec(params.argv, deps, allowlist); }
          catch { trace('refused', 'resolution failed'); return refuse('command resolution failed'); }
          if (resolved.error) {
            const reason = resolved.error.includes('not found') ? 'command missing'
              : resolved.error.includes('shell metacharacters') ? 'shell syntax denied'
              : resolved.error.includes('denied argument') ? 'argument denied'
              : resolved.error.includes('not on this agent') ? 'not allowlisted' : 'constraint denied';
            const logged = trace('refused', reason);
            return refuse(resolved.error + (logged ? '' : ' (audit unavailable)'));
          }
          // Fail closed before executing when durable diagnostic metadata cannot be recorded.
          if (!trace('started')) return refuse('execution audit unavailable; command not started');
          try {
            const { stdout, stderr } = await execFileAsync(resolved.argv[0], resolved.argv.slice(1), {
              cwd: resolved.cwd,
              timeout: timeoutMs,
              // ssh entries authenticate via the owner's ssh-agent; no other command gets the agent socket
              env: childEnv({ passthrough: [...(deps.envPassthrough ?? []), ...(path.basename(resolved.argv[0]) === "ssh" ? ["SSH_AUTH_SOCK"] : [])] }),
              maxBuffer: 8 * 1024 * 1024,
            });
            const secs = Math.round((Date.now() - started) / 1000);
            const body = [
              `exit 0 · ${secs}s · cwd ${resolved.cwd}`,
              stdout.trim() ? `--- stdout ---\n${truncate(stdout, maxOutput)}` : "--- (no stdout) ---",
              stderr.trim() ? `--- stderr ---\n${truncate(stderr, maxOutput)}` : "",
            ].filter(Boolean).join("\n");
            const recorded = trace('succeeded', undefined, 0);
            return { content: [{ type: "text" as const, text: body + (recorded ? '' : '\nAudit completion missing; command succeeded — do not repeat.') }], details: { ok: true, exitCode: 0, durationMs: Date.now() - started } };
          } catch (e) {
            const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
            const secs = Math.round((Date.now() - started) / 1000);
            trace(err.killed ? 'timed-out' : 'failed', 'execution failed', typeof err.code === 'number' ? err.code : null);
            const text = [
              err.killed ? `timed out after ${secs}s` : `exit ${err.code ?? "?"} · ${secs}s`,
              err.stdout?.trim() ? `--- stdout ---\n${truncate(err.stdout, maxOutput)}` : "",
              err.stderr?.trim() ? `--- stderr ---\n${truncate(err.stderr, maxOutput)}` : "",
              !(err.stdout?.trim() || err.stderr?.trim()) ? String(err.message ?? e) : "",
            ].filter(Boolean).join("\n");
            return { content: [{ type: "text" as const, text }], details: { ok: false, exitCode: typeof err.code === "number" ? err.code : null } };
          }
        },
      });
    },
  };
}