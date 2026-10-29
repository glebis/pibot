/** A bounded, side-effect-free client for TypeSafe Jev or Vercel AI Gateway. */
export type JevQuestion =
  | { type: "boolean"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> }
  | { type: "score"; score: number; probabilities: Record<string, number> };

export type JevTrace = {
  outcome: "success" | "failure";
  reason?: JevFailureReason;
  attempts: number;
  elapsedMs: number;
  stateBytes: number;
  questionCount: number;
  httpStatus?: number;
};

export type JevFailureReason =
  | "missing_api_key"
  | "invalid_state"
  | "state_too_large"
  | "invalid_questions"
  | "timeout"
  | "network_error"
  | "http_error"
  | "invalid_response";

export type JevResult =
  | { ok: true; answers: Record<string, JevAnswer>; elapsedMs: number }
  | { ok: false; reason: JevFailureReason; elapsedMs: number };

export type JevProvider = "typesafe" | "gateway";
const GATEWAY_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_STATE_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_QUESTIONS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function validQuestions(questions: Record<string, JevQuestion>): boolean {
  if (!isRecord(questions)) return false;
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > MAX_QUESTIONS) return false;
  for (const [name, question] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || !isRecord(question)
      || !boundedText(question.instructions, 500)) return false;
    if (question.type === "boolean") {
      if (question.criteria !== undefined &&
        (!isRecord(question.criteria) || !boundedText(question.criteria.true, 250)
          || !boundedText(question.criteria.false, 250))) return false;
    } else if (question.type === "choice") {
      if (!isRecord(question.criteria)) return false;
      const options = Object.entries(question.criteria);
      if (options.length < 2 || options.length > 8 ||
        options.some(([key, description]) =>
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || !boundedText(description, 250))) return false;
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2
        || question.criteria.length > 8 || question.criteria.some((rung) => !boundedText(rung, 250))) return false;
    } else return false;
  }
  return true;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function probabilities(value: unknown, keys: string[]): value is Record<string, number> {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => probability(value[key]))
    && Math.abs(keys.reduce((sum, key) => sum + (value[key] as number), 0) - 1) <= 0.03;
}

function parseAnswers(body: unknown, questions: Record<string, JevQuestion>, provider: JevProvider): Record<string, JevAnswer> | null {
  if (!isRecord(body) || (body.model !== undefined && (provider === "gateway"
    ? body.model !== "typesafe-ai/jev" : typeof body.model !== "string" || !body.model.startsWith("jev-")))
    || !isRecord(body.answers)) return null;
  const entries = Object.entries(questions);
  if (Object.keys(body.answers).length !== entries.length) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const [name, question] of entries) {
    const answer = body.answers[name];
    const wireType = provider === "typesafe" && question.type === "boolean" ? "noul" : question.type;
    if (!isRecord(answer) || answer.type !== wireType) return null;
    if (question.type === "boolean") {
      const value = provider === "typesafe" ? answer.noul : answer.probability;
      if (!probability(value)) return null;
      answers[name] = { type: "boolean", probability: value };
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      if (typeof answer.choice !== "string" || !options.includes(answer.choice)
        || !probabilities(answer.probabilities, options)) return null;
      const choiceProbabilities = answer.probabilities;
      if (options.some((option) => choiceProbabilities[option] > choiceProbabilities[answer.choice as string] + 0.001)) return null;
      answers[name] = { type: "choice", choice: answer.choice, probabilities: answer.probabilities };
    } else {
      const rungs = question.criteria.map((_, index) => String(index));
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > rungs.length - 1
        || !probabilities(answer.probabilities, rungs)) return null;
      answers[name] = { type: "score", score: answer.score, probabilities: answer.probabilities };
    }
  }
  return answers;
}

