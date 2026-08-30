// Run a skill-evolution cycle from the CLI:
//   npm run evolve -- <agentId> ["goal text"] [--status]
//   npm run evolve -- assistant "get better at morning briefings"
//   npm run evolve -- assistant --status
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { AgentManager } from "../src/core/agent-manager.js";
import { EventLog } from "../src/core/events.js";
import { EvolutionEngine, createLlmEvolutionIO } from "../src/core/evolution.js";
import { ensureDir } from "../src/core/util.js";

async function main(): Promise<void> {
  const [agentId, ...rest] = process.argv.slice(2);
  const flags = rest.filter((a) => a.startsWith("--"));
  const goal = rest.filter((a) => !a.startsWith("--")).join(" ") || undefined;

  if (!agentId) {
    console.error("usage: npm run evolve -- <agentId> [\"goal\"] [--status|--force]\n  agents are private runtime directories (see /agents in pibot)");
    process.exit(1);
  }

  const config = loadConfig();
  ensureDir(config.dataDir);
  const modelRuntime = await ModelRuntime.create();
  const agents = new AgentManager(config.agentsDir, modelRuntime);
  await agents.discover();

  if (!agents.getAgent(agentId)) {
    console.error(`unknown agent "${agentId}" — available: ${agents.list().map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  const events = new EventLog(config.agentsDir);
  const engine = new EvolutionEngine({
    agents,
    modelRuntime,
    events,
    dataDir: config.dataDir,
    host: { announce: async (id, text) => console.log(`\n[announce → ${id}]\n${text}`) },
    io: createLlmEvolutionIO({
      agents,
      modelRuntime,
      modelFor: (agent) => {
        const spec = agent.manifest.evolution?.model ?? config.heartbeatModel;
        try {
          return agents.resolveModel(spec) ?? agents.resolveModel(agent.manifest.model);
        } catch {
          return undefined;
        }
      },
    }),
  });

  if (flags.includes("--status")) {
    const staged = engine.staged(agentId);
    console.log(staged.length ? `staged: ${staged.join(", ")}\npromote: npm run evolve -- ${agentId} --promote <name>` : "nothing staged");
    process.exit(0);
  }
  if (flags.includes("--promote")) {
    const name = rest[rest.indexOf("--promote") + 1] ?? "";
    console.log(engine.promote(agentId, name) ? `promoted ${name}` : `nothing staged named "${name}"`);
    process.exit(0);
  }
  if (flags.includes("--reject")) {
    const name = rest[rest.indexOf("--reject") + 1] ?? "";
    console.log(engine.reject(agentId, name) ? `rejected ${name}` : `nothing staged named "${name}"`);
    process.exit(0);
  }

  console.log(`🧬 evolving "${agentId}"${goal ? ` — goal: ${goal}` : " (self-directed)"}…\n`);
  const report = await engine.evolve(agentId, goal, { force: true });
  console.log(`\n${report.ok ? "✅" : "⛔"} ${report.summary}`);
  if (report.errors?.length) console.log("errors:", report.errors.join("; "));
  if (report.staged) console.log(`\nstaged — promote with: npm run evolve -- ${agentId} --promote ${report.skill}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
