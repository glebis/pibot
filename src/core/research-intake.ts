// ─── Research-intake primitives: typed questions over the QuestionBus ─────────
// Thin, reusable building blocks for intake flows. Every helper:
//   - preserves the one-pending-question constraint (QuestionBus enforces it),
//   - keeps the free-text fallback (any typed message answers; voice arrives as
//     transcribed text through the same interception path),
//   - returns a normalized IntakeAnswer with modality + skipped flags so
//     analytics can distinguish modality and skip rates.

import * as fs from "node:fs";
import type { ChatRef } from "./types.js";
import type { QuestionAnswer, QuestionSpec } from "./questions.js";

export type AskFn = (
  chat: { transport: string; chatId: string },
  spec: QuestionSpec
) => Promise<QuestionAnswer>;

export type IntakeModality = "button" | "poll" | "text" | "voice" | "none";

export interface IntakeAnswer<T = string | number | boolean | undefined> {
  /** the parsed answer; undefined when timed out / replaced / invalid */
  value?: T;
  /** answer modality as recorded by the question surface */
  modality: IntakeModality;
  /** true when the question expired, was replaced, or was answered emptily */
  skipped: boolean;
  /** the raw QuestionAnswer, for drill-down */
  raw: QuestionAnswer;
}

function modalityOf(raw: QuestionAnswer, source?: "text" | "voice"): IntakeModality {
  if (raw.timedOut || raw.replaced) return "none"; // never answered — no modality
  if (source === "voice" && raw.via === "text") return "voice";
  if (raw.via === "button") return "button";
  if (raw.via === "poll") return "poll";
  if (raw.via === "text") return "text";
  return "none";
}

function wrap<T>(raw: QuestionAnswer, parse: (r: QuestionAnswer) => T, source?: "text" | "voice"): IntakeAnswer<T> {
  const skipped = Boolean(raw.timedOut || raw.replaced) || (raw.index === -1 && raw.via !== "text");
  return {
    value: skipped ? undefined : parse(raw),
    modality: modalityOf(raw, source),
    skipped,
    raw,
  };
}

/** Choice question: ≤6 options → inline buttons; >6 → native poll (automatic). */
export async function askChoice(
  ask: AskFn,
  chat: { transport: string; chatId: string },
  text: string,
  options: string[],
  opts: { timeoutMs?: number; poll?: boolean; source?: "text" | "voice" } = {}
): Promise<IntakeAnswer<string>> {
  const raw = await ask(chat, { text, options, timeoutMs: opts.timeoutMs, poll: opts.poll });
  return wrap(raw, (r) => r.choice, opts.source);
}

/** Yes/No question → boolean (Yes = index 0). */
export async function askConfirm(
  ask: AskFn,
  chat: { transport: string; chatId: string },
  text: string,
  opts: { timeoutMs?: number; yes?: string; no?: string; source?: "text" | "voice" } = {}
): Promise<IntakeAnswer<boolean>> {
  const yes = opts.yes ?? "Yes";
  const no = opts.no ?? "No";
  const raw = await ask(chat, { text, options: [yes, no], timeoutMs: opts.timeoutMs });
  return wrap(
    raw,
    (r) => r.choice.toLowerCase().startsWith(yes.toLowerCase()[0]) || r.index === 0,
    opts.source
  );
}

/** Scale question: numbered buttons 1..N (N ≤ 6 → buttons; more → poll). */
export async function askScale(
  ask: AskFn,
  chat: { transport: string; chatId: string },
  text: string,
  max = 5,
  opts: { timeoutMs?: number; source?: "text" | "voice" } = {}
): Promise<IntakeAnswer<number>> {
  const options = Array.from({ length: Math.max(2, Math.min(max, 10)) }, (_, i) => String(i + 1));
  const raw = await ask(chat, { text, options, timeoutMs: opts.timeoutMs });
  return wrap(raw, (r) => (Number.isInteger(r.index) && r.index >= 0 ? r.index + 1 : Number(r.choice) || 0), opts.source);
}

/** Open question: cardless message; the next typed (or voice) message is the answer. */
export async function askText(
  ask: AskFn,
  chat: { transport: string; chatId: string },
  text: string,
  opts: { timeoutMs?: number; source?: "text" | "voice" } = {}
): Promise<IntakeAnswer<string>> {
  const raw = await ask(chat, { text, options: [], timeoutMs: opts.timeoutMs });
  return wrap(raw, (r) => r.choice, opts.source);
}
// ─── Intake persistence + analytics (data/proactive/intake.json, 0600) ────────

