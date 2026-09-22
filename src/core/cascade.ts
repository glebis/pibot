// ─── Model cascade / triage ─────────────────────────────────────────────────
//
// Every agent gets an ordered chain of model specs:
//   1. agent manifest `model` (primary)
//   2. agent manifest `cascade` (ordered fallback list)   — new optional field
//   3. allowed entries from PIBOT_MODEL_CASCADE
//   4. authenticated models from providers explicitly allowed by the manifest
//
// When a turn fails with a model error, the error is classified
// (unavailable / auth / credits / rate-limit / transient / context / unknown),
// the failing model gets a circuit-breaker cooldown sized to that class
// (escalating ×4 per consecutive failure, capped), and the next model in the
// chain takes the turn inside the same session (history is preserved).
// `unavailable` failures (model removed upstream / incompatible with the
// account) MARK the model and delete it from every chain until a successful
// manual re-probe re-arms it. If the whole chain is down, the message goes to a
// dead-letter queue and is replayed to the agent automatically once a probe
// shows recovery.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";

/** A resolved pi model — structural alias to avoid depending on pi-ai directly */
type ResolvedModel = Parameters<ModelRuntime["complete"]>[0];
import { errorMessage, readJson, truncate, uid, writeJsonAtomic } from "./util.js";

// ─── error classification ───────────────────────────────────────────────────

export type ModelErrorClass = "unavailable" | "auth" | "credits" | "rate-limit" | "transient" | "context" | "unknown";

const RX = {
  // permanent unavailability: the model is gone upstream or can never work with
  // the current auth. These fail identically every retry, so they are MARKED and
  // removed from rotation instead of cooling down (checked first — most specific).
  unavailable: /\bno endpoints found\b|\bmodel is not supported\b|\bmodel_not_found\b|\bmodel (has been )?(removed|deprecated|discontinued)\b/i,
  // credit/billing exhaustion: the account (not one model) can't pay for requests.
  // checked before rate-limit/auth so provider-specific billing wording wins over
  // generic 429/401 status codes.
  credits: /\b402\b|payment required|credit balance|insufficient[ _-]?(credits?|balance|quota|funds)|out of credits?|credits?[^.\n]{0,24}exhausted|exceeded your current quota|spending limit|billing/i,
  auth: /\b(401|403)\b|invalid[ _-]?(api[ _-])?key|unauthor|forbidden|incorrect api key|no auth credentials|quota|exhausted|payment/i,
  rateLimit: /\b429\b|rate[ _-]?limit|too many requests|overloaded|capacity|resource_exhausted|tokens per (minute|day)/i,
  context: /\bcontext\b.{0,40}(window|length|overflow|too (big|long|large|many|much))|too many.{0,20}tokens|maximum .{0,20}(context|tokens)|prompt ?is ?too ?long|context_length_exceeded|request too large/i,
  transient: /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|timeout|timed? ?out|econn|enotfound|ehostunreach|enetunreach|etimedout|eai_again|fetch failed|network|socket|dns|connection (error|refused|reset|closed|terminated)|temporaril|temporar/i,
};

/** Classify a model/transport error message into a triage class. */
export function classifyModelError(message: string): ModelErrorClass {
  const m = message ?? "";
  // order matters: permanent-unavailability markers are the most specific and
  // win over everything; credit/billing markers beat bare status codes;
  // rate-limit mentions counting tokens; auth messages may mention quota; context is a model mismatch, not an outage
  if (RX.unavailable.test(m)) return "unavailable";
  if (RX.context.test(m)) return "context";
  if (RX.credits.test(m)) return "credits";
  if (RX.rateLimit.test(m)) return "rate-limit";
  if (RX.auth.test(m)) return "auth";
  if (RX.transient.test(m)) return "transient";
  return "unknown";
}

