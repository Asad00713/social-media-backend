# Maestro Bridge — Design Spec (talk to Maestro from external channels)

- **Date:** 2026-06-27
- **Branch:** `feat/maestro-agent-sdk` (continues Maestro work)
- **Status:** Design approved with user (decisions locked); pending spec review → implementation plan
- **Author:** Claude (with maplevoiceai)

---

## 1. Summary

Today Maestro lives **only inside the app** (web panel, SSE stream). This spec adds
the **inbound bridge**: a user talks **to** Maestro **from** an external messaging
channel (Telegram, WhatsApp) and Maestro replies on that same channel — running the
exact same agent (same tools, same persistence, same confirm gate) headless. It also
defines the **notification delivery** path (Maestro/tasks → user's channels) which
shares the same link infrastructure.

The bridge runs on **dedicated, Schedura-operated** bots/numbers — **not** the
per-workspace customer-facing bots. The Maestro bot is the owner's private line to
their assistant; it is a separate identity from the inbox/customer bots.

## 2. Goals

- A user links an external identity (Telegram account, WhatsApp number) to their
  Schedura account once, then DMs Maestro from that channel and gets real answers +
  actions (publish a post, check inbox, send a Slack message, etc.).
- One **central** Schedura Maestro bot (Telegram) and one **central** number
  (WhatsApp) — zero per-user bot creation.
- Maestro's confirm-before-send gate, `ask_user` questions, and media results all
  render natively in the channel (inline buttons / numbered options / photos).
- The same link table powers **notifications** ("notify me when the post publishes"
  → message on Telegram / email).
- Telegram + Email are **free**; WhatsApp is **premium** (plan-gated), and that one
  gate unlocks WhatsApp for **both** Maestro chat **and** notifications.

## 3. Non-Goals

- **Not** reusing the per-workspace inbox/customer bots (Telegram custom bots,
  WhatsApp customer numbers). Those stay customer-facing; the bridge is separate.
- **No** Slack/Discord inbound assistant-DM bridge in this spec (deferred — easy to
  add later as another channel adapter).
- **No** full Gmail/IMAP integration. Email is **outbound notifications only** via
  the existing **Resend** infra. Inbound email-to-Maestro is deferred.
- **No** voice/STT.
- **No** new agent capabilities — the bridge is a new *surface* over the existing
  Maestro runtime and tools.

## 4. Key Decisions (locked with user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Bot/number ownership | **Central, Schedura-run** (one Telegram bot + one WhatsApp number). Per-workspace rejected as over-kill for the owner-assistant use case |
| 2 | Separation from inbox bots | Maestro bridge is a **distinct identity** from per-workspace customer bots; different webhook routes, different credentials |
| 3 | Identity model | External account → Schedura user, **token-gated** link; unlinked senders get a "connect first" reply |
| 4 | Multi-workspace | Link has a `defaultWorkspaceId`; `/switch` command (Telegram) / Maestro asks when ambiguous |
| 5 | Phase-1 channels | **Telegram (free)** chat + **Email (free, Resend)** notifications |
| 6 | Phase-2 channel | **WhatsApp (premium)** chat + notifications |
| 7 | WhatsApp billing | **Plan-tier gate** (not a standalone addon). One entitlement unlocks WhatsApp for chat **and** notifications — never two charges |
| 8 | Reuse | Reuse `AgentRuntime` + tools + chatbot conversation tables; add a **headless run consumer** beside the SSE one |
| 9 | Connect UI | "Connect Maestro" — outline brand-icon buttons + Premium badge + tinted "Recommended" card; in **Maestro Settings** + **new-chat intro** |

## 5. Architecture

### 5.1 The three distinct "bots" (disambiguation)

| Surface | Who messages it | Identity | Status |
|---------|-----------------|----------|--------|
| **Inbox customer bot** (Telegram custom bots, WhatsApp customer number) | the workspace's **customers** | per-workspace, branded | exists / in progress |
| **Maestro outward tools** (`send_telegram_message`, `send_slack_message`, …) | — (Maestro acts *on* these) | uses connected channels | built |
| **Maestro bridge bot** (this spec) | the **owner** (you) | **central** Schedura Maestro bot/number | new |

### 5.2 Data model — `maestro_channel_links`

New table (Drizzle schema `src/drizzle/schema/maestro.schema.ts` or extend an
existing maestro schema):

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid pk | |
| `userId` | text/uuid | the Schedura **owner** account |
| `channel` | enum `telegram` \| `whatsapp` \| `email` | |
| `externalId` | text | Telegram user id / WhatsApp `wa_id` (phone) / email address |
| `displayName` | text null | for showing "Connected as …" |
| `defaultWorkspaceId` | text/uuid | which workspace Maestro acts on by default |
| `conversationId` | text null | the Maestro conversation backing this bridge (chatbot tables) |
| `status` | enum `active` \| `revoked` | unlink = `revoked` |
| `metadata` | jsonb | channel-specific (e.g. WhatsApp `phoneNumberId`) |
| `linkedAt` / `updatedAt` | timestamp | |

**Global uniqueness:** unique index on `(channel, externalId)` — one external
identity maps to exactly one Schedura user.

### 5.3 Linking flows (token-gated)

**Telegram** (Phase 1):
1. App "Connect Telegram" → `POST /maestro/bridge/telegram/link-token` returns a
   short-lived **HMAC-signed token** (TTL ~10 min, single-use, bound to `userId` +
   `defaultWorkspaceId`).
2. Frontend opens deep link `t.me/<MaestroBot>?start=<linkToken>`.
3. User taps **Start** → bot webhook receives `/start <linkToken>`.
4. Backend verifies token (signature, TTL, not-used), then upserts
   `maestro_channel_links` (Telegram user id ↔ userId). Replies in-chat:
   "✅ Connected to <workspace>. Send me anything."
5. Frontend polls / SSE-less refresh shows "Connected as @handle".

**WhatsApp** (Phase 2, premium):
1. App "Connect WhatsApp" shows the **central number** + a one-time code (or a
   pre-filled `wa.me/<number>?text=<code>` deep link).
2. User sends the code from their WhatsApp → inbound webhook matches the code →
   link (`wa_id` ↔ userId).
3. Subject to the 24-hour session rule and plan gate.

**Email** (Phase 1): no linking step — the account email is already known. "Email
updates" is an **opt-in toggle** stored on the user/workspace prefs; delivery via
Resend. (Inbound email replies deferred.)

### 5.4 Central bot infrastructure

- **Telegram:** one central bot, token in env `MAESTRO_TELEGRAM_BOT_TOKEN`. Single
  webhook `POST /webhooks/maestro/telegram` with a static secret
  (`MAESTRO_TELEGRAM_WEBHOOK_SECRET`, constant-time compared against
  `X-Telegram-Bot-Api-Secret-Token`). Reuse `TelegramService.forToken(token)` (the
  token-parameterized client from the custom-bots refactor).
- **WhatsApp:** one central WABA number, env creds
  (`MAESTRO_WHATSAPP_*`). Webhook `POST /webhooks/maestro/whatsapp`. Reuse
  `WhatsAppService`.
- These routes are **separate** from the inbox customer webhooks
  (`/webhooks/telegram/:routeId`, inbox WhatsApp) — different credentials, different
  handler, no collision.

### 5.5 Inbound → headless Maestro run

New module `src/maestro/bridge/`:

```
bridge/
├── maestro-bridge.module.ts
├── webhooks/
│   ├── maestro-telegram.controller.ts   # POST /webhooks/maestro/telegram
│   └── maestro-whatsapp.controller.ts   # POST /webhooks/maestro/whatsapp (Phase 2)
├── services/
│   ├── bridge-link.service.ts           # issue/verify link tokens, CRUD links
│   ├── bridge-router.service.ts         # inbound msg -> resolve link -> run -> reply
│   ├── headless-run.service.ts          # consume AgentRuntime events without SSE
│   └── channel-reply/                    # render text/question/media per channel
│       ├── telegram-reply.adapter.ts
│       └── whatsapp-reply.adapter.ts
└── maestro-notification.service.ts      # notify(userId, prefs, message) fan-out
```

**Flow (`bridge-router.service`):**
1. Webhook enqueues `{ channel, externalId, message }` to a `MAESTRO_BRIDGE` BullMQ
   queue (`attempts: 2`) — keep the webhook fast, isolate the subprocess run.
2. Resolve link by `(channel, externalId)`:
   - **Not linked / revoked** → reply "Connect your Schedura account first: <app
     link>." (rate-limited; see Security.)
   - **`/switch`** command → list the user's workspaces as inline buttons; selection
     updates `defaultWorkspaceId`.
   - **Linked** → `ctx = { userId, workspaceId: link.defaultWorkspaceId }`.
3. **Entitlement check** (`canUseMaestroChannel`): WhatsApp requires the plan gate;
   Telegram/Email always allowed. Fail → upsell reply.
4. Load/continue the link's Maestro conversation (chatbot tables) — context persists
   across messages.
5. `headless-run.service` runs the **same `AgentRuntime`** (same tools, same system
   prompt, `confirmBeforeSend` ON by default for an unattended channel) and consumes
   `AgentEvent`s:
   - `text_delta`/final text → accumulate.
   - `tool_result` with `kind:'question'` (ask_user **or** confirm card) → render in
     channel and **pause** the run, awaiting the user's reply (see 5.6).
   - `tool_result` with `kind:'media'` → send photos.
   - platform `kind`s (slack/discord/…) → already narrated in text.
6. Reply final text on the same channel via the channel reply adapter; persist the
   assistant message.

### 5.6 Questions & confirm gate in a chat channel

The agent's `kind:'question'` results (both `ask_user` and the confirm-before-send
card) must render natively:

