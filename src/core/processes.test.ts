import { describe, expect, it } from "vitest";
import { descendantsFromPs, parseEtime } from "./processes.js";

describe("process listing", () => {
  it("parses ps elapsed times", () => {
    expect(parseEtime("05")).toBe(5);
    expect(parseEtime("01:05")).toBe(65);
    expect(parseEtime("02:00:01")).toBe(7201);
    expect(parseEtime("3-00:00:10")).toBe(3 * 86400 + 10);
  });

  it("never exposes child-process arguments that may contain credentials or prompts", () => {
    const rows = descendantsFromPs("205 100 00:10 40000 /opt/bin/worker --token PRIVATE_TOKEN -p PRIVATE_PROMPT", 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe("worker");
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_TOKEN|PRIVATE_PROMPT|--token/);
  });

  it("keeps only the daemon's descendants, in tree order with depth", () => {
    const ps = [
      "  100     1   1-02:00:00  90000 node tsx src/index.ts",
      "  205   100        10:00  40000 claude -p research the repo --output-format text",
      "  206   205        09:58   2000 /bin/zsh -c rg TODO",
      "  210   100        00:03   1000 ps -A -o pid=,ppid=,etime=,rss=,command=",
      "  300     1        05:00   5000 unrelated other-app",
      "  201   100     01:00:00  12000 node mcp-server.js",
    ].join("\n");
    expect(descendantsFromPs(ps, 100).map((p) => [p.pid, p.depth, p.elapsedSec])).toEqual([
      [201, 1, 3600],
      [205, 1, 600],
      [206, 2, 598],
    ]);
  });
});