/** How long a failing model is skipped after an error of each class. */
export const COOLDOWN_MS: Record<ModelErrorClass, number> = {
  unavailable: 24 * 3600e3, // nominally long; the unavailable flag removes it from rotation outright
  auth: 4 * 3600e3, // bad keys rarely self-heal mid-session
  credits: 60 * 60e3, // exhaustion heals by top-up, not time — the recovery probe catches it early
  "rate-limit": 90e3,
  transient: 45e3,
  context: 30 * 60e3, // compaction usually recovers these; don't hammer meanwhile
  unknown: 10 * 60e3,
};

/** Consecutive-failure escalation: cooldown multiplier per streak step, capped. */
export const ESCALATION_FACTOR = 4;
export const ESCALATION_CAP_MS = 24 * 3600e3;

/** "provider/model" → "provider" ("" when the spec has no provider prefix). */
export function specProvider(spec: string): string {
  const slash = spec.indexOf("/");
  return slash > 0 ? spec.slice(0, slash).trim().toLowerCase() : "";
}

// ─── state ──────────────────────────────────────────────────────────────────

export interface CascadeEntry {
  model: string;
  /** model is skipped until this timestamp (0 = healthy) */
  openUntil: number;
  lastError?: string;
  lastErrorClass?: ModelErrorClass;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  failures: number;
  /** consecutive failures since the last success — drives cooldown escalation */
  streak?: number;
  /** permanently unavailable (model removed upstream / incompatible with auth) — removed from rotation */
  unavailable?: boolean;
  unavailableAt?: number;
  unavailableReason?: string;
}

export interface DeadLetter {
  id: string;
  agentId: string;
  transport: string;
  chatId: string;
  text: string;
  createdAt: number;
  attempts: string[];
  lastError?: string;
  /** A replay produced partial output before failing; automatic retries risk duplicate side effects. */
  automaticReplayBlocked?: boolean;
}

/** A credits failure proves the account (all models of one provider) can't pay. */
export interface ProviderCreditHold {
  until: number;
  lastError?: string;
  lastAt?: number;
}

export interface CascadeState {
  entries: Record<string, CascadeEntry>;
  deadLetters: DeadLetter[];
  /** provider → credit hold; set when a credits error shows the account itself is exhausted */
  providerCreditHolds?: Record<string, ProviderCreditHold>;
}

export interface ModelSpec {
  id: string;
  provider: string;
}

// ─── the cascade ────────────────────────────────────────────────────────────

export interface CascadeManifestLike {
  model?: string;
  cascade?: string[];
  providers?: string[];
}

export interface ModelCascadeDeps {
  modelRuntime: ModelRuntime;
  /** where the breaker state + dead letters persist (JSON) */
  statePath: string;
  /** optional global fallback list (from PIBOT_MODEL_CASCADE) */
  globalTail?: string[];
  log?: (msg: string) => void;
}

export class ModelCascade {
  private state: CascadeState = { entries: {}, deadLetters: [] };

  constructor(private deps: ModelCascadeDeps) {
    this.state = readJson<CascadeState>(deps.statePath, { entries: {}, deadLetters: [] });
    if (!this.state.entries) this.state.entries = {};
    if (!this.state.deadLetters) this.state.deadLetters = [];
    if (!this.state.providerCreditHolds) this.state.providerCreditHolds = {};
  }

  // ── chain building ────────────────────────────────────────────────────────

