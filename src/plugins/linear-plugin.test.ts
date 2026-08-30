import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { linearPlugin } from "./linear-plugin.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command, _args, _options, callback) => callback(new Error("external process blocked by test"))),
}));

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

describe("linear plugin", () => {
  it("does not execute issue mutations without an explicit confirmation", async () => {
    const tools = new Map<string, any>();
    const pi = { registerTool: (tool: { name: string }) => tools.set(tool.name, tool), registerCommand: vi.fn(), on: vi.fn() } as unknown as ExtensionAPI;
    factoryOf(linearPlugin())(pi);
    const res = await tools.get("linear_create").execute("call", { title: "External change", description: "Must be approved" });
    expect(res.content[0].text).toContain("confirmation required");
  });
});
