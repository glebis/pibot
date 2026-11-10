/**
 * Vision describe pass (bd pibot: image turns on text-only models).
 *
 * When a photo lands on a chat whose agent runs a text-only model, a
 * vision-capable model from the AGENT'S OWN allowed providers describes the
 * pixels first; the description enters the turn as text next to the stored
 * file path. Provider use stays explicitly allowed: only providers in the
 * agent manifest's `providers` list are considered, and only ones with
 * configured credentials. No vision model within policy → the old behavior
 * (text stub naming the stored file), never a guessed provider.
 */
import * as fs from "node:fs";

export interface VisionModelRuntimeLike {
  getModels(): Array<{ provider: string; id: string; input?: string[] }>;
  hasConfiguredAuth(provider: string): boolean;
  resolveModel(spec: string): { provider?: string; id?: string } & Record<string, unknown> | undefined;
  complete(
    model: NonNullable<unknown>,
    ctx: { systemPrompt?: string; messages: Array<{ role: string; content: unknown }> },
    opts: { maxTokens: number; signal?: AbortSignal },
  ): Promise<{ stopReason?: string; content: Array<{ type: string; text?: string }>; errorMessage?: string }>;
}

export interface DescribeImageInput {
  filePath: string;
  caption?: string;
}

export type DescribeImageResult =
  | { ok: true; description: string; modelSpec: string }
  | { ok: false; error: string };

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".bmp": "image/bmp",
};

export function mimeForImagePath(filePath: string): string {
  return MIME_BY_EXT[filePath.toLowerCase().slice(filePath.lastIndexOf("."))] ?? "";
}

/** First vision-capable model, in policy order: the agent's own primary if it sees
 *  images, then the provider-policy walk (only when a providers allowlist exists).
 *  No configured allowlist means NO discovery — an unconfigured agent gets at most
 *  its own primary, because provider use must stay explicitly allowed. */
export function selectVisionModel(
  runtime: VisionModelRuntimeLike,
  allowedProviders: string[] | undefined,
  primarySpec?: string,
): string | undefined {
  const configured = allowedProviders?.map((p) => p.trim()).filter(Boolean);
  const allowed = configured ? new Set(configured) : undefined;
  let models: Array<{ provider: string; id: string; input?: string[] }>;
  try {
    models = runtime.getModels() ?? [];
  } catch {
    return undefined; // catalog unavailable — no vision pass, old behavior
  }
  const seesImages = (m: { input?: string[] }) => Array.isArray(m?.input) && m.input.includes("image");
  const authOk = (provider: string) => {
    try {
      return runtime.hasConfiguredAuth(provider);
    } catch {
      return false;
    }
  };
  if (configured === undefined) {
    // policy-ungated path: the agent's own primary only, never the catalog
    if (!primarySpec) return undefined;
    const entry = models.find((m) => `${m.provider}/${m.id}` === primarySpec);
    return entry && seesImages(entry) && authOk(entry.provider) ? primarySpec : undefined;
  }
  const allowlist = configured;
  const inPolicy = (provider: string) => allowlist.includes(provider);
  if (primarySpec) {
    const slash = primarySpec.indexOf("/");
    const provider = slash > 0 ? primarySpec.slice(0, slash) : "";
    const entry = models.find((m) => `${m.provider}/${m.id}` === primarySpec);
    if (entry && seesImages(entry) && inPolicy(provider) && authOk(provider)) return primarySpec;
  }
  for (const m of models) {
    if (!seesImages(m)) continue;
    if (!inPolicy(m.provider)) continue; // provider use stays explicitly allowed
    if (!authOk(m.provider)) continue;
    const spec = `${m.provider}/${m.id}`;
    try {
      if (!runtime.resolveModel(spec)) continue;
    } catch {
      continue;
    }
    return spec;
  }
  return undefined;
}

/** Describe one image with a vision model. Returns ok:false instead of throwing —
 *  a failed describe must degrade to the old text-only behavior, never block a turn. */
export async function describeImage(
  runtime: VisionModelRuntimeLike & { resolveModel: (spec: string) => (Record<string, unknown> & { provider?: string; id?: string }) | undefined },
  input: DescribeImageInput,
  allowedProviders: string[] | undefined,
  primarySpec?: string,
): Promise<DescribeImageResult> {
  const spec = selectVisionModel(runtime, allowedProviders, primarySpec);
  if (!spec) return { ok: false, error: "no permitted vision-capable model available" };
  const mimeType = mimeForImagePath(input.filePath);
  if (!mimeType) return { ok: false, error: `unsupported image type: ${input.filePath}` };
  let data: string;
  try {
    const stat = fs.statSync(input.filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) {
      return { ok: false, error: "image file missing or oversized (>20MB)" };
    }
    data = fs.readFileSync(input.filePath).toString("base64");
  } catch (e) {
    return { ok: false, error: `image unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const captionLine = input.caption?.trim() ? `The owner's caption (answer in the caption's language): ${input.caption.trim()}\n` : "";
  const languageLine = input.caption?.trim() ? "" : "Write the description in Russian.\n";
  const systemPrompt =
    "You relay what an image shows to an agent that cannot see it. Be exhaustive but tight: " +
    "every visible text block verbatim, UI structure, objects, people by role, charts and numbers, " +
    "colors only when meaningful. " +
    `${captionLine}${languageLine}` +
    "Never speculate about intent beyond what is visible. No preamble, no headings — just the description.";
  try {
    const model = runtime.resolveModel(spec);
    if (!model) return { ok: false, error: "vision model not resolvable" };
    const result = await runtime.complete(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image for a colleague who cannot see it." },
              { type: "image", data, mimeType },
            ],
          },
        ],
      },
      { maxTokens: 1200, signal: AbortSignal.timeout(60_000) },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return { ok: false, error: result.errorMessage ?? `stopReason ${result.stopReason}` };
    }
    const text = result.content
      .filter((b) => b.type === "text")
      .map((b) => (b.text ?? "").trim())
      .join("\n")
      .trim();
    if (!text) return { ok: false, error: "empty description" };
    return { ok: true, description: text, modelSpec: spec };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}