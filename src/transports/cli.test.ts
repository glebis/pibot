import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readlineMock = vi.hoisted(() => ({ createInterface: vi.fn() }));
vi.mock("node:readline", () => readlineMock);

import { CliTransport } from "./cli.js";

type LineHandler = (line: string) => Promise<void>;

function setup() {
  let lineHandler: LineHandler | undefined;
  let closeHandler: (() => void) | undefined;
  const rl = {
    setPrompt: vi.fn(),
    prompt: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, cb: LineHandler | (() => void)) => {
      if (event === "line") lineHandler = cb as LineHandler;
      if (event === "close") closeHandler = cb as () => void;
      return rl;
    }),
  };
  readlineMock.createInterface.mockReturnValue(rl as never);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const transport = new CliTransport();
  return {
    transport, rl, log, write, exit,
    line: () => {
      if (!lineHandler) throw new Error("line handler not registered");
      return lineHandler;
    },
    close: () => {
      if (!closeHandler) throw new Error("close handler not registered");
      return closeHandler;
    },
  };
}

beforeEach(() => readlineMock.createInterface.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("CliTransport", () => {
  it("starts readline on stdin/stdout and registers the local CLI lifecycle", async () => {
    const f = setup();
    await f.transport.start();

    expect(readlineMock.createInterface).toHaveBeenCalledWith({ input: process.stdin, output: process.stdout });
    expect(f.rl.setPrompt).toHaveBeenCalledWith("you › ");
    expect(f.rl.prompt).toHaveBeenCalledTimes(1);
    expect(f.rl.on).toHaveBeenCalledWith("line", expect.any(Function));
    expect(f.rl.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("trims non-empty input into the exact local chat and re-prompts", async () => {
    const f = setup();
    const onMessage = vi.fn(async () => {});
    f.transport.onMessage(onMessage);
    await f.transport.start();

    await f.line()("  hello  ");

    expect(onMessage).toHaveBeenCalledWith("hello", "local");
    expect(onMessage.mock.calls[0]).toHaveLength(2);
    expect(f.rl.prompt).toHaveBeenCalledTimes(2);
  });

  it("ignores empty input and only re-prompts", async () => {
    const f = setup();
    const onMessage = vi.fn(async () => {});
    f.transport.onMessage(onMessage);
    await f.transport.start();

    await f.line()("   ");

    expect(onMessage).not.toHaveBeenCalled();
    expect(f.rl.prompt).toHaveBeenCalledTimes(2);
  });

  it("renders outbound text and numbered card choices", async () => {
    const f = setup();

    await f.transport.push("local", {
      text: "Choose **carefully**",
      card: { text: "", buttons: [{ label: "Yes", action: "yes" }, { label: "No", action: "no" }] },
    });

    expect(f.log).toHaveBeenCalledWith("agent › Choose carefully\n");
    expect(f.log).toHaveBeenCalledWith("choose › [1] Yes  [2] No   (or type anything else)\n");
  });

  it("routes a valid numbered choice to the action callback in the local chat", async () => {
    const f = setup();
    const onAction = vi.fn(async () => "accepted");
    f.transport.onAction(onAction);
    await f.transport.start();
    await f.transport.push("local", { text: "Pick", card: { text: "", buttons: [{ label: "Yes", action: "yes" }] } });

    await f.line()("1");

    expect(onAction).toHaveBeenCalledWith("yes", "local");
    expect(f.log).toHaveBeenCalledWith("✓ accepted\n");
  });

  it("routes nonnumeric card input as a message and clears the pending card", async () => {
    const f = setup();
    const onMessage = vi.fn(async () => {});
    const onAction = vi.fn(async () => {});
    f.transport.onMessage(onMessage);
    f.transport.onAction(onAction);
    await f.transport.start();
    await f.transport.push("local", { text: "Pick", card: { text: "", buttons: [{ label: "Yes", action: "yes" }] } });

    await f.line()("custom answer");
    await f.line()("1");

    expect(onMessage.mock.calls).toEqual([["custom answer", "local"], ["1", "local"]]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("does not silently lose an out-of-range numbered choice", async () => {
    const f = setup();
    const onMessage = vi.fn(async () => {});
    const onAction = vi.fn(async () => {});
    f.transport.onMessage(onMessage);
    f.transport.onAction(onAction);
    await f.transport.start();
    await f.transport.push("local", { text: "Pick", card: { text: "", buttons: [{ label: "Yes", action: "yes" }] } });

    await f.line()("5");

    expect(onMessage).toHaveBeenCalledWith("5", "local");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("stops readline and exits cleanly on EOF", async () => {
    const f = setup();
    await f.transport.start();

    await f.transport.stop();
    expect(f.rl.close).toHaveBeenCalledTimes(1);
    f.close()();
    expect(f.exit).toHaveBeenCalledWith(0);
  });

  it("formats errors and emits typing only when enabled", async () => {
    const f = setup();
    await f.transport.notifyError("local", "x".repeat(400));
    f.transport.setTyping("local", true);
    f.transport.setTyping("local", false);

    const error = f.log.mock.calls[0][0] as string;
    expect(error).toMatch(/^⚠︎  x+…\n$/);
    expect(error.length).toBe(305);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledWith("…thinking\n");
  });
});
