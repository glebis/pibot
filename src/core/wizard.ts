import * as path from "node:path";
import { buildManifest, buildPersona, validateAgentName, type AgentDraft, type Proactivity } from "./agent-factory.js";
import type { AgentManager, LoadedAgent } from "./agent-manager.js";
import { AMBIGUITY_THRESHOLD, scorePersonaAmbiguity } from "./ambiguity.js";
import { PROACTIVITY_INTERVAL, PROACTIVITY_OPTIONS, suggestedSubBotUsername, VIBE_OPTIONS } from "./agent-factory.js";
import { writeJsonAtomic } from "./util.js";
import type { QuestionBus } from "./questions.js";
import type { Transport, ChatRef } from "./types.js";
import type { Config } from "../config.js";

export interface WizardDeps {
  config: Config;
  agents: AgentManager;
  questions: QuestionBus;
  transports: Map<string, Transport>;
  wizardChats: Set<string>;
  pendingSubBots: Map<string, string>;
  modelRuntime?: import("@earendil-works/pi-coding-agent").ModelRuntime;
  chatKey(t: Transport, chatId: string): string;
  rememberChat(agentId: string, ck: string): void;
  ensureHeartbeatJob(agent: LoadedAgent): void;
  ensureEvolutionJob(agent: LoadedAgent): void;
  attachSubBot(agentId: string, token: string): Promise<{ ok: boolean; botName?: string; error?: string }>;
  subBotDeepLink(agentId: string, username: string, displayName?: string): string;
  telegramUsername(): string | undefined;
}

export class NewAgentWizard {
  constructor(private deps: WizardDeps) {}

