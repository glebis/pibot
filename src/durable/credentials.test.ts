import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReadOnlyAuthJsonStore, defaultAuthJsonPath } from "./credentials.js";

describe("ReadOnlyAuthJsonStore", () => {
  const dirs: string[] = [];
  function tmpAuthFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-auth-"));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "SECRET-ACCESS", accountId: "acc1" },
        huggingface: { type: "api_key", key: "SECRET-KEY" },
      }),
      { mode: 0o600 }
    );
    return path.join(dir, "auth.json");
  }

  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("reads a provider credential by id", async () => {
    const store = new ReadOnlyAuthJsonStore(tmpAuthFile());
    const cred = await store.read("openai-codex");
    expect(cred).toEqual({ type: "oauth", access: "SECRET-ACCESS", accountId: "acc1" });
    expect(await store.read("missing")).toBeUndefined();
  });

  it("lists metadata only, never credential values", async () => {
    const store = new ReadOnlyAuthJsonStore(tmpAuthFile());
    const listed = await store.list();
    expect(listed.map((c) => [c.providerId, c.type])).toEqual([["openai-codex", "oauth"], ["huggingface", "api_key"]]);
    expect(JSON.stringify(listed)).not.toContain("SECRET");
  });

  it("refuses to mutate credentials", async () => {
    const store = new ReadOnlyAuthJsonStore(tmpAuthFile());
    await expect(store.modify("huggingface", async () => undefined)).rejects.toThrow("read-only");
    await expect(store.delete("huggingface")).rejects.toThrow("read-only");
  });

  it("defaults to the shared pi auth store path", () => {
    expect(defaultAuthJsonPath()).toContain(".pi/agent/auth.json");
  });
});