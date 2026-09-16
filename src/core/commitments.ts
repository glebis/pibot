// ─── CommitmentEngine: the measurable follow-through loop (pilot) ─────────────
// Deterministic scheduler-driven loop; the only LLM step is the one next-action
// suggestion when the owner reports being blocked (with a deterministic fallback).
// All measurements land in the ProactiveStore as metadata-only events.

import type { AgentManager } from "./agent-manager.js";
import type { EventLog } from "./events.js";
import type { ProactiveStore, Commitment, CommitmentOrigin, Summary } from "./proactive-store.js";
import type { Scheduler } from "./scheduler.js";
import type { Card, ChatRef, Schedule } from "./types.js";
import { fmtWhen, parseDuration, truncate, uid } from "./util.js";
import { summarize as summarizeStore } from "./proactive-store.js";

const DAY = 86_400e3;
/** Unsolicited pushes per commitment (pre-check + follow-up + deadline). Reactive
 *  cards (rating after a tap) don't count — they answer the owner's own action. */
const PER_COMMITMENT_BUDGET = 3;
/** Room needed between a scheduled pre-check and its deadline. */
const MIN_PRECHECK_GAP = 60e3;

export const DEFAULT_DAILY_BUDGET = 6;
export const DEFAULT_PRECHECK_LEAD_MS = DAY;

export interface CommitmentHost {
  /** Deliver to the agent's owned chats; true when at least one push resolved. */
  deliverToAgent(agentId: string, text: string, card?: Card): Promise<boolean>;
  /** Deliver to one specific chat (the commitment's own loop chat). */
  pushChat(chat: ChatRef, text: string, card?: Card): Promise<boolean>;
}

export interface CommitmentDeps {
  agents: Pick<AgentManager, "getAgent">;
  scheduler: Scheduler;
  events: EventLog;
  store: ProactiveStore;
  bot: CommitmentHost;
  /** one next-action suggestion when the owner is blocked; omit/throw → fallback text */
  suggestNextAction?(agentId: string, text: string): Promise<string>;
  now?: () => number;
}

export interface CaptureResult {
  commitment?: Commitment;
  reply: string;
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

/** Pre-check time: dueAt − lead when that's still ahead, else the midpoint.
 *  Undefined when there is no room for a meaningful check-in. */
export function precheckAt(dueAt: number, leadMs: number, createdAt: number, now: number): number | undefined {
  void createdAt;
  let at = dueAt - leadMs;
  if (at <= now) at = now + Math.max(5 * 60e3, (dueAt - now) / 2);
  if (at >= dueAt - MIN_PRECHECK_GAP) return undefined;
  return at;
}

const RENEG_OFFSET_MS: Record<string, number> = { "1d": DAY, "3d": 3 * DAY, "7d": 7 * DAY };

/** Card factory for the loop's surfaces. stage ∈ confirm|precheck|deadline|rating|scorecard */
export function commitmentCard(stage: string, c: { id: string; text: string; dueAt?: number }, now = Date.now()): Card {
  const due = c.dueAt ? ` — due ${fmtWhen(c.dueAt, now)}` : "";
  switch (stage) {
    case "confirm":
      return {
        text: `📌 Proposed commitment: **${truncate(c.text, 100)}**${due}. Start the follow-through loop?`,
        buttons: [
          { label: "Start ✅", action: `cm:${c.id}:confirm` },
          { label: "Dismiss", action: `cm:${c.id}:dismiss` },
        ],
      };
    case "precheck":
      return {
        text: `⏳ **${truncate(c.text, 100)}**${due}. On track?`,
        buttons: [
          { label: "On track", action: `cm:${c.id}:track` },
          { label: "Blocked", action: `cm:${c.id}:block` },
          { label: "+1d", action: `cm:${c.id}:reneg:1d` },
          { label: "+3d", action: `cm:${c.id}:reneg:3d` },
          { label: "+1w", action: `cm:${c.id}:reneg:7d` },
          { label: "Cancel", action: `cm:${c.id}:cancel` },
        ],
      };
    case "deadline":
      return {
        text: `🎯 **${truncate(c.text, 100)}** — the deadline is now (${fmtWhen(c.dueAt ?? now, now)}). Done?`,
        buttons: [
          { label: "Done ✓", action: `cm:${c.id}:done` },
          { label: "Not yet", action: `cm:${c.id}:notyet` },
          { label: "+1d", action: `cm:${c.id}:reneg:1d` },
        ],
      };
    case "rating":
      return {
        text: `Loop closed. Was this useful?`,
        buttons: [
          { label: "👍", action: `cm:${c.id}:rate:up` },
          { label: "👎", action: `cm:${c.id}:rate:down` },
        ],
      };
    default:
      return { text: c.text, buttons: [] };
  }
}

/** Pure: has this agent exhausted its daily proactive pilot budget? */
export function isOverBudget(source: { events: ReturnType<ProactiveStore["events"]> }, budget: number, now: number): boolean {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  return source.events.filter((e) => e.stage === "delivered").length >= budget;
}

// ─── the engine ───────────────────────────────────────────────────────────────

export class CommitmentEngine {
  private deps: CommitmentDeps;

