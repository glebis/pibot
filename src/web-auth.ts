import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJsonAtomic } from "./core/util.js";

export interface StoredCredential {
  id: string; // base64url
  publicKey: string; // base64 (raw)
  counter: number;
  transports?: string[];
  deviceType?: string;
  backedUp?: boolean;
}

interface WebAuthFile {
  credentials: StoredCredential[];
}

interface ChallengeEntry {
  challenge: string;
  expires: number;
  kind: "register" | "auth";
}

export class WebAuthStore {
  private file: string;
  private challenges = new Map<string, ChallengeEntry>();
  private sessions = new Map<string, number>(); // token -> expires
  private sessionSecret: string;
  private creds: StoredCredential[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private dataDir: string,
    private opts: { rpId: string; rpName: string },
  ) {
    this.file = path.join(dataDir, "web-auth.json");
    this.sessionSecret = this.loadOrCreateSecret();
    this.load();
    // purge expired every minute; challenges TTL 5m
    this.timer = setInterval(() => this.purge(), 60_000);
    // Don't keep process alive
    if (this.timer && typeof (this.timer as any).unref === "function") (this.timer as any).unref();
  }

  private loadOrCreateSecret(): string {
    const f = path.join(this.dataDir, "web-auth-secret");
    try {
      const s = fs.readFileSync(f, "utf8").trim();
      if (s.length >= 16) return s;
    } catch {}
    const s = crypto.randomBytes(32).toString("hex");
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, s + "\n", { mode: 0o600 });
    } catch {}
    return s;
  }

  private load() {
    const j = readJson<WebAuthFile>(this.file, { credentials: [] });
    this.creds = Array.isArray((j as any).credentials) ? (j as any).credentials : [];
    // load sessions from file if exists
    const sf = path.join(this.dataDir, "web-sessions.json");
    try {
      const sj = readJson<{ sessions: { token: string; expires: number }[] }>(sf, { sessions: [] });
      for (const s of sj.sessions ?? []) {
        if (s.expires > Date.now()) this.sessions.set(s.token, s.expires);
      }
    } catch {}
  }

  private save() {
    writeJsonAtomic(this.file, { credentials: this.creds });
  }

  private persistSessions() {
    const sf = path.join(this.dataDir, "web-sessions.json");
    const arr = [...this.sessions.entries()].map(([token, expires]) => ({ token, expires }));
    writeJsonAtomic(sf, { sessions: arr });
  }

  private purge() {
    const now = Date.now();
    for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
    let changed = false;
    for (const [k, v] of this.sessions) if (v < now) { this.sessions.delete(k); changed = true; }
    if (changed) this.persistSessions();
  }

  get credentials(): StoredCredential[] {
    return this.creds;
  }

  get rpId() { return this.opts.rpId; }
  get rpName() { return this.opts.rpName; }

  addCredential(c: StoredCredential) {
    this.creds.push(c);
    this.save();
  }

  updateCounter(id: string, counter: number) {
    const f = this.creds.find((c) => c.id === id);
    if (f) { f.counter = counter; this.save(); }
  }

  removeCredential(id: string): boolean {
    const before = this.creds.length;
    this.creds = this.creds.filter((c) => c.id !== id);
    if (this.creds.length !== before) { this.save(); return true; }
    return false;
  }

  hasCredentials(): boolean { return this.creds.length > 0; }

  // challenges: store challenge -> entry, return challenge string
  createChallenge(kind: "register" | "auth"): string {
    const chal = crypto.randomBytes(32).toString("base64url");
    // key by challenge itself; expectedChallenge function can also verify
    this.challenges.set(chal, { challenge: chal, expires: Date.now() + 5 * 60_1000, kind });
    return chal;
  }

  consumeChallenge(challenge: string, kind: "register" | "auth"): boolean {
    const e = this.challenges.get(challenge);
    if (!e || e.kind !== kind || e.expires < Date.now()) return false;
    this.challenges.delete(challenge);
    return true;
  }

  hasChallenge(challenge: string): boolean {
    const e = this.challenges.get(challenge);
    return !!e && e.expires > Date.now();
  }

  // session tokens
  createSession(): string {
    const token = crypto.randomBytes(32).toString("hex");
    const expires = Date.now() + 30 * 24 * 3600_1000;
    this.sessions.set(token, expires);
    this.persistSessions();
    return token;
  }

  validateSession(token: string): boolean {
    const e = this.sessions.get(token);
    if (!e) return false;
    if (e < Date.now()) { this.sessions.delete(token); this.persistSessions(); return false; }
    return true;
  }

  revokeSession(token: string) {
    this.sessions.delete(token);
    this.persistSessions();
  }

  // signed cookie helpers
  signSessionToken(token: string): string {
    const sig = crypto.createHmac("sha256", this.sessionSecret).update(token).digest("base64url");
    return `${token}.${sig}`;
  }

  verifySignedToken(signed: string): string | null {
    const idx = signed.lastIndexOf(".");
    if (idx < 0) return null;
    const token = signed.slice(0, idx);
    const sig = signed.slice(idx + 1);
    const expected = crypto.createHmac("sha256", this.sessionSecret).update(token).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (!this.validateSession(token)) return null;
    return token;
  }

  makeCookie(token: string): string {
    const signed = this.signSessionToken(token);
    // 30d
    return `pibot_session=${signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
  }

  clearCookie(): string {
    return `pibot_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  parseCookie(header: string | undefined): string | null {
    if (!header) return null;
    for (const part of header.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === "pibot_session") return rest.join("=");
    }
    return null;
  }

  // for tests
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

// helpers for base64url decode using Node
export function b64urlToB64(s: string): string {
  // Node Buffer handles base64url directly
  return Buffer.from(s, "base64url").toString("base64");
}
