import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { calendarPlugin } from "./calendar-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type Tool = { execute: () => Promise<{ content: Array<{ text: string }> }> };

describe("calendar plugin", () => {
  it("registers calendar_today and always returns both sections", async () => {
    const tools = new Map<string, Tool>();
    const pi = {
      registerTool: (t: { name: string }) => tools.set(t.name, t as unknown as Tool),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    factoryOf(calendarPlugin())(pi);

    expect(tools.has("calendar_today")).toBe(true);
    const res = await tools.get("calendar_today")!.execute();
    // both sections present whether or not the backends are available
    expect(res.content[0].text).toContain("macOS Calendar");
    expect(res.content[0].text).toContain("Google Calendar");
  });
});