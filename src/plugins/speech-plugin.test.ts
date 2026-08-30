import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SpeechArtifactStore, SpeechProviderRegistry, type SpeechProvider } from "../core/speech.js";
import { speechPlugin } from "./speech-plugin.js";

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof ext === "function" ? ext : ext.factory;
}

type Tool = ToolDefinition & { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
function captureTools(ext: InlineExtension): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  factoryOf(ext)({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool as Tool), registerCommand: vi.fn(), on: vi.fn() } as unknown as ExtensionAPI);
  return tools;
}

describe("speech plugin", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-speech-plugin-"));
    roots.push(root);
    const provider: SpeechProvider = {
      id: "local",
      configured: () => true,
      generate: vi.fn(async (request) => request.kind === "voice"
        ? { bytes: Buffer.from("OggS-voice"), mimeType: "audio/ogg" as const, extension: ".ogg" as const }
        : { bytes: Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp-audio")]), mimeType: "audio/mp4" as const, extension: ".m4a" as const }),
    };
    const send = vi.fn(async () => undefined);
    const store = new SpeechArtifactStore(root);
    const tools = captureTools(speechPlugin({
      agentId: "coach",
      transport: "telegram:coach",
      chatId: "42",
      providers: new SpeechProviderRegistry([provider]),
      store,
      send,
    }));
    return { tools, provider, send, store };
  }

  it("generates a private artifact without sending it", async () => {
    const { tools, provider, send } = setup();
    expect([...tools.keys()].sort()).toEqual(["speech_generate", "speech_send"]);

    const result = await tools.get("speech_generate")!.execute("call-1", { text: "hello", kind: "voice", provider: "local" });

    expect(provider.generate).toHaveBeenCalledWith({ text: "hello", kind: "voice", voice: undefined });
    expect(result.details.artifactId).toEqual(expect.any(String));
    expect(send).not.toHaveBeenCalled();
  });

  it("sends only to the invoking transport and chat, then removes the artifact", async () => {
    const { tools, send, store } = setup();
    const generated = await tools.get("speech_generate")!.execute("call-1", { text: "hello", kind: "voice", provider: "local" });

    const result = await tools.get("speech_send")!.execute("call-2", { artifactId: generated.details.artifactId, caption: "requested voice" });

    expect(send).toHaveBeenCalledWith("telegram:coach", "42", "voice", expect.stringMatching(/\.ogg$/), "requested voice");
    expect(result.details.sent).toBe(true);
    await expect(store.resolve(String(generated.details.artifactId), { agentId: "coach", transport: "telegram:coach", chatId: "42" })).rejects.toThrow(/not found/i);
  });

  it("keeps the artifact when delivery fails so the owner can retry", async () => {
    const { tools, send, store } = setup();
    const generated = await tools.get("speech_generate")!.execute("call-1", { text: "hello", kind: "audio", provider: "local" });
    send.mockRejectedValueOnce(new Error("offline"));

    await expect(tools.get("speech_send")!.execute("call-2", { artifactId: generated.details.artifactId })).rejects.toThrow("offline");

    await expect(store.resolve(String(generated.details.artifactId), { agentId: "coach", transport: "telegram:coach", chatId: "42" })).resolves.toBeDefined();
  });

  it("reports a successful send even when post-send cleanup fails", async () => {
    const { tools, send, store } = setup();
    const generated = await tools.get("speech_generate")!.execute("call-1", { text: "hello", kind: "voice", provider: "local" });
    vi.spyOn(store, "remove").mockRejectedValueOnce(new Error("cleanup failed"));

    const result = await tools.get("speech_send")!.execute("call-2", { artifactId: generated.details.artifactId });

    expect(send).toHaveBeenCalledOnce();
    expect(result.details.sent).toBe(true);
  });
});