- **Telegram:** inline keyboard buttons (one per option); the user's tap →
  `callback_query` → maps back to the chosen option → the run resumes by re-invoking
  the tool with the answer / `confirmed:true`. Falls back to numbered text if needed.
- **WhatsApp:** interactive reply buttons (≤3) or a numbered list; user replies with
  the number/text.

Because the confirm gate is already a **tool-level two-phase** mechanism (the model
re-calls the tool with `confirmed:true`), the bridge only needs to (a) show options
and (b) feed the choice back as the next user turn — no special-casing per tool.

### 5.7 Notifications (`maestro-notification.service`)

- `notify(userId, { channels }, message)` fans out to the user's **active links** per
  their prefs: Telegram `sendMessage`, Email via Resend, WhatsApp (premium).
- This is the delivery mechanism only; **which events trigger a notification** (post
  published, drip done, long Maestro task finished, etc.) is wired separately as
  callers adopt it. Phase 1 ships the mechanism + Email/Telegram delivery.

## 6. Billing / Entitlement

- `canUseMaestroChannel(workspace, channel)`:
  - `telegram`, `email` → always true (any plan with Maestro access).
  - `whatsapp` → true only on the gated plan tier(s).
- Reuse existing billing entitlement checks (same pattern as other plan-gated
  features). **No new addon SKU.** If usage data later shows demand, a standalone
  WhatsApp addon can be added — explicitly out of scope now (avoids an extra SKU +
  user confusion).
