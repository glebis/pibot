// Large-file delivery over the owner's tailnet (private, TLS, no third party).
//
// Telegram media caps at 20MB (pibot) / 50MB (Bot API); anything larger fails.
// Owner decision 2026-09-23: bigger attachments become signed, expiring links
// served by the dashboard through `tailscale serve` — reachable only from the
// owner's tailnet devices, dead after the TTL.
//
// The token is an HMAC over {file, expiry} with a per-install secret, so a link
// works without a dashboard login but cannot be forged, replayed for another
// file, or outlive its window.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const MEDIA_LINK_TTL_MS = 24 * 3600e3;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign one file link token: `<expiry>.<b64url(file-basename)>.<sig>`. */
export function signMediaToken(file: string, key: string, now: number, opts: { ttlMs?: number } = {}): string {
  const ttl = opts.ttlMs ?? MEDIA_LINK_TTL_MS;
  const base = b64url(Buffer.from(path.basename(file), "utf8"));
  const expiry = now + ttl;
  const payload = `${expiry}.${base}`;
  return `${payload}.${hmac(payload, key)}`;
}

/** Verify a token: correct signature, unexpired, returns the bound file basename. */
export function verifyMediaToken(token: string, key: string, now: number): string | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [expiryRaw, encoded, sig] = parts;
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry <= now || !encoded) return undefined;
  const expected = hmac(`${expiryRaw}.${encoded}`, key);
  if (sig !== expected) return undefined;
  try {
    const file = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return file || undefined;
  } catch {
    return undefined;
  }
}

/** Full link for one media file, bound to its basename. */
export function mediaLinkUrl(base: string, file: string, key: string, now: number, opts: { ttlMs?: number } = {}): string {
  const name = path.basename(file);
  const token = signMediaToken(name, key, now, opts);
  return `${base.replace(/\/+$/, "")}/media/${encodeURIComponent(name)}?t=${token}`;
}

/** Per-install signing secret: created once in dataDir, owner-only mode. */
export function getMediaLinkKey(dataDir: string): string {
  const file = path.join(dataDir, "media-link-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* not created yet */
  }
  const key = crypto.randomBytes(32).toString("base64");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort (some filesystems) */
  }
  return key;
}

/** Tailnet hostname (e.g. macbook-pro-4.tail1234.ts.net) from `tailscale status --json`.
 *  Best effort: undefined when the CLI is missing/offline — callers degrade to a
 *  plain "file kept locally" notice instead of a link. */
export async function tailscaleHostname(run?: (args: string[]) => Promise<string>): Promise<string | undefined> {
  const runStatus = run ?? defaultRun;
  try {
    const out = await runStatus(["status", "--json"]);
    const parsed = JSON.parse(out) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName?.replace(/\.$/, "").trim();
    return dns || undefined;
  } catch {
    return undefined;
  }
}

function defaultRun(args: string[]): Promise<string> {
  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  const candidates = () => (process.env.PIBOT_TAILSCALE_CLI ? [process.env.PIBOT_TAILSCALE_CLI] : ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  return new Promise<string>((resolve, reject) => {
    const tryAt = (i: number): void => {
      if (i >= candidates().length) return reject(new Error("tailscale CLI not found"));
      execFile(candidates()[i], args, { timeout: 5_000 }, (e, stdout) => {
        if (!e && stdout.trim()) return resolve(stdout);
        tryAt(i + 1);
      });
    };
    tryAt(0);
  });
}

/** Home of oversized agent artifacts: private media dir under dataDir. */
export function mediaDirFor(dataDir: string): string {
  return path.join(dataDir, "media");
}

/** One safe copy into the media dir (basename sanitized); returns stored name. */
export function stashForLink(dataDir: string, source: string): string {
  const dir = mediaDirFor(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.basename(source);
  let name = base;
  let i = 1;
  while (fs.existsSync(path.join(dir, name)) && !sameFile(path.join(dir, name), source)) {
    name = `${i++}-${base}`;
  }
  const dest = path.join(dir, name);
  if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* best effort */
  }
  return name;
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.statSync(a).ino === fs.statSync(b).ino && fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}

/** Configured or auto-detected https base for media links (no trailing slash). */
export async function mediaBase(dataDir: string): Promise<string | undefined> {
  const env = process.env.PIBOT_MEDIA_BASE?.trim();
  if (env) return env.replace(/\/+$/, "");
  const dns = await tailscaleHostname();
  return dns ? `https://${dns}` : undefined;
}