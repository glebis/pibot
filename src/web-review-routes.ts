import * as crypto from "node:crypto";
import type { EvolutionReviewDetail } from "./core/evolution.js";
import type { Hono } from "hono";
import type { WebDeps } from "./web.js";
import { renderReviewPage, type ReviewProposal } from "./web-review.js";

/** Covers both sides of the comparison so an old browser cannot apply a changed proposal. */
export function reviewContentHash(current: string | undefined | null, proposed: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([current ?? null, proposed])).digest("hex");
}

export function registerReviewRoutes(app: Hono, deps: WebDeps, csrfToken: string, origins: string[]): void {
  app.get("/review", c => {
    c.header("Cache-Control", "no-store");
    const proposals: ReviewProposal[] = [];
    for (const agent of deps.agents.list()) {
      const candidates: Array<EvolutionReviewDetail & {archiveId?:string}> = [
        ...deps.evolution.reviewDetails(agent.id),
        ...deps.evolution.archivedDetail(agent.id),
      ];
      for (const candidate of candidates) {
        const detail = candidate;
        if (!detail) continue;
        proposals.push({
          id: `${agent.id}/${candidate.name}${candidate.archiveId ? `/${candidate.archiveId}` : ""}`,
          agent: agent.id, name: candidate.name, mode: candidate.mode,
          description: candidate.description, content: candidate.content,
          currentContent: detail.currentContent,
          history: detail.history,
          scores: candidate.scores,
          stagedAt: new Date(candidate.stagedAt).toISOString(),
          status: candidate.archiveId ? "archived" : "staged",
          archiveId: candidate.archiveId,
          contentHash: reviewContentHash(detail.currentContent, candidate.content),
        });
      }
    }
    const tab = c.req.query("tab");
    return c.html(renderReviewPage({
      proposals, csrfToken, selectedId: c.req.query("id"), query: c.req.query("q"),
      agent: c.req.query("agent"), focus: c.req.query("focus"),
      tab: tab === "source" || tab === "evolution" ? tab : "compare",
      notice: c.req.query("msg"), status: c.req.query("status"),
      undo: c.req.query("msg")?.startsWith("Proposal archived") ? proposals.filter(p => p.status === "archived" && p.id === c.req.query("id")).map(p => ({agent:p.agent,name:p.name,archiveId:p.archiveId!}))[0] : undefined,
    }));
  });

  for (const action of ["apply", "archive", "restore"] as const) {
    app.post(`/review/:agent/:name/${action}`, async c => {
      const origin = c.req.header("origin");
      if (origin && !origins.includes(origin)) return c.text("Unexpected request origin", 403);
      const body = await c.req.parseBody().catch(() => ({})) as Record<string, unknown>;
      if (body._csrf !== csrfToken) return c.text("CSRF failed", 403);
      const agent = c.req.param("agent");
      const name = c.req.param("name");
      if (!deps.agents.getAgent(agent)) return c.notFound();
      const back = (msg: string) => `/review?${new URLSearchParams({ agent, id: `${agent}/${name}`, msg })}`;
      if (action === "restore") {
        const ok = deps.evolution.restore(agent, name, String(body.archiveId ?? ""));
        return c.redirect(back(ok ? "Proposal restored. Review it before applying." : "Could not restore: another proposal may already use this name."), 303);
      }
      const candidate = deps.evolution.reviewDetail(agent, name);
      if (!candidate) return c.text("This proposal is no longer staged. Reload the review queue.", 409);
      if (action === "apply") {
        const expected = reviewContentHash(candidate.currentContent, candidate.content);
        if (body.contentHash !== expected) return c.text("The installed skill or proposal changed after you opened it. Reload and compare again before applying.", 409);
        const ok = deps.evolution.promote(agent, name);
        return c.redirect(back(ok ? `Applied ${name} to ${agent}.` : "Not applied. Check agent policy and reload the proposal."), 303);
      }
      const archived = deps.evolution.archive(agent, name);
      return c.redirect(archived ? `/review?${new URLSearchParams({agent,status:"archived",id:`${agent}/${name}/${archived}`,msg:"Proposal archived. Restore it here or return to awaiting review."})}` : back("Nothing archived. Reload the queue."), 303);
    });
  }
}
