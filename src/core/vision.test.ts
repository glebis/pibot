import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";
import * as os from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeImage, mimeForImagePath, selectVisionModel, type VisionModelRuntimeLike } from "./vision.js";

function runtime(models: Array<{ provider: string; id: string; input?: string[] }>, authFailures: string[] = []): VisionModelRuntimeLike & { complete: ReturnType<typeof vi.fn> } {
  return {
    getModels: vi.fn(() => models),
    hasConfiguredAuth: vi.fn((p: string) => !authFailures.includes(p)),
    resolveModel: vi.fn((spec: string) => (spec ? { provider: spec.split("/")[0], id: spec.split("/")[1] } : undefined)),
    complete: vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: "Описание: форма входа" }] })),
  } as unknown as VisionModelRuntimeLike & { complete: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selectVisionModel", () => {
  it("skips text-only models and picks the first permitted vision model", () => {
    const r = runtime([
      { provider: "openai-codex", id: "gpt-6.1-sol" },
      { provider: "openrouter", id: "qwen-vl", input: ["image", "text"] },
    ]);
    expect(selectVisionModel(r, ["openai-codex", "openrouter"])).toBe("openrouter/qwen-vl");
  });

  it("never leaves the agent's provider allowlist", () => {
    const r = runtime([{ provider: "anthropic", id: "sonnet", input: ["image", "text"] }]);
    expect(selectVisionModel(r, ["openrouter"])).toBeUndefined();
    // with no configured allowlist, only the agent's own primary qualifies
    expect(selectVisionModel(r, undefined, "anthropic/sonnet")).toBe("anthropic/sonnet");
    const r2 = runtime([{ provider: "anthropic", id: "sonnet", input: ["image", "text"] }]);
    expect(selectVisionModel(r2, undefined, "openai-codex/gpt-6.1")).toBeUndefined();
  });

  it("requires configured credentials and a resolvable model", () => {
    const r = runtime([{ provider: "openrouter", id: "qwen-vl", input: ["image", "text"] }], ["openrouter"]);
    expect(selectVisionModel(r, ["openrouter"])).toBeUndefined();
  });
});

describe("describeImage", () => {
  let shot: string;
  beforeAll(() => {
    shot = join(os.mkdtempSync(join(tmpdir(), "vision-test-")), "shot.png");
    os.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("returns the model's description with the chosen spec", async () => {
    const r = runtime([{ provider: "openrouter", id: "qwen-vl", input: ["image", "text"] }]);
    const res = await describeImage(r, { filePath: shot }, ["openrouter"]);
    expect(res).toMatchObject({ ok: true, modelSpec: "openrouter/qwen-vl" });
    if (res.ok) expect(res.description).toContain("Описание");
    const call = (r.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const content = (call[1] as { messages: Array<{ content: unknown }> }).messages[0].content as Array<Record<string, unknown>>;
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect((content[1] as { data: string }).data.length).toBeGreaterThan(10);
  });

  it("answers in the caption's language when a caption is present", async () => {
    const r = runtime([{ provider: "openrouter", id: "qwen-vl", input: ["image", "text"] }]);
    await describeImage(r, { filePath: shot, caption: "Что тут не так?" }, ["openrouter"]);
    const sys = (r.complete as ReturnType<typeof vi.fn>).mock.calls[0][1].systemPrompt as string;
    expect(sys).toContain("caption's language");
  });

  it("degrades to ok:false instead of throwing when the model fails", async () => {
    const r = runtime([{ provider: "openrouter", id: "qwen-vl", input: ["image", "text"] }]);
    (r.complete as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ stopReason: "error", content: [], errorMessage: "boom" }));
    const res = await describeImage(r, { filePath: shot }, ["openrouter"]);
    expect(res).toMatchObject({ ok: false });
  });

  it("rejects missing/oversized files before calling the model", async () => {
    const r = runtime([{ provider: "openrouter", id: "qwen-vl", input: ["image", "text"] }]);
    const res = await describeImage(r, { filePath: "/tmp/vision-fixture/missing.png" }, ["openrouter"], "openrouter/qwen-vl");
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("image unreadable") });
  });
});

describe("mimeForImagePath", () => {
  it("maps common image extensions and nothing else", () => {
    expect(mimeForImagePath("/a/shot.PNG")).toBe("image/png");
    expect(mimeForImagePath("/a/p.jpg")).toBe("image/jpeg");
    expect(mimeForImagePath("/a/p.heic")).toBe("image/heic");
    expect(mimeForImagePath("/a/p.m4a")).toBe("");
  });
});