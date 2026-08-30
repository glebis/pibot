import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCorrections,
  composeBias,
  dictionaryFile,
  dictionaryRemoveEntry,
  dictionaryUpsertEntry,
  loadDictionary,
  saveDictionary,
} from "./dictionary.js";

const dirs: string[] = [];
function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-dict-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("dictionary", () => {
  it("loads an empty dictionary when the file is missing or malformed", () => {
    const dir = tmpDataDir();
    expect(loadDictionary(dir)).toEqual({ entries: [] });
    fs.writeFileSync(dictionaryFile(dir), "{not json");
    expect(loadDictionary(dir)).toEqual({ entries: [] });
    fs.writeFileSync(dictionaryFile(dir), JSON.stringify({ entries: [{ from: "  x ", to: "Y " }, { from: "", to: "skip" }, 42] }));
    expect(loadDictionary(dir)).toEqual({ entries: [{ from: "x", to: "Y" }] });
  });

  it("saves, upserts (dedupes by from) and removes entries", () => {
    const dir = tmpDataDir();
    let dict = loadDictionary(dir);
    dict = dictionaryUpsertEntry(dict, "West", "WhisperKit");
    dict = dictionaryUpsertEntry(dict, "west kit", "WhisperKit");
    dict = dictionaryUpsertEntry(dict, "West", "WhisperKit"); // replaces, does not duplicate
    expect(dict.entries.filter((e) => e.from === "West")).toHaveLength(1);
    saveDictionary(dir, dict);
    expect(loadDictionary(dir).entries).toHaveLength(2);
    const afterRemove = dictionaryRemoveEntry(loadDictionary(dir), "west kit"); // matches either side
    expect(afterRemove.entries).toHaveLength(1);
    expect(dictionaryRemoveEntry(loadDictionary(dir), "WhisperKit").entries).toHaveLength(0); // matches via to-form
    saveDictionary(dir, afterRemove);
    expect(loadDictionary(dir).entries).toEqual([{ from: "West", to: "WhisperKit" }]);
  });

  it("applies corrections with word boundaries, case-insensitively", () => {
    const entries = [{ from: "West", to: "WhisperKit" }, { from: "beeds", to: "beads" }];
    expect(applyCorrections("so I tested West today and west works", entries)).toBe("so I tested WhisperKit today and WhisperKit works");
    expect(applyCorrections("that's a Western thing", entries)).toBe("that's a Western thing");
    expect(applyCorrections("the westward path", entries)).toBe("the westward path");
    expect(applyCorrections("nothing here", entries)).toBe("nothing here");
  });

  it("composes a deduped bias prompt capped in length", () => {
    const dict = { entries: [{ from: "a", to: "WhisperKit" }, { from: "b", to: "WhisperKit" }, { from: "c", to: "beads" }] };
    const bias = composeBias(dict);
    expect(bias).toContain("WhisperKit, beads");
    expect(bias.startsWith("This audio may mention")).toBe(true);
    expect(composeBias({ entries: [] })).toBe("");
    const long = composeBias({ entries: Array.from({ length: 200 }, (_, i) => ({ from: `x${i}`, to: `term${"x".repeat(40)}${i}` })) });
    expect(long.length).toBeLessThanOrEqual(800);
  });
});