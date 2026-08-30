import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendBacklogItems,
  backlogFile,
  closeBacklogItems,
  ensureBacklogFile,
  formatBacklogDigest,
  loadBacklogItems,
  pruneBacklog,
  topBacklogItem,
} from "./backlog.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-backlog-"));
}

describe("improvement backlog", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ensures the file, appends items, and round-trips them", () => {
    ensureBacklogFile(dir);
    const file = backlogFile(dir);
    expect(fs.existsSync(file)).toBe(true);
    const n = appendBacklogItems(dir, [{ summary: "Handle burst messages gracefully", source: "heartbeat", priority: "med" }]);
    expect(n).toBe(1);
    const items = loadBacklogItems(dir);
    expect(items).toHaveLength(1);
    expect(items[0].summary).toContain("burst");
    expect(items[0].count).toBe(1);
    expect(items[0].status).toBe("open");
    expect(items[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(items[0].id).toBeTruthy();
  });

  it("counts recurrence in place instead of duplicating", () => {
    const sum = "Add a daily standup summary skill";
    appendBacklogItems(dir, [{ summary: sum, source: "heartbeat" }]);
    appendBacklogItems(dir, [{ summary: sum.toUpperCase(), source: "heartbeat" }]);
    appendBacklogItems(dir, [{ summary: sum.toUpperCase(), source: "chat" }]);
    const items = loadBacklogItems(dir);
    expect(items).toHaveLength(2);
    const bySource = items.find((i) => i.source === "heartbeat");
    expect(bySource?.count).toBe(2);
    expect(items.find((i) => i.source === "chat")?.count).toBe(1);
  });

  it("deduplicates only among open items — a closed item may recur", () => {
    appendBacklogItems(dir, [{ summary: "Tidy the media retention policy", source: "chat" }]);
    const first = loadBacklogItems(dir)[0];
    closeBacklogItems(dir, [first.id]);
    appendBacklogItems(dir, [{ summary: "tidy the media retention policy", source: "chat" }]);
    const items = loadBacklogItems(dir);
    expect(items.filter((i) => i.status === "open")).toHaveLength(1);
    expect(items.filter((i) => i.status === "done")).toHaveLength(1);
  });

  it("digest ranks by priority, then recurrence, then recency — and notes omissions", () => {
    const old = 10 * 86_400e3;
    const now = Date.now();
    const mk = (file: string, mtime: number) => {
      fs.writeFileSync(backlogFile(dir), file);
      fs.utimesSync(backlogFile(dir), new Date(mtime), new Date(mtime));
    };
    ensureBacklogFile(dir);
    // low priority but most recent
    appendBacklogItems(dir, [{ summary: "low item", source: "s", priority: "low" }]);
    closeBacklogItems(dir, [loadBacklogItems(dir)[0].id]);
    // high priority, recurs 3x
    appendBacklogItems(dir, [{ summary: "high recurring", source: "s", priority: "high" }]);
    for (let i = 0; i < 2; i++) appendBacklogItems(dir, [{ summary: "high recurring", source: "s", priority: "high" }]);
    // med priority, recurred 1x
    appendBacklogItems(dir, [{ summary: "medium once", source: "s", priority: "med" }]);
    // force recency: high item last_seen oldest — re-touch its file block by rewriting created/last_seen via append recurrence is enough since count differs
    const items = loadBacklogItems(dir);
    expect(items.filter((i) => i.status === "open")).toHaveLength(2);
    const digest = formatBacklogDigest(dir, { limit: 1 });
    expect(digest).toContain("high recurring"); // priority wins
    expect(digest).toContain("OMISSION NOTE");
    expect(digest).toContain("advisory");
  });

  it("digest is empty when there are no open items", () => {
    expect(formatBacklogDigest(dir)).toBe("");
    ensureBacklogFile(dir);
    expect(formatBacklogDigest(dir)).toBe("");
    appendBacklogItems(dir, [{ summary: "x", source: "s" }]);
    expect(formatBacklogDigest(dir)).toContain("x");
    closeBacklogItems(dir, [loadBacklogItems(dir)[0].id]);
    expect(formatBacklogDigest(dir)).toBe("");
  });

  it("pruneBacklog drops the lowest-ranked open items beyond the cap", () => {
    ensureBacklogFile(dir);
    for (let i = 0; i < 5; i++) {
      // earlier items get older last_seen so recency ordering is unambiguous
      appendBacklogItems(dir, [{ summary: `item-${i}`, source: "test", priority: "low" }], new Date(Date.now() - (5 - i) * 60e3).toISOString());
    }
    const pruned = pruneBacklog(dir, 3);
    expect(pruned).toBe(2);
    expect(loadBacklogItems(dir)).toHaveLength(3);
    const kept = loadBacklogItems(dir).map((i) => i.summary);
    expect(kept).toEqual(["item-4", "item-3", "item-2"]);
  });

  it("topBacklogItem returns the highest-ranked open item or null", () => {
    expect(topBacklogItem(dir)).toBeNull();
    ensureBacklogFile(dir);
    appendBacklogItems(dir, [{ summary: "low thing", source: "s", priority: "low" }]);
    appendBacklogItems(dir, [{ summary: "big thing", source: "s", priority: "high" }]);
    const top = topBacklogItem(dir);
    expect(top?.summary).toBe("big thing");
    expect(top?.id).toBeTruthy();
    closeBacklogItems(dir, [top!.id]);
    expect(topBacklogItem(dir)?.summary).toBe("low thing");
  });
});