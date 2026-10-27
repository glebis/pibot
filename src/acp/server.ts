// ─── ACP server — serve pibot agents to an ACP client over stdio ────────────
//
// The other side of the wire from client.ts: an editor (Zed, …) launches pibot
// as an ACP agent, performs `initialize`, opens sessions and sends prompts.
// This class owns ONLY the protocol — JSON-RPC routing, session bookkeeping,
// cancellation — and delegates the actual turn to an injected `prompt`
// handler (src/acp/agent.ts wires that to a pibot agent session).
//
// Framing is newline-delimited JSON-RPC on the given streams. Diagnostics go
// to stderr via `log`; nothing else may touch the output stream.

import {
  ACP_ERRORS,
  ACP_PROTOCOL_VERSION,
  LineDecoder,
  encodeMessage,
  isNotification,
  isRequest,
  parseMessage,
  type AgentInfo,
  type ContentBlock,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type SessionUpdate,
  type StopReason,
} from "./protocol.js";

export interface AcpPromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
  /** send a session/update notification for this session */
  emit: (update: SessionUpdate) => void;
  /** aborted when the client sends session/cancel */
  signal: AbortSignal;
}

export interface AcpServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  agentInfo: AgentInfo;
  /** run one prompt turn; resolve with its stop reason */
  prompt: (req: AcpPromptRequest) => Promise<StopReason>;
  onSessionNew?: (info: { sessionId: string; cwd: string }) => void;
  log?: (message: string) => void;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  abort?: AbortController;
  currentModeId?: string;
}

/**
 * Minimal ACP v1 agent: initialize, authenticate, session/new, session/prompt,
 * session/cancel, session/set_mode. Anything else is answered method-not-found,
 * which is also the correct reply for the capability-gated methods we do not
 * advertise (loadSession is false, so a client must not call session/load).
 */
export class AcpServer {
  private decoder = new LineDecoder();
  private sessions = new Map<string, SessionState>();
  private counter = 0;

  constructor(private readonly opts: AcpServerOptions) {}

  start(): void {
    const input = this.opts.input;
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      for (const line of this.decoder.push(chunk)) this.handleLine(line);
    });
    input.on("end", () => {
      for (const line of this.decoder.flush()) this.handleLine(line);
    });
  }

  /** Current sessions, for host diagnostics. */
  listSessions(): Array<{ sessionId: string; cwd: string }> {
    return [...this.sessions.values()].map((s) => ({ sessionId: s.sessionId, cwd: s.cwd }));
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  private send(msg: JsonRpcMessage): void {
    (this.opts.output as NodeJS.WritableStream).write(encodeMessage(msg));
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** session/update is a notification (no id) — it must never be answered. */
  private notify(sessionId: string, update: SessionUpdate): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  private handleLine(line: string): void {
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      this.log(`unparseable ACP input: ${parsed.error}`);
      return;
    }
    const msg = parsed.message;
    // session/cancel arrives as a NOTIFICATION (no id) — it must still be routed.
    if (isNotification(msg)) {
      if (msg.method === "session/cancel") this.handleCancel((msg.params ?? undefined) as { sessionId?: string } | undefined);
      return;
    }
    if (!isRequest(msg)) return; // responses are ours to ignore
    void this.route(msg);
  }

  private async route(req: JsonRpcRequest): Promise<void> {
    try {
      switch (req.method) {
        case "initialize":
          return this.handleInitialize(req);
        case "authenticate":
          // No auth: the agent runs with its own configured model access.
          return this.respond(req.id, {});
        case "session/new":
          return this.handleNewSession(req);
        case "session/prompt":
          return void (await this.handlePrompt(req));
        case "session/cancel":
          return this.handleCancel((req.params ?? undefined) as { sessionId?: string } | undefined);
        case "session/set_mode":
          return this.handleSetMode(req);
        default:
          return this.respondError(req.id, ACP_ERRORS.methodNotFound, `method not found: ${req.method}`);
      }
    } catch (e) {
      this.log(`handler error for ${req.method}: ${(e as Error).message}`);
      this.respondError(req.id, ACP_ERRORS.internalError, (e as Error).message);
    }
  }

  private handleInitialize(req: JsonRpcRequest): void {
    // We support exactly wire version 1: echo it when the client asked for 1,
    // otherwise answer with our own latest (1) so the client can decide.
    this.respond(req.id, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      agentInfo: this.opts.agentInfo,
      authMethods: [],
    });
  }

  private handleNewSession(req: JsonRpcRequest): void {
    const params = req.params as { cwd?: string; mcpServers?: unknown[] } | undefined;
    const cwd = params?.cwd;
    if (!cwd) return this.respondError(req.id, ACP_ERRORS.invalidParams, "session/new requires a cwd");
    const sessionId = `sess_${(++this.counter).toString(36)}${Date.now().toString(36)}`;
    this.sessions.set(sessionId, { sessionId, cwd });
    this.opts.onSessionNew?.({ sessionId, cwd });
    this.respond(req.id, { sessionId });
  }

  private async handlePrompt(req: JsonRpcRequest): Promise<void> {
    const params = req.params as { sessionId?: string; prompt?: ContentBlock[] } | undefined;
    const sessionId = params?.sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return this.respondError(req.id, ACP_ERRORS.resourceNotFound, `unknown session: ${sessionId ?? "(none)"}`);

    const abort = new AbortController();
    session.abort = abort;
    const emit = (update: SessionUpdate) => this.notify(sessionId!, update);
    try {
      const stopReason = await this.opts.prompt({ sessionId: sessionId!, prompt: params?.prompt ?? [], emit, signal: abort.signal });
      this.respond(req.id, { stopReason });
    } catch (e) {
      if (abort.signal.aborted) {
        this.respond(req.id, { stopReason: "cancelled" });
      } else {
        this.log(`prompt failed: ${(e as Error).message}`);
        this.respondError(req.id, ACP_ERRORS.internalError, (e as Error).message);
      }
    } finally {
      session.abort = undefined;
    }
  }

  private handleCancel(params: { sessionId?: string } | undefined): void {
    const session = params?.sessionId ? this.sessions.get(params.sessionId) : undefined;
    session?.abort?.abort();
  }

  private handleSetMode(req: JsonRpcRequest): void {
    const params = req.params as { sessionId?: string; modeId?: string } | undefined;
    const session = params?.sessionId ? this.sessions.get(params.sessionId) : undefined;
    if (!session) return this.respondError(req.id, ACP_ERRORS.resourceNotFound, `unknown session: ${params?.sessionId ?? "(none)"}`);
    session.currentModeId = params?.modeId;
    this.respond(req.id, {});
    if (params?.modeId) this.notify(session.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
  }
}
