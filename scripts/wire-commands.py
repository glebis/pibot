"""Wire commands.ts into bot.ts (HELP + handleCommand moved out)."""

p = "src/core/bot.ts"
s = open(p).read()

# 1. remove the module-level HELP block
help_start = s.index("const HELP = [")
help_end = s.index('].join("\\n");', help_start) + len('].join("\\n");')
s = s[:help_start] + s[help_end:].lstrip("\n")

# 2. replace the handleCommand method with the delegate + commandContext builder
cmd_sig = "  private async handleCommand(t: Transport, chatId: string, text: string): Promise<void> {"
cmd_start = s.index(cmd_sig)
end_marker = "  // ── scheduler fire delivery"
cmd_end = s.index(end_marker, cmd_start)

delegate = """  handleCommand(t: Transport, chatId: string, text: string): Promise<void> {
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
      wizard: this,
    };
  }

"""
s = s[:cmd_start] + delegate + s[cmd_end:]

# 3. import + handler field
s = s.replace('import { calendarPlugin } from "../plugins/calendar-plugin.js";',
'import { calendarPlugin } from "../plugins/calendar-plugin.js";\nimport { createCommandHandler, type CommandContext } from "./commands.js";')
s = s.replace("""  private wizardChats = new Set<string>(); // chats running /newagent interview""",
"""  private wizardChats = new Set<string>(); // chats running /newagent interview
  private commandHandler: ((t: Transport, chatId: string, text: string) => Promise<void>) | null = null;""")

open(p, "w").write(s)
print("bot.ts rewired")