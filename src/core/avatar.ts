import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import jpeg from "jpeg-js";

export interface AvatarRequest {
  seed: string;
  label?: string;
  size?: number;
}

export interface GeneratedAvatar {
  bytes: Buffer;
  mimeType: "image/jpeg";
}

export interface AvatarProvider {
  readonly id: string;
  configured(): boolean;
  generate(request: AvatarRequest): Promise<GeneratedAvatar>;
}

export interface AvatarProviderStatus {
  id: string;
  configured: boolean;
}

function rgb(hex: number): [number, number, number] {
  return [(hex >>> 16) & 0xff, (hex >>> 8) & 0xff, hex & 0xff];
}

/** Deterministic, dependency-light raster avatar suitable for Telegram's static JPG API. */
export function renderLocalAvatarJpeg(request: AvatarRequest): Buffer {
  const size = Math.max(128, Math.min(1024, Math.round(request.size ?? 512)));
  const digest = createHash("sha256").update(`${request.seed}\0${request.label ?? ""}`).digest();
  const palette = [0x16213e, 0x0f766e, 0x7c3aed, 0xbe123c, 0x1d4ed8, 0x9a3412];
  const accentPalette = [0xf8fafc, 0xfef3c7, 0xdbeafe, 0xfce7f3, 0xccfbf1];
  const background = rgb(palette[digest[0] % palette.length]);
  const accent = rgb(accentPalette[digest[1] % accentPalette.length]);
  const data = Buffer.alloc(size * size * 4);
  const cells = 7;
  const cell = size / cells;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      const mirroredX = gx < Math.ceil(cells / 2) ? gx : cells - gx - 1;
      const bit = digest[(gy * 4 + mirroredX + 2) % digest.length] & (1 << ((gx + gy) % 8));
      const dx = x - size / 2;
      const dy = y - size / 2;
      const insideDisc = (dx * dx + dy * dy) <= (size * 0.43) ** 2;
      const color = insideDisc && bit ? accent : background;
      const offset = (y * size + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 0xff;
    }
  }

  return Buffer.from(jpeg.encode({ data, width: size, height: size }, 90).data);
}

class LocalAvatarProvider implements AvatarProvider {
  readonly id = "local";
  configured(): boolean { return true; }
  async generate(request: AvatarRequest): Promise<GeneratedAvatar> {
    return { bytes: renderLocalAvatarJpeg(request), mimeType: "image/jpeg" };
  }
}

interface RemoteProviderOptions {
  id: string;
  apiKey?: string;
  endpoint?: string;
  model: string;
  fetch: typeof fetch;
}

/** OpenAI-compatible JSON image adapter. It is inert until both key and endpoint are configured. */
class RemoteAvatarProvider implements AvatarProvider {
  readonly id: string;
  constructor(private readonly options: RemoteProviderOptions) { this.id = options.id; }

  configured(): boolean {
    return Boolean(this.options.apiKey?.trim() && this.options.endpoint?.trim());
  }

  async generate(request: AvatarRequest): Promise<GeneratedAvatar> {
    if (!this.configured()) throw new Error(`Avatar provider "${this.id}" is not configured`);
    const response = await this.options.fetch(this.options.endpoint!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        prompt: `Square Telegram bot avatar. ${request.seed}. Mark: ${request.label ?? "PiBot"}. No text outside the mark.`,
        size: "1024x1024",
        output_format: "jpeg",
      }),
    });
    if (!response.ok) throw new Error(`Avatar provider "${this.id}" failed (${response.status})`);
    const json = await response.json() as { data?: Array<{ b64_json?: string }> };
    const encoded = json.data?.[0]?.b64_json;
    if (!encoded) throw new Error(`Avatar provider "${this.id}" returned no image`);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`Avatar provider "${this.id}" did not return a JPG`);
    return { bytes, mimeType: "image/jpeg" };
  }
}