- The UI shows WhatsApp with a **Premium** badge and an upsell when locked.

## 7. Frontend — "Connect Maestro" UI (separate go-ahead per CLAUDE.md)

Reference style: bold title → muted subtext → full-width **outline buttons with
brand icons** → divider → tinted **"Recommended"** card.

**Locations:**
1. **Maestro Settings → "Connections"** section (permanent home).
2. **New-chat intro / empty state** (compact, for discovery).

**Pieces (shadcn — confirm via MCP at build time):** `Button` (outline) per row,
`Badge` ("Premium"), tinted `Card` for the recommended CTA. Brand icons from the
existing `platform-logos` (`TelegramLogo`, `WhatsAppLogo`). Theme tokens only.

**Rows:**
- **Connect Telegram** (free) — opens deep-link; shows "Connected as @handle" + a
  disconnect action once linked.
- **Connect WhatsApp** `[Premium]` (Phase 2) — locked/upsell until the plan gate.
- **Email updates** — opt-in toggle (Resend).
- Tinted **Recommended** card → Telegram (free, ~1 min setup).

**States (Rule 4):** loading (issuing token / validating), linked, error,
premium-locked (upsell), empty.

**Scaffold** under `src/features/maestro/`:
- `components/connect-maestro.tsx` (+ small row/badge subcomponents)
- `hooks/use-maestro-bridge.ts`
- `api/maestro-bridge.api.ts`

