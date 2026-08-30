import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { errorMessage, truncate } from "./util.js";

/**
 * Speech-to-Text with a configurable provider fallback chain
 * (pattern from verity-agent's stt_service.py).
 *
 * Providers, tried in order (STT_PROVIDERS env, default "whisperkit,groq,local_whisper"):
 * - whisperkit:    whisperkit-cli (Apple Silicon native; best local default on macOS).
 * - groq:          Groq Whisper API — fast, remote. Needs GROQ_API_KEY.
 * - local_whisper: local `whisper` CLI via subprocess, best-effort.
 */

export interface SttResult {
  ok: boolean;
  text: string;
  provider: string;
  error?: string;
}

export const DEFAULT_STT_PROVIDERS = ["whisperkit", "groq", "local_whisper"] as const;
export const KNOWN_STT_PROVIDERS = new Set(["whisperkit", "groq", "local_whisper"]);
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = process.env.STT_GROQ_MODEL || "whisper-large-v3-turbo";
const WHISPERKIT_MODEL = process.env.STT_WHISPERKIT_MODEL || "whisper-tiny";

export function sttProvidersFromEnv(): string[] {
  const raw = (process.env.STT_PROVIDERS ?? "").trim();
  if (!raw) return [...DEFAULT_STT_PROVIDERS];
  const parsed = raw.split(",").map((p) => p.trim()).filter((p) => KNOWN_STT_PROVIDERS.has(p));
  return parsed.length ? parsed : [...DEFAULT_STT_PROVIDERS];
}

export interface SttDeps {
  fetchFn?: typeof fetch;
  execFileFn?: typeof execFile;
  /** precomputed availability of local CLIs (tests inject; null = absent) */
  whisperBin?: string | null;
  whisperkitBin?: string | null;
  timeoutMs?: number;
  whisperkitTimeoutMs?: number;
}

/** One provider attempt. Isolated so tests can stub fetch/exec. */
async function transcribeGroq(audioPath: string, language: string | undefined, deps: SttDeps): Promise<SttResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!process.env.GROQ_API_KEY) {
    return { ok: false, text: "", provider: "groq", error: "GROQ_API_KEY not set" };
  }
  const fetchFn = depsFetch(deps);
  try {
    const buf = await fsp.readFile(path.resolve(audioPath));
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/ogg" }), path.basename(audioPath));
    form.append("model", GROQ_MODEL);
    form.append("response_format", "json");
    if (language) form.append("language", language);
    const res = await fetchFn(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      const body = truncate(await res.text().catch(() => ""), 200);
      return { ok: false, text: "", provider: "groq", error: `groq HTTP ${res.status}: ${body}` };
    }
    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? "").trim();
    if (!text) return { ok: false, text: "", provider: "groq", error: "groq returned empty transcript" };
    return { ok: true, text, provider: "groq" };
  } catch (e) {
    return { ok: false, text: "", provider: "groq", error: `groq: ${errorMessage(e)}` };
  }
}

async function transcribeLocalWhisper(
  audioPath: string,
  language: string | undefined,
  bin: string | null,
  deps: SttDeps,
): Promise<SttResult> {
  if (!bin) return { ok: false, text: "", provider: "local_whisper", error: "whisper CLI not installed" };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-whisper-"));
  const exec = deps.execFileFn ?? execFile;
  const args = [path.resolve(audioPath), "--model", process.env.STT_LOCAL_MODEL || "base", "--output_format", "txt", "--output_dir", outDir];
  if (language) args.push("--language", language);
  try {
    await new Promise<void>((resolve, reject) => {
      exec(bin, args, { timeout: deps.timeoutMs ?? 300_000 }, (err) => (err ? reject(err) : resolve()));
    });
    const txt = path.join(outDir, path.basename(audioPath).replace(/\.[^.]+$/, "") + ".txt");
    const text = (await fsp.readFile(txt, "utf8")).trim();
    if (!text) return { ok: false, text: "", provider: "local_whisper", error: "whisper produced no output" };
    return { ok: true, text, provider: "local_whisper" };
  } catch (e) {
    return { ok: false, text: "", provider: "local_whisper", error: `local_whisper: ${errorMessage(e)}` };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function depsFetch(deps: SttDeps): typeof fetch {
  return deps.fetchFn ?? fetch;
}

/** whisperkit-cli (Apple Silicon): transcript arrives on stdout. */
async function transcribeWhisperkit(
  audioPath: string,
  language: string | undefined,
  bin: string | null,
  deps: SttDeps,
): Promise<SttResult> {
  if (!bin) return { ok: false, text: "", provider: "whisperkit", error: "whisperkit-cli not installed" };
  const exec = deps.execFileFn ?? execFile;
  const args = ["transcribe", "--audio-path", path.resolve(audioPath), "--model", WHISPERKIT_MODEL, "--download-model-path", process.env.STT_WHISPERKIT_MODEL_PATH || path.join(process.env.HOME ?? "~/", "Library/whisperkit")];
  if (language) args.push("--language", language);
  try {
    const [stdout, stderr] = await new Promise<[string, string]>((resolve, reject) => {
      exec(bin, args, { timeout: deps.whisperkitTimeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024 }, (err, so, se) =>
        err ? reject(err) : resolve([so.toString(), se.toString()])
      );
    });
    const text = (stdout || stderr)
      .split("\n")
      .map((l) => l.replace(/^\[\d{2}:\d{2}[:.].*?\]\s*/, "").trim())
      .filter((l) => l && !/^(Transcrib|Loading)/i.test(l) && !/^Error:/i.test(l))
      .join(" ")
      .trim();
    if (!text) return { ok: false, text: "", provider: "whisperkit", error: "whisperkit produced no output" };
    return { ok: true, text, provider: "whisperkit" };
  } catch (e) {
    return { ok: false, text: "", provider: "whisperkit", error: `whisperkit: ${errorMessage(e)}` };
  }
}

export class SttService {
  private providers: string[];
  private language: string | undefined;
  private deps: SttDeps;

  constructor(providers?: string[], deps: SttDeps = {}) {
    this.providers = providers ?? sttProvidersFromEnv();
    const lang = (process.env.STT_LANGUAGE ?? "").trim();
    this.language = lang || undefined;
    this.deps = deps;
  }

  /** True when at least one provider in the chain can plausibly run. */
  configured(): boolean {
    return this.providers.some((p) => (p === "groq" ? !!process.env.GROQ_API_KEY : true));
  }

  async transcribe(audioPath: string): Promise<SttResult> {
    const failures: string[] = [];
    for (const provider of this.providers) {
      const deps = this.deps;
      const result =
        provider === "groq"
          ? await transcribeGroq(audioPath, this.language, deps)
          : provider === "whisperkit"
            ? await transcribeWhisperkit(audioPath, this.language, deps.whisperkitBin ?? (await whichBin(deps.execFileFn ?? execFile, "whisperkit-cli")), deps)
            : await transcribeLocalWhisper(audioPath, this.language, deps.whisperBin ?? (await whichBin(deps.execFileFn ?? execFile, "whisper")), deps);
      if (result.ok) return result;
      failures.push(`${result.provider}: ${result.error}`);
    }
    return { ok: false, text: "", provider: "none", error: `all STT providers failed — ${failures.join("; ")}` };
  }
}

/** Best-effort `command -v <name>` — resolves the binary path or null. */
async function whichBin(execFn: typeof execFile, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFn("sh", ["-c", `command -v ${name}`], { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}