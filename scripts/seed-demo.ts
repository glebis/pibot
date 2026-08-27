// seed a demo schedule for browser testing: npx tsx scripts/seed-demo.ts
import { Scheduler } from "../src/core/scheduler.js";
import { loadConfig } from "../src/config.js";
import { ensureDir } from "../src/core/util.js";

const config = loadConfig();
ensureDir(config.dataDir);
const s = new Scheduler(config.dataDir, () => {});
s.create({
  agentId: "assistant",
  chat: { transport: "telegram", chatId: "123" },
  title: "water the plants",
  detail: "the monstera looks thirsty",
  kind: "reminder",
  dueAt: Date.now() + 45 * 60e3,
  wake: "normal",
  delivery: "direct",
});
s.create({
  agentId: "assistant",
  chat: { transport: "telegram", chatId: "123" },
  title: "morning brief",
  kind: "subject",
  dueAt: Date.now() + 12 * 3600e3,
  repeat: { dailyAt: "08:30" },
  wake: "normal",
  delivery: "agent",
});
s.flush();
console.log("seeded 2 schedules →", config.dataDir);
s.stop();
process.exit(0);