## 8. Security

- **Link tokens:** short-lived, HMAC-signed, single-use, bound to `userId` +
  `defaultWorkspaceId`. Verified server-side on `/start`.
- **Webhook secrets:** static env secret per central bot, constant-time compared.
- **Unlinked inbound:** safe "connect first" reply, **rate-limited per externalId**
  to prevent spam/abuse of the public bot.
- **Run rate-limit:** cap headless runs per user/window (cost control; reuse the
  existing rate-limit guard concept). Subprocess-per-turn cost is real.
- **Global uniqueness** on `(channel, externalId)` prevents identity collisions.
- **Revoke:** unlink from settings → `status='revoked'`; future messages get
  "connect first".
- Confirm-before-send ON by default on bridge channels (unattended surface) — Maestro
  never sends/publishes without an explicit in-channel confirmation tap.

## 9. Phasing

**Phase 1 (this build):**
- `maestro_channel_links` table + migration (journal-drift script pattern).
- Central Telegram bot infra + webhook + `MAESTRO_BRIDGE` queue.
- Link token issue/verify; `/start` linking; `/switch` workspace.
- Headless run service + Telegram reply adapter (text, inline-button questions/confirm,
  media photos).
- `maestro-notification.service` + Email (Resend) + Telegram delivery.
- "Connect Maestro" UI (Telegram + Email) in Settings + intro (after backend, with
  approval).

**Phase 2:**
- WhatsApp bridge (premium, plan-gated) + WhatsApp reply adapter + notifications.
- Inbound email-to-Maestro (optional, deferred).

**Deferred:** Slack/Discord inbound assistant-DM bridges; full Gmail; voice.

## 10. Integration Risks (verify early)

1. **Headless run vs SSE coupling.** `MaestroService.streamMessage` is SSE-shaped.
   Extract a channel-agnostic `runTurn()` core (yields `AgentEvent`s) consumed by
   both the SSE controller and `headless-run.service`. Verify no SSE/`res` leakage.
2. **Pausing a subprocess run for a question.** The Agent SDK `query()` is one
   subprocess per turn; a question ends the turn (agent waits). The bridge resumes on
   the **next inbound message** (the user's button tap), re-running with history —
   matches the existing in-app behaviour. Confirm the confirm-card resume works with
   history replay (already fixed for images; same path).
3. **Telegram central bot vs existing custom-bot webhook routing.** Ensure the
   central `/webhooks/maestro/telegram` route and the inbox `/webhooks/telegram/:routeId`
   route never overlap; the central bot is a different token/webhook.
4. **WhatsApp 24h window** applies to the bridge too (Phase 2) — user-initiated, so
   replies within 24h are fine; notifications outside the window need templates.
5. **Cost / abuse.** Public bot = anyone can message it. Rate-limit unlinked senders
   hard; only linked users trigger a (billable) run.

## 11. Testing

- **Unit:** link-token sign/verify (TTL, single-use, tamper); `(channel, externalId)`
  uniqueness; entitlement gate; reply-adapter rendering (question → inline buttons).
- **Manual (live):** link Telegram via deep link → DM "publish my latest draft" →
  confirm card appears as buttons → tap Yes → post publishes + inbox reflects → ask a
  question Maestro answers from a tool → `/switch` workspace → unlink → confirm
  "connect first" afterward. Repeat a notification ("notify me when it publishes").
- **Build:** `npm run build` (backend) + `npm run build` (frontend).

## 12. Definition of Done (Phase 1)

- A linked Telegram user can hold a real Maestro conversation from Telegram: tool
  calls run, questions/confirm render as buttons, media returns as photos, replies
  come back on Telegram, context persists.
- `/switch` changes the active workspace; unlink revokes access.
- Email + Telegram notifications deliver via `maestro-notification.service`.
- WhatsApp shows as **Premium-locked** in the UI (no Phase-1 backend).
- Unlinked/over-rate senders are safely handled; no run is billed for them.
- Existing in-app Maestro (SSE) unaffected.
