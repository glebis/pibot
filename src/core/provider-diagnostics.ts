/**
 * Provider failure diagnostics (bd pibot-hn90).
 *
 * An unattended executor must not turn a setup-routing problem into an authentication
 * verdict. This module keeps the evidence vocabulary shared by the two production paths
 * that can produce a Groq failure without a human present:
 *   - exec: an agent tries to launch the interactive key-intake helper
 *   - host STT: a transcription call fails
 *
 * Every diagnostic names the service, the executor, the credential SOURCE and the failure
 * category. It never carries credential values, response bodies or raw provider payloads.
 * Presence is not validity: `source=host-env` says only where a credential would come from.
 */

export type ProviderService = "groq-key-setup" | "groq-stt-host" | "groq-parts-exec";

/** Where a credential would come from. `unknown` means "not inspected"; `none` means "absent". */
export type CredentialSource = "host-env" | "skill-env-file" | "keychain" | "sops" | "unknown" | "none";

export type ProviderFailureCategory =
  /** An interactive intake/helper route was invoked without a human at the terminal. */
  | "setup-intake-interactive"
  /** A noninteractive probe mode was invoked through an unattended executor. */
  | "noninteractive-probe-refused"
  /** The executor's credential layer has no value at all. */
  | "credential-missing"
  /** A scoped 401 from the service: the only category that warrants rotation. */
  | "auth"
  /** Access refused (e.g. 403 / edge policy) — not an API auth verdict; a block claim needs independent evidence. */
  | "access-refused"
  /** 429 / budget exhaustion — wait, do not rotate. */
  | "quota"
  /** The request did not complete in time — not an auth verdict. */
  | "timeout"
  /** DNS/connectivity/5xx — not an auth verdict. */
  | "network"
  /** The wrapper could not receive required standard input. */
  | "stdin-unavailable"
  /** Local wrapper or executor refused to continue; no provider verdict. */
  | "refusal"
  /** Provider answered successfully but returned no transcript. */
  | "empty-output"
  | "unknown";

export type OwnerAction = "none" | "setup-manual" | "rotate-credential" | "inspect-source" | "wait" | "investigate";

export interface ProviderDiagnostic {
  service: ProviderService;
  /** Executor identity without secrets, e.g. `host-stt-daemon` or the agent directory name. */
  executor: string;
  source: CredentialSource;
  category: ProviderFailureCategory;
  at?: Date;
  durationMs?: number;
  /** Caller-supplied, non-secret context (status code, omitted-body note). Never a raw payload. */
  detail?: string;
}

function diagnosticDisposition(diagnostic: ProviderDiagnostic): { action: OwnerAction; rotation: string } {
  if (diagnostic.category === "auth" && diagnostic.source === "unknown") {
    return { action: "inspect-source", rotation: "source-unresolved" };
  }
  return { action: ownerActionFor(diagnostic.category), rotation: rotationWarranted(diagnostic.category) ? "warranted" : "not-warranted" };
}

/** Compact owner-facing fields. No free-form detail or raw provider payload is included. */
export function formatCompactProviderDiagnostic(diagnostic: ProviderDiagnostic): string {
  const { action, rotation } = diagnosticDisposition(diagnostic);
  return `service=${diagnostic.service} executor=${diagnostic.executor} source=${diagnostic.source} category=${diagnostic.category} action=${action} rotation=${rotation}`;
}

export function ownerActionFor(category: ProviderFailureCategory): OwnerAction {
  switch (category) {
    case "auth":
      return "rotate-credential";
    case "credential-missing":
      return "setup-manual";
    case "quota":
      return "wait";
    case "timeout":
    case "network":
    case "access-refused":
      return "investigate";
    default:
      return "none";
  }
}

/** Only a scoped 401 is evidence for credential rotation. */
export function rotationWarranted(category: ProviderFailureCategory): boolean {
  return category === "auth";
}

/**
 * Classify a key-setup helper invocation. The script's only noninteractive mode is `status`;
 * every other form (including no args) opens an interactive dialog and validates over the
 * network, so it is setup intake, never an auth result.
 */
