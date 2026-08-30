// ─── cloud providers: status + login (API keys & subscription OAuth) ────────
//
// Wraps the ModelRuntime auth surface ("just like pi itself supports"):
//   - status(): every provider with credentials or a login method — auth type,
//     source, subscription badge (OAuth isSubscription, e.g. Claude Pro/Max,
//     SuperGrok/X Premium), available model counts.
//   - login: OAuth subscription flows and API-key flows are bridged to the
//     dashboard as a small prompt/event state machine. Credentials land in the
//     shared pi auth store (~/.pi/agent/auth.json), so pi and pibot see the
//     same logins. Provider credentials never change an agent's model policy:
//     the agent must explicitly allow that provider in its manifest.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  authType?: "api_key" | "oauth";
  source?: string;
  /** OAuth backed by a provider subscription (Claude Pro/Max, SuperGrok/X Premium, …) */
  subscription: boolean;
  canLoginOauth: boolean;
  canLoginApiKey: boolean;
  loginLabel?: string;
  models: number;
}

/** UI-facing shape of a pending AuthPrompt (mirrors pi-ai's AuthPrompt union). */
export interface PendingPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}

export type LoginState =
  | { phase: "active"; events: LoginEvent[]; prompt?: PendingPrompt }
  | { phase: "done"; message: string }
  | { phase: "failed"; message: string };

/** Subset of pi-ai's AuthEvent pibot surfaces in the UI. */
export type LoginEvent = {
  type: "info";
  message: string;
  links?: readonly { url: string; label?: string }[];
} | {
  type: "auth_url";
  url: string;
  instructions?: string;
} | {
  type: "device_code";
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
} | {
  type: "progress";
  message: string;
};

interface ProviderLike {
  id: string;
  name?: string;
  auth?: {
    oauth?: { name?: string; loginLabel?: string; isSubscription?: boolean };
    apiKey?: { name?: string; login?: unknown };
  };
}

const MAX_EVENTS = 12;

export class ProviderManager {
  private flows = new Map<string, LoginFlow>();

  constructor(private readonly mr: ModelRuntime) {}

  /** Status of every provider with credentials or a login method. */
  async status(): Promise<ProviderStatus[]> {
    const out: ProviderStatus[] = [];
    for (const p of this.mr.getProviders() as unknown as ProviderLike[]) {
      const auth = p.auth ?? {};
      const loginable = !!auth.oauth || !!auth.apiKey?.login;
      let check: { type?: "api_key" | "oauth"; source?: string } | undefined;
      try {
        check = (await this.mr.checkAuth(p.id)) ?? undefined;
      } catch {
        check = undefined;
      }
      if (!check && !loginable) continue; // ambient-only, nothing to show or do
      out.push({
        id: p.id,
        name: p.name ?? p.id,
        configured: !!check,
        authType: check?.type,
        source: check?.source,
        subscription: this.mr.isUsingSubscription(p.id),
        canLoginOauth: !!auth.oauth,
        canLoginApiKey: !!auth.apiKey?.login,
        loginLabel: auth.oauth?.loginLabel,
        models: this.mr.getModels(p.id).length,
      });
    }
    out.sort((a, b) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));
    return out;
  }

  /** Compact text form for the Telegram /providers command. */
  async statusText(): Promise<string> {
    const list = await this.status();
    const lines = list.map((p) => {
      const mark = p.configured ? "✓" : "·";
      const kind = p.subscription
        ? "subscription"
        : p.authType === "oauth"
          ? "oauth"
          : p.authType === "api_key"
            ? `api key${p.source ? ` via ${p.source}` : ""}`
            : "not configured";
      const login = !p.configured
        ? ` — login: ${[p.canLoginOauth ? (p.loginLabel ?? "OAuth") : null, p.canLoginApiKey ? "API key" : null].filter(Boolean).join(" · ")} (dashboard → Providers)`
        : "";
      const models = p.configured ? ` — ${p.models} model${p.models === 1 ? "" : "s"}` : "";
      return `${mark} **${p.id}** ${kind}${models}${login}`;
    });
    if (!lines.length) return "No cloud providers visible.";
    lines.push("_Subscription sign-ins (Claude Pro/Max, SuperGrok / X Premium, …) live in the shared pi credentials. Login in the dashboard → Providers, then explicitly allow the provider in each agent that may use it._");
    return lines.join("\n");
  }

  /** Kick off a login flow (oauth = subscription sign-in, api_key = paste key). */
  startLogin(providerId: string, type: AuthType): { ok: boolean; error?: string } {
    if (this.flows.get(providerId)?.state().phase === "active") return { ok: true };
    const flow = new LoginFlow(providerId, (interaction) => this.mr.login(providerId, type, interaction));
    flow.start();
    this.flows.set(providerId, flow);
    return { ok: true };
  }

  /** Answer the active login prompt (dashboard form submit). */
  answer(providerId: string, value: string): boolean {
    return this.flows.get(providerId)?.answer(value) ?? false;
  }

  /** Abort an active login flow. */
  cancel(providerId: string): void {
    this.flows.get(providerId)?.cancel();
  }

  loginState(providerId: string): LoginState | undefined {
    return this.flows.get(providerId)?.state();
  }

  async logout(providerId: string): Promise<void> {
    this.flows.delete(providerId);
    await this.mr.logout(providerId);
  }
}