  /** Ordered, deduplicated chain of model specs for an agent. */
  chainFor(manifest: CascadeManifestLike): string[] {
    const specs: string[] = [];
    const configuredProviders = manifest.providers?.map((provider) => provider.trim()).filter(Boolean);
    const allowedProviders = new Set(configuredProviders ?? []);
    const providerAllowed = (spec: string) => {
      const slash = spec.indexOf("/");
      return slash > 0 && allowedProviders.has(spec.slice(0, slash));
    };
    const push = (s?: string | string[], enforcePolicy = false) => {
      for (const item of Array.isArray(s) ? s : s ? [s] : []) {
        const v = item.trim();
        if (!v || v === "same") continue;
        if (enforcePolicy && !providerAllowed(v)) continue;
        if (this.entry(v)?.unavailable) continue; // deleted from rotation
        if (!specs.includes(v)) specs.push(v);
      }
    };
    push(manifest.model, configuredProviders !== undefined);
    push(manifest.cascade, configuredProviders !== undefined);
    push(this.deps.globalTail ?? [], true);
    // Authenticated-provider discovery is opt-in through manifest.providers.
    try {
      for (const m of this.deps.modelRuntime.getModels()) {
        const spec = `${m.provider}/${m.id}`;
        if (specs.includes(spec)) continue;
        if (!allowedProviders.has(m.provider)) continue;
        if (!this.deps.modelRuntime.hasConfiguredAuth(m.provider)) continue;
        if (this.entry(spec)?.unavailable) continue; // deleted from rotation
        specs.push(spec);
      }
    } catch {
      /* catalog unavailable — work with what we have */
    }
    return specs.slice(0, 8); // bound the cascade walk
  }

  /** Resolve a spec to a pi Model. Undefined when the spec isn't in the catalog. */
  resolveModel(spec: string): ResolvedModel | undefined {
    if (!spec) return undefined;
    try {
      const r = resolveCliModel({ cliModel: spec, modelRuntime: this.deps.modelRuntime });
      return r.error ? undefined : r.model ?? undefined;
    } catch {
      return undefined;
    }
  }

  // ── circuit breaker ───────────────────────────────────────────────────────

  entry(spec: string): CascadeEntry | undefined {
    return this.state.entries[spec.trim().toLowerCase()];
  }

  isOpen(spec: string, now = Date.now()): boolean {
    const e = this.entry(spec);
    return Boolean(e && e.openUntil > now);
  }

  /** Record a model failure: classify, open the breaker for the cooldown, persist.
   *  Consecutive failures of the same model escalate the cooldown (×4 per step,
   *  capped) so a permanently sick entry fades out instead of re-poisoning the
   *  chain head every base-cooldown cycle. `unavailable` failures skip
   *  escalation — the model is removed from rotation outright. */
  noteFailure(spec: string, err: string, now = Date.now()): ModelErrorClass {
    const cls = classifyModelError(err);
    const key = spec.trim().toLowerCase();
    const prev = this.state.entries[key];
    const streak = (prev?.streak ?? 0) + 1;
    const base = COOLDOWN_MS[cls];
    const escalated = cls === "credits" || cls === "unavailable"
      ? base
      : Math.min(base * Math.pow(ESCALATION_FACTOR, streak - 1), ESCALATION_CAP_MS);
    this.state.entries[key] = {
      model: spec.trim(),
      openUntil: now + escalated,
      lastError: truncate(err, 300),
      lastErrorClass: cls,
      lastFailureAt: now,
      failures: (prev?.failures ?? 0) + 1,
      streak,
      lastSuccessAt: prev?.lastSuccessAt,
      ...(cls === "unavailable"
        ? { unavailable: true, unavailableAt: now, unavailableReason: truncate(err, 200) }
        : {}),
    };
    // credits exhaustion is per account: block every model of this provider,
    // not just the one that happened to answer the request
    if (cls === "credits") {
      const provider = specProvider(spec);
      if (provider) {
        this.state.providerCreditHolds![provider] = { until: now + COOLDOWN_MS[cls], lastError: truncate(err, 300), lastAt: now };
      }
    }
    this.persist();
    this.deps.log?.(`[cascade] ${spec} failed (${cls}, cooldown ${Math.round(COOLDOWN_MS[cls] / 1e3)}s): ${truncate(err, 140)}`);
    return cls;
  }

