import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SttService, sttProvidersFromEnv } from "./stt.js";

const tmpDirs: string[] = [];
function tmpOgg(content = "fake-opus-bytes"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-stt-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "voice.ogg");
  fs.writeFileSync(file, content);
  return file;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const k of ["GROQ_API_KEY", "STT_PROVIDERS", "STT_LANGUAGE"]) delete process.env[k];
});

function fakeFetchJson(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return handler as unknown as typeof fetch;
}

describe("sttProvidersFromEnv", () => {
  it("falls back to defaults, filters unknown names, honors env", () => {
    delete process.env.STT_PROVIDERS;
    expect(sttProvidersFromEnv()).toEqual(["groq", "local_whisper"]);
    process.env.STT_PROVIDERS = "bogus, groq ,";
    expect(sttProvidersFromEnv()).toEqual(["groq"]);
    process.env.STT_PROVIDERS = "local_whisper";
    expect(sttProvidersFromEnv()).toEqual(["local_whisper"]);
  });
});

describe("SttService", () => {
  it("returns the groq transcript on success", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const file = tmpOgg();
    let sawAuth = "";
    const fetchFn = fakeFetchJson((_url, init) => {
      sawAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ text: "  hello from the voice note " }), { status: 200 });
    });
    const stt = new SttService(["groq"], { fetchFn });
    const res = await stt.transcribe(file);
    expect(res).toMatchObject({ ok: true, text: "hello from the voice note", provider: "groq" });
    expect(sawAuth).toBe("Bearer test-key");
  });

  it("skips groq without an api key and falls back to local whisper", async () => {
    const file = tmpOgg();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-whisper-out-"));
    fs.mkdirSync(outDir, { recursive: true });
    const fakeExec = ((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
    ) => {
      const args = _args as string[];
      const src = args.find((a) => a.endsWith(".ogg"))!;
      const outDir = args[args.indexOf("--output_dir") + 1]!;
      fs.writeFileSync(path.join(outDir, path.basename(src).replace(/\.ogg$/, ".txt")), "local result");
      queueMicrotask(() => cb(null, "", ""));
    }) as unknown as typeof execFile;
    const stt = new SttService(["groq", "local_whisper"], { execFileFn: fakeExec, whisperBin: "whisper-cpp-fake" });
    const res = await stt.transcribe(file);
    expect(res).toMatchObject({ ok: true, text: "local result", provider: "local_whisper" });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("reports every failure when the chain is exhausted", async () => {
    process.env.GROQ_API_KEY = "bad-key";
    const fetchFn = fakeFetchJson(() => new Response("unauthorized", { status: 401 }));
    const stt = new SttService(["groq", "local_whisper"], { fetchFn, whisperBin: null });
    const res = await stt.transcribe(tmpOgg());
    expect(res.ok).toBe(false);
    expect(res.provider).toBe("none");
    expect(res.error).toContain("groq: groq HTTP 401");
    expect(res.error).toContain("local_whisper: whisper CLI not installed");
  });

  it("configured() is false only when groq is the sole provider without a key", () => {
    expect(new SttService(["groq"]).configured()).toBe(false);
    process.env.GROQ_API_KEY = "k";
    expect(new SttService(["groq"]).configured()).toBe(true);
    expect(new SttService(["local_whisper"]).configured()).toBe(true);
  });
});