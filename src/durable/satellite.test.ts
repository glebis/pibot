import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
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
    fauxA.setResponses([fauxAssistantMessage([fauxText("answer one")]), fauxAssistantMessage([fauxText("answer two")])]);
    const a = await openSatellite({ provider: fauxA.provider, workspaceDir: workspace, storageDir });
    void a.ask("task one", "job-1").catch(() => {});
    void a.ask("task two", "job-2").catch(() => {});

    // give process A a moment so both jobs are durably admitted
    await new Promise((r) => setTimeout(r, 50));
    // "kill" A: drop all references without waiting for answers

    // process B: reopens the same storage, resumes unfinished work
    const fauxB = fauxProvider();
    fauxB.setResponses([fauxAssistantMessage([fauxText("answer one")]), fauxAssistantMessage([fauxText("answer two")])]);
    const b = await openSatellite({ provider: fauxB.provider, workspaceDir: workspace, storageDir });
    b.resume();

    // the owner retries job-1 with the same requestId — must get the ORIGINAL submission, not a second run
    const retried = await b.ask("task one", "job-1");
    const second = await b.ask("task two", "job-2");
    const again = await b.ask("task one", "job-1");

    expect(second).toContain("answer two");
    expect(again).toBe(retried); // exactly-once: the retry replays, never re-runs
    fs.rmSync(dir, { recursive: true, force: true });
  });
});