// ─── Display timezone: ONE named zone for date rendering and date guards ─────
//
// The owner is in Berlin and the runtime already renders user-facing times in
// "Europe/Berlin" (web-review, web-processes, voice/*, coordinator/*). The
// heartbeat digest render and the relative-date guards must agree on the SAME
// named zone: a spoken "today" has to be judged against the exact calendar day
// the digest was written in — never the machine's implicit offset and never a
// value carried in prose.
//
// Kept as its own tiny module (not util.ts) so the heartbeat guard, the digest
// render and the ledger date check can share one value without a cross-cutting
// edit to a file other lanes own. Scoped to the date/heartbeat work.
export const DISPLAY_TIME_ZONE = "Europe/Berlin";
