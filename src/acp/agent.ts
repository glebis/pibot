// ─── pibot agents behind ACP ────────────────────────────────────────────────
//
// Bridges the protocol-only AcpServer to a real pibot agent: each ACP session
// maps to one pibot chat session (`agentId::acp-<sessionId>`), and the SDK's
// streaming events are translated into ACP session/update notifications so an
// editor sees the agent's text, thoughts and tool calls as they happen.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../core/agent-manager.js";
import type { Scheduler } from "../core/scheduler.js";
import type { ChatRef } from "../core/types.js";
import { truncate } from "../core/util.js";
import type { AcpPromptRequest } from "./server.js";
import { contentBlocksToText, type SessionUpdate, type StopReason, type ToolKind } from "./protocol.js";

export interface PibotAcpOptions {
  agents: AgentManager;
  scheduler: Scheduler;
  /** the pibot agent every ACP session runs as */
  agentId: string;
  log?: (message: string) => void;
}

type SessionRecord = {
  session: AgentSession;
  /** set while a prompt turn is running — events are dropped when absent */
  emit: ((update: SessionUpdate) => void) | null;
  /** true once any assistant text delta was streamed for the current turn */
  sawText: boolean;
};

/** Create the AcpServer `prompt` handler backed by pibot agent sessions. */
export function createPibotAcpPrompt(opts: PibotAcpOptions): (req: AcpPromptRequest) => Promise<StopReason> {
  const records = new Map<string, SessionRecord>();

  const ensure = async (sessionId: string): Promise<SessionRecord> => {
    const existing = records.get(sessionId);
    if (existing) return existing;
    const chat: ChatRef = { transport: "acp", chatId: sessionId };
    const chatKey = `acp-${sessionId}`;
    const session = await opts.agents.getOrCreateSession(opts.agentId, chatKey, chat, opts.scheduler);
    const record: SessionRecord = { session, emit: null, sawText: false };
    records.set(sessionId, record);
    session.subscribe((ev) => forwardEvent(record, ev));
    opts.log?.(`session ${sessionId} → agent ${opts.agentId} (chatKey ${chatKey})`);
    return record;
  };

  return async (req: AcpPromptRequest): Promise<StopReason> => {
    const text = contentBlocksToText(req.prompt);
    if (!text) return "end_turn";
    const record = await ensure(req.sessionId);

    record.emit = req.emit;
    record.sawText = false;
    const onAbort = () => {
      void Promise.resolve(record.session.abort()).catch(() => undefined);
    };
    if (req.signal.aborted) {
      record.emit = null;
      return "cancelled";
    }
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await record.session.prompt(text, { source: "rpc" });
      // Non-streaming models (or an ending on a tool call) never emit a text
      // delta: send the final assistant text once so the client is not left blank.
      if (!record.sawText) {
        const final = extractAssistantText(record.session);
        if (final) req.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: final } });
      }
      return req.signal.aborted ? "cancelled" : "end_turn";
    } catch (e) {
      if (req.signal.aborted) return "cancelled";
      throw e;
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      record.emit = null;
    }
  };
}

function forwardEvent(record: SessionRecord, ev: unknown): void {
  const emit = record.emit;
  if (!emit) return;
  const e = ev as {
    type?: string;
    assistantMessageEvent?: { type?: string; delta?: string };
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
  };
  switch (e.type) {
    case "message_update": {
      const ame = e.assistantMessageEvent;
      if (ame?.type === "text_delta" && ame.delta) {
        record.sawText = true;
        emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ame.delta } });
      } else if (ame?.type === "thinking_delta" && ame.delta) {
        emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: ame.delta } });
      }
      break;
    }
    case "tool_execution_start": {
      const name = e.toolName ?? "tool";
      emit({
        sessionUpdate: "tool_call",
        toolCallId: e.toolCallId ?? name,
        title: describeToolCall(name, e.args),
        name,
        kind: toolKind(name),
        status: "in_progress",
        rawInput: e.args,
      });
      break;
    }
    case "tool_execution_end": {
      emit({
        sessionUpdate: "tool_call_update",
        toolCallId: e.toolCallId ?? e.toolName ?? "tool",
        status: e.isError ? "failed" : "completed",
        rawOutput: truncate(stringify(e.result), 2_000),
      });
      break;
    }
  }
}

function describeToolCall(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const target = a.path ?? a.file_path ?? a.filePath ?? a.command ?? a.pattern ?? a.query;
  return typeof target === "string" && target.trim() ? `${name}: ${truncate(target.trim(), 120)}` : name;
}

const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "execute",
  grep: "search",
  glob: "search",
  find: "search",
  ls: "read",
  webfetch: "fetch",
  web_fetch: "fetch",
  websearch: "search",
  web_search: "search",
  think: "think",
};

function toolKind(name: string): ToolKind {
  return TOOL_KINDS[name.toLowerCase()] ?? "other";
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Last assistant text in a session's transcript (completion fallback). */
function extractAssistantText(session: AgentSession): string | null {
  const messages = ((session as unknown as { agent?: { state?: { messages?: unknown[] } } }).agent?.state?.messages ?? []) as unknown[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> };
    if (m?.role !== "assistant") continue;
    const text = (m.content ?? [])
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}
