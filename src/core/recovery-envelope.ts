/**
 * Recovery-envelope provenance (bd pibot-0xpf.6).
 *
 * The Nov 9 incident: a delegated vault-search recovery reconstructed paths from a
 * refusal quote and delivered an inventory — but the recovered session had neither the
 * intended tool nor the ORIGINAL owner question, so the answer the owner actually asked
 * for was never recovered, and the owner had to repeat it.
 *
 * A recovery must carry the original request, the canonical task identity, the exact
 * paths produced so far, and the searched scope — never re-invented from a refusal.
 * When the original request cannot be recovered, the envelope says exactly that:
 * missing prerequisites are reported, not guessed, and at most one bounded
 * clarification is asked (never invent the request, never create duplicate searches
 * or tasks from an invented one).
 */

export interface RecoveryEnvelope {
  /** Canonical durable task ID this recovery serves (e.g. "tmw9g1wu99zlj"). */
  taskId: string;
  /** The original owner request, verbatim. */
  originalRequest: string;
  /** Exact vault-relative (or otherwise scoped) paths already produced. */
  paths: string[];
  /** What was actually searched: scope root + coverage notes. */
  scope: string;
  /** Explicit coverage/freshness caveats ("not an index", "hidden excluded", …). */
  coverageCaveats?: string[];
}

/**
 * Validation outcome. `ok` carries the envelope for a fresh delegated session;
 * any `missing-*` variant names the exact prerequisite that is absent — the caller
 * must report that prerequisite, not reconstruct it from a sibling's prose.
 */
export type RecoveryValidation =
  | { ok: true; envelope: RecoveryEnvelope }
  | { ok: false; reason: "missing-original-request" | "missing-task-id" | "missing-scope" };

export function validateRecoveryEnvelope(input: Partial<RecoveryEnvelope>): RecoveryValidation {
  if (!input.taskId || !input.taskId.trim()) return { ok: false, reason: "missing-task-id" };
  if (!input.originalRequest || !input.originalRequest.trim()) return { ok: false, reason: "missing-original-request" };
  if (!input.scope || !input.scope.trim()) return { ok: false, reason: "missing-scope" };
  return {
    ok: true,
    envelope: {
      taskId: input.taskId,
      originalRequest: input.originalRequest,
      paths: input.paths ?? [],
      scope: input.scope,
      ...(input.coverageCaveats?.length ? { coverageCaveats: input.coverageCaveats } : {}),
    },
  };
}

/**
 * Render the envelope as the delegation text for a fresh recovery session. The
 * original request is the payload; paths/scope are evidence already gathered — the
 * recovered session answers the original request, it does not re-ask the owner.
 */
export function formatRecoveryDelegation(e: RecoveryEnvelope): string {
  const lines = [
    `RECOVERY for task ${e.taskId}`,
    ``,
    `Original owner request (answer THIS): ${e.originalRequest}`,
    ``,
    `Searched scope: ${e.scope}`,
  ];
  if (e.paths.length) lines.push(`Paths already recovered: ${e.paths.join(", ")}`);
  if (e.coverageCaveats?.length) lines.push(`Coverage caveats: ${e.coverageCaveats.join("; ")}`);
  lines.push(``, `Search scoped filenames/content, then answer the original request directly. Do not ask the owner to repeat it.`);
  return lines.join("\n");
}

/** One bounded clarification when the prerequisite truly cannot be recovered. */
export function missingPrerequisiteMessage(v: Extract<RecoveryValidation, { ok: false }>): string {
  switch (v.reason) {
    case "missing-original-request":
      return "Cannot recover: the original owner request for this task is not recorded. One bounded clarification needed: what was the question?";
    case "missing-task-id":
      return "Cannot recover: no canonical task ID is attached; refusing to invent one (would risk a duplicate search/task).";
    case "missing-scope":
      return "Cannot recover: the searched scope is not recorded, so coverage cannot be stated honestly.";
  }
}
