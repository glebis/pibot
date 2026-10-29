import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SttPolicy } from "./stt.js";
import {
  probeDurationSecWithFfprobe,
  runChunkedTranscription,
  segmentAudioWithFfmpeg,
  type ChunkedTranscriptionDeps,
} from "./audio-chunks.js";

const AGENT_POLICY: SttPolicy = { providers: ["whisperkit", "groq"], allowExternal: true };

const tmpDirs: string[] = [];
function tmpFile(content = "fake-audio"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-chunk-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "talk.ogg");
  fs.writeFileSync(file, content);
  return file;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Deterministic IO: three fixture parts, each transcribing to a distinct line. */
function fakeIo(over: Partial<ChunkedTranscriptionDeps> = {}): ChunkedTranscriptionDeps & { cleanup: ReturnType<typeof vi.fn>; seen: Array<{ path: string; index: number }> } {
  const cleanup = vi.fn(async () => {});
  const seen: Array<{ path: string; index: number }> = [];
  const io: ChunkedTranscriptionDeps & { cleanup: typeof cleanup; seen: typeof seen } = {
    probeDurationSec: vi.fn(async () => 27 * 60),
    segment: vi.fn(async (_file: string, _sec: number) => ["/tmp/chunk-000.wav", "/tmp/chunk-001.wav"]),
    transcribeChunk: vi.fn(async (p: string, index: number) => {
      seen.push({ path: p, index });
      return { ok: true, text: `part ${index}`, provider: "groq" };
    }),
    cleanupParts: cleanup,
    cleanup,
    seen,
    ...over,
  };
  return io;
}

describe("runChunkedTranscription", () => {
  it("segments, transcribes each chunk with Groq and joins in order", async () => {
    const io = fakeIo();
    const file = tmpFile();
    const r = await runChunkedTranscription(file, { durationSec: 27 * 60, policy: AGENT_POLICY, hostProviders: ["whisperkit", "groq"] }, io);
    expect(r.ok).toBe(true);
    expect(r.route).toBe("chunked-external");
    expect(r.provider).toBe("groq");
    expect(r.chunks).toBe(2);
    expect(r.transcripts).toEqual(["part 0", "part 1"]);
    expect(r.text).toBe("part 0\n\npart 1");
    expect(io.segment).toHaveBeenCalledWith(file, 900);
    expect(io.seen.map((s) => s.index)).toEqual([0, 1]);
    expect(io.cleanup).toHaveBeenCalledWith(["/tmp/chunk-000.wav", "/tmp/chunk-001.wav"]);
  });

  it("probes an unknown duration and re-plans before segmenting", async () => {
    const io = fakeIo({ probeDurationSec: vi.fn(async () => 27 * 60) });
    const r = await runChunkedTranscription(tmpFile(), { durationSec: null, policy: AGENT_POLICY, hostProviders: ["whisperkit", "groq"] }, io);
    expect(r.ok).toBe(true);
    expect(io.probeDurationSec).toHaveBeenCalled();
    expect(r.durationSec).toBe(27 * 60);
  });

  it("blocks with a precise error when the duration cannot be probed — never asserts long", async () => {
    const io = fakeIo({ probeDurationSec: vi.fn(async () => null) });
    const r = await runChunkedTranscription(tmpFile(), { durationSec: null, policy: AGENT_POLICY, hostProviders: ["whisperkit", "groq"] }, io);
    expect(r.ok).toBe(false);
    expect(r.route).toBe("probe-required");
    expect(r.error).toMatch(/probe/i);
    expect(io.segment).not.toHaveBeenCalled();
    expect(io.transcribeChunk).not.toHaveBeenCalled();
  });

  it("refuses the whole file when the approved route is blocked (Groq unavailable) and never substitutes locally", async () => {
    const io = fakeIo();
    const r = await runChunkedTranscription(
      tmpFile(),
      { durationSec: 27 * 60, policy: { providers: ["whisperkit", "local_whisper"] }, hostProviders: ["whisperkit", "local_whisper"] },
      io,
    );
    expect(r.ok).toBe(false);
    expect(r.route).toBe("blocked");
    expect(r.provider).toBe("none");
    expect(r.error).toMatch(/Groq/);
    expect(io.transcribeChunk).not.toHaveBeenCalled();
  });

  it("reports the failing chunk precisely and attempts no local fallback", async () => {
    const io = fakeIo({
      segment: vi.fn(async () => ["/tmp/c0.wav", "/tmp/c1.wav", "/tmp/c2.wav"]),
      transcribeChunk: vi.fn(async (_p: string, index: number) =>
        index === 1 ? { ok: false, text: "", provider: "groq", error: "groq HTTP 429" } : { ok: true, text: `part ${index}`, provider: "groq" },
      ),
    });
    const r = await runChunkedTranscription(tmpFile(), { durationSec: 45 * 60, policy: AGENT_POLICY, hostProviders: ["whisperkit", "groq"] }, io);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("chunk 2/3 failed");
    expect(r.error).toContain("groq HTTP 429");
    expect(r.error).toMatch(/no local fallback/i);
    expect(r.transcripts).toEqual(["part 0"]);
    expect(io.cleanup).toHaveBeenCalled();
  });

  it("reports a segmentation failure instead of transcribing the uncut file", async () => {
    const io = fakeIo({ segment: vi.fn(async () => { throw new Error("ffmpeg died"); }) });
    const r = await runChunkedTranscription(tmpFile(), { durationSec: 27 * 60, policy: AGENT_POLICY, hostProviders: ["whisperkit", "groq"] }, io);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/segmentation failed: ffmpeg died/);
    expect(io.transcribeChunk).not.toHaveBeenCalled();
  });

  it("blocks when the segmenter produces no chunks", async () => {
    const io = fakeIo({ segment: vi.fn(async () => []) });
    const r = await runChunkedTranscription(tmpFile(), { durationSec: 27 * 60, policy: AGENT_POLICY, hostProviders: ["whisperkit", "groq"] }, io);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no chunks/);
    expect(io.transcribeChunk).not.toHaveBeenCalled();
  });

  it("does not silently service a short-audio route through the chunk executor", async () => {
    const io = fakeIo();
    const r = await runChunkedTranscription(tmpFile(), { durationSec: 5 * 60, policy: AGENT_POLICY, hostProviders: ["whisperkit", "groq"] }, io);
    expect(r.ok).toBe(false);
    expect(r.route).toBe("policy");
    expect(r.error).toContain("only runs the long-audio Groq route");
    expect(io.segment).not.toHaveBeenCalled();
  });
});

