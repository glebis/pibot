# PiBot message-only implementation — first bounded slice

First slice implemented 13 October 2026. This is not a claim that every message-only architecture gate is closed. Development only; activation remains off. No real mandate was granted, Telegram message sent, daemon restarted, or telephone integration enabled.

## What is implemented

Personal Contracts has a separate contact-authority domain: authenticated human approval, renewal, revocation, exact recipient attestation, immutable versions, shared owner limits, and a dedicated read-only local authority bridge. An operation contract cannot silently authorize contact. Agents cannot issue mandates through the action tools. Raw SQL agent tools are disabled in Personal Contracts because the framework’s nominal read-only SQL tool does not enforce a reliable read-only boundary; typed application read actions remain available. Human mandate changes additionally require a verified same-origin browser session in production.

PiBot has a separate SQLite coordinator and direct Telegram sender. The coordinator stores decisions, versioned controls, delivery attempts, response receipts and attention timers. It checks current authority before dispatch and reserves rolling lineage and owner message capacity before contacting Telegram. Quiet hours use Europe/Berlin. Unavailable, revoked or changed authority blocks dispatch.

The sender makes one request per attempt. Known rejection is not automatically retried. A crash or uncertain response leaves delivery visibly uncertain. The normal UI does not enable uncertain resends. Backend support for one explicitly authorized urgent possible-duplicate resend is tested but not exposed by the manual creation UI.

Telegram polling persists the configured owner's coordinator callbacks before grammY can advance its polling cursor, including the final polling request during shutdown. Startup replays captured replies before outbound work. Other conversations are not copied into this ledger.

The authenticated PiBot dashboard at `/coordinator` accepts a contract reference, question, bounded choices and a deadline. It shows decisions and delivery status. Recipient and authority identifiers come from the private runtime configuration, never the request body. Reply controls support an answer, Seen, Snooze 15 min and Dismiss. A response records a decision; it does not execute a contract.

## Deliberate scope boundaries

- Contract references are entered manually. The existing contract kernel lacks canonical per-contract ownership, so automatic contract projection is blocked until a reviewed ownership mapping exists.
- Salience-based automatic source selection, inline/Cenno routing, legacy heartbeat migration, and workflow resumption are future integration steps. This milestone establishes the bounded message path beneath them.
- Seen and snooze timers reopen attention visibly; they do not create automatic reminder bursts.
- Unknown delivery has no provider-history reconciliation. It remains visible for review.
- Managed restore has a persistent dispatch hold, but authenticated recovery/resume is not implemented. Do not replace the database under a running coordinator. Arbitrary file rollback is outside this milestone's protection.
- The runtime is single-host and uses one configured main Telegram account and private recipient. Unix permissions protect the local service boundary, not against arbitrary code already running as the same OS user.
- Calls, Twilio credentials, billing and voice media are excluded.

## Activation checklist for a later authorized step

1. Review changes in both repositories. Enable authenticated production Personal Contracts access and authenticated PiBot dashboard access. Development cannot approve mandates or run the authority bridge. Configure the exact browser origin and Better Auth session-cookie name for human approval; bearer credentials and frontend tags alone are rejected.
2. In Personal Contracts, approve a short-lived message-only mandate for the exact bot/chat/user identifiers, coordinator ID, finite daily limits and Berlin quiet hours. Record its mandate ID. This must be a human action.
3. Provision a distinct 32-byte random hex bridge credential in a 0600 regular file inside an owned 0700 directory. Configure the bridge environment below. No credential belongs in a prompt, git, or this report.
4. Place PiBot's JSON configuration in a private 0600 file. Supply its absolute path as `PIBOT_COORDINATOR_CONFIG`. Use a new dedicated coordinator data directory; do not repurpose existing durable workflow files. The configured chat must already be allowlisted for the main bot.
5. Only after explicit operational authorization, start/restart services, confirm bridge identity and status, and queue one short-lived manual test decision. Inspect the persisted response and delivery record before expanding use.

Personal Contracts environment:

```text
NODE_ENV=production
CONTACT_MANDATE_HUMAN_ORIGIN=<exact browser origin, no path>
CONTACT_MANDATE_HUMAN_SESSION_COOKIE=<actual Better Auth session_token cookie name>
CONTACT_MANDATE_BRIDGE_ENABLED=1
CONTACT_MANDATE_BRIDGE_SOCKET=<absolute private socket path>
CONTACT_MANDATE_BRIDGE_TOKEN_FILE=<absolute private credential path>
CONTACT_MANDATE_BRIDGE_OWNER_ID=<authenticated approval identity>
CONTACT_MANDATE_BRIDGE_COORDINATOR_ID=<chosen coordinator identity>
```

PiBot private configuration shape (placeholders, not an active configuration):

```json
{
  "ownerId": "<same authenticated approval identity>",
  "coordinatorId": "<same coordinator identity>",
  "mandateId": "<human-approved mandate ID>",
  "botId": "<numeric bot ID>",
  "chatId": "<numeric private chat ID>",
  "userId": "<same numeric owner user ID>",
  "socketPath": "<absolute private socket path>",
  "tokenFile": "<absolute private credential path>",
  "dataDir": "<absolute dedicated coordinator directory>"
}
```

PiBot coordinator tests ran on Node 22.22.3 with the built-in SQLite module. The module is loaded only when the coordinator is enabled.

The existing encrypted PiBot bot token is reused internally; it is not placed in this configuration. Leaving `PIBOT_COORDINATOR_CONFIG` unset and the bridge enable flag unset keeps the new path disabled.

## Validation

Focused automated checks cover mandate lifecycle and authentication, private bridge protocol, authority failures, owner-cap changes, rate limits, recipient isolation, stale/duplicate replies, quiet hours, crash recovery, capture-before-cursor, and dashboard request security. Fake providers and temporary databases are used. Live end-to-end verification remains intentionally unperformed pending activation.

Verification evidence from this implementation session:

- PiBot: 198 checks passed in the combined coordinator, dashboard and Telegram regression run; subsequent focused runs passed the expanded six dashboard-auth tests and seven authority-client tests. TypeScript passed.
- Personal Contracts: the existing suite passed 40 JavaScript and 74 TypeScript checks before final security hardening; the targeted lifecycle/bridge/session checks and TypeScript were rerun after hardening.
- A real child-process exit after fake provider acceptance verifies that restart leaves an uncertain attempt without an automatic resend. A real grammY Bot with a fake API transport verifies capture before its stop-time polling acknowledgement.
- Production browser approval, live Telegram delivery, automatic contract projection and real-provider recovery have not been validated. They are not claimed by these test results.
