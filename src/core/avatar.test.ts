import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AvatarArtifactStore,
  AvatarProviderRegistry,
  createDefaultAvatarProviders,
  renderLocalAvatarJpeg,
  type AvatarProvider,
} from "./avatar.js";

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + length;
  }
  return null;
}

describe("local avatar renderer", () => {
  it("renders deterministic Telegram-compatible JPG bytes", () => {
    const first = renderLocalAvatarJpeg({ seed: "pibot", label: "PB", size: 512 });
    const second = renderLocalAvatarJpeg({ seed: "pibot", label: "PB", size: 512 });
    const different = renderLocalAvatarJpeg({ seed: "another", label: "PB", size: 512 });

    expect(Buffer.compare(first, second)).toBe(0);
    expect(Buffer.compare(first, different)).not.toBe(0);
    expect([...first.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...first.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(jpegDimensions(first)).toEqual({ width: 512, height: 512 });
  });
});

describe("avatar providers", () => {
  it("discovers provider configuration without making a network request", () => {
    const fetchFn = vi.fn();
    const registry = createDefaultAvatarProviders({ env: {}, fetch: fetchFn as typeof fetch });

    const statuses = registry.list();
    expect(statuses.find((item) => item.id === "local")).toMatchObject({ configured: true });
    expect(statuses.find((item) => item.id === "openai")).toMatchObject({ configured: false });
    expect(statuses.find((item) => item.id === "nano-banana")).toMatchObject({ configured: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses an unconfigured remote provider before any request is made", async () => {
    const fetchFn = vi.fn();
    const registry = createDefaultAvatarProviders({ env: {}, fetch: fetchFn as typeof fetch });

    await expect(registry.generate("openai", { seed: "pibot", label: "PB" })).rejects.toThrow(/not configured/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("supports injected providers behind one registry contract", async () => {
    const provider: AvatarProvider = {
      id: "fixture",
      configured: () => true,
      generate: vi.fn(async () => ({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg" as const })),
    };
    const registry = new AvatarProviderRegistry([provider]);

    await expect(registry.generate("fixture", { seed: "pibot", label: "PB" })).resolves.toMatchObject({ mimeType: "image/jpeg" });
    expect(provider.generate).toHaveBeenCalledOnce();
  });
});

describe("avatar artifact selection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps generated files inside the store and scopes selection to agent and transport", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-avatar-"));
    roots.push(root);
    const store = new AvatarArtifactStore(root);
    const artifact = await store.save({
      agentId: "coach",
      transport: "telegram:coach",
      providerId: "local",
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: "image/jpeg",
    });

    expect(path.resolve(artifact.filePath).startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true);
    await expect(store.resolve(artifact.id, { agentId: "coach", transport: "telegram:coach" })).resolves.toMatchObject({ id: artifact.id });
    await expect(store.resolve(artifact.id, { agentId: "other", transport: "telegram:coach" })).rejects.toThrow(/not found|scope/i);
    await expect(store.resolve(artifact.id, { agentId: "coach", transport: "telegram" })).rejects.toThrow(/not found|scope/i);
    await expect(store.resolve("../../outside", { agentId: "coach", transport: "telegram:coach" })).rejects.toThrow(/invalid|not found/i);
  });

  it("resolves a selected artifact after the store is recreated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-avatar-"));
    roots.push(root);
    const artifact = await new AvatarArtifactStore(root).save({
      agentId: "coach",
      transport: "telegram:coach",
      providerId: "local",
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: "image/jpeg",
    });

    const reopened = new AvatarArtifactStore(root);

    await expect(reopened.resolve(artifact.id, {
      agentId: "coach",
      transport: "telegram:coach",
    })).resolves.toMatchObject({ id: artifact.id, filePath: artifact.filePath });
  });
});
