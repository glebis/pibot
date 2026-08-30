import * as fs from "node:fs";
import * as path from "node:path";
import { truncate, writeJsonAtomic } from "./util.js";

/**
 * Custom STT vocabulary ("dictionary") for voice transcription.
 *
 * Two mechanisms (research-backed):
 * 1. `composeBias` — the `to:` terms become an initial_prompt/--prompt bias so
 *    whisper-family decoders prefer them (224-token cap; prompt conditions the
 *    first 30s window — ideal for short voice notes).
 * 2. `applyCorrections` — deterministic post-transcription replacements
 *    (verbatim transcript_corrector.py pattern from verity-agent).
 */

export interface DictionaryEntry {
  /** form to replace (e.g. "West") — matched word-boundary, case-insensitive */
  from: string;
  /** canonical form (e.g. "WhisperKit") */
  to: string;
}

export interface Dictionary {
  entries: DictionaryEntry[];
}

export const DICTIONARY_FILE = "dictionary.json";

export function dictionaryFile(dataDir: string): string {
  return path.join(dataDir, DICTIONARY_FILE);
}

export function loadDictionary(dataDir: string): Dictionary {
  try {
    const raw = JSON.parse(fs.readFileSync(dictionaryFile(dataDir), "utf8")) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return { entries: [] };
    const entries = raw.entries
      .filter((e): e is DictionaryEntry => {
        const t = e as DictionaryEntry;
        return typeof t?.from === "string" && typeof t?.to === "string" && t.from.trim() !== "" && t.to.trim() !== "";
      })
      .map((e) => ({ from: e.from.trim(), to: e.to.trim() }));
    return { entries };
  } catch {
    return { entries: [] };
  }
}

export function saveDictionary(dataDir: string, dict: Dictionary): void {
  writeJsonAtomic(dictionaryFile(dataDir), { entries: dict.entries });
}

export function dictionaryUpsertEntry(dict: Dictionary, from: string, to: string): Dictionary {
  const f = from.trim();
  const t = to.trim();
  const rest = dict.entries.filter((e) => e.from !== f);
  return { entries: [...rest, { from: f, to: t }] };
}

export function dictionaryRemoveEntry(dict: Dictionary, key: string): Dictionary {
  const k = key.trim().toLowerCase();
  return { entries: dict.entries.filter((e) => e.from.toLowerCase() !== k && e.to.toLowerCase() !== k) };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary, case-insensitive "from → to" replacement across the transcript. */
export function applyCorrections(text: string, entries: DictionaryEntry[]): string {
  let out = text;
  for (const { from, to } of entries) {
    const f = from.trim();
    if (!f) continue;
    // \b works with ASCII word chars; names/terms in personal dictionaries qualify
    out = out.replace(new RegExp(`\\b${escapeRegex(f)}\\b`, "gi"), to);
  }
  return out;
}

/** Compose the decoder-bias prompt from canonical terms (deduped, capped). */
export function composeBias(dict: Dictionary, maxChars = 800): string {
  const terms = [...new Set(dict.entries.map((e) => e.to).filter(Boolean))];
  if (!terms.length) return "";
  const body = `This audio may mention these words and names, keep them spelled exactly: ${terms.join(", ")}.`;
  return truncate(body, maxChars);
}