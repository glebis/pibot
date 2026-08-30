import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioMediaProcessor } from "./audio-media.js";

const roots: string[] = [];

function fixture(name: string): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-audio-media-"));
  roots.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, "media-bytes");
  return { root, file };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AudioMediaProcessor", () => {
  it("rejects paths outside the private media root without deleting them", async () => {
    const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-audio-root-"));
    roots.push(mediaRoot);
    const outside = fixture("outside.ogg").file;
    const processor = new AudioMediaProcessor(mediaRoot, { ffprobeBin: "/usr/bin/ffprobe" });

    const result = await processor.prepare({ kind: "voice", chatId: "42", filePath: outside, fileId: "f" });

    expect(result.ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("rejects a claimed audio document when the media probe finds no audio stream", async () => {
    const { root, file } = fixture("claimed.mp3");
    const execFileFn = vi.fn((
      _bin: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => queueMicrotask(() => cb(null, JSON.stringify({ format: { duration: "2.0" }, streams: [{ codec_type: "video" }] }), ""))) as unknown as typeof execFile;
    const processor = new AudioMediaProcessor(root, { execFileFn, ffprobeBin: "/usr/bin/ffprobe" });

    const result = await processor.prepare({ kind: "audio_document", chatId: "private-chat", filePath: file, fileId: "f" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejected media");
    expect(result.error).toContain("no audio track");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("extracts only the bounded audio track from a video note into a private safe file", async () => {
    const { root, file } = fixture("private-chat-77-video_note.mp4");
    const execFileMock = vi.fn((
      bin: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (bin.endsWith("ffprobe")) {
        queueMicrotask(() => cb(null, JSON.stringify({ format: { duration: "4.2" }, streams: [{ codec_type: "audio" }, { codec_type: "video" }] }), ""));
        return;
      }
      const out = String(args.at(-1));
      fs.writeFileSync(out, "pcm-audio", { mode: 0o644 });
      queueMicrotask(() => cb(null, "", ""));
    });
    const execFileFn = execFileMock as unknown as typeof execFile;
    const processor = new AudioMediaProcessor(root, {
      execFileFn,
      ffprobeBin: "/usr/bin/ffprobe",
      ffmpegBin: "/usr/bin/ffmpeg",
    });

    const result = await processor.prepare({ kind: "video_note", chatId: "private-chat", filePath: file, fileId: "f", durationSec: 4 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.basename(result.filePath)).not.toContain("private-chat");
    expect(path.extname(result.filePath)).toBe(".wav");
    expect(fs.statSync(result.filePath).mode & 0o777).toBe(0o600);
    const ffmpegCall = execFileMock.mock.calls.find((call) => String(call[0]).endsWith("ffmpeg"));
    expect(ffmpegCall?.[1]).toEqual(expect.arrayContaining(["-vn", "-ac", "1", "-ar", "16000"]));

    await result.cleanup();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(result.filePath)).toBe(false);
  });

  it("rejects media whose probed duration exceeds the configured bound", async () => {
    const { root, file } = fixture("too-long.ogg");
    const execFileFn = vi.fn((
      _bin: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => queueMicrotask(() => cb(null, JSON.stringify({ format: { duration: "301" }, streams: [{ codec_type: "audio" }] }), ""))) as unknown as typeof execFile;
    const processor = new AudioMediaProcessor(root, { execFileFn, ffprobeBin: "/usr/bin/ffprobe", maxVoiceSeconds: 300 });

    const result = await processor.prepare({ kind: "voice", chatId: "42", filePath: file, fileId: "f" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejected media");
    expect(result.error).toContain("duration");
    expect(fs.existsSync(file)).toBe(false);
  });
});
