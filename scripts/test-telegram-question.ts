// live round-trip test: buttons + poll against the real bot
// usage: npx tsx scripts/test-telegram-question.ts <chatId>
import { TelegramTransport } from "../src/transports/telegram.js";
import { loadConfig, loadSettings } from "../src/config.js";

const config = loadConfig();
const settings = loadSettings(config.dataDir);
const token = settings.telegram?.token ?? config.telegramToken!;
const chatId = process.argv[2];
if (!chatId) { console.error("usage: tsx scripts/test-telegram-question.ts <chatId>"); process.exit(1); }

const t = new TelegramTransport(token, []);

let tapResolve: ((v: string) => void) | null = null;
const tapPromise = new Promise<string>((r) => { tapResolve = r; });
t.onAction((action) => { if (action.startsWith("q:")) tapResolve?.(`tap ${action}`); });

let voteResolve: ((v: string) => void) | null = null;
const votePromise = new Promise<string>((r) => { voteResolve = r; });
t.onPollAnswer?.((pid, idx) => voteResolve?.(`vote pid=${pid} idx=${idx}`));

await t.push(chatId, { text: "🧪 Buttons test — which account?", card: { text: "", buttons: [
  { label: "client", action: "q:test1:0" },
  { label: "personal", action: "q:test1:1" },
  { label: "own-account", action: "q:test1:2" },
] } });
console.log("buttons sent");

const poll = await t.sendPoll!(chatId, "🧪 Poll test — which dinner? (tap one)", ["pizza", "sushi", "ramen", "döner", "salad", "curry", "pasta", "tacos"]);
console.log("poll sent, pollId =", JSON.stringify(poll.pollId));

const result = await Promise.race([
  tapPromise,
  votePromise,
  new Promise<string>((r) => setTimeout(() => r("TIMEOUT — nothing received in 120s"), 120e3)),
]);
console.log("RESULT:", result);
process.exit(0);
