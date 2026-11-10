import { describe, expect, it } from "vitest";
import {
  classifyGroqPartsFailure,
  classifyKeySetupInvocation,
  classifySttFailure,
  formatCompactProviderDiagnostic,
  formatProviderDiagnostic,
  ownerActionFor,
  rotationWarranted,
} from "./provider-diagnostics.js";

describe("provider diagnostics", () => {
  it("classifies interactive key setup separately from an auth verdict", () => {
    for (const args of [[], ["sops"], ["keychain"], ["bogus"]]) {
      expect(classifyKeySetupInvocation(args)).toBe("setup-intake-interactive");
      expect(rotationWarranted(classifyKeySetupInvocation(args))).toBe(false);
    }
    expect(classifyKeySetupInvocation(["status"])).toBe("noninteractive-probe-refused");
    expect(rotationWarranted("noninteractive-probe-refused")).toBe(false);
  });

  it("only a scoped 401 warrants credential rotation", () => {
    expect(classifySttFailure({ status: 401 })).toBe("auth");
    expect(rotationWarranted("auth")).toBe(true);
    expect(classifySttFailure({ status: 403 })).toBe("access-refused");
    expect(rotationWarranted("access-refused")).toBe(false);
    for (const input of [
      { status: 403 },
      { status: 429 },
      { status: 503 },
      { timedOut: true },
      { errorText: "fetch failed: ECONNREFUSED" },
      { missingCredential: true },
      { emptyOutput: true },
    ]) {
      const category = classifySttFailure(input);
      expect(rotationWarranted(category)).toBe(false);
      expect(ownerActionFor(category)).not.toBe("rotate-credential");
    }
  });

  it("formats service/executor/source metadata without secret values or raw payloads", () => {
    const line = formatProviderDiagnostic({
      service: "groq-stt-host",
      executor: "host-stt-daemon",
      source: "host-env",
      category: "auth",
      at: new Date("2026-11-04T10:00:00.000Z"),
      detail: "HTTP 401; response body omitted",
    });
    expect(line).toContain("at=2026-11-04T10:00:00.000Z");
    expect(line).toContain("service=groq-stt-host");
    expect(line).toContain("executor=host-stt-daemon");
    expect(line).toContain("source=host-env");
    expect(line).toContain("category=auth");
    expect(line).toContain("rotation=warranted");
    expect(line).not.toMatch(/Bearer|secret|sk-[A-Za-z0-9]/i);
  });

  it("marks a credential-presence gap as owner setup, never as rotation", () => {
    expect(ownerActionFor("credential-missing")).toBe("setup-manual");
    expect(rotationWarranted("credential-missing")).toBe(false);
  });

  it("classifies Groq parts wrapper evidence without treating old invalid-key prose as a status", () => {
    expect(classifyGroqPartsFailure({ stderr: "HTTP Error 401: Unauthorized. Get a fresh key" })).toBe("auth");
    expect(classifyGroqPartsFailure({ stdout: "blocked: blocked: Groq says Invalid API Key (401) — get a fresh key" })).toBe("auth");
    expect(classifyGroqPartsFailure({ stdout: "blocked: Groq rate limit (429) — wait" })).toBe("quota");
    expect(classifyGroqPartsFailure({ stdout: "blocked: transcription call failed (403)" })).toBe("access-refused");
    expect(classifyGroqPartsFailure({ stdout: "transcript: speaker said Groq says Invalid API Key (401)" })).toBe("unknown");
    expect(classifyGroqPartsFailure({ stderr: "HTTP 429 Too Many Requests" })).toBe("quota");
    expect(classifyGroqPartsFailure({ stderr: "HTTP 403 Forbidden" })).toBe("access-refused");
    expect(classifyGroqPartsFailure({ stderr: "TimeoutError: request took too long" })).toBe("timeout");
    expect(classifyGroqPartsFailure({ stderr: "URLError: failed to connect" })).toBe("network");
    expect(classifyGroqPartsFailure({ stderr: "EOFError: input required" })).toBe("stdin-unavailable");
    expect(classifyGroqPartsFailure({ stderr: "refused: local limit reached" })).toBe("refusal");
    expect(classifyGroqPartsFailure({ stderr: "Invalid API key; get a fresh key" })).toBe("unknown");
  });

  it("keeps an unknown-source 401 scoped until its credential source is inspected", () => {
    const diagnostic = { service: "groq-parts-exec" as const, executor: "worker", source: "unknown" as const, category: "auth" as const };
    const compact = formatCompactProviderDiagnostic(diagnostic);
    expect(compact).toContain("action=inspect-source rotation=source-unresolved");
    expect(formatProviderDiagnostic(diagnostic)).toContain("action=inspect-source rotation=source-unresolved");
    expect(formatCompactProviderDiagnostic({ ...diagnostic, service: "groq-stt-host", source: "host-env" })).toContain("action=rotate-credential rotation=warranted");
  });
});