  constructor(deps: CommitmentDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private pilotEnabled(agentId: string): boolean {
    return this.deps.agents.getAgent(agentId)?.manifest.proactive?.pilot === true;
  }

  private budget(agentId: string): number {
    return this.deps.agents.getAgent(agentId)?.manifest.proactive?.dailyBudget ?? DEFAULT_DAILY_BUDGET;
  }

  private precheckLeadMs(agentId: string): number {
    const raw = this.deps.agents.getAgent(agentId)?.manifest.proactive?.precheckLead;
    return (raw && parseDuration(raw)) || DEFAULT_PRECHECK_LEAD_MS;
  }

  // ── capture ───────────────────────────────────────────────────────────────

  captureExplicit(agentId: string, chat: ChatRef, text: string, dueAt: number): CaptureResult {
    if (!this.pilotEnabled(agentId)) {
      return { reply: "The proactive pilot is off for this agent (enable it in the dashboard manifest)." };
    }
    if (dueAt <= this.now()) return { reply: "That deadline is already in the past." };
    const c = this.startLoop(agentId, chat, text, dueAt, "explicit");
    const pre = precheckAt(c.dueAt, this.precheckLeadMs(agentId), c.createdAt, this.now());
    const preLine = pre ? ` I'll pre-check ${fmtWhen(pre, this.now())}.` : "";
    return {
      commitment: c,
      reply: `Commitment tracked ✅ "${truncate(c.text, 120)}" — due ${fmtWhen(c.dueAt, this.now())}.${preLine} (id ${c.id})`,
    };
  }

  /** Inferred captures stay `proposed` until the owner confirms. */
  captureInferred(agentId: string, chat: ChatRef, text: string, dueAt: number): CaptureResult {
    if (!this.pilotEnabled(agentId) || dueAt <= this.now()) {
      return { reply: "Pilot disabled or deadline past — nothing captured." };
    }
    const c = this.deps.store.createCommitment({
      agentId,
      chat,
      text,
      dueAt,
      origin: "inferred",
      status: "proposed",
      groupId: uid("cmg", 6),
    });
    this.deps.store.appendEvent({ agentId, loop: "pilot", stage: "proposed", commitmentId: c.id, outcome: "capture:inferred" });
    void this.deps.bot
      .deliverToAgent(agentId, `📌 I think you just made a commitment: **${truncate(c.text, 120)}** — due ${fmtWhen(dueAt, this.now())}. Start the follow-through loop?`, commitmentCard("confirm", c, this.now()))
      .catch(() => {});
    return {
      commitment: c,
      reply: `Commitment proposed 📌 "${truncate(c.text, 120)}" (id ${c.id}) — awaiting your confirmation in the chat.`,
    };
  }

  confirm(id: string): boolean {
    const c = this.deps.store.getCommitment(id);
    if (!c || c.status !== "proposed") return false;
    this.scheduleLoopJobs(c);
    this.deps.store.updateCommitment(id, { status: "active", confirmedAt: this.now() });
    this.deps.store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: "confirmed", commitmentId: c.id, outcome: "confirmation:confirmed" });
    return true;
  }