/**
 * Bridges ModelRuntime.login()'s AuthInteraction (prompts + events) to a
 * request/response web flow: the dashboard renders the current prompt and
 * events, submits answers through ProviderManager.answer().
 */
export class LoginFlow {
  private controller = new AbortController();
  private events: AuthEvent[] = [];
  private pending?: { prompt: PendingPrompt; resolve: (v: string) => void };
  private _state: LoginState = { phase: "active", events: [] };
  private runPromise?: Promise<unknown>;

  constructor(
    readonly providerId: string,
    private readonly run: (interaction: AuthInteraction) => Promise<unknown>,
  ) {}

  start(): void {
    const interaction: AuthInteraction = {
      signal: this.controller.signal,
      notify: (event: AuthEvent) => {
        this.events = [...this.events.slice(-(MAX_EVENTS - 1)), event];
        this._state = { ...this._state, phase: "active", events: this.events } as LoginState;
      },
      prompt: async (prompt: AuthPrompt): Promise<string> => {
        const p: PendingPrompt = {
          type: prompt.type,
          message: prompt.message,
          placeholder: (prompt as AuthPrompt & { placeholder?: string }).placeholder,
          options: prompt.type === "select" ? prompt.options : undefined,
        };
        this._state = { ...this._state, phase: "active", events: this.events, prompt: p };
        const value = await new Promise<string>((resolve, reject) => {
          const onAbort = () => reject(new Error("aborted"));
          this.controller.signal.addEventListener("abort", onAbort, { once: true });
          this.pending = {
            prompt: p,
            resolve: (v: string) => {
              this.controller.signal.removeEventListener("abort", onAbort);
              resolve(v);
            },
          };
        });
        this._state = { phase: "active", events: this.events, prompt: undefined };
        return value;
      },
    };
    void (this.runPromise = this.run(interaction)
      .then((credential) => {
        this._state = { phase: "done", message: "credential stored — explicitly allow this provider in each agent that may use it" };
        return credential;
      })
      .catch((e: unknown) => {
        if (this._state.phase === "done") return undefined;
        const msg = e instanceof Error ? e.message : String(e);
        this._state = { phase: "failed", message: msg === "aborted" ? "login cancelled" : msg } as LoginState;
        return undefined;
      }));
  }

  /** Resolves when the login flow reached a terminal state (done/failed). */
  async settled(): Promise<void> {
    await this.runPromise?.catch(() => {});
  }

  /** Deliver the user's answer to the pending prompt. Returns false if none pending. */
  answer(value: string): boolean {
    const p = this.pending;
    if (!p) return false;
    this.pending = undefined;
    p.resolve(value);
    return true;
  }

  cancel(): void {
    this.controller.abort();
  }

  state(): LoginState {
    return this._state;
  }
}

