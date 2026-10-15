// Voice front (bead: voice front + durable background agents).
//
// A fast conversational model that answers every spoken turn in a few seconds and
// never runs the agent's tools itself. Anything slower becomes a durable background
// task (src/durable/task-ledger.ts) that runs the full agent; the front starts,
// lists, checks and cancels those tasks, so the owner can keep talking — and start
// more — while work runs. The canonical Telegram session is never locked by a call.

import { Type } from "typebox";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import type { LedgerEntry, TaskLedger } from "../durable/task-ledger.js";

export interface FrontContext {
  /** agent display name */
  name: string;
  /** the agent's persona (AGENTS.md), trimmed */
  persona: string;
  /** recent Telegram chat, oldest first, one line per turn */
  recent: string;
}

export interface FrontHost {
  /** one fast-model completion with the front's tools */
  complete(agentId: string, context: { systemPrompt: string; messages: Message[]; tools: Tool[] }, signal: AbortSignal): Promise<AssistantMessage>;
  context(agentId: string, chatKey: string): Promise<FrontContext>;
  ledger(): TaskLedger | undefined;
  /** recent steps of a running task's own session (tool calls, notes), newest last */
  activity?(agentId: string, taskId: string): string[];
}

interface Call {
  agentId: string;
  chatKey: string;
  allowedTools?: string[];
  messages: Message[];
  /** spoken exchange, for the end-of-call summary */
  transcript: Array<{ role: "owner" | "agent"; text: string }>;
  started: string[];
  /** the front asked to hang up after this turn's goodbye */
  ending?: boolean;
  /** task id → last status seen by this call; undefined until the first poll baselines it */
  seen?: Map<string, string>;
}

export interface TaskEvent { taskId: string; status: string; title: string; text: string }

export interface CallRecord {
  agentId: string;
  chatKey: string;
  transcript: Array<{ role: "owner" | "agent"; text: string }>;
  tasks: LedgerEntry[];
}

const MAX_ROUNDS = 4;
const MAX_MESSAGES = 60;

export const FRONT_TOOLS: Tool[] = [
  {
    name: "start_task",
    description: "Start a background task that runs the full agent with its tools (research, files, web, other agents, multi-step work). Returns at once; the result is posted to the owner's Telegram chat and announced on the call. Several tasks can run in parallel.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title the owner will recognise when it's announced" }),
      instructions: Type.String({ description: "Self-contained instructions: everything needed from this call and the recent chat — the task sees neither" }),
    }),
  },
  { name: "list_tasks", description: "The owner's recent background tasks with their status (running, done, failed, cancelled).", parameters: Type.Object({}) },
  { name: "task_status", description: "Status and result of one background task by id.", parameters: Type.Object({ id: Type.String() }) },
  { name: "cancel_task", description: "Cancel a queued or running background task by id.", parameters: Type.Object({ id: Type.String() }) },
  { name: "end_call", description: "Hang up this voice call. Use when the owner asks to end or hang up, says goodbye to finish, or is clearly done. Say a short goodbye in the same reply; background tasks keep running.", parameters: Type.Object({}) },
];

