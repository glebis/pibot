import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelCascade } from "./cascade.js";

function cascade(globalTail: string[] = []) {
  return new ModelCascade({
    statePath: path.join(os.tmpdir(), `pibot-cascade-${Math.random()}.json`),
    globalTail,
    modelRuntime: {
      getModels: () => [
        { provider: "ollama", id: "local" },
        { provider: "anthropic", id: "claude" },
      ],
      hasConfiguredAuth: () => true,
    } as never,
  });
}

describe("per-agent provider routing", () => {
  it("does not append global or authenticated providers when no policy opts into them", () => {
    expect(cascade(["anthropic/global"]).chainFor({ model: "ollama/primary" })).toEqual(["ollama/primary"]);
  });

  it("only routes through providers explicitly allowed by the agent", () => {
    expect(cascade(["anthropic/global", "ollama/global"]).chainFor({
      model: "ollama/primary",
      providers: ["anthropic"],
    })).toEqual(["anthropic/global", "anthropic/claude"]);
  });
});
