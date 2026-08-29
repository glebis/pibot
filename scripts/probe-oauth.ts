import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const mr = await ModelRuntime.create();
for (const p of mr.getProviders()) {
  const auth = await mr.checkAuth(p.id).catch(() => undefined);
  if (!auth) continue;
  const oauth = (p as any).auth?.oauth;
  console.log(`${p.id.padEnd(22)} type=${auth.type.padEnd(7)} source=${(auth.source ?? "").padEnd(20)} Subscription-OAuth=${mr.isUsingSubscription(p.id)} oauthLogin=${oauth ? "yes" : "-"}${oauth?.loginLabel ? ` [${oauth.loginLabel}]` : ""}${oauth?.isSubscription ? " (SUBSCRIPTION)" : ""}`);
}
process.exit(0);
