// ─── ACP client — drive an external ACP agent over stdio ────────────────────
//
// Spawns an ACP agent (e.g. `cmd acp`, Command Code) as a subprocess, performs
// the initialize handshake, opens a session, sends prompts and collects the
// session/update stream. The agent may call BACK into us while it works
// (fs/read_text_file, fs/write_text_file, session/request_permission); those
// are answered here. We advertise only the filesystem we can confine — never
// terminals — so an agent can always fall back to its own tools.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { childEnv } from "../core/child-env.js";
import { truncate } from "../core/util.js";
import {
  ACP_ERRORS,
  ACP_PROTOCOL_VERSION,
  LineDecoder,
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
  parseMessage,
  type AgentCapabilities,
  type ContentBlock,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type PermissionOption,
  type SessionUpdate,
  type StopReason,
} from "./protocol.js";

export interface AcpAgentSpec {
  /** human label for results and tool descriptions */
  label: string;
  /** executable on PATH (or an absolute path) */
  command: string;
  args: string[];
}

/**
 * ACP agents pibot may launch by name. `cmd acp` runs Command Code as an ACP
 * agent over stdio — the same binary the `/goal` method resolver documents.
 */
export const ACP_AGENTS: Record<string, AcpAgentSpec> = {
  cmd: { label: "Command Code", command: "cmd", args: ["acp"] },
};

export interface AcpClientOptions {
  command: string;
  args?: string[];
  /** session working directory (passed to the agent AND the fs confinement root) */
  cwd: string;
  /** extra env var names the agent may inherit (allowlisted env otherwise) */
  envPassthrough?: readonly string[];
  /** root filesystem requests must stay inside (defaults to `cwd`) */
  fsRoot?: string;
  /** how to answer session/request_permission (default "allow") */
  permission?: "allow" | "reject";
  /** called for every session/update notification */
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  /** agent stderr lines (diagnostics; the agent is free to log here) */
  onStderr?: (line: string) => void;
  /** per-request timeout, ms (default 120s; prompts use their own deadline) */
  requestTimeoutMs?: number;
}

export interface AcpPromptResult {
  stopReason: StopReason;
  /** every session/update seen during this prompt */
  updates: SessionUpdate[];
}

const DEFAULT_REQUEST_TIMEOUT = 120_000;

