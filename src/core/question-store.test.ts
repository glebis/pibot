// Durable owner questions (bd pibot-jciq).
// The failure these cover: a restart while a question is pending used to lose it,
// so the owner's tap hit an unknown qid (reported stale, answer discarded) and the
// asking turn waited out its timeout.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionStore, type QuestionRecord } from "./question-store.js";
import { QuestionBus, type QuestionSpec } from "./questions.js";
import type { ChatRef } from "./types.js";

const CHAT: ChatRef = { transport: "mock", chatId: "42" };
const spec = (over: Partial<QuestionSpec> = {}): QuestionSpec => ({ text: "which account?", options: ["client", "personal", "own-account"], ...over });

function transport() {
  return { push: vi.fn(async () => ({ messageId: 1 })) };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-questions-"));
  file = path.join(dir, "questions.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const busWith = (store?: QuestionStore, t: unknown = transport()) => {
  const tr = t as { push: ReturnType<typeof vi.fn> };
  return { bus: new QuestionBus({ getTransport: () => tr as never, store }), tr };
};

/** Write what a previous process left in its journal: a question already shown to the owner. */
function seed(rec: { qid: string; questionKey?: string; pendingUntil?: number }): QuestionRecord {
  const record: QuestionRecord = {
    snapshot: {
      qid: rec.qid,
      agentId: "assistant",
      canonicalChatId: "mock:42",
      question: "which account?",
      options: ["client", "personal", "own-account"],
      revision: "sha256:seeded",
      createdAt: Date.now() - 1_000,
      pendingUntil: rec.pendingUntil ?? Date.now() + 600_000,
      acceptedMessageAt: Date.now() - 900,
      status: "pending",
    },
    spec: spec(),
    ...(rec.questionKey !== undefined ? { questionKey: rec.questionKey } : {}),
    recordedAt: Date.now() - 1_000,
  };
  fs.writeFileSync(file, JSON.stringify({ records: [record] }));
  return record;
}

describe("QuestionStore", () => {
  it("survives a reopen with its pending question intact", async () => {
    const { bus, tr } = busWith(new QuestionStore(file));
    const waiting = bus.ask("assistant", CHAT, spec());
    await vi.waitFor(() => expect(tr.push).toHaveBeenCalled());
    const qid = bus.pendingSnapshots()[0].qid;
    expect(new QuestionStore(file).get(qid)?.snapshot.status).toBe("pending");
    bus.cancelPending("mock:42");
    await waiting;
  });

  it("answers a question restored after a restart instead of reporting it stale", () => {
    seed({ qid: "q_restored", questionKey: "task:t1:which-account" });
    const store = new QuestionStore(file);
    const { bus } = busWith(store);
    expect(bus.pendingSnapshots().map((s) => s.qid)).toContain("q_restored");
    expect(bus.resolveCallback("q:q_restored:1")).toEqual({ choice: "personal", index: 1, via: "button" });
    expect(new QuestionStore(file).get("q_restored")?.answer).toEqual({ choice: "personal", index: 1, via: "button" });
  });

  it("reports an answer given while no process was listening, and the resumed turn reads it by key", () => {
    seed({ qid: "q_offline", questionKey: "task:t2:which-account" });
    const store = new QuestionStore(file);
    const { bus } = busWith(store);
    bus.resolveCallback("q:q_offline:2");

    const offline = bus.answersRecordedOffline();
    expect(offline).toHaveLength(1);
    expect(offline[0]).toMatchObject({ qid: "q_offline", chatKey: "mock:42", questionKey: "task:t2:which-account", answer: { choice: "own-account", index: 2 } });
    expect(bus.answerFor("task:t2:which-account")).toMatchObject({ choice: "own-account" });
  });

  it("answers a restored question from typed text and records it durably", () => {
    seed({ qid: "q_typed" });
    const store = new QuestionStore(file);
    const { bus } = busWith(store);
    expect(bus.answerViaText("mock:42", "own-account")).toBe(true);
    expect(store.get("q_typed")?.answer).toMatchObject({ choice: "own-account", via: "text" });
  });

  it("never resolves a question late: an expired window rejects the tap", () => {
    seed({ qid: "q_old", pendingUntil: Date.now() - 1_000 });
    const store = new QuestionStore(file);
    const { bus } = busWith(store);
    expect(bus.resolveCallback("q:q_old:0")).toBeNull();
    expect(store.get("q_old")?.answer).toBeUndefined();
    expect(store.get("q_old")?.snapshot.status).toBe("expired");
  });

  it("keeps the recorded answer when a duplicate tap arrives afterwards", async () => {
    const { bus, tr } = busWith(new QuestionStore(file));
    const waiting = bus.ask("assistant", CHAT, spec());
    await vi.waitFor(() => expect(tr.push).toHaveBeenCalled());
    const qid = bus.pendingSnapshots()[0].qid;
    bus.resolveCallback(`q:${qid}:0`);
    await waiting;
    expect(new QuestionStore(file).get(qid)?.answer?.choice).toBe("client");

    // the replayed tap finds nothing live, and never rewrites the journal
    const reopened = new QuestionStore(file);
    const { bus: second } = busWith(reopened);
    expect(second.resolveCallback(`q:${qid}:2`)).toBeNull();
    expect(reopened.get(qid)?.answer?.choice).toBe("client");
  });

  it("a resumed ask() with the same questionKey returns the recorded answer without asking again", async () => {
    const first = busWith(new QuestionStore(file));
    const waiting = first.bus.ask("assistant", CHAT, spec({ questionKey: "task:t9:go?" }));
    await vi.waitFor(() => expect(first.tr.push).toHaveBeenCalled());
    first.bus.resolveCallback(`q:${first.bus.pendingSnapshots()[0].qid}:0`);
    await waiting;

    const t2 = transport();
    const resumed = busWith(new QuestionStore(file), t2);
    expect(await resumed.bus.ask("assistant", CHAT, spec({ questionKey: "task:t9:go?" }))).toMatchObject({ choice: "client", index: 0 });
    expect(t2.push).not.toHaveBeenCalled();
  });

  it("a resumed ask() re-attaches to the question still on the owner's screen", async () => {
    seed({ qid: "q_live", questionKey: "task:t4:go?" });
    const store = new QuestionStore(file);
    const { bus } = busWith(store);
    const resumed = bus.ask("assistant", CHAT, spec({ questionKey: "task:t4:go?" }));
    // no second message: the owner already has this question open
    expect(bus.resolveCallback("q:q_live:1")?.choice).toBe("personal");
    expect(await resumed).toMatchObject({ choice: "personal", index: 1 });
  });

  it("a resumed ask() whose window closed while down reports a timeout without asking again", async () => {
    seed({ qid: "q_closed", questionKey: "task:t3:go?", pendingUntil: Date.now() - 1_000 });
    const t2 = transport();
    const resumed = busWith(new QuestionStore(file), t2);
    expect(await resumed.bus.ask("assistant", CHAT, spec({ questionKey: "task:t3:go?" }))).toMatchObject({ timedOut: true });
    expect(t2.push).not.toHaveBeenCalled();
  });

  it("drops a corrupt journal entry instead of the whole journal", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        records: [
          { snapshot: null },
          {
            snapshot: { qid: "q_ok", agentId: "a", canonicalChatId: "mock:42", question: "q", options: ["a", "b"], revision: "r", createdAt: Date.now(), pendingUntil: Date.now() + 60_000, status: "pending" },
            spec: spec(),
            recordedAt: Date.now(),
          },
        ],
      }),
    );
    expect(new QuestionStore(file).listPending().map((r) => r.snapshot.qid)).toEqual(["q_ok"]);
  });

  it("an unparseable journal file falls back to empty instead of throwing", () => {
    fs.writeFileSync(file, "{not json");
    expect(() => new QuestionStore(file)).not.toThrow();
    expect(new QuestionStore(file).listPending()).toHaveLength(0);
  });

  it("keeps the journal owner-only", async () => {
    const { bus, tr } = busWith(new QuestionStore(file));
    const waiting = bus.ask("assistant", CHAT, spec());
    await vi.waitFor(() => expect(tr.push).toHaveBeenCalled());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    bus.cancelPending("mock:42");
    await waiting;
  });
});

describe("QuestionBus without a store (in-memory, unchanged)", () => {
  it("still asks, answers and rejects stale ids", async () => {
    const { bus, tr } = busWith();
    const pending = bus.ask("assistant", CHAT, spec());
    await vi.waitFor(() => expect(tr.push).toHaveBeenCalled());
    const qid = bus.pendingSnapshots()[0].qid;
    expect(bus.resolveCallback(`q:${qid}:1`, "mock:42")?.choice).toBe("personal");
    expect(await pending).toMatchObject({ choice: "personal", index: 1 });
    expect(bus.resolveCallback(`q:${qid}:1`)).toBeNull();
  });
});
