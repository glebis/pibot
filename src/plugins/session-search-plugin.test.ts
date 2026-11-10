import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { sessionSearchPlugin } from "./session-search-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type CapturedTool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown }> };

function captureTools(): { pi: ExtensionAPI; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t as CapturedTool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

function line(entry: unknown): string {
  return JSON.stringify(entry);
}

function messageFile(params: { timestamp: string; messages: Array<{ role: string; content: unknown }> }): string {
  const lines = [
    line({ type: "session", version: 1, id: "s", timestamp: params.timestamp }),
    ...params.messages.map((m) => line({ type: "message", timestamp: params.timestamp + "0", message: m })),
  ];
  return lines.join("\n") + "\n";
}

describe("session-search plugin", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-sess-"));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("registers session_search", () => {
    const { pi, tools } = captureTools();
    factoryOf(sessionSearchPlugin({ sessionsDir }))(pi);
    expect(tools.has("session_search")).toBe(true);
  });

  it("finds a keyword in past user and assistant messages with date, chat label and bounded snippet", async () => {
    const url = "https://linkedin.com/feed/update/urn:li:ugcPost:1234567890 — this is the one I promised to re-encode";
    const filler = "x".repeat(300);
    fs.writeFileSync(
      path.join(sessionsDir, "2026-10-24T10-42-20-307Z_01a1.jsonl"),
      messageFile({
        timestamp: "2026-10-24T10:42:20.307Z",
        messages: [
          { role: "user", content: `here are the links ${url}` },
          { role: "assistant", content: [{ type: "text", text: filler + " saw the linkedin link, will squash it later " + filler }] },
        ],
      }),
    );
    fs.writeFileSync(path.join(sessionsDir, "index.json"), JSON.stringify({ "telegram:42": "2026-10-24T10-42-20-307Z_01a1.jsonl" }));

    const { pi, tools } = captureTools();
    factoryOf(sessionSearchPlugin({ sessionsDir }))(pi);
    const res = await tools.get("session_search")!.execute("t1", { query: "linkedin" });
    const text = res.content[0].text;
    expect(text).toContain("2026-10-24");
    expect(text).toContain("chat telegram:42");
    expect(text).toContain("user:");
    expect(text).toContain("https://linkedin.com/feed/update/urn:li:ugcPost:1234567890");
    // the 300-char filler must NOT be dumped whole: snippets stay bounded
    expect(text).not.toContain(filler);
    expect((res.details as { matches: number }).matches).toBe(2);
  });

  it("searches only user/assistant text — tool results and thinking blocks stay out", async () => {
    fs.writeFileSync(
      path.join(sessionsDir, "2026-11-01T09-00-00-000Z_b.jsonl"),
      [
        line({ type: "session", version: 1, id: "s", timestamp: "2026-11-01T09:00:00Z" }),
        line({ type: "message", timestamp: "2026-11-01T09:00:01Z", message: { role: "toolResult", content: [{ type: "text", text: "raw export mentions sesamestreet here" }] } }),
        line({ type: "message", timestamp: "2026-11-01T09:00:02Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "thinking about sesamestreet secretly" }, { type: "text", text: "plain answer" }] } }),
        line({ type: "custom", someOther: "sesamestreet" }),
      ].join("\n") + "\n",
    );
    const { pi, tools } = captureTools();
    factoryOf(sessionSearchPlugin({ sessionsDir }))(pi);
    const res = await tools.get("session_search")!.execute("t1", { query: "sesamestreet" });
    expect(res.content[0].text).toContain("No transcripts of yours contain");
    expect(res.details).toMatchObject({ matches: 0 });
  });

  it("honours the after date filter and the limit window", async () => {
    const older = "2026-09-10T08-00-00-000Z_c1.jsonl";
    const newer = "2026-10-20T08-00-00-000Z_c2.jsonl";
    for (const [name, day] of [[older, "2026-09-10"], [newer, "2026-10-20"]] as const) {
      fs.writeFileSync(
        path.join(sessionsDir, name),
        messageFile({
          timestamp: day + "T08:00:00Z",
          messages: [{ role: "user", content: "remember the video vault " + day }],
        }),
      );
    }
    const { pi, tools } = captureTools();
    factoryOf(sessionSearchPlugin({ sessionsDir }))(pi);

    const after = await tools.get("session_search")!.execute("t1", { query: "video vault", after: "2026-10-01" });
    expect(after.content[0].text).toContain("2026-10-20");
    expect(after.content[0].text).not.toContain("2026-09-10");

    fs.rmSync(path.join(sessionsDir, older));
    for (let i = 0; i < 10; i++) {
      fs.copyFileSync(path.join(sessionsDir, newer), path.join(sessionsDir, `2026-10-2${i}T08-00-00-000Z_d${i}.jsonl`));
    }
    const limited = await tools.get("session_search")!.execute("t1", { query: "video vault", limit: 3 });
    const body = (limited.content[0].text as string).split("\n");
    expect(body.filter((l) => l.startsWith("- "))).toHaveLength(3);
    expect(limited.content[0].text).toContain("(+8 more");
    expect((limited.details as { matches: number }).matches).toBe(11); // newest-first window kept searching
  });

  it("answers with guidance on empty query, unparsable after, and an empty sessions dir", async () => {
    const { pi, tools } = captureTools();
    factoryOf(sessionSearchPlugin({ sessionsDir }))(pi);
    const empty = await tools.get("session_search")!.execute("t1", { query: "   " });
    expect(empty.content[0].text).toContain("Empty query");
    const badDate = await tools.get("session_search")!.execute("t1", { query: "x", after: "sometime last week" });
    expect(badDate.content[0].text).toContain("not a date");
    const none = await tools.get("session_search")!.execute("t1", { query: "anything" });
    expect(none.content[0].text).toContain("No past transcripts");
  });

  it("returns the match even when index.json is missing or corrupt", async () => {
    fs.writeFileSync(
      path.join(sessionsDir, "2026-10-30T12-00-00-000Z_e.jsonl"),
      messageFile({ timestamp: "2026-10-30T12:00:00Z", messages: [{ role: "user", content: "the master file is rough-cut.mp4" }] }),
    );
    fs.writeFileSync(path.join(sessionsDir, "index.json"), "{ not json");
    const { pi, tools } = captureTools();
    factoryOf(sessionSearchPlugin({ sessionsDir }))(pi);
    const res = await tools.get("session_search")!.execute("t1", { query: "rough-cut" });
    expect(res.content[0].text).toContain("rough-cut.mp4");
    expect(res.content[0].text).not.toContain("chat ");
  });
});