// ─── dashboard/telegram formatting helpers ──────────────────────────────────

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One dashboard row for a provider (plain HTML — caller wraps in the page). */
export function providerRowHtml(p: ProviderStatus, state: LoginState | undefined, csrfField: string): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${csrfField}">`;
  const flow = state
    ? `<div style="margin-top:8px">${renderFlowEvents(p.id, state, csrfInput)}</div>`
    : "";
  const badges = [
    p.authType ? `<span class="pill ${p.authType === "oauth" ? "on" : ""}">${esc(p.authType)}</span>` : "",
    p.subscription ? `<span class="pill on">⭐ subscription</span>` : "",
    p.source && !p.subscription ? `<span class="mono muted">${esc(p.source)}</span>` : "",
  ].join(" ");
  const buttons: string[] = [];
  if (state?.phase !== "active") {
    if (p.canLoginOauth) {
      buttons.push(`<form method="post" action="/providers/${p.id}/login" class="inline">${csrfInput}<input type="hidden" name="type" value="oauth"><button type="submit" class="btn">🔐 ${esc(p.loginLabel ?? `Sign in to ${esc(p.name)}`)}</button></form>`);
    }
    if (p.canLoginApiKey) {
      buttons.push(`<form method="post" action="/providers/${p.id}/login" class="inline">${csrfInput}<input type="hidden" name="type" value="api_key"><input type="text" name="value" placeholder="API key" autocomplete="off" style="width:220px"><button type="submit" class="btn ghost">🔑 Set API key</button></form>`);
    }
    if (p.configured) {
      buttons.push(`<form method="post" action="/providers/${p.id}/logout" class="inline">${csrfInput}<button type="submit" class="danger mini">Disconnect</button></form>`);
    }
  }
  const status = p.configured
    ? `🟢 <strong>${esc(p.name)}</strong> ${badges} <span class="muted">${esc(String(p.models))} model${p.models === 1 ? "" : "s"}</span>`
    : `<span class="pill">⚪ ${esc(p.name)}</span> <span class="muted">not configured${p.models ? ` — ${esc(String(p.models))} models once connected` : ""}</span>`;
  return `<div class="card"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">${status}</div>${buttons.length ? `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${buttons.join("")}</div>` : ""}${flow}</div>`;
}

function renderFlow(pending: PendingPrompt, providerId: string, csrfInput: string): string {
  const field = pending.type === "select"
    ? `<select name="value">${(pending.options ?? []).map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join("")}</select>`
    : `<input type="${pending.type === "secret" ? "password" : "text"}" name="value" placeholder="${esc(pending.placeholder ?? "")}" autocomplete="off" style="width:260px">`;
  return `<form method="post" action="/providers/${providerId}/answer" style="margin-top:8px">${csrfInput}
    <label>${esc(pending.message)}</label> ${field}
    <button type="submit" class="btn">Continue</button>
  </form>`;
}

export function renderFlowEvents(providerId: string, state: LoginState, csrfInput: string): string {
  if (state.phase === "active") {
    const evLines = state.events.map((e) => {
      if (e.type === "auth_url") return `↗ <a href="${esc(e.url)}" target="_blank" rel="noopener">Open sign-in page</a>${e.instructions ? ` <span class="muted">${esc(e.instructions)}</span>` : ""}`;
      if (e.type === "device_code") return `📟 code <strong class="mono">${esc(e.userCode)}</strong> at <a href="${esc(e.verificationUri)}">${esc(e.verificationUri)}</a>`;
      if (e.type === "info" || e.type === "progress") return `<span class="muted">${esc(e.message)}</span>`;
      return "";
    }).filter(Boolean).join("<br>");
    const promptHtml = state.prompt
      ? renderFlow(state.prompt, providerId, csrfInput)
      : `<p class="muted">Waiting for provider…</p>`;
    return `${evLines ? `<p>${evLines}</p>` : ""}${promptHtml}
      <form method="post" action="/providers/${providerId}/cancel" class="inline" style="margin-top:6px">${csrfInput}<button type="submit" class="mini ghost">Cancel</button></form>`;
  }
  if (state.phase === "done") return `<p class="flash">🟢 ${esc(state.message)}</p>`;
  if (state.phase === "failed") return `<p class="flash warn">⛔ ${esc(state.message)} — <a href="/providers">retry</a></p>`;
  return "";
}