  /** Record a success: clear the breaker, mark liveness, re-arm a marked-unavailable model. */
  noteSuccess(spec: string, now = Date.now()): void {
    const key = spec.trim().toLowerCase();
    const e = this.state.entries[key] ?? { model: spec.trim(), openUntil: 0, failures: 0 };
    e.openUntil = 0;
    e.lastSuccessAt = now;
    e.streak = 0;
    delete e.unavailable;
    delete e.unavailableAt;
    delete e.unavailableReason;
    this.state.entries[key] = e;
    const provider = specProvider(spec);
    if (provider && this.state.providerCreditHolds?.[provider]) {
      delete this.state.providerCreditHolds[provider]; // a paid request went through — account works again
    }
    this.persist();
  }

  /** Active credit hold for a provider, if any. */
  providerHold(provider: string, now = Date.now()): ProviderCreditHold | undefined {
    const h = this.state.providerCreditHolds?.[provider];
    return h && h.until > now ? h : undefined;
  }

  /** Providers currently blocked for credit exhaustion (sorted). */
  creditBlockedProviders(now = Date.now()): string[] {
    return Object.entries(this.state.providerCreditHolds ?? {})
      .filter(([, h]) => h.until > now)
      .map(([p]) => p)
      .sort();
  }

  /**
   * Next model to try: first chain entry that isn't circuit-open, differs from
   * `failedSpec`, and resolves in the catalog. Returns undefined when the whole
   * chain is down — the caller then falls back to deterministic handling.
   */
  nextCandidate(chain: string[], failedSpec?: string, now = Date.now()): string | undefined {
    const failedKey = failedSpec?.trim().toLowerCase();
    for (const spec of chain) {
      const key = spec.trim().toLowerCase();
      if (key === failedKey) continue;
      if (this.entry(key)?.unavailable) continue; // removed from rotation
      if (this.isOpen(spec, now)) continue;
      // same account, same credits — a credits hold rules out the provider's siblings too
      const provider = specProvider(spec);
      if (provider && this.providerHold(provider, now)) continue;
      if (!this.resolveModel(spec)) continue;
      return spec;
    }
    return undefined;
  }

  /** First n healthy, resolvable specs in the chain — for recovery probes that
   *  must not stall on a single (possibly mis-probed) chain head. */
  firstHealthyCandidates(chain: string[], n: number, now = Date.now()): string[] {
    const out: string[] = [];
    for (const spec of chain) {
      if (this.entry(spec.trim().toLowerCase())?.unavailable) continue;
      if (this.isOpen(spec, now)) continue;
      const provider = specProvider(spec);
      if (provider && this.providerHold(provider, now)) continue;
      if (!this.resolveModel(spec)) continue;
      if (!out.includes(spec)) out.push(spec);
      if (out.length >= n) break;
    }
    return out;
  }

  /** Specs currently marked permanently unavailable (most recent first). */
  unavailableEntries(now = Date.now()): Array<CascadeEntry & { spec: string }> {
    return Object.values(this.state.entries)
      .filter((e) => e.unavailable)
      .sort((a, b) => (b.unavailableAt ?? 0) - (a.unavailableAt ?? 0))
      .map((e) => ({ ...e, spec: e.model }));
  }

  /** First healthy, resolvable spec in the chain — for fresh turns. */
  firstHealthy(chain: string[], now = Date.now()): string | undefined {
    return this.nextCandidate(chain, undefined, now);
  }

  // ── dead letters (deterministic fallback) ─────────────────────────────────

  queueDead(dl: Omit<DeadLetter, "id">): DeadLetter {
    const entry: DeadLetter = { ...dl, id: uid("dl", 6) };
    this.state.deadLetters.push(entry);
    // bound the queue — the oldest unsent messages are the least relevant
    if (this.state.deadLetters.length > 100) this.state.deadLetters = this.state.deadLetters.slice(-100);
    this.persist();
    return entry;
  }

  deadLetterCount(): number {
    return this.state.deadLetters.length;
  }

  deadLetters(): readonly DeadLetter[] {
    return this.state.deadLetters;
  }

  /** Pop the oldest dead letter (removed from the queue). */
  takeOneDead(): DeadLetter | undefined {
    const dl = this.state.deadLetters.shift();
    if (dl) this.persist();
    return dl;
  }

