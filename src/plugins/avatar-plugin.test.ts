import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AvatarArtifactStore, AvatarProviderRegistry, type AvatarProvider } from "../core/avatar.js";
import { avatarPlugin } from "./avatar-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };

function captureTools(ext: InlineExtension): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool as Tool),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  factoryOf(ext)(pi);
  return tools;
}

describe("avatar plugin", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup(confirm: (description: string) => Promise<boolean>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-avatar-tool-"));
    roots.push(root);
    const provider: AvatarProvider = {
      id: "local",
      configured: () => true,
      generate: vi.fn(async () => ({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg" as const })),
    };
    const applyProfilePhoto = vi.fn(async (_transport: string, _filePath: string) => undefined);
    const tools = captureTools(avatarPlugin({
      agentId: "coach",
      transport: "telegram:coach",
      providers: new AvatarProviderRegistry([provider]),
      store: new AvatarArtifactStore(root),
      confirm,
      applyProfilePhoto,
    }));
    return { tools, provider, applyProfilePhoto };
  }

  it("generates a selected artifact without applying it automatically", async () => {
    const { tools, provider, applyProfilePhoto } = setup(vi.fn(async () => true));
    expect([...tools.keys()].sort()).toEqual(["avatar_apply", "avatar_generate"]);

    const result = await tools.get("avatar_generate")!.execute("call-1", { provider: "local", seed: "calm", label: "FC" });

    expect(provider.generate).toHaveBeenCalledWith({ seed: "calm", label: "FC" });
    expect(result.content[0].text).toMatch(/generated|ready/i);
    expect(result.details.artifactId).toEqual(expect.any(String));
    expect(applyProfilePhoto).not.toHaveBeenCalled();
  });

  it("cancels apply when the owner does not confirm", async () => {
    const confirm = vi.fn(async () => false);
    const { tools, applyProfilePhoto } = setup(confirm);
    const generated = await tools.get("avatar_generate")!.execute("call-1", { provider: "local", seed: "calm", label: "FC" });

    const result = await tools.get("avatar_apply")!.execute("call-2", { artifactId: generated.details.artifactId });

    expect(confirm).toHaveBeenCalledOnce();
    expect(result.content[0].text).toMatch(/cancel/i);
    expect(applyProfilePhoto).not.toHaveBeenCalled();
  });

  it("applies a confirmed artifact only through the invoking Telegram transport", async () => {
    const confirm = vi.fn(async () => true);
    const { tools, applyProfilePhoto } = setup(confirm);
    const generated = await tools.get("avatar_generate")!.execute("call-1", { provider: "local", seed: "calm", label: "FC" });

    const result = await tools.get("avatar_apply")!.execute("call-2", { artifactId: generated.details.artifactId });

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/profile photo|avatar/i));
    expect(applyProfilePhoto).toHaveBeenCalledWith("telegram:coach", expect.stringMatching(/\.jpe?g$/i));
    expect(result.content[0].text).toMatch(/updated|applied/i);
  });
});