const ago = (ms: number) => { const m = Math.round(ms / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const FILLER = /^(?:(?:done|ok(?:ay)?|sure|finished|complete[d]?|all set|here (?:you go|it is|they are))[.!:,—-]*\s+)+/i;
/** First informative sentence of a result: markdown and filler openers ("Done.", "Okay —") stripped. */
const firstSentence = (text: string, max = 220) => {
  const plain = text.replace(/[*_`#>\[\]]/g, "").replace(/\s+/g, " ").trim().replace(FILLER, "");
  return (plain.match(/^.{12,220}?[.!?](?=\s|$)/)?.[0] ?? plain.slice(0, max)).trim();
};

export function taskLine(t: LedgerEntry, now: number): string {
  const tail = t.status === "done" ? ` — ${firstSentence(t.result ?? "")}` : t.status === "failed" ? ` — ${firstSentence(t.error ?? "")}` : "";
  return `${t.id} [${t.status}] "${t.title}" (${ago(now - t.createdAt)})${tail}`;
}

function textOf(message: AssistantMessage): string {
  return message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(" ").trim();
}

export class VoiceFront {
  private calls = new Map<string, Call>();
  constructor(private host: FrontHost, private now: () => number = Date.now) {}

  open(callId: string, agentId: string, chatKey: string, allowedTools?: string[]): void {
    this.calls.set(callId, { agentId, chatKey, ...(allowedTools ? { allowedTools } : {}), messages: [], transcript: [], started: [] });
  }

  has(callId: string): boolean { return this.calls.has(callId); }

  /** True once the front decided to hang up; the bridge ends the call after the goodbye is spoken. */
  ending(callId: string): boolean { return this.calls.get(callId)?.ending === true; }

  /** Tasks of this chat that finished since the last poll, as spoken announcements. The first poll only baselines. */
  async events(callId: string): Promise<TaskEvent[]> {
    const call = this.calls.get(callId); const ledger = this.host.ledger();
    if (!call || !ledger) return [];
    const tasks = await ledger.list({ agentId: call.agentId, chatKey: call.chatKey });
    const first = !call.seen; call.seen ??= new Map();
    const out: TaskEvent[] = [];
    for (const t of tasks) {
      const before = call.seen.get(t.id); call.seen.set(t.id, t.status);
      if (first || before === t.status) continue;
      // a task that finished before the call started was baselined; announce changes and tasks born during the call
      const text = announcement(t);
      if (!text) continue;
      out.push({ taskId: t.id, status: t.status, title: t.title, text });
      // the front must know too: its context otherwise still says "running"
      const body = t.status === "done" ? `Result:\n${(t.result ?? "").slice(0, 3000)}` : t.status === "failed" ? `Error: ${(t.error ?? "").slice(0, 500)}` : "";
      call.messages.push({ role: "user", content: `[Background task update — not said by the owner; already announced on the call] "${t.title}" (${t.id}) is ${t.status}.${body ? `\n${body}` : ""}`, timestamp: this.now() });
    }
    return out;
  }

  /** Ends the call and returns what happened in it (nothing when the call had no exchange). */
  async close(callId: string): Promise<CallRecord | undefined> {
    const call = this.calls.get(callId);
    this.calls.delete(callId);
    if (!call || !call.transcript.length) return undefined;
    const ledger = this.host.ledger();
    const tasks: LedgerEntry[] = [];
    if (ledger) for (const id of call.started) { const t = await ledger.get(id); if (t) tasks.push(t); }
    return { agentId: call.agentId, chatKey: call.chatKey, transcript: call.transcript, tasks };
  }

  async turn(callId: string, text: string, signal: AbortSignal): Promise<string> {
    const call = this.calls.get(callId);
    if (!call) throw new Error("voice_call_unknown");
    const said = text.trim();
    call.transcript.push({ role: "owner", text: said });
    call.messages.push({ role: "user", content: said, timestamp: this.now() });
    const systemPrompt = await this.systemPrompt(call);
    let reply = "";
    for (let round = 0; round < MAX_ROUNDS && !reply; round++) {
      const answer = await this.host.complete(call.agentId, { systemPrompt, messages: call.messages, tools: FRONT_TOOLS }, signal);
      if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error("voice_front_model_failed");
      call.messages.push(answer);
      const toolCalls = answer.content.filter((c) => c.type === "toolCall");
      if (!toolCalls.length) { reply = textOf(answer); break; }
      for (const tc of toolCalls) {
        const result = await this.runTool(callId, call, tc.name, tc.arguments as Record<string, unknown>, tc.id);
        call.messages.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: [{ type: "text", text: result }], isError: result.startsWith("ERROR"), timestamp: this.now() });
      }
    }
    reply ||= call.ending ? "Bye for now." : "Okay.";
    call.transcript.push({ role: "agent", text: reply });
    // keep the live context bounded; the transcript for the summary is kept separately
    if (call.messages.length > MAX_MESSAGES) call.messages.splice(0, call.messages.length - MAX_MESSAGES + (call.messages[call.messages.length - MAX_MESSAGES]?.role === "toolResult" ? 1 : 0));
    while (call.messages[0] && call.messages[0].role !== "user") call.messages.shift();
    return reply;
  }

  /** The front's instructions for a call — what a speech-to-speech model is configured with. */
  async instructions(callId: string): Promise<string> {
    const call = this.calls.get(callId);
    if (!call) throw new Error("voice_call_unknown");
    return this.systemPrompt(call);
  }

  /** Run one front tool for a call (used by speech-to-speech fronts that call tools themselves). */
  async tool(callId: string, name: string, args: Record<string, unknown>, toolCallId: string): Promise<string> {
    const call = this.calls.get(callId);
    if (!call) throw new Error("voice_call_unknown");
    return this.runTool(callId, call, name, args, toolCallId);
  }

  /** Record what a speech-to-speech front heard and said, so the call summary stays complete. */
  note(callId: string, role: "owner" | "agent", text: string): void {
    const t = text.trim(); if (t) this.calls.get(callId)?.transcript.push({ role, text: t.slice(0, 4000) });
  }

  private async systemPrompt(call: Call): Promise<string> {
    const ctx = await this.host.context(call.agentId, call.chatKey);
    const ledger = this.host.ledger();
    const tasks = ledger ? (await ledger.list({ agentId: call.agentId, chatKey: call.chatKey })).slice(0, 8) : [];
    const detail = (t: LedgerEntry) => {
      if (t.status === "done") return `${taskLine(t, this.now())}\n  Result: ${(t.result ?? "").replace(/\s+/g, " ").slice(0, 1200)}`;
      const steps = (t.status === "running" || t.status === "queued") ? this.host.activity?.(call.agentId, t.id) ?? [] : [];
      return steps.length ? `${taskLine(t, this.now())}\n  Latest steps: ${steps.join(" → ")}` : taskLine(t, this.now());
    };
    return [
      `You are ${ctx.name}, talking with the owner on a live voice call. Everything you say is spoken aloud.`,
      ctx.persona ? `Your persona:\n${ctx.persona}` : "",
      "How to work on this call:",
      "- Reply in 1–3 short spoken sentences. Plain speech: no markdown, lists, links, code or file paths.",
      "- Answer directly when the conversation, the recent chat or common knowledge is enough.",
      ledger
        ? "- Anything that needs tools, files, the web, other agents, memory lookups or more than a quick answer: call start_task with self-contained instructions, then say in one sentence that it's running. Its result arrives in the Telegram chat and is announced on the call. You can run several tasks at once and keep talking meanwhile."
        : "- Background tasks are unavailable right now; say you'll follow up in the Telegram chat instead.",
      "- For \"how's it going\" or \"what came back\", use list_tasks or task_status — never guess. cancel_task stops one.",
      "- Ask clarifying questions out loud when a request is ambiguous.",
      "- When the owner wants to finish (\"that's all\", \"bye\", \"hang up\"), say a brief goodbye and call end_call. Running tasks continue and report to the chat.",
      `Recent Telegram chat (oldest first):\n${ctx.recent || "(none)"}`,
      `Background tasks (current — trust this over anything said earlier in the call):\n${tasks.length ? tasks.map(detail).join("\n") : "(none yet)"}`,
      `Now: ${new Date(this.now()).toISOString()}`,
    ].filter(Boolean).join("\n\n");
  }

  private async runTool(callId: string, call: Call, name: string, args: Record<string, unknown>, toolCallId: string): Promise<string> {
    const ledger = this.host.ledger();
    if (!ledger) return "ERROR: background tasks are unavailable";
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const own = async (id: string) => { const t = await ledger.get(id); return t && t.agentId === call.agentId && t.chatKey === call.chatKey ? t : undefined; };
    try {
      if (name === "start_task") {
        const title = str(args.title, 120), instructions = str(args.instructions, 8000);
        if (!title || !instructions) return "ERROR: title and instructions are required";
        // A voice turn may be replayed after the front has already issued its tool call.
        // Reuse the current scrape/research job rather than surfacing or launching a second one.
        const duplicate = await ledger.latestActive(call.agentId, call.chatKey);
        if (duplicate && /scrap|research|fetch|web|source/i.test(`${duplicate.title}\n${duplicate.instructions}`) && /scrap|research|fetch|web|source/i.test(`${title}\n${instructions}`)) {
          if (!call.started.includes(duplicate.id)) call.started.push(duplicate.id);
          return `Already running ${duplicate.id} "${duplicate.title}". I will use the latest result.`;
        }
        const t = await ledger.start({ agentId: call.agentId, chatKey: call.chatKey, title, instructions, ...(call.allowedTools ? { allowedTools: call.allowedTools } : {}) }, `voice:${callId}:${toolCallId}`);
        if (!call.started.includes(t.id)) call.started.push(t.id);
        return `Started ${t.id} "${t.title}". It runs in the background; the result goes to the chat and is announced here.`;
      }
      if (name === "list_tasks") {
        const tasks = (await ledger.list({ agentId: call.agentId, chatKey: call.chatKey })).slice(0, 10);
        return tasks.length ? tasks.map((t) => taskLine(t, this.now())).join("\n") : "No background tasks yet.";
      }
      if (name === "task_status") {
        const t = await own(str(args.id, 40));
        if (!t) return "No such task.";
        const steps = t.status === "running" || t.status === "queued" ? this.host.activity?.(call.agentId, t.id) ?? [] : [];
        return `${taskLine(t, this.now())}${t.status === "done" ? `\nResult:\n${(t.result ?? "").slice(0, 3000)}` : ""}${steps.length ? `\nLatest steps: ${steps.join(" → ")}` : ""}`;
      }
      if (name === "cancel_task") {
        const t = await own(str(args.id, 40));
        if (!t) return "No such task.";
        return (await ledger.cancel(t.id)) ? `Cancelling "${t.title}".` : `"${t.title}" is already ${t.status}.`;
      }
      if (name === "end_call") { call.ending = true; return "The call ends right after your goodbye. Keep the goodbye to one short sentence."; }
      return `ERROR: unknown tool ${name}`;
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/** Spoken one-liner when a background task changes state during a call. */
export function announcement(t: LedgerEntry): string | undefined {
  if (t.status === "done") return `"${t.title}" is done. ${firstSentence(t.result ?? "")} The full result is in the chat.`;
  if (t.status === "failed") return `"${t.title}" failed. The details are in the chat.`;
  if (t.status === "cancelled") return `"${t.title}" was cancelled.`;
  return undefined;
}
