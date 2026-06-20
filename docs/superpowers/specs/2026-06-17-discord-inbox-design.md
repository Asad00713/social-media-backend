# Discord Inbox — Design

> Companion to `2026-06-17-discord-inbox-scope.md` (scope + cross-agent
> coordination). This is the technical design for Phase 1.
> Branch: `feat/discord-inbox` (backend + frontend). Date: 2026-06-17.

**Goal:** Add Discord as a DM/mention inbox platform — receive bot DMs and
@mentions (with attachments + edit/delete sync) and reply (text + attachments,
delete own message), matching the existing Slack/Telegram inbox surface.

**Architecture in one line:** A single persistent Discord **Gateway (WebSocket)
worker** receives events and enqueues them to a `DISCORD_INGEST` BullMQ queue;
an ingest processor maps `guild_id`/DM → workspace+channel, rehosts attachments
to R2, and writes `inbox_items` — identical downstream to the existing
Slack/Telegram ingest, only the *entry point* differs (gateway instead of HTTP
webhook). Replies/deletes go out via Discord REST through a `DiscordDmAdapter`.

---

## Why Discord differs from existing platforms (recap)

- **No inbound HTTP webhook.** Slack (`/webhooks/slack/events`) and Telegram
  (`/webhooks/telegram`) push events over HTTP and enqueue to `SLACK_INGEST` /
  `TELEGRAM_INGEST`. Discord has no equivalent — incoming messages arrive ONLY
  over a persistent Gateway WebSocket. So Discord's "entry point" is a long-lived
  worker, not a controller route.
- **One shared bot, many guilds.** A single `DISCORD_BOT_TOKEN` powers one
  Gateway connection that multiplexes events for every guild the bot is in.
  Route each event by `guild_id → channel row → workspace`.
- **One workspace → many Discord connections.** A workspace can invite the bot
  to multiple servers; each server = one `social_media_channels` row
  (`platformAccountId = guild_id`). Already supported by the per-workspace
  many-rows model. DMs to the bot route by resolving the DM author's shared
  guild → workspace (or, when ambiguous, the most recent connecting workspace —
  see Open Questions).
- **Privileged intent not needed for Phase 1.** DM content and @mention content
  are exempt from the Message Content privileged intent.

## Components (new)

All under `src/channels/services/` and `src/inbox/`:

1. **`DiscordGatewayService`** (`src/channels/services/discord-gateway.service.ts`)
   - Owns the WebSocket connection (IDENTIFY, heartbeat, RESUME on reconnect,
     exponential backoff). Intents: `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES`
     (+ message content is auto-granted for DMs/mentions).
   - On `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `MESSAGE_DELETE`: filter to
     (a) DMs to the bot, (b) messages that @mention the bot. Enqueue raw event to
     `DISCORD_INGEST`. Does NOT touch the DB directly (keeps the worker thin and
     extractable).
   - Started on module init **only when** `process.env.DISCORD_GATEWAY_ENABLED`
     is truthy (see Deployment) so it runs in exactly one place.

2. **`DiscordIngestProcessor`** (`src/inbox/processors/discord-ingest.processor.ts`)
   - `@Processor(QUEUES.DISCORD_INGEST)`. Mirrors `slack-ingest.processor.ts`:
     resolve channel by `guild_id` (or DM author), dedup by
     `(channel_id, platform_item_id=message.id)`, rehost attachments to R2,
     upsert `inbox_items`, handle edit (update text) and delete (soft `[deleted]`).

3. **`DiscordDmAdapter`** (`src/inbox/adapters/discord-dm.adapter.ts`)
   - Implements `PlatformDmAdapter`. Registered in `InboxDispatcher.dmAdapters`
     under `'discord'`. `getReplyWindowState` → always `{ canReply: true }`
     (Discord has no messaging window). `deleteDm` → REST `DELETE` of the message.
     `sendDm` / `sendDmWithAttachments` → REST create message (with
     `message_reference` for reply threading). `listConversations` /
     `fetchConversationMessages` are backed by stored `inbox_items` (ingest-driven,
     not a REST list — Discord exposes no "list all DM conversations" endpoint).

4. **`DiscordService`** (`src/channels/services/discord.service.ts`)
   - REST client (bot token): create message, delete message, upload attachment
     (multipart), fetch user/guild info for author enrichment, exchange OAuth code
     for the bot-invite connect flow.

## Data flow

**Inbound:**
```
Discord Gateway WS  →  DiscordGatewayService (filter DM/mention)
   →  DISCORD_INGEST queue  →  DiscordIngestProcessor
   →  resolve guild_id→channel→workspace, rehost attachments→R2
   →  upsert inbox_items  →  realtime event to frontend (existing inbox WS)
