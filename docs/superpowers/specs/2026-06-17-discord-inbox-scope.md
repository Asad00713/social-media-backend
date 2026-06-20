# Discord Inbox — Scope & Cross-Agent Coordination

> Status: **Brainstorming / scope approved (Phase 1)**. Full design doc (infra
> approaches + data model) still to be finalized before implementation.
> Branch: `feat/discord-inbox` (backend + frontend).
> Date: 2026-06-17.

## Goal

Add Discord as an **inbox platform** (DMs + @mentions receive + reply), matching
the existing Slack/Telegram DM inbox surface, but adapted to Discord's
fundamentally different (push-based, server-centric, single-bot) model.

## Critical architectural facts (why Discord ≠ Slack/Telegram)

1. **No inbound HTTP webhook.** Discord does NOT push incoming messages over
   HTTP. Receiving messages/DMs requires a **persistent Gateway (WebSocket)
   connection** with heartbeat + resume/reconnect. Discord's "Webhook" feature
   is **outbound only** (post to a channel). → A single always-on Gateway worker
   is required (separate single-replica process / leader-guarded), NOT the
   stateless request model Slack/Telegram use.
2. **Single shared bot identity.** Unlike Slack (per-workspace bot tokens),
   the whole platform uses ONE Discord application + ONE bot token. Each
   customer connects by **inviting the same bot** into their server (guild).
   One Gateway connection multiplexes events for ALL guilds; route each event
   by `guild_id → workspace` (and DM channel → workspace).
3. **Privileged intents.** Reading arbitrary channel message *content* needs the
   privileged **Message Content** intent (free < 10k users, then Discord review).
   **DM content and @mentions are exempt** — so Phase 1 (DMs + mentions) does NOT
   require the privileged intent.

## Credentials needed (Discord Developer Portal → one Application)

- `DISCORD_BOT_TOKEN` — bot REST + Gateway (core)
- `DISCORD_CLIENT_ID` — OAuth + bot invite link
- `DISCORD_CLIENT_SECRET` — OAuth code exchange
- `DISCORD_PUBLIC_KEY` — only if Interactions (slash commands/buttons) used
- OAuth redirect URI configured for the `bot` (+ `applications.commands`) invite

(Existing scaffolding: `channels.schema.ts` discord config with scopes
`['bot','guilds','messages.read']`; `oauth.service.ts` discord endpoints.)

## Phase 1 — build now (production-grade, complete inbox)

**Receive (Gateway worker):**
- Bot DMs
- @mentions of the bot in guild channels
- Incoming attachments (image/file/voice) → rehost to R2 (same as Slack)
- Incoming message **edits + deletes** synced (MESSAGE_UPDATE / MESSAGE_DELETE)

**Reply / actions (Discord REST):**
- Reply send (text + attachments)
- Delete our own sent message (`deleteDm`)
- Reply-to-message threading via `message_reference`

**Infra / wiring:**
- Single shared Gateway WebSocket worker (reconnect / heartbeat / resume)
- `guild_id → workspace` routing; bot-invite OAuth connect flow
- Conform to existing `PlatformDmAdapter` interface; ingest pushed events into
  `inbox_items` (Discord is ingest-driven, not poll-driven — `listConversations`
  / `fetchConversationMessages` backed by gateway-populated data, not a REST list)

## Phase 2 — deferred (gated or low-value)

- All-channel message reading (needs Message Content privileged intent + review)
- Reactions as inbox signals
- Threads-as-conversations
- Slash-command / button interactions
- Presence / typing indicators

---

## ⚠️ Cross-agent coordination — Telegram is being advanced in PARALLEL

A **separate agent** is advancing **Telegram** to support **multiple Telegram bot
connections** (more than one Telegram bot per workspace). That work runs
concurrently with this Discord work.

**Collision risk — shared files both efforts may touch:**
- `src/drizzle/schema/channels.schema.ts` (platform config / account types)
- Inbox adapter wiring / dispatcher (`InboxDispatcher`, adapter registration)
- Inbox DM platform constants (frontend `src/features/inbox/constants.ts`
  `INBOX_DM_PLATFORMS`; backend `dmSupportedPlatforms()`)
- `src/features/onboarding/constants.ts` + platform-logos (frontend)
- Telegram binding / channel connect tables (the Telegram agent may change the
  single-bot binding model → multi-bot; Discord's single-shared-bot model is
  different and must not be conflated with Telegram's new multi-bot model)

**Rule of thumb:** Discord = ONE shared platform bot (guild→workspace).
Telegram (new) = MULTIPLE per-workspace bots. Keep the two connection models
separate; do not generalize one onto the other without explicit agreement.
