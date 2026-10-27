import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpClient, acpAgentAvailable, installedAcpAgents } from "./client.js";
import { collectAgentText } from "../plugins/acp-plugin.js";

// A minimal ACP agent subprocess. It exercises the paths the client must serve
// while an agent works: permission requests, fs reads/writes, and cancellation.
const FAKE_AGENT = String.raw`
const readline = require("node:readline");
const path = require("node:path");
const rl = readline.createInterface({ input: process.stdin });
let nextId = 1000;
const pending = new Map();
let slowPrompt = null;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const request = (method, params) => { const id = nextId++; send({ jsonrpc: "2.0", id, method, params }); return new Promise((res) => pending.set(id, res)); };
const chunk = (sessionId, text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const finish = (id, stopReason) => send({ jsonrpc: "2.0", id, result: { stopReason } });
const inCwd = (...parts) => path.join(process.cwd(), ...parts);

rl.on("line", async (line) => {
  const t = line.trim();
  if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === undefined) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); } return; }
  const { id, method, params } = msg;
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake", version: "1" } } });
  if (method === "session/new") return send({ jsonrpc: "2.0", id, result: { sessionId: "s1" } });
  if (method === "session/cancel") { if (slowPrompt !== null) { const pid = slowPrompt; slowPrompt = null; finish(pid, "cancelled"); } return; }
  if (method === "session/prompt") {
    const sessionId = params.sessionId;
    const text = (params.prompt || []).map((b) => b.text || "").join("");
    if (text === "slow") { slowPrompt = id; return; }
    if (text === "escape") {
      const r = await request("fs/read_text_file", { sessionId, path: "/etc/hosts" });
      chunk(sessionId, "escape=" + (r.error ? r.error.code : "no-error"));
      return finish(id, "end_turn");
    }
    if (text === "write") {
      const w = await request("fs/write_text_file", { sessionId, path: inCwd("sub", "out.txt"), content: "written-by-agent" });
      chunk(sessionId, "write=" + (w.error ? "err" : "ok"));
      return finish(id, "end_turn");
    }
    const perm = await request("session/request_permission", { sessionId, toolCall: { toolCallId: "t1" }, options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ] });
    const read = await request("fs/read_text_file", { sessionId, path: inCwd("hello.txt") });
    chunk(sessionId, "perm=" + (perm.result && perm.result.outcome ? perm.result.outcome.optionId : "none") + " file=" + (read.result ? read.result.content.trim() : "ERR"));
    return finish(id, "end_turn");
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
});
`;

let dir: string;
let scriptPath: string;
let client: AcpClient | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-acp-"));
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello contents\n");
  scriptPath = path.join(dir, "fake-agent.cjs");
  fs.writeFileSync(scriptPath, FAKE_AGENT);
});

afterEach(async () => {
  await client?.dispose();
  client = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(permission: "allow" | "reject" = "allow"): AcpClient {
  client = new AcpClient({ command: process.execPath, args: [scriptPath], cwd: dir, fsRoot: dir, permission });
  client.start();
  return client;
}

describe("AcpClient against a real subprocess", () => {
  it("initializes, opens a session and answers the agent's permission + fs requests", async () => {
    const c = start("allow");
    const init = await c.initialize();
    expect(init.agentInfo?.name).toBe("fake");
    const sessionId = await c.newSession(dir);
    expect(sessionId).toBe("s1");

    const result = await c.prompt(sessionId, "hello");
    expect(result.stopReason).toBe("end_turn");
    const text = collectAgentText(result.updates);
    expect(text).toContain("perm=allow-once");
    expect(text).toContain("file=hello contents");
  });

  it("honours a reject policy for permission requests", async () => {
    const c = start("reject");
    await c.initialize();
    const sessionId = await c.newSession(dir);
    const result = await c.prompt(sessionId, "hello");
    expect(collectAgentText(result.updates)).toContain("perm=reject-once");
  });

  it("refuses filesystem requests outside the session workspace", async () => {
    const c = start();
    await c.initialize();
    const sessionId = await c.newSession(dir);
    const result = await c.prompt(sessionId, "escape");
    // -32603 internal error is what the client returns for a refused path
    expect(collectAgentText(result.updates)).toContain("escape=-32603");
  });

  it("serves fs/write_text_file, creating missing directories", async () => {
    const c = start();
    await c.initialize();
    const sessionId = await c.newSession(dir);
    const result = await c.prompt(sessionId, "write");
    expect(collectAgentText(result.updates)).toContain("write=ok");
    expect(fs.readFileSync(path.join(dir, "sub/out.txt"), "utf8")).toBe("written-by-agent");
  });

  it("cancels a running prompt", async () => {
    const c = start();
    await c.initialize();
    const sessionId = await c.newSession(dir);
    const pending = c.prompt(sessionId, "slow");
    c.cancel(sessionId);
    const result = await pending;
    expect(result.stopReason).toBe("cancelled");
  });

  it("rejects everything in flight once disposed", async () => {
    const c = start();
    await c.initialize();
    const sessionId = await c.newSession(dir);
    // attach the rejection handler BEFORE disposing so the rejection is never unhandled
    const assertion = expect(c.prompt(sessionId, "slow")).rejects.toThrow(/disposed|exited/);
    await c.dispose();
    client = null;
    await assertion;
  });

  it("times out a prompt the agent never finishes", async () => {
    const c = start();
    await c.initialize();
    const sessionId = await c.newSession(dir);
    await expect(c.prompt(sessionId, "slow", 300)).rejects.toThrow(/timed out/);
  });
});

describe("ACP agent discovery", () => {
  it("resolves an absolute executable and rejects a missing one", () => {
    expect(acpAgentAvailable({ label: "node", command: process.execPath, args: [] })).toBe(true);
    expect(acpAgentAvailable({ label: "ghost", command: "pibot-no-such-acp-binary", args: [] })).toBe(false);
  });

  it("lists installed ACP agents from the registry", () => {
    // Never asserts a specific host state — only that the list is filtered to
    // agents whose binary actually resolves.
    for (const name of installedAcpAgents()) expect(acpAgentAvailable({ label: name, command: name, args: [] })).toBe(true);
  });
});