import * as path from "node:path";
import { readJson, uid, writeJsonAtomic } from "./util.js";

export type IntakeKind = "choice" | "poll" | "confirm" | "scale" | "text";
export type IntakeSessionStatus = "active" | "completed" | "skipped" | "failed";

export interface IntakeAnswerRecord {
  key: string;
  question: string;
  kind: IntakeKind;
  value?: string | number | boolean;
  modality: IntakeModality;
  skipped: boolean;
  latencyMs: number;
  ts: number;
}

export interface IntakeRecord {
  id: string;
  agentId: string;
  chat: { transport: string; chatId: string };
  flow: string;
  status: IntakeSessionStatus;
  createdAt: number;
  finishedAt?: number;
  /** question keys not yet answered, in order */
  pendingKeys: string[];
  answers: IntakeAnswerRecord[];
}

export interface IntakeStats {
  sessions: number;
  answers: number;
  answered: number;
  skipped: number;
  skipPct: number;
  modalitySplit: Record<string, number>;
  avgLatencyMs: number;
  perFlow: Record<string, number>;
}

export class IntakeStore {
  private file: string;
  private sessions: IntakeRecord[];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "proactive", "intake.json");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.sessions = readJson<IntakeRecord[]>(this.file, []);
  }

  private save(): void {
    writeJsonAtomic(this.file, this.sessions, 0o600);
  }

  createSession(agentId: string, chat: { transport: string; chatId: string }, flow: string, keys: string[]): IntakeRecord {
    const rec: IntakeRecord = {
      id: uid("in", 6),
      agentId,
      chat,
      flow,
      status: "active",
      createdAt: Date.now(),
      pendingKeys: [...keys],
      answers: [],
    };
    this.sessions.push(rec);
    this.save();
    return rec;
  }

  get(id: string): IntakeRecord | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  recordAnswer(
    id: string,
    key: string,
    a: { value?: string | number | boolean; modality: IntakeModality; skipped: boolean; latencyMs?: number; kind?: IntakeKind; question?: string }
  ): IntakeRecord | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    rec.pendingKeys = rec.pendingKeys.filter((k) => k !== key);
    rec.answers.push({
      key,
      question: a.question ?? "",
      kind: a.kind ?? "text",
      value: a.skipped ? undefined : a.value,
      modality: a.modality,
      skipped: a.skipped,
      latencyMs: a.latencyMs ?? 0,
      ts: Date.now(),
    });
    this.save();
    return rec;
  }

  finishSession(id: string, status: Exclude<IntakeSessionStatus, "active">): IntakeRecord | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    rec.status = status;
    rec.finishedAt = Date.now();
    this.save();
    return rec;
  }

  get list(): IntakeRecord[] {
    return this.sessions;
  }

  stats(f: { since?: number; agentId?: string; flow?: string } = {}): IntakeStats {
    const sessions = this.sessions.filter((s) => {
      if (f.agentId && s.agentId !== f.agentId) return false;
      if (f.flow && s.flow !== f.flow) return false;
      if (f.since && s.createdAt < f.since) return false;
      return true;
    });
    const answers = sessions.flatMap((s) => s.answers);
    const skipped = answers.filter((a) => a.skipped).length;
    const answered = answers.length - skipped;
    const latencies = answers.filter((a) => !a.skipped).map((a) => a.latencyMs);
    const modalitySplit: Record<string, number> = {};
    for (const a of answers.filter((x) => !x.skipped)) modalitySplit[a.modality] = (modalitySplit[a.modality] ?? 0) + 1;
    const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 100));
    const perFlow: Record<string, number> = {};
    for (const s of sessions) perFlow[s.flow] = (perFlow[s.flow] ?? 0) + 1;
    return {
      sessions: sessions.length,
      answers: answers.length,
      answered,
      skipped,
      skipPct: pct(skipped, answers.length),
      modalitySplit,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((x, y) => x + y, 0) / latencies.length) : 0,
      perFlow,
    };
  }
}

// ─── ResearchWizard: reusable 3–5-question intake flow ────────────────────────

export interface WizardQuestion {
  key: string;
  question: string;
  kind: IntakeKind;
  /** choice options (≤5 when skippable, so the Skip button keeps it inline) */
  options?: string[];
  /** scale upper bound (buttons 1..max, ≤6) */
  max?: number;
  /** required questions cannot be skipped; timeout ends the run */
  required?: boolean;
}