export function classifyKeySetupInvocation(args: readonly string[]): ProviderFailureCategory {
  if (args.length === 1 && args[0] === "status") return "noninteractive-probe-refused";
  return "setup-intake-interactive";
}

export interface SttFailureInput {
  status?: number;
  errorText?: string;
  timedOut?: boolean;
  missingCredential?: boolean;
  emptyOutput?: boolean;
}

export function classifySttFailure(input: SttFailureInput): ProviderFailureCategory {
  if (input.missingCredential) return "credential-missing";
  if (input.emptyOutput) return "empty-output";
  const text = input.errorText ?? "";
  if (input.timedOut || /\b(timeout|timed out|abort(ed)?)\b/i.test(text)) return "timeout";
  if (input.status === 401) return "auth";
  if (input.status === 403) return "access-refused";
  if (input.status === 429) return "quota";
  if (input.status !== undefined && input.status >= 500) return "network";
  if (/\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket)\b/i.test(text)) return "network";
  return "unknown";
}

export interface GroqPartsFailureInput {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  killed?: boolean;
}

/** Classify only the pinned Groq parts wrapper's failed execution. Wrapper prose alone is
 * not proof of a bad credential: require an explicit HTTP 401 for an auth verdict. */
export function classifyGroqPartsFailure(input: GroqPartsFailureInput): ProviderFailureCategory {
  const output = `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
  if (input.killed || input.code === "ETIMEDOUT" || /\b(?:timed? out|timeout|TimeoutError)\b/i.test(output)) return "timeout";
  // The pinned wrapper emits these status-bearing lines without "HTTP". Match its
  // failure prefix and exact wording; arbitrary transcript text containing (401) is not evidence.
  const wrapperFailure = /(?:^|\n)\s*(?:blocked:\s*){1,2}(Groq says Invalid API Key \(401\)|Groq rate limit \(429\)|transcription call failed \(403\))/i.exec(output);
  if (/(?:^|\n)\s*(?:blocked:\s*){1,2}GROQ_API_KEY missing\b/i.test(output)) return "credential-missing";
  if (wrapperFailure?.[1]?.includes("(401)")) return "auth";
  if (wrapperFailure?.[1]?.includes("(429)")) return "quota";
  if (wrapperFailure?.[1]?.includes("(403)")) return "access-refused";
  if (/\b(?:HTTP(?:\s+Error)?\s*[:=]?\s*401|401\s+Unauthorized)\b/i.test(output)) return "auth";
  if (/\b(?:HTTP(?:\s+Error)?\s*[:=]?\s*429|429\s+Too\s+Many\s+Requests)\b/i.test(output)) return "quota";
  if (/\b(?:HTTP(?:\s+Error)?\s*[:=]?\s*403|403\s+Forbidden)\b/i.test(output)) return "access-refused";
  if (/\b(?:stdin|standard input|EOFError|input required|non.?interactive input)\b/i.test(output)) return "stdin-unavailable";
  if (/\b(?:refused|not allowed|local limit|daily limit|file too large|unsupported format)\b/i.test(output)) return "refusal";
  if (typeof input.code === "string" && /^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)$/.test(input.code)) return "network";
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|socket|DNS|URLError|HTTP(?:\s+Error)?\s*[:=]?\s*5\d\d)\b/i.test(output)) return "network";
  return "unknown";
}

export function formatProviderDiagnostic(diagnostic: ProviderDiagnostic): string {
  const at = (diagnostic.at ?? new Date()).toISOString();
  const { action, rotation } = diagnosticDisposition(diagnostic);
  const duration = diagnostic.durationMs !== undefined ? ` durationMs=${diagnostic.durationMs}` : "";
  const detail = diagnostic.detail ? ` — ${diagnostic.detail}` : "";
  return `[provider-diagnostic] at=${at} service=${diagnostic.service} executor=${diagnostic.executor} category=${diagnostic.category} source=${diagnostic.source} action=${action} rotation=${rotation}${duration}${detail}`;
}
