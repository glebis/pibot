import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, truncate } from "./util.js";

export interface EventEntry {
  t: number;
  type: "message" | "fire" | "snooze" | "heartbeat" | "system" | "maintenance";
  summary: string;
}

const REDACTED = "[REDACTED]";
const SENSITIVE_JSON_ASSIGNMENT_RE = /("(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|private[_-]?key|signing[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|credentials?|password|passwd|passphrase|secret|token)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|null|true|false|-?\d+(?:\.\d+)?)/gi;
const SENSITIVE_ASSIGNMENT_RE = /(\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|private[_-]?key|signing[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|credentials?|password|passwd|passphrase|secret|token)\b\s*(?:=|:)\s*)(?:Bearer\s+[^\s,;}\]]+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi;
const BEARER_CREDENTIAL_RE = /\bBearer\s+[^\s,;}\]]+/gi;
const TELEGRAM_BOT_TOKEN_RE = /(?<!\d)\d{5,12}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;

/** Remove common credential forms at the single boundary where event summaries persist. */
export function redactEventSummary(summary: string): string {
  return summary
    .replace(SENSITIVE_JSON_ASSIGNMENT_RE, `$1"${REDACTED}"`)
    .replace(SENSITIVE_ASSIGNMENT_RE, `$1${REDACTED}`)
    .replace(BEARER_CREDENTIAL_RE, `Bearer ${REDACTED}`)
    .replace(TELEGRAM_BOT_TOKEN_RE, "[TELEGRAM_BOT_TOKEN_REDACTED]");
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
    const entry: EventEntry = { t: Date.now(), type, summary: truncate(redactEventSummary(summary), 300) };
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
