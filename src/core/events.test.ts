import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "./events.js";

describe("EventLog", () => {
  let dir: string;
  let log: EventLog;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-events-"));
    log = new EventLog(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends and tails events in order", () => {
    log.log("agent", "message", "hello");
    log.log("agent", "fire", "stretch");
    log.log("agent", "snooze", "1h");

    const tail = log.tail("agent", 2);
    expect(tail.map((e) => e.type)).toEqual(["fire", "snooze"]);
    expect(tail[0].summary).toBe("stretch");
    expect(tail[0].t).toBeGreaterThan(0);
    expect(log.tail("agent", 10)).toHaveLength(3);
  });

  it("keeps agents isolated", () => {
    log.log("a", "message", "one");
    log.log("b", "message", "two");
    expect(log.tail("a").map((e) => e.summary)).toEqual(["one"]);
  });
});