import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { composeBias, dictionaryRemoveEntry, dictionaryUpsertEntry, loadDictionary, saveDictionary } from "../core/dictionary.js";

/**
 * Shared plugin: bot-wide custom vocabulary for voice transcription.
 * Entries bias the STT decoder AND get applied as deterministic corrections.
 */
export function dictionaryPlugin(deps: { dataDir: string }): InlineExtension {
  return {
    name: "dictionary",
    factory: (pi) => {
      pi.registerTool({
        name: "dictionary_add",
        label: "Add vocabulary entry",
        description: "Add a custom-vocabulary entry for voice transcription. Use when the owner wants a name/term to be transcribed correctly (e.g. their name, project names, recurring jargon). The 'to' term is both the decoder bias and the correction target.",
        parameters: Type.Object({
          from: Type.String({ description: "What the transcript currently says (misheard form), e.g. 'West'" }),
          to: Type.String({ description: "What it should say (canonical form), e.g. 'WhisperKit'" }),
        }),
        async execute(_tcid, params) {
          if (params.from.trim().toLowerCase() === params.to.trim().toLowerCase()) {
            return { content: [{ type: "text", text: "from and to are the same — nothing to add." }], details: { entries: loadDictionary(deps.dataDir).entries.length } };
          }
          const dict = loadDictionary(deps.dataDir);
          const next = dictionaryUpsertEntry(dict, params.from, params.to);
          saveDictionary(deps.dataDir, next);
          return {
            content: [{ type: "text", text: `Added vocabulary: "${params.from.trim()}" → "${params.to.trim()}" (${next.entries.length} entries total). Applies to future voice notes.` }],
            details: { entries: next.entries.length },
          };
        },
      });

      pi.registerTool({
        name: "dictionary_list",
        label: "List vocabulary",
        description: "Show the custom transcription vocabulary. Mention it when a voice transcript keeps mishearing something the owner could add here.",
        parameters: Type.Object({}),
        async execute() {
          const dict = loadDictionary(deps.dataDir);
          if (!dict.entries.length) {
            return { content: [{ type: "text", text: "Custom vocabulary is empty. Add entries with dictionary_add." }], details: { entries: 0 } };
          }
          const lines = dict.entries.map((e) => `- "${e.from}" → "${e.to}"`);
          return { content: [{ type: "text", text: `**Custom STT vocabulary** (${dict.entries.length}, bias: "${composeBias(dict)}")\n${lines.join("\n")}` }], details: { entries: dict.entries.length } };
        },
      });

      pi.registerTool({
        name: "dictionary_remove",
        label: "Remove vocabulary entry",
        description: "Remove a custom-vocabulary entry by either its from- or to-form.",
        parameters: Type.Object({
          key: Type.String({ description: "The from- or to-form of the entry to remove" }),
        }),
        async execute(_tcid, params) {
          const dict = loadDictionary(deps.dataDir);
          const next = dictionaryRemoveEntry(dict, params.key);
          if (next.entries.length === dict.entries.length) {
            return { content: [{ type: "text", text: `No entry matches "${params.key}".` }], details: { entries: dict.entries.length } };
          }
          saveDictionary(deps.dataDir, next);
          return { content: [{ type: "text", text: `Removed. ${next.entries.length} entries remain.` }], details: { entries: next.entries.length } };
        },
      });
    },
  };
}