/** Synthetic candidate text only; no live PiBot session or model generation. */
import * as path from "node:path";
import { decryptJsonWithSops } from "../src/core/secrets.js";
import { createJevResponseJudge, DEFAULT_RESPONSE_SELECTION_POLICY, selectToolFreeResponse } from "../src/core/response-selection.js";

const settings = await decryptJsonWithSops<{ env?: Record<string, string> }>(path.resolve("data/settings.enc.json"));
const apiKey = settings.env?.TYPESAFE_API_KEY;
if (!apiKey?.trim()) throw new Error("Direct TypeSafe key unavailable in SOPS settings");

const drafts: Record<string, string> = {
  primary: "The numbers are 3, 5, and 8. I'll add them shortly.",
  backup: "The numbers are 3, 5, and 8. Their sum is 16.",
  third: "The numbers are 3, 5, and 8. Their sum is 17.",
};
const judge = createJevResponseJudge({
  task: "State the numbers 3, 5, and 8 and give their sum.",
  criteria: "The answer must include all three numbers and the correct sum, 16.",
  dataClass: "synthetic", permission: { enabled: true, dataScope: "synthetic", providers: ["typesafe-ai"] }, apiKey,
});
for (const mode of ["sequential", "best_of_n"] as const) {
  const started = Date.now();
  const result = await selectToolFreeResponse({ models: Object.keys(drafts),
    policy: { ...DEFAULT_RESPONSE_SELECTION_POLICY, mode, maxCandidates: 3 },
    generate: async model => drafts[model]!, assess: judge.assess, compare: judge.compare });
  console.log(JSON.stringify({ mode, selected: result.selected?.model, reason: result.reason,
    candidates: result.candidates.map(c => ({ model: c.model, meetsProbability: c.meetsProbability })),
    elapsedMs: Date.now() - started }));
  if (result.selected?.model !== "backup") process.exitCode = 1;
}
