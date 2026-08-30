import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, truncate } from "./util.js";

export interface EventEntry {
  t: number;
  type: "message" | "fire" | "snooze" | "heartbeat" | "system";
  summary: string;
}

/** Tiny per-agent append-only event log — feeds heartbeat context and debugging. */
export class EventLog {
  private dir: string;

  constructor(agentsDir: string) {
    this.dir = agentsDir;
  }

  private file(agentId: string): string {
    return path.join(this.dir, agentId, "state", "events.jsonl");
  }

  log(agentId: string, type: EventEntry["type"], summary: string): void {
    const file = this.file(agentId);
    const stateDir = path.dirname(file);
    const agentDir = path.dirname(stateDir);
    ensureDir(stateDir);
    fs.chmodSync(agentDir, 0o700);
    fs.chmodSync(stateDir, 0o700);
    const entry: EventEntry = { t: Date.now(), type, summary: truncate(summary, 300) };
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    // keep the file bounded
    try {
      const st = fs.statSync(file);
      if (st.size > 512 * 1024) {
        const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
        fs.writeFileSync(file, lines.slice(-500).join("\n") + "\n", { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      }
    } catch {
      /* ignore */
    }
  }

  tail(agentId: string, n = 10): EventEntry[] {
    try {
      const lines = fs.readFileSync(this.file(agentId), "utf8").trimEnd().split("\n").filter(Boolean);
      return lines.slice(-n).map((l) => {
        try {
          return JSON.parse(l) as EventEntry;
        } catch {
          return { t: 0, type: "system", summary: l } as EventEntry;
        }
      });
    } catch {
      return [];
    }
  }
}
