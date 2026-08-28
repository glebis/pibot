import { TelegramTransport } from "../transports/telegram.js";
import { loadSettings, saveSettings, type Config } from "../config.js";
import { suggestedSubBotUsername } from "./agent-factory.js";
import { errorMessage } from "./util.js";
import type { AgentManager } from "./agent-manager.js";
import type { EventLog } from "./events.js";
import type { Transport } from "./types.js";

export interface SubBotManagerDeps {
  config: Config;
  agents: AgentManager;
  events: EventLog;
  transports: Map<string, Transport>;
  pendingSubBots: Map<string, string>;
  secrets: import("./secrets.js").SecretStore;
  telegramUsername(): string | undefined;
  addTransport(t: Transport): void;
  deliverToAgent(agentId: string, text: string): Promise<void>;
}

export class SubBotManager {
  constructor(private deps: SubBotManagerDeps) {}

  private async persistSubBot(agentId: string, token: string, username?: string): Promise<void> {
    const cur = this.deps.secrets.get();
    const subBots = { ...(cur.telegram?.subBots ?? {}), [agentId]: { token, username } };
    await this.deps.secrets.save({ telegram: { ...cur.telegram, subBots } });
  }

  /** Wire a dedicated bot for one agent (token verified against Telegram first) */
  async attachSubBot(agentId: string, token: string): Promise<{ ok: boolean; botName?: string; error?: string }> {
    const existingName = `telegram:${agentId}`;
    if (this.deps.transports.has(existingName)) {
      await this.deps.transports.get(existingName)?.stop().catch(() => {});
      this.deps.transports.delete(existingName);
    }
    const t = new TelegramTransport(token, [], { nameSuffix: agentId, boundAgentId: agentId });
    let botName: string;
    try {
      botName = await t.verify();
    } catch (e) {
      return { ok: false, error: `Token rejected by Telegram: ${errorMessage(e)}` };
    }
    this.deps.addTransport(t);
    try {
      await t.start();
    } catch (e) {
      this.deps.transports.delete(existingName);
      return { ok: false, error: `Started but polling failed: ${errorMessage(e)}` };
    }
    await this.persistSubBot(agentId, token, botName.startsWith("@") ? botName.slice(1) : botName);
    this.deps.events.log("system", "system", `sub-bot attached for ${agentId} as ${botName}`);
    return { ok: true, botName };
  }

  async detachSubBot(agentId: string): Promise<boolean> {
    const t = this.deps.transports.get(`telegram:${agentId}`);
    if (!t) return false;
    await t.stop().catch(() => {});
    this.deps.transports.delete(`telegram:${agentId}`);
    const cur = loadSettings(this.deps.config.dataDir);
    const subBots = { ...(cur.telegram?.subBots ?? {}) };
    delete subBots[agentId];
    saveSettings(this.deps.config.dataDir, { telegram: { ...cur.telegram, subBots } });
    this.deps.events.log("system", "system", `sub-bot detached for ${agentId}`);
    return true;
  }

  /** Deep link that lets the chat owner create a managed sub-bot for an agent */
  subBotDeepLink(agentId: string, username: string, displayName?: string): string {
    const name = encodeURIComponent(displayName ?? agentId);
    return `https://t.me/newbot/${this.deps.telegramUsername() ?? "pimother_bot"}/${username}?name=${name}`;
  }

  telegramUsername(): string | undefined {
    const t = this.deps.transports.get("telegram");
    return t instanceof TelegramTransport ? t.botUsername() : undefined;
  }

  managerMode(): boolean {
    const t = this.deps.transports.get("telegram");
    return t instanceof TelegramTransport ? t.managerMode() : false;
  }

  managerUsername(): string | undefined {
    return this.telegramUsername();
  }

  subBotFor(agentId: string): { username?: string } | undefined {
    const t = this.deps.transports.get(`telegram:${agentId}`);
    return t instanceof TelegramTransport && t.botUsername() ? { username: t.botUsername() } : undefined;
  }