```

**Outbound (reply/delete):** identical to Slack/Telegram —
`inbox.service.sendDm/deleteDm` → `dispatcher.getDm('discord')` →
`DiscordDmAdapter` → `DiscordService` REST.

## Data model

- Reuse `social_media_channels`: `platform='discord'`, `platformAccountId=guild_id`,
  `accessToken`/bot context as needed. Existing `channels.schema.ts` discord
  config already present (scopes `bot`/`guilds`/`messages.read`).
- Reuse `inbox_items` (type `dm`). `conversationId` = Discord channel id
  (DM channel or guild channel); `platformItemId` = Discord message id.
- New queue: add `DISCORD_INGEST: 'discord-ingest'` to `QUEUES`
  (`src/queue/queue.module.ts`) + register it.

## Connect flow (bot-invite OAuth)

- Frontend: Discord connect = open Discord's bot-invite authorize URL
  (`oauth.service.ts` discord endpoints already configured) with a guild picker.
- On callback: the bot joins the chosen guild; backend creates a
  `social_media_channels` row (`platformAccountId = guild_id`) via the existing
  `channel.service.createChannel` path, then `onChannelConnected` runs (sync state
  init — analytics snapshot is a no-op for an inbox-only platform).

## Deployment / infra decision

- **Now:** run `DiscordGatewayService` **in-process inside the main API at 1
  replica**, gated by `DISCORD_GATEWAY_ENABLED=true` on exactly one running
  instance. Zero extra Railway cost.
- **Built for extraction:** the gateway only enqueues to `DISCORD_INGEST` and
  never writes the DB, so moving it into a dedicated single-replica worker later
  is a deploy/config change (flip the env flag, point a new Railway service at the
  same codebase) — not a rewrite.
- **Future (noted, not now):** a consolidated **background worker service** could
  host the Discord gateway **plus the existing polling jobs** (`INBOX_POLLING`,
  snapshots, etc.) to offload the main API. Deferred until scale warrants it.
- **Guardrail:** never run the gateway on >1 replica — Discord disconnects a bot
  that opens a second IDENTIFY. The env-flag-on-one-instance rule enforces this
  until a dedicated worker exists.

## Error handling

- Gateway: auto-reconnect with backoff; RESUME with session id + seq to replay
  missed events; on invalid session, re-IDENTIFY. Log connect/disconnect.
- Ingest: dedup on `(channel_id, message_id)`; attachment rehost failure →
  persist the message text-only and log (don't drop the message).
- Outbound: surface Discord REST errors to the user (e.g. missing permission,
  message already deleted) the same way Slack/Telegram adapters do.

## Testing

- Unit: `DiscordDmAdapter` (send/delete/reply-reference mapping), ingest mapper
  (gateway event → `inbox_items` shape, dedup, edit/delete), gateway event filter
  (DM + mention only).
- Integration: enqueue a synthetic `MESSAGE_CREATE` → assert an `inbox_items` row
  with rehosted attachment; reply round-trips through the adapter (REST mocked).

## Frontend (Phase 1)

- Add `'discord'` to `INBOX_DM_PLATFORMS` (`src/features/inbox/constants.ts`)
  once backend `dmSupportedPlatforms()` returns it.
- Add `'discord'` to `DELETE_SUPPORTED_PLATFORMS`
  (`src/features/inbox/components/dm-message-bubble.tsx`).
- Discord connect dialog = bot-invite (server picker) in
  `connect-channel-grid.tsx`.

## Open questions (resolve during planning)

1. **DM → workspace routing when a user shares multiple connected guilds across
   different workspaces.** Proposal: attribute the DM to the workspace of the most
   recently active shared guild; revisit if it causes mis-routing.
2. Exact intents list + whether to request `GUILD_MEMBERS` (privileged) for
   author display names, or enrich names lazily via REST (preferred — avoids a
   privileged intent).

## Cross-agent coordination

See `2026-06-17-discord-inbox-scope.md`. Telegram is being advanced to **multiple
per-workspace bots** by a separate agent (sequenced AFTER this Discord work).
Discord = ONE shared bot (guild→workspace); Telegram(new) = MANY per-workspace
bots. Keep the two connection models distinct.