  /**
   * Guided /newagent interview: name → job → vibe → proactivity.
   * Uses ask_user buttons; each new question replaces the last; /cancel aborts.
   */
  async runNewAgentWizard(t: Transport, chatId: string): Promise<void> {
    const ck = this.deps.chatKey(t, chatId);
    const chat: ChatRef = { transport: t.name, chatId };
    this.deps.wizardChats.add(ck);
    let aborted = false;

    const ask = async (text: string, options?: string[]): Promise<string | null> => {
      if (aborted) return null;
      const res = await this.deps.questions.ask("system", chat, { text, options: options ?? [], timeoutMs: 600e3 });
      if (!res || res.timedOut || res.replaced) return null;
      return res.choice;
    };

    try {
      await t.push(chatId, { text: "🧙 New agent wizard — answer the questions (taps or typing). /cancel anytime." });

      // 1. name
      let name = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await ask(
          attempt === 0 ? "What should I call this agent? (lowercase, dashes — e.g. 'coach')" : "That name didn't work. Try another (lowercase, dashes, 2–32 chars):",
        );
        if (raw == null) {
          aborted = true;
          break;
        }
        const err = validateAgentName(raw.trim().toLowerCase(), this.deps.agents.list().map((a) => a.id));
        if (err) {
          await t.push(chatId, { text: `⚠︎ ${err}` });
          continue;
        }
        name = raw.trim().toLowerCase();
        break;
      }
      if (aborted || !name) {
        await t.push(chatId, { text: "Wizard aborted — nothing created. /newagent to restart." });
        return;
      }

      // 2. job
      const job = await ask(`What is ${name}'s main job? One or two sentences.`);
      if (job == null) {
        aborted = true;
      }
      if (aborted) {
        await t.push(chatId, { text: "Wizard aborted — nothing created. /newagent to restart." });
        return;
      }

      // 3. vibe
      const vibeRes = await ask(`What vibe should ${name} have?`, VIBE_OPTIONS as unknown as string[]);
      if (vibeRes == null) {
        aborted = true;
      }
      if (aborted || vibeRes == null) {
        await t.push(chatId, { text: "Wizard aborted — nothing created. /newagent to restart." });
        return;
      }
      const vibe = vibeRes;

      // 4. proactivity
      const proRes = await ask(`How proactive should ${name} be?`, PROACTIVITY_OPTIONS as unknown as string[]);
      if (proRes == null) {
        aborted = true;
      }
      if (aborted || proRes == null) {
        await t.push(chatId, { text: "Wizard aborted — nothing created. /newagent to restart." });
        return;
      }
      const proactivity: Proactivity = proRes.startsWith("quiet")
        ? "quiet"
        : proRes.startsWith("chatty")
          ? "chatty"
          : proRes.startsWith("off")
            ? "off"
            : "balanced";

      // 5. ambiguity gate (Ouroboros-style): score the draft, ask follow-ups if vague
      let extraAnswers: string[] = [];
      const draft0: AgentDraft = { name, job: job ?? "", vibe, proactivity };
      try {
        const gate = await scorePersonaAmbiguity(buildPersona(draft0), {
          modelRuntime: this.deps.modelRuntime as never,
          model: this.deps.agents.resolveModel(process.env.PIBOT_DEFAULT_MODEL),
          cwd: process.cwd(),
        });
        if (gate.score > AMBIGUITY_THRESHOLD) {
          await t.push(chatId, { text: `🧙 A couple of clarifying questions to make ${name} sharper:` });
          for (const q of gate.questions.slice(0, 2)) {
            const answer = await this.deps.questions.ask("system", chat, { text: q, options: [], timeoutMs: 600e3 });
            if (!answer || answer.replaced) break;
            extraAnswers.push(`Q: ${q}\nA: ${answer.choice}`);
          }
        }
      } catch {
        /* gate failure = proceed with what we have */
      }

      // build
      const draft: AgentDraft = { name, job: [job ?? "", ...extraAnswers].filter(Boolean).join("\n"), vibe, proactivity };
      const err = this.deps.agents.createAgent(name, buildPersona(draft));
      if (err) {
        await t.push(chatId, { text: `Couldn't create: ${err}` });
        return;
      }
      const agent = this.deps.agents.getAgent(name)!;
      // write the wizard-built manifest (heartbeat rhythm per proactivity)
      writeJsonAtomic(path.join(agent.dir, "agent.json"), buildManifest(draft));
      await this.deps.agents.discover();
      const fresh = this.deps.agents.getAgent(name)!;
      this.deps.ensureHeartbeatJob(fresh);
      this.deps.ensureEvolutionJob(fresh);
      this.deps.rememberChat(name, ck);

      const proLabel = draft.proactivity === "off" ? "react-only (no heartbeat)" : `heartbeat every ${PROACTIVITY_INTERVAL[draft.proactivity]}`;
      await t.push(chatId, {
        text: [
          `Born: **${name}** 🎉`,
          `— ${draft.job}`,
          `— vibe: ${vibe}`,
          `— ${proLabel}${draft.proactivity !== "off" ? `, quiet 23:00–08:00` : ""}`,
          ``,
          `You're talking to it now. Its files: agents/${name}/ (persona, memory, skills — all editable on the dashboard).`,
        ].join("\n"),
      });
      void t.push(chatId, { text: `Say hi to **${name}** — try: "what can you do for me?"` });

      // 5. own Telegram identity (optional)
      const wantBot = await ask(`Give ${name} its own Telegram bot? (separate chat, its own @identity)`, [
        "yes — create it now",
        "skip for now",
      ]);
      if (wantBot?.startsWith("yes") && fresh) {
        await this.setupSubBot(t, chatId, fresh);
      }
    } finally {
      this.deps.wizardChats.delete(ck);
    }
  }

  /**
   * Sub-bot setup for one agent. Manager mode ON → deep link + automatic token
   * fetch. Otherwise: @BotFather instructions + pasted token.
   */
  private async setupSubBot(t: Transport, chatId: string, agent: LoadedAgent): Promise<void> {
    const tg = this.deps.transports.get("telegram") as import("../transports/telegram.js").TelegramTransport | undefined;
    const suggestedUsername = suggestedSubBotUsername(agent.id, this.deps.telegramUsername());

    if (tg?.managerMode()) {
      await t.push(chatId, {
        text: `Give **${agent.id}** its own Telegram identity? Tap — Telegram will create the bot and I'll wire it automatically.`,
        card: {
          text: "",
          buttons: [{ label: `Create @${suggestedUsername} bot`, action: `url:${this.deps.subBotDeepLink(agent.id, suggestedUsername, agent.id)}`, url: this.deps.subBotDeepLink(agent.id, suggestedUsername, agent.id) }],
        },
      });
      this.deps.pendingSubBots.set(agent.id, agent.id);
      return;
    }

    // fallback: manual BotFather + token paste
    await t.push(chatId, {
      text: [
        `Want **${agent.id}** to have its own Telegram identity?`,
        ``,
        `1. Open @BotFather → /newbot`,
        `2. Name: ${agent.id} · Username: must end in "bot" (e.g. ${suggestedUsername})`,
        `3. Paste the token here as your answer.`,
      ].join("\n"),
    });
    const token = await this.deps.questions.ask("system", { transport: t.name, chatId }, { text: "Paste the BotFather token here (or type /cancel to skip):", options: [], timeoutMs: 600e3 });
    if (!token || token.replaced) return;
    const r = await this.deps.attachSubBot(agent.id, token.choice.trim());
    await t.push(chatId, { text: r.ok ? `🟢 ${agent.id} is live as **${r.botName}** — its own bot, its own chat.` : `⚠︎ ${r.error}` });
  }
}
