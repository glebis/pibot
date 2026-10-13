/**
 * Minimal environment for child processes spawned on behalf of an agent
 * (SDK bash tool, delegate_cli, herdr).
 *
 * secrets.ts injects every decrypted secret into process.env so the HOST's
 * providers can read them. Children must NOT inherit that: a prompt-injected
 * agent with `bash` could simply run `env`. We therefore build the child env
 * from an ALLOWLIST. A denylist ("strip *_KEY, *_TOKEN…") fails open: any secret
 * with an unexpected name (DATABASE_URL, a bot token, a webhook URL) leaks, and
 * every new secret is leaked by default. An allowlist fails closed.
 *
 * Note: this does not restrict filesystem access (e.g. ~/.config/sops/age/keys.txt).
 */

/** Exact names of non-secret base variables that are passed through. */
export const CHILD_ENV_BASE = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM",
  "TMPDIR", "TZ", "COLORTERM", "NO_COLOR",
] as const;

/** Prefixes of non-secret base variables (locale, XDG dirs). */
export const CHILD_ENV_BASE_PREFIXES = ["LC_", "XDG_"] as const;

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Whether `name` is an acceptable env var name for envPassthrough. */
export function isValidEnvName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

export interface ChildEnvOptions {
  /** Extra variable names to copy from process.env (e.g. manifest.envPassthrough). Invalid names are ignored. */
  passthrough?: readonly string[];
  /** Explicit values set on top (not read from process.env). */
  extra?: Record<string, string>;
  /** Source env; defaults to process.env (injectable for tests). */
  source?: NodeJS.ProcessEnv;
}

export function childEnv(opts: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const src = opts.source ?? process.env;
  const out: NodeJS.ProcessEnv = {};
  const base = new Set<string>(CHILD_ENV_BASE);
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (base.has(k) || CHILD_ENV_BASE_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  for (const name of opts.passthrough ?? []) {
    if (!isValidEnvName(name)) continue;
    const v = src[name];
    if (v !== undefined) out[name] = v;
  }
  if (opts.extra) Object.assign(out, opts.extra);
  return out;
}