describe("real host IO helpers (injected exec, temp fixtures)", () => {
  const fakeExec = (stdout: string) =>
    ((_cmd: string, _args: readonly string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      queueMicrotask(() => cb(null, stdout));
    }) as unknown as typeof import("node:child_process").execFile;

  it("ffprobe helper parses a usable duration and rejects garbage", async () => {
    expect(await probeDurationSecWithFfprobe(fakeExec("1530.5\n"), "/tmp/x.ogg", "/opt/ffprobe")).toBeCloseTo(1530.5);
    expect(await probeDurationSecWithFfprobe(fakeExec("N/A\n"), "/tmp/x.ogg", "/opt/ffprobe")).toBeNull();
    expect(await probeDurationSecWithFfprobe(fakeExec("10"), "/tmp/x.ogg", null)).toBeNull();
  });

  it("ffmpeg segment helper returns ordered chunk paths from the output dir", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-seg-"));
    tmpDirs.push(outDir);
    let sawArgs: string[] = [];
    const exec = ((_cmd: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      sawArgs = [...args];
      const pattern = args[args.length - 1];
      const dir = path.dirname(pattern);
      fs.writeFileSync(path.join(dir, "chunk-001.wav"), "b");
      fs.writeFileSync(path.join(dir, "chunk-000.wav"), "a");
      queueMicrotask(() => cb(null, ""));
    }) as unknown as typeof import("node:child_process").execFile;
    const parts = await segmentAudioWithFfmpeg(exec, "/tmp/in.ogg", 900, outDir, "/opt/ffmpeg");
    expect(sawArgs).toContain("-segment_time");
    expect(sawArgs).toContain("900");
    expect(parts).toEqual([path.join(outDir, "chunk-000.wav"), path.join(outDir, "chunk-001.wav")]);
  });
});
