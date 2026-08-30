import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMacSpeechProvider, SpeechArtifactStore, SpeechProviderRegistry } from "./speech.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-speech-"));
  roots.push(value);
  return value;
}

function fakeLocalProvider(): { provider: LocalMacSpeechProvider; calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn((
    bin: string,
    args: readonly string[],
    _opts: unknown,
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const output = String(bin.endsWith("say") ? args[args.indexOf("-o") + 1] : args.at(-1));
    if (bin.endsWith("say")) fs.writeFileSync(output, "FORM-local-aiff");
    else if (output.endsWith(".ogg")) fs.writeFileSync(output, "OggS-local-opus");
    else fs.writeFileSync(output, Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A "), Buffer.from("local-aac")]));
    queueMicrotask(() => cb(null, "", ""));
  });
  return {
    provider: new LocalMacSpeechProvider({ execFileFn: calls as unknown as typeof execFile, sayBin: "/usr/bin/say", ffmpegBin: "/opt/homebrew/bin/ffmpeg" }),
    calls,
  };
}

describe("local speech generation", () => {
  it("renders a Telegram voice artifact through say and argument-safe ffmpeg", async () => {
    const { provider, calls } = fakeLocalProvider();

    const generated = await provider.generate({ text: "short private reply", kind: "voice" });

    expect(generated.mimeType).toBe("audio/ogg");
    expect(generated.extension).toBe(".ogg");
    expect(generated.bytes.subarray(0, 4).toString()).toBe("OggS");
    const say = calls.mock.calls.find((call) => String(call[0]).endsWith("say"));
    expect(say).toBeDefined();
    expect(say?.[1]).not.toContain("--data-format=LEI16@16000");
    const ffmpeg = calls.mock.calls.find((call) => String(call[0]).endsWith("ffmpeg"));
    expect(ffmpeg?.[1]).toEqual(expect.arrayContaining(["-c:a", "libopus", "-application", "voip"]));
  });

  it("renders Telegram music-player audio as M4A", async () => {
    const { provider } = fakeLocalProvider();

    const generated = await provider.generate({ text: "audio version", kind: "audio" });

    expect(generated.mimeType).toBe("audio/mp4");
    expect(generated.extension).toBe(".m4a");
    expect(generated.bytes.subarray(4, 8).toString()).toBe("ftyp");
  });

  it("exposes only configured providers and makes no call during discovery", () => {
    const { provider, calls } = fakeLocalProvider();
    const registry = new SpeechProviderRegistry([provider]);

    expect(registry.list()).toEqual([{ id: "local", configured: true }]);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("SpeechArtifactStore", () => {
  it("stores private chat-scoped artifacts without message text or raw chat ids", async () => {
    const dir = root();
    const store = new SpeechArtifactStore(dir);
    const artifact = await store.save({
      agentId: "coach",
      transport: "telegram:coach",
      chatId: "secret-chat-42",
      providerId: "local",
      kind: "voice",
      mimeType: "audio/ogg",
      extension: ".ogg",
      bytes: Buffer.from("OggS-private-audio"),
    });

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(artifact.filePath).mode & 0o777).toBe(0o600);
    const metadata = fs.readFileSync(path.join(dir, `${artifact.id}.json`), "utf8");
    expect(metadata).not.toContain("secret-chat-42");
    expect(metadata).not.toContain("private-audio");
    await expect(store.resolve(artifact.id, { agentId: "coach", transport: "telegram:coach", chatId: "different" })).rejects.toThrow(/scope/i);
    await expect(store.resolve(artifact.id, { agentId: "coach", transport: "telegram:coach", chatId: "secret-chat-42" })).resolves.toMatchObject({ id: artifact.id });
  });

  it("removes an artifact after successful delivery and sweeps expired files", async () => {
    const dir = root();
    let now = 1_000;
    const store = new SpeechArtifactStore(dir, { now: () => now, retentionMs: 1_000 });
    const scope = { agentId: "coach", transport: "telegram:coach", chatId: "42" };
    const first = await store.save({ ...scope, providerId: "local", kind: "voice", mimeType: "audio/ogg", extension: ".ogg", bytes: Buffer.from("OggS-first") });
    await store.remove(first.id, scope);
    expect(fs.existsSync(first.filePath)).toBe(false);

    const expired = await store.save({ ...scope, providerId: "local", kind: "audio", mimeType: "audio/mp4", extension: ".m4a", bytes: Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp-old")]) });
    now = 2_001;
    await store.sweep();
    expect(fs.existsSync(expired.filePath)).toBe(false);
  });

  it("rejects a private artifact whose audio bytes were replaced after generation", async () => {
    const dir = root();
    const store = new SpeechArtifactStore(dir);
    const scope = { agentId: "coach", transport: "telegram:coach", chatId: "42" };
    const artifact = await store.save({ ...scope, providerId: "local", kind: "voice", mimeType: "audio/ogg", extension: ".ogg", bytes: Buffer.from("OggS-valid") });
    fs.writeFileSync(artifact.filePath, "not-ogg", { mode: 0o600 });

    await expect(store.resolve(artifact.id, scope)).rejects.toThrow(/OGG|invalid/i);
  });
});
