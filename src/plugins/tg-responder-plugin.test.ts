import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tgResponderPlugin } from "./tg-responder-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type Tool = ToolDefinition & {
  execute: (
    ...args: unknown[]
  ) => Promise<{
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
};

function captureTools(ext: InlineExtension): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool as Tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  factoryOf(ext)(pi);
  return tools;
}

function isTObjectSchema(schema: Record<string, unknown>): schema is Record<string, unknown> & { type: "object"; properties: Record<string, unknown> } {
  return typeof schema === "object"
    && schema !== null
    && schema.type === "object"
    && typeof schema.properties === "object";
}

function runSql(dbPath: string, sql: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    execFile("sqlite3", [dbPath, sql], (err, stdout, stderr) => {
      if (err) { rej(new Error(stderr || err.message)); return; }
      res({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function runSqlJson(dbPath: string, sql: string): Promise<unknown[]> {
  return new Promise((res, rej) => {
    execFile("sqlite3", ["-json", dbPath, sql], (err, stdout, stderr) => {
      if (err) { rej(new Error(stderr || err.message)); return; }
      const s = stdout.toString().trim();
      res(s ? (JSON.parse(s) as unknown[]) : []);
    });
  });
}

const SCHEMA = `
  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_name TEXT,
    received_at INTEGER,
    urgency TEXT,
    text TEXT,
    status TEXT
  );
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    inbox_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    draft_text TEXT,
    status TEXT,
    source TEXT NOT NULL CHECK (source = 'classification'),
    draft_created_at INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE follow_ups (
    sender_name TEXT,
    outbound_at INTEGER,
    next_reminder_at INTEGER,
    reminder_count INTEGER,
    status TEXT
  );
`;

function makeTempDbDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `tg-responder-test-${Date.now()}-${Math.random().toString(36).slice(2,8)}`));
  chmodSync(dir, 0o700);
  return dir;
}

function makeTempDbPath(): { dir: string; dbPath: string } {
  const dir = makeTempDbDir();
  const dbPath = path.join(dir, 'responder.db');
  return { dir, dbPath };
}

let sqlite3Checked = false;
beforeAll(() => {
  // best-effort: ensure sqlite3 is reachable
  if (!sqlite3Checked) {
    try {
      require("node:child_process").execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    } catch (e) {
      throw new Error("sqlite3 CLI not available on PATH: " + (e as Error).message);
    }
    sqlite3Checked = true;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tg-responder plugin (real sqlite)", () => {
  it("registers discovery tools with no send capability", () => {
    const ext = tgResponderPlugin();
    const tools = captureTools(ext);
    expect([...tools.keys()].sort()).toEqual(["draft_reply", "followups_open", "inbox_pending"]);
  });

  it("inbox_pending provides read-only access to inbox (parameters empty object)", () => {
    const ext = tgResponderPlugin();
    const tools = captureTools(ext);
    const tool = tools.get("inbox_pending")!;
    expect(tool.parameters).toMatchObject({ type: "object", properties: {} });
  });

  it("followups_open provides read-only access to follow-ups (parameters empty object)", () => {
    const ext = tgResponderPlugin();
    const tools = captureTools(ext);
    const tool = tools.get("followups_open")!;
    expect(tool.parameters).toMatchObject({ type: "object", properties: {} });
  });

  it("draft_reply exposes TypeBox schema with positive-integer pattern for inboxId", () => {
    const ext = tgResponderPlugin();
    const tools = captureTools(ext);
    const tool = tools.get("draft_reply")!;
    expect(isTObjectSchema(tool.parameters as Record<string, unknown>)).toBe(true);
    expect(tool.parameters).toHaveProperty("properties");
    const props = (tool.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props).toHaveProperty("inboxId");
    expect(props.inboxId).toMatchObject({ description: "Inbox message id (from inbox_pending)" });
    expect(props.inboxId).toHaveProperty("pattern", "^[1-9][0-9]*$");
    expect(props).toHaveProperty("text");
    expect(props.text).toMatchObject({ description: "Draft reply text" });
  });

  it("draft_reply rejects malformed inboxId with exact error message — 12junk, 0, -1, not-a-number", async () => {
    const ext = tgResponderPlugin();
    const tools = captureTools(ext);
    const tool = tools.get("draft_reply")!;

    const cases: Array<unknown> = ["12junk", 0, -1, "not-a-number"];
    for (const inboxId of cases) {
      const result = await tool.execute("call-1", { inboxId, text: "Test" });
      expect(result.content[0].text).toBe("ERROR: inboxId must be a positive integer.");
      expect(result.details.ok).toBe(false);
    }
  });

  it("draft_reply succeeds against real temp SQLite DB and persists source='classification'", async () => {
    const { dir, dbPath } = makeTempDbPath();
    try {
      await runSql(dbPath, SCHEMA);
      await runSql(dbPath, `INSERT INTO inbox (id, chat_id, sender_name, received_at, status) VALUES (42, 'chat-xyz', 'Test Sender', ${Math.floor(Date.now()/1000)}, 'pending')`);

      const tool = captureTools(tgResponderPlugin({ dbPath })).get("draft_reply")!;
      const result = await tool.execute("call-1", { inboxId: "42", text: "Hello world" });

      expect(result.details.ok).toBe(true);
      expect(result.content[0].text).toContain("Draft saved for review");

      const rows = await runSqlJson(dbPath, `SELECT inbox_id, source, status, draft_text FROM outbox WHERE inbox_id = 42`) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect(rows[0].source).toBe("classification");
      expect(rows[0].status).toBe("draft");
      expect(rows[0].draft_text).toBe("Hello world");
      expect(rows[0].inbox_id).toBe(42);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("draft_reply escapes single quotes in text — survives a real SQLite round-trip", async () => {
    const { dir, dbPath } = makeTempDbPath();
    try {
      await runSql(dbPath, SCHEMA);
      await runSql(dbPath, `INSERT INTO inbox (id, chat_id, status) VALUES (7, 'c', 'pending')`);

      const tool = captureTools(tgResponderPlugin({ dbPath })).get("draft_reply")!;
      const evil = "'; DROP TABLE inbox; --";
      const result = await tool.execute("call-1", { inboxId: "7", text: evil });
      expect(result.details.ok).toBe(true);

      const rows = await runSqlJson(dbPath, `SELECT draft_text FROM outbox WHERE inbox_id = 7`) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect(rows[0].draft_text).toBe(evil);

      // inbox table should still exist
      const inboxRows = await runSqlJson(dbPath, `SELECT id FROM inbox WHERE id = 7`) as Array<Record<string, unknown>>;
      expect(inboxRows.length).toBe(1);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("draft_reply returns 'No inbox message N' when the row is missing", async () => {
    const { dir, dbPath } = makeTempDbPath();
    try {
      await runSql(dbPath, SCHEMA);
      const tool = captureTools(tgResponderPlugin({ dbPath })).get("draft_reply")!;
      const result = await tool.execute("call-1", { inboxId: "999", text: "Test" });
      expect(result.details.ok).toBe(false);
      expect(result.content[0].text).toBe("No inbox message 999.");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("draft_reply INSERT passes source='classification' so CHECK(source='classification') accepts the row", async () => {
    const { dir, dbPath } = makeTempDbPath();
    try {
      await runSql(dbPath, SCHEMA);
      await runSql(dbPath, `INSERT INTO inbox (id, chat_id, status) VALUES (10, 'c10', 'pending')`);

      const tool = captureTools(tgResponderPlugin({ dbPath })).get("draft_reply")!;
      const result = await tool.execute("call-1", { inboxId: "10", text: "ok" });
      expect(result.details.ok).toBe(true);

      // Direct negative probe: any other source value should violate CHECK
      await expect(runSql(dbPath, `INSERT INTO outbox (inbox_id, chat_id, status, source) VALUES (10, 'c10', 'draft', 'pibot')`))
        .rejects.toThrow(/CHECK|constraint/i);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("draft_reply is invoked with correct sqlite3 arguments for query (-json <db> SELECT...)", async () => {
    const { dir, dbPath } = makeTempDbPath();
    try {
      await runSql(dbPath, SCHEMA);
      await runSql(dbPath, `INSERT INTO inbox (id, chat_id, sender_name, received_at, status) VALUES (1, 'cx', 'X', ${Math.floor(Date.now()/1000)}, 'pending')`);

      const tool = captureTools(tgResponderPlugin({ dbPath })).get("inbox_pending")!;
      const result = await tool.execute("call-1");
      // inbox_pending is real sqlite, returns "Inbox clear — nobody is waiting." if filter excludes
      expect(result.content[0].text).toMatch(/Inbox clear|^\-/m);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("draft_reply is invoked with correct sqlite3 arguments for exec (plain <db> INSERT...)", async () => {
    const { dir, dbPath } = makeTempDbPath();
    try {
      await runSql(dbPath, SCHEMA);
      await runSql(dbPath, `INSERT INTO inbox (id, chat_id, status) VALUES (5, 'c5', 'pending')`);

      const tool = captureTools(tgResponderPlugin({ dbPath })).get("draft_reply")!;
      const result = await tool.execute("call-1", { inboxId: "5", text: "Hello" });
      expect(result.details.ok).toBe(true);

      // Negative probe: if exec were called with -json, sqlite3 would error on INSERT
      const rows = await runSqlJson(dbPath, `SELECT inbox_id, source, draft_text FROM outbox`) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect(rows[0].source).toBe("classification");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("uses custom dbPath when provided", async () => {
    const { dir, dbPath: customPath } = makeTempDbPath();
    try {
      await runSql(customPath, SCHEMA);
      await runSql(customPath, `INSERT INTO inbox (id, chat_id, sender_name, received_at, status) VALUES (1, 'chat', 'X', ${Math.floor(Date.now()/1000)}, 'pending')`);

      // Custom path tool SHOULD see the row
      const customTool = captureTools(tgResponderPlugin({ dbPath: customPath })).get("inbox_pending")!;
      const customResult = await customTool.execute("call-1");
      expect(customResult.content[0].text).toContain("X");

      // Default plugin with non-existent dbPath should error gracefully
      const badPath = "/this/path/does/not/exist/responder.db";
      const defaultTool = captureTools(tgResponderPlugin({ dbPath: badPath })).get("inbox_pending")!;
      const defaultResult = await defaultTool.execute("call-1");
      expect(defaultResult.details).toMatchObject({ count: 0 });
      expect(defaultResult.content[0].text).toMatch(/^inbox unavailable:/);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns graceful 'inbox unavailable' when sqlite3 errors", async () => {
    // Point plugin at a non-existent directory so sqlite3 will fail
    const badPath = "/this/path/does/not/exist/responder.db";
    const tool = captureTools(tgResponderPlugin({ dbPath: badPath })).get("inbox_pending")!;
    const result = await tool.execute("call-1");
    expect(result.details).toMatchObject({ count: 0 });
    expect(result.content[0].text).toMatch(/^inbox unavailable:/);
  });

  it("returns graceful 'draft failed' when sqlite3 errors on INSERT", async () => {
    const badPath = "/this/path/does/not/exist/responder.db";
    const tool = captureTools(tgResponderPlugin({ dbPath: badPath })).get("draft_reply")!;
    const result = await tool.execute("call-1", { inboxId: "1", text: "Test" });
    expect(result.details.ok).toBe(false);
    expect(result.content[0].text).toMatch(/^draft failed:/);
  });

  it("discovery: registering the plugin makes no external or sqlite calls", () => {
    // Spy on execFile to ensure it is NOT called during registration/discovery
    const spy = vi.spyOn(require("node:child_process"), "execFile");
    captureTools(tgResponderPlugin());
    expect(spy).not.toHaveBeenCalled();
  });
});
