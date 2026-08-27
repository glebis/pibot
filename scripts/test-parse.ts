import { parseWhen, parseDuration, fmtWhen } from "../src/core/util.js";

const now = Date.now();
const tests = [
  "in 20m", "2h30m", "at 18:00", "9am", "tomorrow 9am", "daily at 08:00",
  "every 2h", "hourly", "every day at 9am", "friday 18:00", "mondays 10am",
  "every 30m", "45m", "1.5h", "every monday 10:00", "2026-03-01T10:00:00Z",
  "snooze nothing garbage",
];
for (const t of tests) {
  const r = parseWhen(t, now);
  console.log(JSON.stringify(t).padEnd(26), "→", r ? new Date(r.dueAt).toLocaleString() + (r.repeat ? "  repeat:" + JSON.stringify(r.repeat) : "") : "NULL");
}
console.log("dur 45m =", parseDuration("45m"), "| fmt +75m:", fmtWhen(now + 4500e3, now));