  dismiss(id: string): boolean {
    const c = this.deps.store.getCommitment(id);
    if (!c || c.status !== "proposed") return false;
    this.deps.store.updateCommitment(id, { status: "dismissed", closedAt: this.now() });
    this.deps.store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: "dismissed", commitmentId: c.id, outcome: "confirmation:dismissed" });
    return true;
  }

  // ── agent-facing helpers (commitment_capture plugin) ────────────────────────

  listCommitments(agentId: string): Array<{ id: string; text: string; status: string; dueAt: number; origin: string }> {
    return this.deps.store
      .commitments({ agentId })
      .filter((c) => c.status === "active" || c.status === "proposed")
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 20)
      .map((c) => ({ id: c.id, text: c.text, status: c.status, dueAt: c.dueAt, origin: c.origin }));
  }

  cancelCommitment(id: string): boolean {
    const c = this.deps.store.getCommitment(id);
    if (!c) return false;
    if (c.status === "proposed") return this.dismiss(id);
    if (c.status !== "active") return false;
    this.cancelGroup(c);
    this.deps.store.updateCommitment(id, { status: "cancelled", closedAt: this.now() });
    this.deps.store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: "acted", commitmentId: c.id, outcome: "cancel" });
    return true;
  }

  // ── loop ──────────────────────────────────────────────────────────────────

  private startLoop(agentId: string, chat: ChatRef, text: string, dueAt: number, origin: CommitmentOrigin): Commitment {
    const c = this.deps.store.createCommitment({ agentId, chat, text, dueAt, origin, status: "active" });
    this.scheduleLoopJobs(c);
    this.deps.store.appendEvent({ agentId, loop: "pilot", stage: origin === "explicit" ? "confirmed" : "proposed", commitmentId: c.id, outcome: `capture:${origin}` });
    return c;
  }

  private scheduleLoopJobs(c: Commitment): void {
    const { scheduler } = this.deps;
    const groupId = c.groupId ?? uid("cmg", 6);
    if (!c.groupId) this.deps.store.updateCommitment(c.id, { groupId });
    const pre = precheckAt(c.dueAt, this.precheckLeadMs(c.agentId), c.createdAt, this.now());
    const needed = pre ? 2 : 1;
    try {
      this.deps.scheduler.assertCapacity(c.agentId, needed);
    } catch {
      this.deps.store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: "skipped", commitmentId: c.id, outcome: "capacity:full" });
      return;
    }
    if (pre) {
      scheduler.create({
        agentId: c.agentId,
        chat: c.chat,
        title: `pre-check: ${truncate(c.text, 60)}`,
        detail: `cm:${c.id}:precheck`,
        kind: "commitment",
        dueAt: pre,
        wake: "normal",
        delivery: "direct",
        groupId,
        cardPending: false,
      });
    }
    scheduler.create({
      agentId: c.agentId,
      chat: c.chat,
      title: `deadline: ${truncate(c.text, 60)}`,
      detail: `cm:${c.id}:deadline`,
      kind: "commitment",
      dueAt: c.dueAt,
      wake: "important",
      delivery: "direct",
      groupId,
      cardPending: false,
    });
  }

  /** Fire handler — job.detail carries `cm:<id>:<stage>` (precheck|deadline|scorecard). */
  async onFire(job: Schedule): Promise<void> {
    const m = (job.detail ?? "").match(/^cm:(cm\w+|scorecard):(\w+)$/);
    if (!m) return;
    const [, id, stage] = m;
    if (stage === "scorecard") {
      await this.fireScorecard(job);
      return;
    }
    const c = this.deps.store.getCommitment(id);
    if (!c || c.status !== "active") return;
    if (stage === "precheck") await this.pushGuarded(c, commitmentCard("precheck", c, this.now()));
    else if (stage === "deadline") await this.pushGuarded(c, commitmentCard("deadline", c, this.now()));
  }

  /** Budget + per-commitment guards, then push and record delivered. */
  private async pushGuarded(c: Commitment, card: Card): Promise<void> {
    const store = this.deps.store;
    const now = this.now();
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    const perCommitment = store.events({ commitmentId: c.id, loop: "pilot" }).filter((e) => e.stage === "delivered").length;
    const today = store.events({ agentId: c.agentId, loop: "pilot", since: midnight }).filter((e) => e.stage === "delivered").length;
    let blocked: string | undefined;
    if (perCommitment >= PER_COMMITMENT_BUDGET) blocked = "budget:commitment";
    else if (isOverBudget({ events: store.events({ agentId: c.agentId, loop: "pilot", since: midnight }) }, this.budget(c.agentId), now)) blocked = "budget:over";
    if (blocked) {
      store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: "skipped", commitmentId: c.id, outcome: blocked });
      return;
    }
    const ok = await this.deps.bot.pushChat(c.chat, card.text, card);
    store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: ok ? "delivered" : "skipped", commitmentId: c.id, outcome: ok ? undefined : "push:failed" });
  }

  // ── card actions ──────────────────────────────────────────────────────────

  async handleAction(action: string, _chatId: string): Promise<string | void> {
    const m = action.match(/^cm:(cm\w+|scorecard):(\w+)(?::(\w+))?$/);
    if (!m) return;
    const [, id, verb, arg] = m;
    const store = this.deps.store;
    if (id === "scorecard") {
      if (verb === "rate") {
        const rating = arg === "up" ? "up" : "down";
        store.appendEvent({ agentId: "*", loop: "pilot", stage: "acted", outcome: `scorecard:${rating}` });
        return rating === "up" ? "Glad it helps." : "Noted — the budget will get tighter.";
      }
      return;
    }
    const c = store.getCommitment(id);
    if (!c) return "Unknown commitment.";
    const seen = (): void => {
      store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: "seen", commitmentId: c.id });
    };
    const acted = (outcome: string): void => {
      store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: "acted", commitmentId: c.id, outcome });
    };

    switch (verb) {
      case "confirm":
        return this.confirm(id) ? "Loop started ✅ — I'll check in before the deadline." : "Nothing to confirm.";
      case "dismiss":
        return this.dismiss(id) ? "Dismissed — it won't be tracked." : "Nothing to dismiss.";
      case "track": {
        if (c.status !== "active") return "This loop is closed.";
        seen();
        acted("precheck:on-track");
        return `On track 👍 — next touch is the deadline, ${fmtWhen(c.dueAt, this.now())}.`;
      }
      case "block": {
        if (c.status !== "active") return "This loop is closed.";
        if (c.blockedFollowUp) return "Follow-up already sent once for this commitment.";
        seen();
        acted("precheck:block");
        store.updateCommitment(c.id, { blockedFollowUp: true });
        const suggestion = await this.suggestNextAction(c.agentId, c.text);
        const ok = await this.deps.bot.pushChat(c.chat, `🧱 Blocked on "${truncate(c.text, 120)}"? One next action: ${suggestion}`, {
          text: "",
          buttons: [
            { label: "+1d", action: `cm:${c.id}:reneg:1d` },
            { label: "+3d", action: `cm:${c.id}:reneg:3d` },
            { label: "Done anyway ✓", action: `cm:${c.id}:done` },
          ],
        });
        store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: ok ? "delivered" : "skipped", commitmentId: c.id, outcome: "followup:block" });
        return "Help is on the way.";
      }
      case "reneg": {
        if (c.status !== "active") return "This loop is closed.";
        const ms = RENEG_OFFSET_MS[arg ?? "1d"] ?? DAY;
        return this.renegotiate(c, ms);
      }
      case "cancel": {
        if (c.status !== "active") return "This loop is closed.";
        this.cancelGroup(c);
        store.updateCommitment(c.id, { status: "cancelled", closedAt: this.now() });
        acted("cancel");
        return "Commitment cancelled.";
      }
      case "done": {
        if (c.status !== "active") return "This loop is closed.";
        this.cancelGroup(c);
        store.updateCommitment(c.id, { status: "completed", closedAt: this.now() });
        acted("deadline:done");
        await this.pushRating(c, "completed");
        return "Done ✓ — logged. Nice.";
      }
      case "notyet": {
        if (c.status !== "active") return "This loop is closed.";
        this.cancelGroup(c);
        store.updateCommitment(c.id, { status: "missed", closedAt: this.now() });
        acted("deadline:not-yet");
        await this.pushRating(c, "missed");
        return "Logged as missed — the scorecard will show it. No drama.";
      }
      case "rate": {
        if (c.status === "active" || c.status === "proposed") return "Rate after the loop closes.";
        const rating = arg === "up" ? "up" : "down";
        store.updateCommitment(c.id, { rating });
        acted(`rating:${rating}`);
        return "Thanks — feedback recorded.";
      }
      default:
        return;
    }
  }

  private async pushRating(c: Commitment, status: string): Promise<void> {
    await this.deps.bot.pushChat(c.chat, `${status === "completed" ? "🎉" : "🪺"} "${truncate(c.text, 120)}" — ${status}. Was this loop helpful?`, commitmentCard("rating", c, this.now()));
  }

  /** Close the current commitment, open a successor with the same text pushed by ms. */
  private renegotiate(c: Commitment, ms: number): string {
    this.cancelGroup(c);
    const successor = this.startLoop(c.agentId, c.chat, c.text, this.now() + ms, c.origin);
    this.deps.store.updateCommitment(c.id, { status: "renegotiated", closedAt: this.now() });
    this.deps.store.appendEvent({ agentId: c.agentId, loop: "pilot", stage: "acted", commitmentId: c.id, outcome: `reneg:${successor.id}` });
    return `Pushed to ${fmtWhen(successor.dueAt, this.now())} (new id ${successor.id}). Old deadline dropped.`;
  }

  private cancelGroup(c: Commitment): void {
    if (!c.groupId) return;
    for (const j of this.deps.scheduler.list(c.agentId, { includePaused: true })) {
      if (j.groupId === c.groupId && j.status === "pending") this.deps.scheduler.cancel(j.id);
    }
  }

  private async suggestNextAction(agentId: string, text: string): Promise<string> {
    try {
      const s = await this.deps.suggestNextAction?.(agentId, text);
      if (s?.trim()) return truncate(s.trim(), 220);
    } catch {
      /* fall through */
    }
    return "tell me what's in the way and we'll adjust the plan.";
  }

  // ── scorecard (weekly) ─────────────────────────────────────────────────────

  /** Idempotent governance sync: scorecard job exists while the pilot is on,
   *  gone when it's off. Called from the dashboard manifest save. */
  syncPilotGovernance(agentId: string): void {
    const existing = this.deps.scheduler.list(agentId, { includePaused: true }).find((j) => j.kind === "commitment" && j.detail === "cm:scorecard:fire");
    if (this.pilotEnabled(agentId)) {
      if (!existing) this.ensureScorecardJob(agentId);
    } else if (existing?.status === "pending") {
      this.deps.scheduler.cancel(existing.id);
    }
  }

  /** Weekly Monday 09:00 scorecard job per pilot agent (idempotent). */
  ensureScorecardJob(agentId: string): void {
    if (!this.pilotEnabled(agentId)) return;
    const existing = this.deps.scheduler.list(agentId, { includePaused: true }).find((j) => j.kind === "commitment" && j.detail === "cm:scorecard:fire");
    if (existing) return;
    this.deps.scheduler.create({
      agentId,
      chat: { transport: "telegram", chatId: "*" } as ChatRef, // resolved via deliverToAgent at fire time
      title: "proactive scorecard",
      detail: "cm:scorecard:fire",
      kind: "commitment",
      dueAt: this.now(),
      repeat: { weekdays: [1], dailyAt: "09:00" },
      wake: "normal",
      delivery: "direct",
      internal: true,
    });
  }

  private async fireScorecard(job: Schedule): Promise<void> {
    const agentId = job.agentId;
    if (!this.pilotEnabled(agentId)) return;
    const since = this.now() - 7 * DAY;
    const s = summarizeStore(
      { events: this.deps.store.events(), commitments: this.deps.store.commitments() },
      { since, now: this.now(), agentId, loop: "pilot" }
    );
    const text = [
      `📊 **Proactive scorecard** (7d, pilot)`,
      `- delivered: ${s.delivered} · seen ${s.seenPct}% · acted ${s.actedPct}%`,
      `- commitments: ${s.explicitCount} explicit / ${s.inferredCount} inferred · completed ${s.completedPct}%`,
      `- helpful ${s.helpfulPct}% · noise ${s.noisePct}%${s.ignored ? ` (${s.ignored} ignored)` : ""}`,
    ].join("\n");
    const ok = await this.deps.bot.deliverToAgent(agentId, text, {
      text: "",
      buttons: [
        { label: "Useful", action: `cm:scorecard:rate:up` },
        { label: "Too much", action: `cm:scorecard:rate:down` },
      ],
    });
    this.deps.store.appendEvent({ agentId, loop: "pilot", stage: ok ? "delivered" : "skipped", outcome: "scorecard" });
  }

  /** Heartbeat speaks land in the store too — the loop filter needs both loops. */
  deliverHeartbeatSpeak(agentId: string, delivered: boolean): void {
    this.deps.store.appendEvent({ agentId, loop: "heartbeat", stage: delivered ? "delivered" : "skipped", outcome: delivered ? undefined : "push:failed" });
  }
}