  /** Put a popped dead letter back at the front (delivery failed). */
  unshiftDead(dl: DeadLetter): void {
    this.state.deadLetters.unshift(dl);
    this.persist();
  }

  // ── recovery probing ──────────────────────────────────────────────────────

  /** Is a recovery probe worth a network call? (open breakers or queued messages) */
  needsRecoveryProbe(now = Date.now()): boolean {
    if (this.state.deadLetters.length > 0) return true;
    return Object.values(this.state.entries).some((e) => e.openUntil > now);
  }

  /** Manual override: close all open breakers immediately. Returns how many were open. */
  clearBreakers(now = Date.now()): number {
    let n = 0;
    for (const e of Object.values(this.state.entries)) {
      if (e.openUntil > now) {
        e.openUntil = 0;
        n++;
      }
    }
    let held = false;
    for (const p of Object.keys(this.state.providerCreditHolds ?? {})) {
      if (this.providerHold(p, now)) held = true;
      delete this.state.providerCreditHolds![p];
    }
    if (n || held) this.persist();
    return n;
  }

  /**
   * Probe the chain head (or every open model) with a tiny request.
   * Clears the breaker of every model that answers.
   */
  async probeAlive(specs: string[]): Promise<Array<{ spec: string; ok: boolean; error?: string }>> {
    const out: Array<{ spec: string; ok: boolean; error?: string }> = [];
    for (const spec of specs.slice(0, 6)) {
      const model = this.resolveModel(spec);
      if (!model) {
        out.push({ spec, ok: false, error: "not in catalog" });
        continue;
      }
      try {
        console.log(`[cascade] probe ${spec} → provider=${model.provider} baseUrl=${(model as unknown as { baseUrl?: string }).baseUrl ?? "(default)"}`);
        const msg = await this.deps.modelRuntime.complete(
          model,
          { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
          { maxTokens: 4 }
        );
        const ok = msg.stopReason !== "error" && msg.stopReason !== "aborted";
        out.push(ok ? { spec, ok } : { spec, ok: false, error: msg.errorMessage ?? `stopReason=${msg.stopReason}` });
        if (ok) this.noteSuccess(spec);
      } catch (e) {
        out.push({ spec, ok: false, error: errorMessage(e) });
      }
    }
    return out;
  }

  // ── status rendering ──────────────────────────────────────────────────────

  statusLines(chain: string[], now = Date.now()): string[] {
    const lines: string[] = [];
    for (const spec of chain) {
      const e = this.entry(spec);
      const hold = this.providerHold(specProvider(spec), now);
      if (!e && hold) {
        const mins = Math.ceil((hold.until - now) / 60e3);
        lines.push(`✕ ${spec} — out of credits (provider hold, retry in ~${mins}m)`);
      } else if (!e) {
        lines.push(`· ${spec} — untested`);
      } else if (hold && e.openUntil <= now) {
        const mins = Math.ceil((hold.until - now) / 60e3);
        lines.push(`✕ ${spec} — out of credits (provider hold, retry in ~${mins}m)`);
      } else if (e.openUntil > now) {
        const mins = Math.ceil((e.openUntil - now) / 60e3);
        lines.push(`✕ ${spec} — down (${e.lastErrorClass ?? "error"}) retry in ~${mins}m — ${truncate(e.lastError ?? "", 80)}`);
      } else if (e.lastSuccessAt) {
        lines.push(`✓ ${spec} — ok${e.failures ? ` (${e.failures} failures, last recovered)` : ""}`);
      } else if (e.failures) {
        lines.push(`· ${spec} — ${e.failures} failures (cooldown over, untested)`); 
      } else {
        lines.push(`· ${spec} — untested`);
      }
    }
    return lines;
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.deps.statePath, this.state);
    } catch (e) {
      this.deps.log?.(`[cascade] persist failed: ${errorMessage(e)}`);
    }
  }
}
