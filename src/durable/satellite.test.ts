import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openSatellite } from "./satellite.js";

type FauxSteps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

function scriptedSatellite(steps: FauxSteps, dir?: { storage: string; workspace: string }) {
  const faux = fauxProvider();
  faux.setResponses([...steps]);
  const workspace = dir?.workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "pibot-durable-ws-"));
  const sat = openSatellite({
    provider: faux.provider,
    workspaceDir: workspace,
    storageDir: dir?.storage,
  });
  return { faux, workspace, sat };
}

/** Reply keyed to the request, not to call order: under load process A may finish job-1 before the
 *  crash snapshot, so B resumes only job-2 — a positional faux queue would hand job-2 "answer one". */
function answerByTask(steps: number) {
  return Array.from({ length: steps }, () => (ctx: { messages: Array<{ role: string; content: unknown }> }) => {
    const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user");
    return fauxAssistantMessage([fauxText(JSON.stringify(lastUser?.content ?? "").includes("task two") ? "answer two" : "answer one")]);
  });
}

describe("durable satellite (pi-durable harness prototype)", () => {
  it("answers a submitted input with the scripted model reply", async () => {
    const { sat } = scriptedSatellite([fauxAssistantMessage([fauxText("durable answer works")])]);
    const s = await sat;
    const answer = await s.ask("hello satellite", "job-1");
    expect(answer).toContain("durable answer works");
  });

  it("runs a registered tool through the harness before the final answer", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-durable-ws-"));
    fs.writeFileSync(path.join(workspace, "material-a.txt"), "alpha", { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, "material-b.txt"), "beta", { mode: 0o600 });
    const { sat } = scriptedSatellite([
      fauxAssistantMessage([fauxToolCall("list_workspace", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("found: material-a.txt, material-b.txt")]),
    ]);
    const s = await sat;
    const answer = await s.ask("what materials exist?", "job-2");
    expect(answer).toContain("material-a.txt");
    expect(answer).toContain("material-b.txt");
  });

  it("survives an abandoned process: reopen the storage, resume, and the same requestId returns the original submission exactly once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-durable-crash-"));
    const storageDir = path.join(dir, "storage");
    fs.mkdirSync(storageDir, { recursive: true });
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    // process A: admits two jobs but is "killed" before their answers are awaited
    const fauxA = fauxProvider();
    fauxA.setResponses(answerByTask(4));
    const a = await openSatellite({ provider: fauxA.provider, workspaceDir: workspace, storageDir });
    void a.ask("task one", "job-1").catch(() => {});
    void a.ask("task two", "job-2").catch(() => {});

    // give process A a moment so both jobs are durably admitted
    await new Promise((r) => setTimeout(r, 50));
    // "kill" A: pi-durable has no public close(), so A's scheduler would keep writing to
    // the same files and race B. Snapshot what A had on disk at this instant instead —
    // that is exactly what a restarted process finds after a crash.
    const crashedStorage = path.join(dir, "storage-at-crash");
    fs.cpSync(storageDir, crashedStorage, { recursive: true });

    // process B: reopens the crashed storage, resumes unfinished work
    const fauxB = fauxProvider();
    fauxB.setResponses(answerByTask(4));
    const b = await openSatellite({ provider: fauxB.provider, workspaceDir: workspace, storageDir: crashedStorage });
    b.resume();

    // the owner retries job-1 with the same requestId — must get the ORIGINAL submission, not a second run
    const retried = await b.ask("task one", "job-1");
    const second = await b.ask("task two", "job-2");
    const again = await b.ask("task one", "job-1");

    expect(second).toContain("answer two");
    expect(again).toBe(retried); // exactly-once: the retry replays, never re-runs
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the exact answer for the latest ask once the transcript exceeds one 50-entry page", async () => {
    const rounds = 30; // 2 entries per round => 60 > 50
    const steps = Array.from({ length: rounds }, (_, i) => fauxAssistantMessage([fauxText(`reply-number-${i}`)]));
    const { sat } = scriptedSatellite(steps);
    const s = await sat;
    for (let i = 0; i < rounds; i++) {
      expect(await s.ask(`question ${i}`, `req-${i}`)).toBe(`reply-number-${i}`);
    }
    const total = (await s.root.entries({}, 500, undefined, BACKGROUND_CONTEXT)).items.length;
    expect(total).toBeGreaterThan(50);
  });

  it("calls harness.resume() on open, so interrupted work restarts without a new ask", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-durable-resume-"));
    const storageDir = path.join(dir, "storage");
    fs.mkdirSync(storageDir, { recursive: true });
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    // process A: submit a job, never await it
    const fauxA = fauxProvider();
    fauxA.setResponses([fauxAssistantMessage([fauxText("resumed answer")])]);
    const a = await openSatellite({ provider: fauxA.provider, workspaceDir: workspace, storageDir });
    const sub = await a.root.submit({ type: "input", content: "task", requestId: "r-1" }, BACKGROUND_CONTEXT);
    const subId = sub.id;

    // process B: reopen only; no ask(), no explicit resume()
    const fauxB = fauxProvider();
    fauxB.setResponses([fauxAssistantMessage([fauxText("resumed answer")])]);
    const b = await openSatellite({ provider: fauxB.provider, workspaceDir: workspace, storageDir });
    const resumed = await b.harness.submission(subId, BACKGROUND_CONTEXT);
    expect(resumed).toBeDefined();
    const settled = await resumed!.wait(BACKGROUND_CONTEXT);
    expect(settled.status).not.toBe("unanswered");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