  /** Manager-mode: a user confirmed a managed sub-bot creation → fetch its token and wire it */
  async handleManagedBot(t: Transport, info: { creatorId: string; botId: number; botUsername?: string; firstName?: string }): Promise<void> {
    const botName = info.botUsername ?? info.firstName ?? `bot_${info.botId}`;
    console.log(`[telegram] managed bot update: ${botName} (id ${info.botId}) by ${info.creatorId}`);

    // token rotation for an already-wired sub-bot: re-attach with the fresh token
    for (const [agentId, sub] of Object.entries(loadSettings(this.deps.config.dataDir).telegram?.subBots ?? {})) {
      if (sub.username && info.botUsername && sub.username.toLowerCase() === info.botUsername.toLowerCase()) {
        const token = await (t as import("../transports/telegram.js").TelegramTransport).getManagedBotToken(info.botId);
        const r = await this.attachSubBot(agentId, token);
        this.deps.events.log(agentId, "system", `sub-bot token rotated → ${r.ok ? "re-attached" : r.error}`);
        return;
      }
    }

    const agentId =
      this.deps.pendingSubBots.get(botName) ??
      this.deps.pendingSubBots.get(botName.replace(/_?bot$/, "")) ??
      [...this.deps.pendingSubBots.keys()].find((id) => botName.toLowerCase().includes(id.replace(/-/g, "").toLowerCase()));
    if (!agentId) {
      console.log(`[telegram] managed bot ${botName} — no pending request, ignoring`);
      return;
    }
    try {
      const tg = t as import("../transports/telegram.js").TelegramTransport;
      const token = await tg.getManagedBotToken(info.botId);
      const r = await this.attachSubBot(agentId, token);
      this.deps.pendingSubBots.delete(agentId);
      // managed sub-bots are private: only the manager's owner can use them
      await tg.setManagedBotAccessSettings(info.botId, true).catch((e) => console.error("[telegram] access restriction failed:", errorMessage(e)));
      if (r.ok) {
        this.deps.events.log(agentId, "system", `sub-bot created: ${r.botName} (restricted to owner)`);
        await this.deps.deliverToAgent(agentId, `🟢 My own Telegram bot is live: **${r.botName}** — its own chat, its own identity, restricted to you.`);
      } else {
        this.deps.events.log(agentId, "system", `sub-bot wiring failed: ${r.error}`);
      }
    } catch (e) {
      this.deps.events.log("system", "system", `managed bot token fetch failed: ${errorMessage(e)}`);
    }
  }

  /** Manager-mode: register a pending sub-bot creation + push the deep link into the agent's chats */
  async requestSubBotCreation(
    agentId: string,
    agentChats: Map<string, Set<string>>,
    transports: Map<string, Transport>,
    deliverToAgent: (agentId: string, text: string) => Promise<void>,
  ): Promise<void> {
    const agent = this.deps.agents.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent "${agentId}"`);
    if (!this.managerMode()) throw new Error("manager mode is off — enable bot management mode for @pimother_bot in BotFather's mini app");
    const suggestedUsername = suggestedSubBotUsername(agentId, this.telegramUsername());
    this.deps.pendingSubBots.set(agentId, agentId);
    await deliverToAgent(
      agentId,
      [
        `Tap to give **${agentId}** its own Telegram identity:`,
        ``,
        `Telegram pre-fills @${suggestedUsername} — confirm and I'll fetch the token and wire it automatically. The bot will be restricted to you.`,
      ].join("\n"),
    );
    // deep-link URL button into the agent's registered chats
    for (const ck of agentChats.get(agentId) ?? new Set<string>()) {
      const idx = ck.lastIndexOf(":");
      const tr = transports.get(ck.slice(0, idx));
      if (tr)
        void tr
          .push(ck.slice(idx + 1), {
            text: `🧬 Create **@${suggestedUsername}** for ${agentId}:`,
            card: { text: "", buttons: [{ label: `Create @${suggestedUsername}`, action: `url:${this.subBotDeepLink(agentId, suggestedUsername, agent.id)}`, url: this.subBotDeepLink(agentId, suggestedUsername, agent.id) }] },
          })
          .catch(() => {});
    }
  }
}
