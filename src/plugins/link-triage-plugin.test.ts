import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JevResult } from "../core/jev-evaluator.js";
import { linkTriageConfig, normalizeScraperMaterial, triageScraperMaterial } from "./link-triage-plugin.js";

const created: string[] = [];
function material(body: string): { agentDir: string; file: string } {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-link-triage-"));
  created.push(agentDir);
  const dir = path.join(agentDir, "materials");
  fs.mkdirSync(dir);
  const file = path.join(dir, "source.md");
  fs.writeFileSync(file, body);
  return { agentDir, file };
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const source = `---
url: https://example.org/article?private=token
tool: firecrawl
fetched_at: 2026-09-22T10:00:00Z
http_status: 200
size: 320
---
# Better research notes

This article explains how to build a reusable source review workflow with citations and review steps.
`;

const good: Extract<JevResult, { ok: true }> = {
  ok: true,
  elapsedMs: 20,
  answers: {
    relevance: { type: "choice", choice: "relevant", probabilities: { relevant: 0.91, adjacent: 0.09, irrelevant: 0, unclear: 0 } },
    destination: { type: "choice", choice: "researcher", probabilities: { researcher: 0.92, knower: 0.08, keep_with_sender: 0, owner_review: 0 } },
    processing_depth: { type: "choice", choice: "read_excerpt", probabilities: { metadata_only: 0.02, read_excerpt: 0.9, full_read: 0.08, owner_review: 0 } },
  },
};

describe("scraper link triage shadow", () => {
  it("is disabled by default and bounds owner focus", () => {
    expect(linkTriageConfig({})).toEqual({ enabled: false, focusContext: "" });
    expect(linkTriageConfig({ PIBOT_LINK_TRIAGE_SHADOW: "on", PIBOT_LINK_TRIAGE_FOCUS: "x".repeat(900) }).focusContext).toHaveLength(500);
  });

  it("normalizes provenance plus a bounded excerpt, without forwarding query parameters", async () => {
    const { agentDir, file } = material(source.replace("with citations and review steps.", "with citations and review steps at https://example.org/read?secret=abc."));
    expect(normalizeScraperMaterial(agentDir, file)).toMatchObject({ sourceHost: "example.org", title: "Better research notes", tool: "firecrawl", httpStatus: "200" });
    const evaluate = vi.fn(async () => good);
    const log = vi.fn();
    const result = await triageScraperMaterial(file, { agentDir, config: { enabled: true, focusContext: "Research source review" }, evaluate, log });
    expect(result).toEqual({ status: "suggestion", relevance: "relevant", destination: "researcher", processingDepth: "read_excerpt" });
    expect(evaluate).toHaveBeenCalledOnce();
    const state = (evaluate.mock.calls[0] as unknown as [{ state: unknown }])[0].state;
    expect(JSON.stringify(state)).not.toContain("private=token");
    expect(JSON.stringify(state)).not.toContain("secret=abc");
    expect(log.mock.calls[0][0]).not.toContain("example.org");
  });

  it("requires focus and sufficient source description before any remote call", async () => {
    const { agentDir, file } = material(source.replace(/This article explains[^\n]+/, "Short."));
    const evaluate = vi.fn(async () => good);
    expect(await triageScraperMaterial(file, { agentDir, config: { enabled: true, focusContext: "" }, evaluate })).toEqual({ status: "review_needed", reason: "missing_focus_context" });
    expect(await triageScraperMaterial(file, { agentDir, config: { enabled: true, focusContext: "Research" }, evaluate })).toEqual({ status: "review_needed", reason: "insufficient_description" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects material outside the scraper directory and private URLs", () => {
    const { agentDir, file } = material(source.replace("example.org", "localhost"));
    expect(normalizeScraperMaterial(agentDir, file)).toBeUndefined();
    const outside = path.join(agentDir, "outside.md");
    fs.writeFileSync(outside, source);
    expect(normalizeScraperMaterial(agentDir, outside)).toBeUndefined();
  });

  it("returns review needed on low probability or evaluator failure", async () => {
    const { agentDir, file } = material(source);
    const deps = { agentDir, config: { enabled: true, focusContext: "Research" } };
    const uncertain: JevResult = { ...good, answers: { ...good.answers, destination: { type: "choice", choice: "researcher", probabilities: { researcher: 0.6, knower: 0.4, keep_with_sender: 0, owner_review: 0 } } } };
    expect(await triageScraperMaterial(file, { ...deps, evaluate: async () => uncertain })).toEqual({ status: "review_needed", reason: "low_probability" });
    expect(await triageScraperMaterial(file, { ...deps, evaluate: async () => ({ ok: false, reason: "timeout", elapsedMs: 10 }) })).toEqual({ status: "review_needed", reason: "evaluator_unavailable" });
  });
});
