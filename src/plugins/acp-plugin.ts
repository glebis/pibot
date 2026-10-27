// ─── ACP client capability — pibot agents driving an external ACP agent ─────
//
// `acp_run` launches an ACP agent (Command Code via `cmd acp`) as a subprocess,
// opens a fresh session in the workspace, sends one self-contained prompt and
// returns the agent's final answer plus a compact record of the tool calls it
// made. This is the ACP counterpart of delegate_cli/herdr: pibot dispatches,
// the ACP agent works with its OWN model access and permissions.

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AcpClient, ACP_AGENTS, describeAcpFailure, installedAcpAgents, type AcpClientOptions } from "../acp/client.js";
import type { SessionUpdate } from "../acp/protocol.js";
import { truncate } from "../core/util.js";
import { resolveDelegateCwd } from "./delegate-plugin.js";

const DEFAULT_TIMEOUT_S = 600;
const MAX_OUT = 4_000;

export interface AcpToolCallSummary {
  toolCallId: string;
  title: string;
  status: string;
}

/** Merge tool_call / tool_call_update notifications into one ordered list. */
export function summarizeToolCalls(updates: readonly SessionUpdate[]): AcpToolCallSummary[] {
  const order: string[] = [];
  const byId = new Map<string, AcpToolCallSummary>();
  for (const u of updates) {
    const rec = u as { sessionUpdate?: string; toolCallId?: string; title?: string; status?: string; name?: string };
    if (rec.sessionUpdate === "tool_call" && rec.toolCallId) {
      if (!byId.has(rec.toolCallId)) order.push(rec.toolCallId);
      byId.set(rec.toolCallId, { toolCallId: rec.toolCallId, title: rec.title ?? rec.name ?? rec.toolCallId, status: rec.status ?? "pending" });
    } else if (rec.sessionUpdate === "tool_call_update" && rec.toolCallId) {
      const prev = byId.get(rec.toolCallId);
      if (!prev) order.push(rec.toolCallId);
      byId.set(rec.toolCallId, {
        toolCallId: rec.toolCallId,
        title: rec.title ?? prev?.title ?? rec.toolCallId,
        status: rec.status ?? prev?.status ?? "pending",
      });
    }
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/** Concatenate the agent's streamed message text. */
export function collectAgentText(updates: readonly SessionUpdate[]): string {
  const parts: string[] = [];
  for (const u of updates) {
    const rec = u as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (rec.sessionUpdate === "agent_message_chunk" && rec.content?.type === "text" && rec.content.text) parts.push(rec.content.text);
  }
  return parts.join("");
}

/** Owner-facing rendering of one ACP run. */
export function renderAcpResult(label: string, updates: readonly SessionUpdate[]): string {
  const text = collectAgentText(updates).trim();
  const calls = summarizeToolCalls(updates);
  const lines = [`**${label}** result:`, "", truncate(text || "(no text returned)", MAX_OUT)];
  if (calls.length) {
    lines.push("", `tools used: ${calls.length}`);
    for (const call of calls) lines.push(`- ${truncate(call.title, 140)} — ${call.status}`);
  }
  return lines.join("\n");
}

export interface AcpPluginDeps {
  /** cwd override root; an ACP run may not escape it */
  workspace?: string;
  /** allowed ACP agent names; defaults to the installed set */
  allowed?: string[];
  agentId?: string;
  /** extra env var names the ACP agent may inherit (manifest.envPassthrough) */
  envPassthrough?: readonly string[];
  /** default permission policy for the agent's tool calls */
  permission?: "allow" | "reject";
  /** injectable client builder (tests) */
  clientFactory?: (opts: AcpClientOptions) => AcpClient;
}

export function acpPlugin(deps: AcpPluginDeps = {}): InlineExtension {
  const allowed = new Set(deps.allowed ?? installedAcpAgents());

  return {
    name: "acp",
    factory: (pi) => {
      pi.registerTool({
        name: "acp_run",
        label: "Run ACP agent",
        description: `Run an external Agent Client Protocol agent and wait for its result. Available: ${[...allowed].map((n) => `${n} (${ACP_AGENTS[n]?.label ?? n})`).join(", ") || "(none installed)"}. The agent starts a fresh session in the workspace, works with its own model access and permissions, and returns its final answer plus a list of the tool calls it made. The prompt must be fully self-contained (absolute paths, what to change, where to write output).`,
        parameters: Type.Object({
          prompt: Type.String({ description: "Self-contained task prompt for the ACP agent" }),
          agent: Type.Optional(Type.String({ description: `ACP agent to run (default: ${[...allowed][0] ?? "cmd"})` })),
          cwd: Type.Optional(Type.String({ description: "Working directory for the session; must be inside the agent workspace (default: the workspace)" })),
          timeout_seconds: Type.Optional(Type.Number({ description: `Give up after N seconds (default ${DEFAULT_TIMEOUT_S})` })),
          permission: Type.Optional(Type.String({ description: "How to answer the agent's permission requests: allow | reject (default allow)" })),
        }),
        async execute(_tcid, params) {
          const agentName = params.agent ?? [...allowed][0] ?? "cmd";
          const spec = ACP_AGENTS[agentName];
          const permission = params.permission === "reject" ? "reject" : deps.permission ?? "allow";
          const timeoutMs = Math.max(1, params.timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1_000;

          let text: string;
          let details: Record<string, unknown>;
          let resolved: ReturnType<typeof resolveDelegateCwd>;
          if (!spec) {
            text = `ERROR: unknown ACP agent "${agentName}" — use ${Object.keys(ACP_AGENTS).join(", ")}.`;
            details = { ok: false };
          } else if (!allowed.has(agentName)) {
            text = `ERROR: "${agentName}" is not in the allowed ACP agent list (${[...allowed].join(", ") || "none installed"}).`;
            details = { ok: false };
          } else if (!(resolved = resolveDelegateCwd(params.cwd, deps.workspace)).ok) {
            text = `ERROR: ${resolved.error}.`;
            details = { ok: false };
          } else {
            const cwd = resolved.cwd ?? deps.workspace ?? process.cwd();
            const build = deps.clientFactory ?? ((opts: AcpClientOptions) => new AcpClient(opts));
            const client = build({
              command: spec.command,
              args: spec.args,
              cwd,
              envPassthrough: deps.envPassthrough,
              permission,
              requestTimeoutMs: timeoutMs,
            });
            try {
              client.start();
              await client.initialize();
              const sessionId = await client.newSession(cwd);
              const result = await client.prompt(sessionId, params.prompt, timeoutMs);
              text = renderAcpResult(spec.label, result.updates);
              details = { ok: true, agent: agentName, sessionId, stopReason: result.stopReason, toolCalls: summarizeToolCalls(result.updates).length };
            } catch (e) {
              text = `**${spec.label}** failed: ${describeAcpFailure(e)}`;
              details = { ok: false, agent: agentName };
            } finally {
              await client.dispose().catch(() => undefined);
            }
          }
          return { content: [{ type: "text", text }], details };
        },
      });
    },
  };
}