export interface WizardResult {
  sessionId: string;
  status: "completed" | "skipped" | "failed";
  answers: Record<string, string | number | boolean | undefined>;
}

const WIZARD_MAX_QUESTIONS = 5;
const SKIP_RE = /^\s*skip\b/i;
const EXIT_RE = /^\s*(exit|stop|quit)\b/i;

export class ResearchWizard {
  constructor(
    private deps: {
      ask: AskFn;
      store: IntakeStore;
      /** question timeout for every step (QuestionBus default 10m when unset) */
      timeoutMs?: number;
      now?: () => number;
    }
  ) {}

  async run(
    agentId: string,
    chat: { transport: string; chatId: string },
    flow: string,
    questions: WizardQuestion[]
  ): Promise<WizardResult> {
    if (questions.length < 3 || questions.length > WIZARD_MAX_QUESTIONS) {
      throw new Error(`an intake flow takes 3–5 questions (got ${questions.length})`);
    }
    const sess = this.deps.store.createSession(agentId, chat, flow, questions.map((q) => q.key));
    const answers: WizardResult["answers"] = {};
    const total = questions.length;

    try {
      for (let i = 0; i < total; i++) {
        const q = questions[i];
        const started = this.deps.now?.() ?? Date.now();
        const progress = `(${i + 1}/${total}) `;
        const skipHint = q.required ? "" : " — reply skip or exit anytime";
        let raw: QuestionAnswer;
        if (q.kind === "confirm") {
          raw = await this.deps.ask(chat, { text: `${progress}${q.question}${skipHint}`, options: ["Yes", "No"], timeoutMs: this.deps.timeoutMs });
        } else if (q.kind === "scale") {
          const n = Math.max(2, Math.min(q.max ?? 5, 6));
          const options = Array.from({ length: n }, (_, x) => String(x + 1));
          if (!q.required) options.push("Skip");
          raw = await this.deps.ask(chat, { text: `${progress}${q.question}${skipHint}`, options, timeoutMs: this.deps.timeoutMs });
        } else if (q.kind === "text") {
          raw = await this.deps.ask(chat, { text: `${progress}${q.question}${skipHint}`, options: [], timeoutMs: this.deps.timeoutMs });
        } else {
          const options = [...(q.options ?? [])];
          if (!q.required && options.length < 6) options.push("Skip");
          raw = await this.deps.ask(chat, { text: `${progress}${q.question}${skipHint}`, options, timeoutMs: this.deps.timeoutMs });
        }

        if (EXIT_RE.test(raw.choice)) {
          this.deps.store.finishSession(sess.id, "skipped");
          return { sessionId: sess.id, status: "skipped", answers };
        }
        if (SKIP_RE.test(raw.choice) && !q.required) {
          this.deps.store.recordAnswer(sess.id, q.key, { modality: modalityOf(raw), skipped: true, latencyMs: this.deps.now?.() ?? 0 - started, kind: q.kind, question: q.question });
          answers[q.key] = undefined;
          continue;
        }
        if (raw.timedOut || raw.replaced) {
          this.deps.store.recordAnswer(sess.id, q.key, { modality: modalityOf(raw), skipped: true, latencyMs: this.deps.now?.() ?? 0 - started, kind: q.kind, question: q.question });
          if (q.required) {
            // a required question timing out ends the run — no re-ask loop
            this.deps.store.finishSession(sess.id, "skipped");
            return { sessionId: sess.id, status: "skipped", answers };
          }
          answers[q.key] = undefined;
          continue;
        }

        const value =
          q.kind === "confirm"
            ? raw.index === 0 || raw.choice.toLowerCase().startsWith("y")
            : q.kind === "scale"
              ? (Number.isInteger(raw.index) && raw.index >= 0 ? raw.index + 1 : Number(raw.choice) || undefined)
              : raw.choice;
        this.deps.store.recordAnswer(sess.id, q.key, {
          value: value as string | number | boolean,
          modality: modalityOf(raw),
          skipped: false,
          latencyMs: (this.deps.now?.() ?? Date.now()) - started,
          kind: q.kind,
          question: q.question,
        });
        answers[q.key] = value;
      }
      this.deps.store.finishSession(sess.id, "completed");
      return { sessionId: sess.id, status: "completed", answers };
    } catch (e) {
      this.deps.store.finishSession(sess.id, "failed");
      throw e;
    }
  }
}
