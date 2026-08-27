"""One-shot refactor: extract handleCommand from bot.ts into src/core/commands.ts."""
import re

BOT = "src/core/bot.ts"
CMDS = "src/core/commands.ts"

s = open(BOT).read()

# ── 1. locate blocks ──────────────────────────────────────────────────────────
help_start = s.index("const HELP = [")
help_end = s.index('].join("\\n");', help_start) + len('].join("\\n");')
help_block = s[help_start:help_end]

cmd_sig = "  private async handleCommand(t: Transport, chatId: string, text: string): Promise<void> {"
cmd_start = s.index(cmd_sig)
end_marker = "  // ── scheduler fire delivery"
cmd_end = s.index(end_marker, cmd_start)
cmd_block = s[cmd_start:cmd_end]

# ── 2. transform the switch body: this.* → ctx/deps ───────────────────────────
body = cmd_block.replace(cmd_sig, "")
# close-of-method stays; we rewrap below
body = body.replace("this.deps.", "deps.")
for member in ["transports", "agentChats", "pendingSubBots", "wizardChats"]:
    body = body.replace(f"this.{member}", f"ctx.{member}")
for method in ["rememberChat(", "chatKey(t, chatId)", "ensureHeartbeatJob(", "ensureEvolutionJob(", "ensureMorningBriefJob("]:
    body = body.replace(f"this.{method}", f"ctx.{method}")
body = body.replace("this.deliverToAgent", "ctx.deliverToAgent")
body = body.replace("this.questions.cancelPending", "ctx.questions.cancelPending")
body = body.replace("this.currentAgent(", "ctx.currentAgent(")

# body currently is: `{\n ...switch... \n  }\n` (the method minus signature)
# strip the leading brace-line remnants: body starts right after the signature
inner = body[body.index("{") + 1:]  # after the opening brace of the method
inner = inner.rstrip()
# the method's final "  }" (its closing brace) is the last line
assert inner.endswith("  }"), inner[-40:]
inner = inner[: -len("  }")].rstrip()  # drop the method's own closing brace

commands_ts = f'''// ─── Chat commands: the /command layer of pibot ─────────────────────────────
// Satisfied by PiBot via a narrow context interface — keeps this file
// independent of the routing/wiring in bot.ts.

import type {{ AgentManager, LoadedAgent }} from "./agent-manager.js";
import type {{ EvolutionEngine }} from "./evolution.js";
import type {{ EventLog }} from "./events.js";
import type {{ QuestionBus }} from "./questions.js";
import type {{ Scheduler }} from "./scheduler.js";
import type {{ Config, Schedule, Transport }} from "./types.js";
import {{ errorMessage, fmtWhen, nextDailyAt, nextQuietEnd, parseDuration, readJson, truncate, writeJsonAtomic }} from "./util.js";
import * as path from "node:path";
import type {{ LoadedAgentShape }} from "./agent-shapes.js";

{help_block}

export interface CommandContext {{
  config: Config;
  agents: AgentManager;
  scheduler: Scheduler;
  events: EventLog;
  transports: Map<string, Transport>;
  agentChats: Map<string, Set<string>>;
  pendingSubBots: Map<string, string>;
  wizardChats: Set<string>;
  evolution?: EvolutionEngine;
  heartbeat: {{ tick: (agentId: string, opts?: {{ brief?: boolean }}) => Promise<void>; noteUserMessage?: (agentId: string) => void }};
  telegram?: {{
    managerMode(): boolean;
    managerUsername(): string | undefined;
    subBotFor(agentId: string): {{ username?: string }} | undefined;
    attachSubBot(agentId: string, token: string): Promise<{{ ok: boolean; botName?: string; error?: string }}>;
    detachSubBot(agentId: string): Promise<boolean>;
    requestSubBotCreation(agentId: string): Promise<void>;
  }};
  currentAgent(ck: string): string | undefined;
  chatKey(t: Transport, chatId: string): string;
  rememberChat(agentId: string, ck: string): void;
  ensureHeartbeatJob(agent: LoadedAgentShape): void;
  ensureEvolutionJob(agent: LoadedAgentShape): void;
  ensureMorningBriefJob(agent: LoadedAgentShape): void;
  deliverToAgent(agentId: string, text: string): Promise<void>;
  questions: Pick<QuestionBus, "cancelPending">;
}}

export function createCommandHandler(ctx: CommandContext) {{
  const deps = ctx;
  return async (t: Transport, chatId: string, text: string): Promise<void> => {{
{inner}
  }};
}}
'''

open(CMDS, "w").write(commands_ts)
print(f"commands.ts written ({len(commands_ts.splitlines())} lines)")

# ── 3. replace in bot.ts ──────────────────────────────────────────────────────
delegate = """  handleCommand(t: Transport, chatId: string, text: string): Promise<void> {
    return this.commandHandler(t, chatId, text);
  }
"""
s = s[:help_start] + delegate + "\n" + s[cmd_end:]

# commandHandler field (lazily built)
s = s.replace("""  private wizardChats = new Set<string>(); // chats running /newagent interview""",
"""  private wizardChats = new Set<string>(); // chats running /newagent interview
  private commandHandler: ((t: Transport, chatId: string, text: string) => Promise<void>) | null = null;""")

# commandContext accessor — build once
s = s.replace("""  handleCommand(t: Transport, chatId: string, text: string): Promise<void> {
    return this.commandHandler(t, chatId, text);
  }""",
"""  handleCommand(t: Transport, chatId: string, text: string): Promise<void> {
    this.commandHandler ??= createCommandHandler(this.commandContext());
    return this.commandHandler(t, chatId, text);
  }

  /** @internal narrow surface for the command layer */
  private commandContext(): CommandContext {
    return {
      config: this.deps.config,
      agents: this.deps.agents,
      scheduler: this.deps.scheduler,
      events: this.deps.events,
      transports: this.transports,
      agentChats: this.agentChats,
      pendingSubBots: this.pendingSubBots,
      wizardChats: this.wizardChats,
      evolution: this.deps.evolution,
      heartbeat: this.deps.heartbeat,
      telegram: this,
      currentAgent: (ck) => this.currentAgent(ck),
      chatKey: (t, chatId) => this.chatKey(t, chatId),
      rememberChat: (agentId, c) => this.rememberChat(agentId, c),
      ensureHeartbeatJob: (a) => this.ensureHeartbeatJob(a as never),
      ensureEvolutionJob: (a) => this.ensureEvolutionJob(a as never),
      ensureMorningBriefJob: (a) => this.ensureMorningBriefJob(a as never),
      deliverToAgent: (id, text) => this.deliverToAgent(id, text),
      questions: this.questions,
    };
  }""")

# import
s = s.replace('import { calendarPlugin } from "../plugins/calendar-plugin.js";',
'import { calendarPlugin } from "../plugins/calendar-plugin.js";\nimport { createCommandHandler } from "./commands.js";')

open(BOT, "w").write(s)
print("bot.ts rewired")