export class AcpClient {
  private child: ChildProcess | null = null;
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** updates collected while a prompt for this session is in flight */
  private collectors = new Map<string, SessionUpdate[]>();
  private exited = false;
  private readonly fsRoot: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly opts: AcpClientOptions) {
    this.fsRoot = path.resolve(opts.fsRoot ?? opts.cwd);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child) return;
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: childEnv({ passthrough: this.opts.envPassthrough }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string | Buffer) => {
      for (const line of this.decoder.push(chunk)) this.handleLine(line);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string | Buffer) => {
      for (const line of String(chunk).split("\n")) {
        const text = line.trim();
        if (text) this.opts.onStderr?.(text);
      }
    });
    child.on("error", (e) => this.failAll(`ACP agent failed to start: ${e.message}`));
    child.on("exit", (code, signal) => {
      this.exited = true;
      const tail = this.decoder.flush();
      for (const line of tail) this.handleLine(line);
      this.failAll(`ACP agent exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`);
    });
  }

  private write(msg: JsonRpcMessage): void {
    if (!this.child || this.exited) throw new Error("ACP agent is not running");
    this.child.stdin!.write(encodeMessage(msg));
  }

  private request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private failAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      this.opts.onStderr?.(`unparseable ACP output: ${parsed.error}`);
      return;
    }
    const msg = parsed.message;
    if (isRequest(msg)) {
      void this.handleIncoming(msg);
      return;
    }
    if (isResponse(msg)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
      return;
    }
    if (isNotification(msg)) {
      if (msg.method === "session/update") this.handleUpdate(msg.params);
    }
  }

  private handleUpdate(params: unknown): void {
    const p = params as { sessionId?: string; update?: SessionUpdate } | undefined;
    if (!p?.sessionId || !p.update) return;
    this.collectors.get(p.sessionId)?.push(p.update);
    this.opts.onUpdate?.(p.sessionId, p.update);
  }

  /** Requests the agent makes of the client while doing work. */
  private async handleIncoming(req: JsonRpcRequest): Promise<void> {
    try {
      switch (req.method) {
        case "session/request_permission": {
          const params = req.params as { options?: PermissionOption[] } | undefined;
          const options = params?.options ?? [];
          const want = (kind: string) => options.find((o) => o.kind === kind);
          const chosen =
            this.opts.permission === "reject"
              ? (want("reject_once") ?? want("reject_always") ?? options[options.length - 1])
              : (want("allow_once") ?? want("allow_always") ?? options.find((o) => String(o.kind ?? "").startsWith("allow")));
          this.respond(req.id, chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "cancelled" } });
          return;
        }
        case "fs/read_text_file": {
          const params = req.params as { path?: string; line?: number; limit?: number } | undefined;
          const target = this.confine(params?.path);
          const raw = fs.readFileSync(target, "utf8");
          this.respond(req.id, { content: sliceLines(raw, params?.line, params?.limit) });
          return;
        }
        case "fs/write_text_file": {
          const params = req.params as { path?: string; content?: string } | undefined;
          const target = this.confine(params?.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, params?.content ?? "");
          this.respond(req.id, {});
          return;
        }
        default:
          this.respondError(req.id, ACP_ERRORS.methodNotFound, `method not found: ${req.method}`);
      }
    } catch (e) {
      this.respondError(req.id, ACP_ERRORS.internalError, (e as Error).message);
    }
  }

  private respond(id: JsonRpcId, result: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", id, result });
    } catch {
      /* agent already gone */
    }
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    try {
      this.write({ jsonrpc: "2.0", id, error: { code, message } });
    } catch {
      /* agent already gone */
    }
  }

  /** Resolve an agent-supplied absolute path, refusing anything outside the root. */
  private confine(rawPath: string | undefined): string {
    if (!rawPath) throw new Error("missing path");
    const resolved = path.resolve(rawPath);
    const canonRoot = canonicalize(this.fsRoot);
    const canon = canonicalize(resolved);
    const rel = path.relative(canonRoot, canon);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) return canon;
    throw new Error(`path outside the session workspace: ${rawPath}`);
  }

  // ── protocol operations ───────────────────────────────────────────────────

  async initialize(): Promise<InitializeResult> {
    const result = (await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: "pibot", title: "pibot", version: "0.1.0" },
    })) as InitializeResult;
    return result;
  }

  async newSession(cwd = this.opts.cwd): Promise<string> {
    const result = (await this.request("session/new", { cwd, mcpServers: [] })) as { sessionId?: string };
    if (!result?.sessionId) throw new Error("ACP session/new returned no sessionId");
    this.collectors.set(result.sessionId, []);
    return result.sessionId;
  }

  /** Send one prompt and resolve when the agent ends the turn. */
  async prompt(sessionId: string, prompt: ContentBlock[] | string, timeoutMs?: number): Promise<AcpPromptResult> {
    const blocks: ContentBlock[] = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    const collected: SessionUpdate[] = [];
    this.collectors.set(sessionId, collected);
    try {
      const result = (await this.request("session/prompt", { sessionId, prompt: blocks }, timeoutMs ?? this.requestTimeoutMs)) as { stopReason?: StopReason };
      return { stopReason: result?.stopReason ?? "end_turn", updates: collected };
    } finally {
      this.collectors.delete(sessionId);
    }
  }

  /** Best-effort cancellation (a notification; the pending prompt ends "cancelled"). */
  cancel(sessionId: string): void {
    try {
      this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    } catch {
      /* agent already gone */
    }
  }

  /** Terminate the subprocess and reject anything still in flight. */
  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.failAll("ACP client disposed");
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        done();
      }, 3_000);
      force.unref?.();
    });
  }
}

/** Check a subprocess executable is resolvable before offering an ACP agent. */
export function acpAgentAvailable(spec: AcpAgentSpec): boolean {
  const candidates = spec.command.includes(path.sep)
    ? [spec.command]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, spec.command));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Names of the ACP agents actually installed on this host. */
export function installedAcpAgents(): string[] {
  return Object.keys(ACP_AGENTS).filter((name) => acpAgentAvailable(ACP_AGENTS[name]));
}

/** Canonical form of `p`: realpath of the deepest existing ancestor, remainder re-appended. */
function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(canonicalize(parent), path.basename(p));
}

/** ACP file reads may ask for a line window (1-based, inclusive start). */
function sliceLines(text: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return text;
  const lines = text.split("\n");
  const start = line && line > 0 ? line - 1 : 0;
  const end = limit && limit > 0 ? start + limit : undefined;
  return lines.slice(start, end).join("\n");
}

/** Compact one-line description of an ACP agent error for tool output. */
export function describeAcpFailure(e: unknown): string {
  return truncate(e instanceof Error ? e.message : String(e), 300);
}