export async function evaluateJev(input: {
  state: unknown;
  questions: Record<string, JevQuestion>;
  apiKey?: string;
  provider?: JevProvider;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  trace?: (event: JevTrace) => void;
}): Promise<JevResult> {
  const started = Date.now();
  const questionCount = isRecord(input.questions) ? Object.keys(input.questions).length : 0;
  let stateBytes = 0;
  let attempts = 0;
  let httpStatus: number | undefined;
  const finish = (result: { ok: true; answers: Record<string, JevAnswer> } | { ok: false; reason: JevFailureReason }): JevResult => {
    const elapsedMs = Date.now() - started;
    try {
      input.trace?.({ outcome: result.ok ? "success" : "failure", reason: result.ok ? undefined : result.reason,
        attempts, elapsedMs, stateBytes, questionCount, httpStatus });
    } catch { /* tracing cannot affect decisions */ }
    return { ...result, elapsedMs };
  };

  // An explicit injected key keeps the existing gateway call contract. With
  // encrypted runtime credentials, prefer the direct TypeSafe route and never
  // silently fall back to another provider after an HTTP or network failure.
  const provider = input.provider ?? (input.apiKey !== undefined ? "gateway"
    : process.env.TYPESAFE_API_KEY?.trim() ? "typesafe" : "gateway");
  const key = input.apiKey ?? (provider === "typesafe" ? process.env.TYPESAFE_API_KEY : process.env.AI_GATEWAY_API_KEY);
  if (!key?.trim()) return finish({ ok: false, reason: "missing_api_key" });
  if (typeof input.state !== "string" && !isRecord(input.state) && !Array.isArray(input.state))
    return finish({ ok: false, reason: "invalid_state" });
  let serializedState: string;
  try {
    serializedState = JSON.stringify(input.state);
    if (serializedState === undefined) return finish({ ok: false, reason: "invalid_state" });
    stateBytes = Buffer.byteLength(serializedState, "utf8");
  } catch { return finish({ ok: false, reason: "invalid_state" }); }
  if (stateBytes > MAX_STATE_BYTES) return finish({ ok: false, reason: "state_too_large" });
  if (!validQuestions(input.questions)) return finish({ ok: false, reason: "invalid_questions" });

  const timeoutMs = Math.min(10_000, Math.max(250, input.timeoutMs ?? 4_000));
  const wireQuestions = provider === "typesafe"
    ? Object.fromEntries(Object.entries(input.questions).map(([name, question]) => [name, question.type === "boolean"
      ? { type: "noul", instructions: question.criteria
        ? `${question.instructions}\nTrue: ${question.criteria.true}\nFalse: ${question.criteria.false}` : question.instructions }
      : question]))
    : input.questions;
  const body = provider === "typesafe"
    ? JSON.stringify({ model: "jev-latest", state: JSON.parse(serializedState), questions: wireQuestions })
    : JSON.stringify({ model: "typesafe-ai/jev", state: JSON.parse(serializedState), questions: wireQuestions,
      providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } } });
  const fetchFn = input.fetchFn ?? globalThis.fetch;

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetchFn(provider === "typesafe" ? TYPESAFE_ENDPOINT : GATEWAY_ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body,
            signal: controller.signal,
          });
          httpStatus = response.status;
          if (!response.ok) return { kind: "http" as const, status: response.status };
          const contentLength = response.headers?.get("content-length");
          if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) return { kind: "invalid" as const };
          const responseText = await response.text();
          if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) return { kind: "invalid" as const };
          let parsed: unknown;
          try { parsed = JSON.parse(responseText); } catch { return { kind: "invalid" as const }; }
          const answers = parseAnswers(parsed, input.questions, provider);
          return answers ? { kind: "success" as const, answers } : { kind: "invalid" as const };
        })(),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve({ kind: "timeout" }); }, timeoutMs);
        }),
      ]);
      if (result.kind === "success") return finish({ ok: true, answers: result.answers });
      if (result.kind === "invalid") return finish({ ok: false, reason: "invalid_response" });
      if (result.kind === "http") {
        if (attempt === 0 && (result.status === 429 || result.status >= 500)) continue;
        return finish({ ok: false, reason: "http_error" });
      }
      if (attempt === 1) return finish({ ok: false, reason: "timeout" });
    } catch {
      if (attempt === 1) return finish({ ok: false, reason: "network_error" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return finish({ ok: false, reason: "network_error" });
}