export class AvatarProviderRegistry {
  private readonly providers: Map<string, AvatarProvider>;
  constructor(providers: readonly AvatarProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  list(): AvatarProviderStatus[] {
    return [...this.providers.values()].map((provider) => ({ id: provider.id, configured: provider.configured() }));
  }

  async generate(providerId: string, request: AvatarRequest): Promise<GeneratedAvatar> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown avatar provider "${providerId}"`);
    if (!provider.configured()) throw new Error(`Avatar provider "${providerId}" is not configured`);
    return provider.generate(request);
  }
}

export function createDefaultAvatarProviders(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): AvatarProviderRegistry {
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? globalThis.fetch;
  return new AvatarProviderRegistry([
    new LocalAvatarProvider(),
    new RemoteAvatarProvider({
      id: "openai",
      apiKey: env.OPENAI_API_KEY,
      endpoint: env.OPENAI_IMAGE_ENDPOINT ?? (env.OPENAI_API_KEY ? "https://api.openai.com/v1/images/generations" : undefined),
      model: env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
      fetch: fetchFn,
    }),
    new RemoteAvatarProvider({
      id: "nano-banana",
      apiKey: env.NANO_BANANA_API_KEY,
      endpoint: env.NANO_BANANA_IMAGE_ENDPOINT,
      model: env.NANO_BANANA_IMAGE_MODEL ?? "nano-banana",
      fetch: fetchFn,
    }),
  ]);
}

export interface AvatarArtifact {
  id: string;
  agentId: string;
  transport: string;
  providerId: string;
  filePath: string;
  mimeType: "image/jpeg";
}

export class AvatarArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
  }

  async save(input: Omit<AvatarArtifact, "id" | "filePath"> & { bytes: Buffer }): Promise<AvatarArtifact> {
    if (input.mimeType !== "image/jpeg") throw new Error("Avatar artifacts must be JPG images");
    if (input.bytes.length < 4 || input.bytes[0] !== 0xff || input.bytes[1] !== 0xd8
      || input.bytes.at(-2) !== 0xff || input.bytes.at(-1) !== 0xd9) {
      throw new Error("Avatar artifact is not a valid JPG image");
    }
    const id = randomUUID();
    const filePath = path.join(this.root, `${id}.jpg`);
    const artifact: AvatarArtifact = {
      id,
      agentId: input.agentId,
      transport: input.transport,
      providerId: input.providerId,
      filePath,
      mimeType: input.mimeType,
    };
    const metadataPath = path.join(this.root, `${id}.json`);
    await fsp.writeFile(filePath, input.bytes, { mode: 0o600, flag: "wx" });
    try {
      // Persist only routing metadata: prompts, labels, credentials and image bytes never enter the index.
      await fsp.writeFile(metadataPath, JSON.stringify({
        id: artifact.id,
        agentId: artifact.agentId,
        transport: artifact.transport,
        providerId: artifact.providerId,
        mimeType: artifact.mimeType,
      }), { mode: 0o600, flag: "wx" });
    } catch (error) {
      await fsp.unlink(filePath).catch(() => undefined);
      throw error;
    }
    return artifact;
  }

  async resolve(id: string, scope: { agentId: string; transport: string }): Promise<AvatarArtifact> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Invalid avatar artifact id");
    }
    const metadataPath = path.join(this.root, `${id}.json`);
    const filePath = path.join(this.root, `${id}.jpg`);
    let stored: Partial<AvatarArtifact>;
    try {
      const metadataStat = await fsp.lstat(metadataPath);
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error("Invalid metadata file");
      stored = JSON.parse(await fsp.readFile(metadataPath, "utf8")) as Partial<AvatarArtifact>;
    } catch {
      throw new Error("Avatar artifact not found in this agent/transport scope");
    }
    if (stored.id !== id || stored.agentId !== scope.agentId || stored.transport !== scope.transport
      || stored.mimeType !== "image/jpeg" || typeof stored.providerId !== "string") {
      throw new Error("Avatar artifact not found in this agent/transport scope");
    }
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) throw new Error("Invalid avatar artifact path");
    const imageStat = await fsp.lstat(resolved);
    if (!imageStat.isFile() || imageStat.isSymbolicLink()) throw new Error("Invalid avatar artifact file");
    await fsp.access(resolved, fs.constants.R_OK);
    const artifact: AvatarArtifact = {
      id,
      agentId: stored.agentId,
      transport: stored.transport,
      providerId: stored.providerId,
      filePath: resolved,
      mimeType: stored.mimeType,
    };
    return artifact;
  }
}
