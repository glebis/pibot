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
    ensureDir(path.dirname(this.file(agentId)));
    const entry: EventEntry = { t: Date.now(), type, summary: truncate(summary, 300) };
    fs.appendFileSync(this.file(agentId), JSON.stringify(entry) + "\n");
    // keep the file bounded
    try {
      const st = fs.statSync(this.file(agentId));
      if (st.size > 512 * 1024) {
        const lines = fs.readFileSync(this.file(agentId), "utf8").trimEnd().split("\n");
        fs.writeFileSync(this.file(agentId), lines.slice(-500).join("\n") + "\n");
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