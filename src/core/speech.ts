import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { errorMessage } from "./util.js";

export type SpeechKind = "voice" | "audio";
export interface SpeechRequest {
  text: string;
  kind: SpeechKind;
  voice?: string;
}
export interface GeneratedSpeech {
  bytes: Buffer;
  mimeType: "audio/ogg" | "audio/mp4";
  extension: ".ogg" | ".m4a";
}
export interface SpeechProvider {
  readonly id: string;
  configured(): boolean;
  generate(request: SpeechRequest): Promise<GeneratedSpeech>;
}

export interface LocalMacSpeechOptions {
  execFileFn?: typeof execFile;
  sayBin?: string | null;
  ffmpegBin?: string | null;
  timeoutMs?: number;
}

export class LocalMacSpeechProvider implements SpeechProvider {
  readonly id = "local";
  constructor(private readonly options: LocalMacSpeechOptions = {}) {}

  configured(): boolean {
    const say = "sayBin" in this.options ? this.options.sayBin : "/usr/bin/say";
    const ffmpeg = "ffmpegBin" in this.options ? this.options.ffmpegBin : findExecutable("ffmpeg");
    return Boolean(say && ffmpeg && fs.existsSync(say) && fs.existsSync(ffmpeg));
  }

  async generate(request: SpeechRequest): Promise<GeneratedSpeech> {
    const text = request.text.trim();
    if (!text || text.length > 2_000) throw new Error("Speech text must be 1-2000 characters");
    if (request.voice && !/^[\p{L}\p{N} _.-]{1,80}$/u.test(request.voice)) throw new Error("Invalid local voice name");
    const say = "sayBin" in this.options ? this.options.sayBin : "/usr/bin/say";
    const ffmpeg = "ffmpegBin" in this.options ? this.options.ffmpegBin : findExecutable("ffmpeg");
    if (!say || !ffmpeg) throw new Error("Local speech tools are not configured");

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pibot-speech-"));
    await fsp.chmod(tempDir, 0o700);
    const aiff = path.join(tempDir, "source.aiff");
    const extension = request.kind === "voice" ? ".ogg" : ".m4a";
    const output = path.join(tempDir, `speech${extension}`);
    try {
      // Let `say` choose the AIFF-compatible data format; ffmpeg performs the
      // explicit resampling. LEI16 is incompatible with AIFF on macOS.
      const sayArgs = ["-o", aiff];
      if (request.voice) sayArgs.push("-v", request.voice);
      sayArgs.push(text);
      await runExec(this.options.execFileFn ?? execFile, say, sayArgs, this.options.timeoutMs ?? 60_000);
      const ffmpegArgs = request.kind === "voice"
        ? ["-nostdin", "-v", "error", "-i", aiff, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-y", output]
        : ["-nostdin", "-v", "error", "-i", aiff, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-y", output];
      await runExec(this.options.execFileFn ?? execFile, ffmpeg, ffmpegArgs, this.options.timeoutMs ?? 60_000);
      const bytes = await fsp.readFile(output);
      validateSpeechBytes(request.kind, bytes);
      return request.kind === "voice"
        ? { bytes, mimeType: "audio/ogg", extension: ".ogg" }
        : { bytes, mimeType: "audio/mp4", extension: ".m4a" };
    } finally {
      await Promise.all([aiff, output].map((entry) => fsp.unlink(entry).catch(() => {})));
      await fsp.rmdir(tempDir).catch(() => {});
    }
  }
}

export class SpeechProviderRegistry {
  private readonly providers: Map<string, SpeechProvider>;
  constructor(providers: readonly SpeechProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }
  list(): Array<{ id: string; configured: boolean }> {
    return [...this.providers.values()].map((provider) => ({ id: provider.id, configured: provider.configured() }));
  }
  async generate(providerId: string, request: SpeechRequest): Promise<GeneratedSpeech> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown speech provider "${providerId}"`);
    if (!provider.configured()) throw new Error(`Speech provider "${providerId}" is not configured`);
    return provider.generate(request);
  }
}

export function createDefaultSpeechProviders(): SpeechProviderRegistry {
  return new SpeechProviderRegistry([new LocalMacSpeechProvider()]);
}

export interface SpeechArtifact {
  id: string;
  agentId: string;
  transport: string;
  chatScope: string;
  providerId: string;
  kind: SpeechKind;
  mimeType: "audio/ogg" | "audio/mp4";
  extension: ".ogg" | ".m4a";
  filePath: string;
  createdAt: number;
}

type SpeechScope = { agentId: string; transport: string; chatId: string };
type SpeechStoreInput = SpeechScope & Omit<SpeechArtifact, "id" | "agentId" | "transport" | "chatScope" | "filePath" | "createdAt"> & { bytes: Buffer };

export class SpeechArtifactStore {
  private readonly root: string;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(root: string, options: { retentionMs?: number; now?: () => number } = {}) {
    this.root = path.resolve(root);
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60_000;
    this.now = options.now ?? Date.now;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
  }

  async save(input: SpeechStoreInput): Promise<SpeechArtifact> {
    validateSpeechBytes(input.kind, input.bytes);
    if (input.bytes.length > 50 * 1024 * 1024) throw new Error("Speech artifact exceeds Telegram's 50 MB limit");
    if ((input.kind === "voice" && (input.mimeType !== "audio/ogg" || input.extension !== ".ogg"))
      || (input.kind === "audio" && (input.mimeType !== "audio/mp4" || input.extension !== ".m4a"))) {
      throw new Error("Speech artifact format does not match its delivery kind");
    }
    await this.sweep();
    const id = randomUUID();
    const createdAt = this.now();
    const artifact: SpeechArtifact = {
      id,
      agentId: input.agentId,
      transport: input.transport,
      chatScope: scopeHash(input),
      providerId: input.providerId,
      kind: input.kind,
      mimeType: input.mimeType,
      extension: input.extension,
      filePath: path.join(this.root, `${id}${input.extension}`),
      createdAt,
    };
    const metadataPath = path.join(this.root, `${id}.json`);
    await fsp.writeFile(artifact.filePath, input.bytes, { mode: 0o600, flag: "wx" });
    try {
      const { filePath: _filePath, ...metadata } = artifact;
      await fsp.writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
    } catch (error) {
      await fsp.unlink(artifact.filePath).catch(() => {});
      throw error;
    }
    return artifact;
  }

  async resolve(id: string, scope: SpeechScope): Promise<SpeechArtifact> {
    const stored = await this.read(id);
    if (!stored || stored.agentId !== scope.agentId || stored.transport !== scope.transport || stored.chatScope !== scopeHash(scope)) {
      throw new Error("Speech artifact not found in this agent/transport/chat scope");
    }
    if (this.now() - stored.createdAt > this.retentionMs) {
      await this.removeFiles(stored);
      throw new Error("Speech artifact expired");
    }
    const stat = await fsp.lstat(stored.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) throw new Error("Invalid speech artifact file");
    validateSpeechBytes(stored.kind, await fsp.readFile(stored.filePath));
    return stored;
  }

  async remove(id: string, scope: SpeechScope): Promise<void> {
    const artifact = await this.resolve(id, scope);
    await this.removeFiles(artifact);
  }

  async sweep(): Promise<void> {
    for (const entry of await fsp.readdir(this.root).catch(() => [] as string[])) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(entry)) continue;
      const id = entry.slice(0, -5);
      const stored = await this.read(id);
      if (stored && this.now() - stored.createdAt > this.retentionMs) await this.removeFiles(stored);
    }
  }

  private async read(id: string): Promise<SpeechArtifact | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
    try {
      const metadataPath = path.join(this.root, `${id}.json`);
      const stat = await fsp.lstat(metadataPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8")) as Omit<SpeechArtifact, "filePath">;
      if (metadata.id !== id || !["voice", "audio"].includes(metadata.kind)) return null;
      const extension = metadata.kind === "voice" ? ".ogg" : ".m4a";
      const filePath = path.join(this.root, `${id}${extension}`);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(`${this.root}${path.sep}`)) return null;
      return { ...metadata, extension, filePath };
    } catch { return null; }
  }

  private async removeFiles(artifact: SpeechArtifact): Promise<void> {
    await Promise.all([
      fsp.unlink(artifact.filePath).catch(() => {}),
      fsp.unlink(path.join(this.root, `${artifact.id}.json`)).catch(() => {}),
    ]);
  }
}

function scopeHash(scope: SpeechScope): string {
  return createHash("sha256").update(`${scope.agentId}\0${scope.transport}\0${scope.chatId}`).digest("hex");
}

function validateSpeechBytes(kind: SpeechKind, bytes: Buffer): void {
  if (bytes.length < 8) throw new Error("Generated speech is empty or invalid");
  if (kind === "voice" && bytes.subarray(0, 4).toString() !== "OggS") throw new Error("Voice artifact is not OGG/Opus");
  if (kind === "audio" && bytes.subarray(4, 8).toString() !== "ftyp") throw new Error("Audio artifact is not M4A");
}

function runExec(execFn: typeof execFile, bin: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFn(bin, args, { timeout, maxBuffer: 1024 * 1024 }, (error) => error ? reject(new Error(`${path.basename(bin)} failed: ${errorMessage(error)}`)) : resolve());
  });
}

function findExecutable(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return null;
}
