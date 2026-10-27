// ─── Agent Client Protocol (ACP) v1 — wire types + NDJSON framing ───────────
//
// ACP is how editors (Zed, …) drive coding agents: JSON-RPC 2.0 over stdio,
// ONE message per line, UTF-8, no embedded newlines. pibot sits on BOTH sides:
//
//   client — an agent capability that launches an ACP agent (e.g. `cmd acp`)
//            as a subprocess and drives it (src/acp/client.ts, acp-plugin.ts);
//   agent  — pibot serving its own agents to an ACP client over stdio
//            (src/acp/server.ts, agent.ts, main.ts).
//
// This module holds the subset of the v1 schema both ends need plus the
// framing helpers they share. Spec: https://agentclientprotocol.com — the
// stable wire version is the single integer 1.

import { StringDecoder } from "node:string_decoder";

export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC 2.0 / ACP error codes. */
export const ACP_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return typeof (m as JsonRpcRequest).method === "string" && (m as JsonRpcRequest).id !== undefined;
}
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return typeof (m as JsonRpcNotification).method === "string" && (m as JsonRpcRequest).id === undefined;
}
export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return (m as JsonRpcRequest).method === undefined && (m as JsonRpcResponse).id !== undefined;
}

// ─── content blocks ─────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string;
}
export interface AudioContent {
  type: "audio";
  mimeType: string;
  data: string;
}
export interface EmbeddedResourceContent {
  type: "resource";
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
}
export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
}
export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | EmbeddedResourceContent
  | ResourceLinkContent;

/** Flatten prompt content blocks to the plain text pibot passes to a model. */
export function contentBlocksToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "resource":
        parts.push(
          block.resource?.text !== undefined
            ? `--- ${block.resource.uri} ---\n${block.resource.text}\n--- end ${block.resource.uri} ---`
            : `[resource ${block.resource?.uri ?? "(unknown)"}]`,
        );
        break;
      case "resource_link":
        parts.push(`[resource ${block.uri}]`);
        break;
      case "image":
        parts.push("[image attachment]");
        break;
      case "audio":
        parts.push("[audio attachment]");
        break;
    }
  }
  return parts.join("\n\n").trim();
}

// ─── tool calls & session updates ───────────────────────────────────────────

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
  messageId?: string;
}
export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
  messageId?: string;
}
export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
  messageId?: string;
}
export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  name?: string;
  content?: unknown[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}
export interface ToolCallProgressUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  name?: string;
  content?: unknown[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}
export interface PlanUpdate {
  sessionUpdate: "plan";
  entries: Array<{ content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" }>;
}
export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: Array<{ name: string; description: string; input?: { hint?: string } | null }>;
}
export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
}
export interface UsageUpdate {
  sessionUpdate: "usage_update";
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}
export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
  updatedAt?: string;
}

/** Unknown/newer update variants are carried as-is so a client never drops them. */
export type AnySessionUpdate = { sessionUpdate: string; [key: string]: unknown };

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | UserMessageChunkUpdate
  | ToolCallUpdate
  | ToolCallProgressUpdate
  | PlanUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | UsageUpdate
  | SessionInfoUpdate
  | AnySessionUpdate;

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

// ─── capabilities ───────────────────────────────────────────────────────────

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  auth?: { terminal?: boolean };
}
export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: Record<string, unknown>;
  auth?: { logout?: unknown };
}
export interface AgentInfo {
  name: string;
  title?: string;
  version: string;
}
export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}
export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo?: AgentInfo;
  authMethods?: AuthMethod[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

// ─── framing ────────────────────────────────────────────────────────────────

/** One JSON-RPC message per line; the trailing newline is the frame delimiter. */
export function encodeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

export type ParsedLine =
  | { ok: true; message: JsonRpcMessage }
  | { ok: false; error: string };

/** Parse one NDJSON line into a JSON-RPC message (never throws). */
export function parseMessage(line: string): ParsedLine {
  const text = line.trim();
  if (!text) return { ok: false, error: "empty line" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "not a JSON-RPC object" };
  }
  const msg = value as JsonRpcMessage;
  if (typeof (msg as JsonRpcRequest).method !== "string" && (msg as JsonRpcResponse).id === undefined) {
    return { ok: false, error: "neither request/notification nor response" };
  }
  return { ok: true, message: msg };
}

/**
 * Splits a byte stream into complete NDJSON lines.
 *
 * A `StringDecoder` carries a split multi-byte UTF-8 sequence across chunks, and
 * the trailing partial line stays buffered until its newline arrives — ACP
 * messages are large (an editor's command list can be tens of KB) and a naive
 * per-chunk `toString()` would corrupt them.
 */
export class LineDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.takeLines();
  }

  /** Emit whatever remains (a final line without its trailing newline). */
  flush(): string[] {
    this.buffer += this.decoder.end();
    const lines = this.takeLines();
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) lines.push(rest);
    return lines;
  }

  private takeLines(): string[] {
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts.map((l) => l.trim()).filter((l) => l.length > 0);
  }
}
