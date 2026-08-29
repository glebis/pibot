import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { LoginFlow, ProviderManager, providerRowHtml } from "./providers.js";
import { createWebApp } from "../web.js";

function fakeRuntime(over: Record<string, unknown> = {}): ModelRuntime {
  return {
    getProviders: () => [
      { id: "xai", name: "xAI", auth: { oauth: { loginLabel: "Sign in with SuperGrok or X Premium", isSubscription: true } } },
      { id: "groq", name: "Groq", auth: { apiKey: { name: "Groq API key", login: async () => ({ type: "api_key" as const }) } } },
    ],
    checkAuth: vi.fn(async (id: string) =>
      id === "xai" ? { type: "api_key" as const, source: "XAI_API_KEY" } : undefined),
    isUsingSubscription: vi.fn((id: string) => id === "xai"),
    getModels: vi.fn((id: string) => (id === "xai" ? [{}, {}, {}, {}] : [])),
    hasConfiguredAuth: vi.fn((id: string) => id === "xai"),
    login: vi.fn(async () => ({ type: "oauth" as const })),
    logout: vi.fn(async () => {}),
    ...over,
  } as unknown as ModelRuntime;
}

// ─── status shaping ──────────────────────────────────────────────────────────

describe("ProviderManager.status", () => {
  it("shapes providers with subscription badge, auth source and model counts", async () => {
    const mgr = new ProviderManager(fakeRuntime());
    const list = await mgr.status();
    expect(list.map((p) => p.id)).toEqual(["xai", "groq"]); // configured first
    const xai = list.find((p) => p.id === "xai")!;
    expect(xai.configured).toBe(true);
    expect(xai.subscription).toBe(true);
    expect(xai.authType).toBe("api_key");
    expect(xai.source).toBe("XAI_API_KEY");
    expect(xai.models).toBe(4);
    expect(xai.canLoginOauth).toBe(true);
    expect(xai.loginLabel).toBe("Sign in with SuperGrok or X Premium");
    const groq = list.find((p) => p.id === "groq")!;
    expect(groq.configured).toBe(false);
    expect(groq.canLoginApiKey).toBe(true);
    expect(groq.models).toBe(0);
  });

  it("statusText marks subscription login paths and points to the dashboard", async () => {
    const mgr = new ProviderManager(fakeRuntime());
    const text = await mgr.statusText();
    expect(text).toContain("✓ **xai**");
    expect(text).toContain("subscription");
    expect(text).toContain("· **groq** not configured — login:");
    expect(text).toContain("dashboard → Providers");
  });

  it("providerRowHtml renders subscription login button and pending prompt form", () => {
    const html = providerRowHtml(
      {
        id: "xai", name: "xAI", configured: true, authType: "api_key", source: "XAI_API_KEY",
        subscription: true, canLoginOauth: true, canLoginApiKey: false,
        loginLabel: "Sign in with SuperGrok or X Premium", models: 4,
      },
      undefined,
      "testcsrf",
    );
    expect(html).toContain("Sign in with SuperGrok or X Premium");
    expect(html).toContain("⭐ subscription");
    expect(html).toContain("_csrf");
  });
});

// ─── login flow state machine ────────────────────────────────────────────────

describe("LoginFlow", () => {
  it("bridges auth_url + manual_code prompts to the answer() loop", async () => {
    const seen: string[] = [];
    const flow = new LoginFlow("xai", async (i: AuthInteraction) => {
      i.notify({ type: "auth_url", url: "https://x.ai/signin", instructions: "paste the code" });
      const code = await i.prompt({ type: "manual_code", message: "Paste the code", placeholder: "abcd-1234" });
      seen.push(code);
      i.notify({ type: "progress", message: "verifying" });
      return { type: "oauth" as const };
    });
    flow.start();
    // let the run() microtask reach the prompt
    await vi.waitFor(() => {
      const st = flow.state();
      if (st.phase !== "active" || !st.prompt) throw new Error("prompt not pending yet");
      expect(st.events.some((e) => e.type === "auth_url")).toBe(true);
      expect(st.prompt.type).toBe("manual_code");
    });
    expect(flow.answer("abcd-1234")).toBe(true);
    await flow.settled();
    expect(seen[0]).toBe("abcd-1234");
    expect(flow.state().phase).toBe("done");
  });

  it("answer() with no prompt pending returns false", () => {
    const flow = new LoginFlow("xai", async () => undefined);
    flow.start();
    expect(flow.answer("x")).toBe(false);
  });

  it("provider errors land in the failed state with the message", async () => {
    const flow = new LoginFlow("xai", async () => {
      throw new Error("invalid_grant");
    });
    flow.start();
    await flow.settled();
    const st = flow.state();
    expect(st.phase).toBe("failed");
    expect(st.phase === "failed" && st.message).toBe("invalid_grant");
  });

  it("cancel aborts a pending prompt into a friendly failed message", async () => {
    const flow = new LoginFlow("xai", async (i: AuthInteraction) => {
      await i.prompt({ type: "text", message: "waiting…" });
      return undefined;
    });
    flow.start();
    await vi.waitFor(() => {
      const st = flow.state();
      if (st.phase !== "active" || !st.prompt) throw new Error("prompt not pending yet");
    });
    flow.cancel();
    await flow.settled();
    const st = flow.state();
    expect(st.phase).toBe("failed");
    expect(st.phase === "failed" && st.message).toBe("login cancelled");
  });
});

// ─── manager wiring ──────────────────────────────────────────────────────────

describe("ProviderManager login wiring", () => {
  it("startLogin records the flow; answer reaches the interaction prompt", async () => {
    let prompted = false;
    const rt = fakeRuntime({
      login: async (_id: string, _t: string, i: AuthInteraction) => {
        prompted = true;
        await i.prompt({ type: "secret", message: "API key" });
        return { type: "api_key" as const };
      },
    });
    const mgr = new ProviderManager(rt);
    mgr.startLogin("groq", "api_key");
    await vi.waitFor(() => expect(prompted).toBe(true));
    expect(mgr.loginState("groq")?.phase).toBe("active");
    expect(mgr.answer("groq", "sk-test")).toBe(true);
    await vi.waitFor(() => expect(mgr.loginState("groq")?.phase).toBe("done"));
  });

  it("logout delegates to the runtime", async () => {
    const logout = vi.fn(async () => {});
    const mgr = new ProviderManager(fakeRuntime({ logout }));
    await mgr.logout("xai");
    expect(logout).toHaveBeenCalledWith("xai");
  });
});

// ─── dashboard integration ───────────────────────────────────────────────────

describe("providers dashboard page", () => {
  it("GET /providers renders provider rows with login forms; answer posts are CSRF-checked", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-prov-"));
    const providers = new ProviderManager(fakeRuntime());
    providers.startLogin("xai", "oauth"); // immediate done for the stub; page shows the state
    const app = createWebApp({
      agents: { getAgent: () => undefined, list: () => [] } as never,
      scheduler: { stop() {}, takePendingCards: () => [] } as never,
      events: { log() {} } as never,
      evolution: {} as never,
      dataDir,
      providers,
    });
    try {
      const res = await app.request("/providers");
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("Cloud providers");
      expect(html).toContain("Sign in with SuperGrok or X Premium");

      const bad = await app.request("/providers/xai/answer", {
        method: "POST",
        body: new URLSearchParams({ value: "x", _csrf: "nope" }),
      });
      expect(bad.status).toBe(403);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});