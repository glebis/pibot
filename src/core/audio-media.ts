import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { IncomingMedia } from "./types.js";
import { errorMessage } from "./util.js";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 120_000;

export interface AudioMediaDeps {
  execFileFn?: typeof execFile;
  ffprobeBin?: string | null;
  ffmpegBin?: string | null;
  probeTimeoutMs?: number;
  extractTimeoutMs?: number;
  maxVoiceSeconds?: number;
  maxAudioSeconds?: number;
}

export type PreparedAudio =
  | { ok: true; filePath: string; durationSec: number; cleanup: () => Promise<void> }
  | { ok: false; error: string };

interface ProbeJson {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string }>;
}

export class AudioMediaProcessor {
  constructor(private readonly mediaDir: string, private readonly deps: AudioMediaDeps = {}) {}

  async prepare(media: IncomingMedia): Promise<PreparedAudio> {
    const source = path.resolve(media.filePath);
    const cleanupPaths = new Set<string>();
    try {
      this.ensurePrivateDir();
      const root = fs.realpathSync(this.mediaDir);
      const sourceStat = fs.lstatSync(source);
      if (sourceStat.isSymbolicLink()) return { ok: false, error: "media path is not a regular private file" };
      const resolvedSource = fs.realpathSync(source);
      const relative = path.relative(root, resolvedSource);
      if (!sourceStat.isFile() || relative.startsWith("..") || path.isAbsolute(relative)) {
        return { ok: false, error: "media path is outside the private media directory" };
      }
      cleanupPaths.add(resolvedSource);
      const probe = await this.probe(resolvedSource);
      if (!probe.hasAudio) throw new Error("media has no audio track");
      const maxDuration = media.kind === "audio" || media.kind === "audio_document"
        ? this.deps.maxAudioSeconds ?? 1800
        : this.deps.maxVoiceSeconds ?? 300;
      if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0 || probe.durationSec > maxDuration) {
        throw new Error(`audio duration must be between 0 and ${maxDuration} seconds`);
      }
      if (media.kind !== "video_note") {
        await fsp.chmod(resolvedSource, 0o600);
        return { ok: true, filePath: resolvedSource, durationSec: probe.durationSec, cleanup: () => this.cleanup(cleanupPaths) };
      }

      const output = path.join(this.mediaDir, `${randomUUID()}.wav`);
      cleanupPaths.add(output);
      await this.extract(resolvedSource, output);
      const stat = await fsp.stat(output);
      if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) throw new Error("extracted audio is empty or too large");
      await fsp.chmod(output, 0o600);
      return { ok: true, filePath: output, durationSec: probe.durationSec, cleanup: () => this.cleanup(cleanupPaths) };
    } catch (error) {
      await this.cleanup(cleanupPaths);
      return { ok: false, error: errorMessage(error) };
    }
  }

  private ensurePrivateDir(): void {
    fs.mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.mediaDir, 0o700);
  }

  private async probe(filePath: string): Promise<{ hasAudio: boolean; durationSec: number }> {
    const bin = "ffprobeBin" in this.deps ? this.deps.ffprobeBin : await whichBin(this.deps.execFileFn ?? execFile, "ffprobe");
    if (!bin) throw new Error("ffprobe is not installed");
    const [stdout] = await runExec(this.deps.execFileFn ?? execFile, bin, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type",
      "-of", "json",
      filePath,
    ], this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    let parsed: ProbeJson;
    try { parsed = JSON.parse(stdout) as ProbeJson; } catch { throw new Error("media probe returned invalid output"); }
    return {
      hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === "audio"),
      durationSec: Number(parsed.format?.duration),
    };
  }

  private async extract(source: string, output: string): Promise<void> {
    const bin = "ffmpegBin" in this.deps ? this.deps.ffmpegBin : await whichBin(this.deps.execFileFn ?? execFile, "ffmpeg");
    if (!bin) throw new Error("ffmpeg is not installed");
    await runExec(this.deps.execFileFn ?? execFile, bin, [
      "-nostdin", "-v", "error", "-i", source,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-y", output,
    ], this.deps.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS);
  }

  private async cleanup(paths: Iterable<string>): Promise<void> {
    await Promise.all([...paths].map((entry) => fsp.unlink(entry).catch(() => {})));
  }
}

function runExec(execFn: typeof execFile, bin: string, args: string[], timeout: number): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    execFn(bin, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(bin)} failed: ${errorMessage(error)}`));
      else resolve([stdout.toString(), stderr.toString()]);
    });
  });
}

function whichBin(execFn: typeof execFile, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFn("sh", ["-c", `command -v ${name}`], { timeout: 5_000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}
