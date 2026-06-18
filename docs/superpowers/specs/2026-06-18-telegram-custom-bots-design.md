# Telegram Custom Bots — Design Spec

- **Date:** 2026-06-18
- **Branch:** `feat/telegram-custom-bots`
- **Status:** Design approved; pending spec review → implementation plan
- **Author:** Claude (with maplevoiceai)

---

## 1. Summary

Replace the single **shared** Telegram bot (token in `TELEGRAM_BOT_TOKEN` env) with
**user-provided custom bots**. Each workspace connects one or more of its own bots
(created via @BotFather) by pasting the bot token. The bot itself becomes the
routing identity: every chat on a given bot belongs to exactly that bot's channel,
so the `/start <workspaceId>` deep-link binding flow is eliminated.

This is a **full replacement** of the shared-bot model. The env bot is retained
only as an optional dev/local default and is no longer the production path.

## 2. Goals

- A workspace can connect **multiple** Telegram bots, each as its own channel.
- Connect = paste token only; bot username/name auto-resolved via `getMe`.
- Bot token stored **encrypted** (same convention as every other platform).
- Per-bot webhook routing with a derived (not stored) secret.
- Every incoming DM (and group message) on a connected bot flows straight into the
  inbox — no per-chat opt-in step.
- All existing inbox capabilities (text, images, voice, video, files, avatars,
  delete) keep working, now per-bot.

## 3. Non-Goals

- Group/supergroup threading UX (already deferred — see
  `2026-06-16-telegram-group-threading-design.md`). Group messages may ingest, but
  the dedicated threading UI is out of scope here.
- Migrating existing shared-bot conversation history. Pre-launch; existing
  `mode='shared_bot'` channels will be deprecated and must be reconnected.
- Bot creation inside Schedura (users create the bot in Telegram/@BotFather
  themselves; we only consume the token).

## 4. Current State (what changes)

| Area | Today (shared bot) | After (custom bots) |
|------|--------------------|---------------------|
| Token | `TELEGRAM_BOT_TOKEN` env, one global | Encrypted per-channel `accessToken` |
| `TelegramService` | Singleton bound to env token | Token-parameterized client |
| Webhook | One URL `/webhooks/telegram`, one env secret | Per-bot `/webhooks/telegram/<routeId>` + derived secret |
| Webhook setup | `TelegramBotSetupService` at boot (one setWebhook) | `setWebhook` per bot at connect time |
| Routing | `telegram_chat_bindings` (chatId→workspace) | Channel known from `routeId` in URL |
| Connect | Deep link `t.me/<bot>?start=<wsId>` + poll | Token form → validate → store |
| Channel row | Lazy `ensureTelegramChannel`, `platformAccountId='shared'`, 1/workspace | Explicit at connect, `platformAccountId=<botId>`, N/workspace |
| `/start` binding | Required to bind chat | Removed (auto-flow) |

## 5. Architecture

### 5.1 Data model

Add one column to `social_media_channels`:

```
telegram_webhook_route_id  text  NULL  -- random opaque id, unique, indexed
```

Telegram channel row fields:

| Field | Value |
|-------|-------|
| `platform` | `telegram` |
| `accountType` | `bot` |
| `platformAccountId` | bot's Telegram user id (`getMe.id`) — **globally unique** |
| `username` | bot username (no `@`) |
| `accountName` | bot first_name / name |
| `accessToken` | **encrypted** bot token (via `encrypt()`) |
| `profilePictureUrl` | optional bot avatar |
| `telegramWebhookRouteId` | random hex (32 chars), unique |
| `metadata` | `{ mode: 'custom_bot' }` |
| `connectedByUserId` | connecting user |

**Webhook secret is NOT stored.** It is derived on demand:

```
secret = HMAC_SHA256(TELEGRAM_WEBHOOK_HMAC_SECRET, routeId)  // hex
```

`TELEGRAM_WEBHOOK_HMAC_SECRET` is a new server-side env secret. Verifying an
incoming webhook recomputes the secret from the row's `routeId` and compares it to
the `X-Telegram-Bot-Api-Secret-Token` header (constant-time compare).

**Global uniqueness:** a given bot (Telegram id) can be connected only once across
the whole system — Telegram allows exactly one webhook per bot, so a second connect
elsewhere would silently steal the webhook. Connect rejects duplicates with 409.

### 5.2 `TelegramService` refactor

Convert from env-singleton to **token-parameterized**. Preferred shape — a bound
client factory so call sites stay clean:

```ts
const tg = this.telegram.forToken(botToken);
await tg.sendMessage(chatId, text);
await tg.getFile(fileId);
```

`forToken(token)` returns an object exposing the existing method surface
(`getMe`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`, `sendMessage`,
`editMessageText`, `deleteMessage`, `answerCallbackQuery`, `getChatAdministrators`,
`getFile`, `getUserProfilePhotoFileId`, `downloadFile`, `sendPhoto/Voice/Audio/
Video/Document`, `resolveEntities`). Internally `callJson` / `callMultipart` /
`downloadFile` use the bound token's base URLs.

`TELEGRAM_BOT_TOKEN` env remains only as a dev fallback for `forToken()` callers
that pass nothing; production always passes a per-channel token.

New methods needed: `deleteWebhook()`, `getWebhookInfo()` (verify after setWebhook).

### 5.3 Connect flow (backend)

`POST /channels/workspaces/:workspaceId/telegram/connect` — body `{ token: string }`:

1. Assert workspace access.
2. `tg = forToken(token); me = await tg.getMe()` — invalid token → 400
   "Invalid bot token. Re-copy it from @BotFather."
3. Global uniqueness: reject (409) if any channel already has
   `platformAccountId === me.id`.
4. Generate `routeId` (crypto random hex), derive `secret`.
5. `tg.setWebhook(BASE_URL/webhooks/telegram/<routeId>, secret, allowed_updates)`.
   `allowed_updates = ['message','edited_message','callback_query','my_chat_member']`.
6. `tg.getWebhookInfo()` — verify `url` matches and no `last_error_message`.
7. Insert channel row (encrypted token + routeId + bot identity).
8. Return the created channel (shape consistent with other connect responses).

`BASE_URL` from `TELEGRAM_WEBHOOK_BASE_URL` (existing env) or `API_PUBLIC_URL`.

**Disconnect:** the existing channel-disconnect path, when `platform==='telegram'`,
calls `forToken(token).deleteWebhook()` (best-effort; failure logged, disconnect
proceeds).

### 5.4 Webhook + ingest

New route:

```
POST /webhooks/telegram/:routeId
```

1. Look up channel by `telegramWebhookRouteId === routeId`. Not found → 200 `{ok:true}`
   (don't leak; Telegram won't retry usefully). Log a warn.
2. Derive expected secret from `routeId`; constant-time compare with
   `X-Telegram-Bot-Api-Secret-Token`. Mismatch → 403.
3. Enqueue `{ channelId, workspaceId, update }` to `TELEGRAM_INGEST`
   (`attempts: 3`, `removeOnComplete: true`).

Old `POST /webhooks/telegram` route is removed.

**`TelegramIngestProcessor` changes:**

- Job data is now `{ channelId, workspaceId, update }`.
- Resolve token via `channelService.getAccessToken(channelId, workspaceId)`;
  build `tg = forToken(token)`.
- **Bot self-filter** uses the stored bot id (`channel.platformAccountId`) — no
  `getMe` call in the hot path. Cache per-channel if needed.
- **No binding lookup, no `/start` handling, no `ensureTelegramChannel`.** The
  channel is already known from the route.
- `workspaceId` comes from the job (no `telegram_chat_bindings` read).
- Media rehost, avatar resolution, entity resolution: unchanged logic but use the
  per-channel `tg` client.
- `conversationId` = chat id (unchanged). Inbox grouping by
  `(channelId, conversationId)` already isolates per-bot.
- `my_chat_member` / `callback_query` group-bind handlers: no longer needed for the
  bind flow (auto-flow). Group ingest, if kept, attributes to the route's channel
  directly. Group threading UI remains deferred.

### 5.5 Removed / obsolete

- `TelegramBotSetupService` (boot-time single setWebhook).
- `generateTelegramConnectLink` (deep link) + `checkTelegramBinding` endpoints.
- `telegram_chat_bindings` reads/writes (table left in place, unused; drop in a
  later cleanup migration).
- Shared `ensureTelegramChannel`, `platformAccountId='shared'` sentinel,
  `accessToken=''` sentinel.
- Frontend deep-link button + binding poll.

## 6. Frontend (separate go-ahead per CLAUDE.md)

Replace `ConnectTelegramButton` (deep-link + poll) with a **shadcn Dialog + Form
(RHF + Zod)**:

- Trigger button "Connect Telegram".
- Dialog: single token `Input` (password-style), inline helper "How to create a bot
  (@BotFather)" with steps, submit `Button` with loading state.
- On submit → `POST .../telegram/connect`; success → toast + show connected bot
  (avatar + `@username`), close dialog, refresh channels.
- Errors surfaced inline / toast: invalid token (400), already connected (409).
- Multiple bots: each connected bot appears as its own row in the channels list.
- States: loading (validating), disabled, error, empty — per Rule 4.

Components scaffold under `src/features/channels/`:
- `components/connect-telegram-dialog.tsx`
- `hooks/use-connect-telegram.ts` (replace existing)
- `api/telegram.api.ts` (replace deep-link calls with `connect({ token })`)
- `schemas/telegram-connect.schema.ts`

## 7. Error Handling

| Failure | Handling |
|---------|----------|
| Invalid token (`getMe` fails) | 400, user-friendly message |
| Bot already connected | 409 |
| `setWebhook` fails | 400 with Telegram's description; no row inserted |
| `getWebhookInfo` shows error | 400; surface `last_error_message` |
| Webhook route not found | 200 ok, warn-logged |
| Secret mismatch | 403 |
| Token decrypt fails at send/ingest | Log + surface as channel error (reconnect prompt) |
| `deleteWebhook` on disconnect fails | Best-effort, logged, disconnect proceeds |

## 8. Security

- Bot token encrypted at rest (`encrypt()`), only decrypted via
  `channelService.getAccessToken`.
- Webhook secret derived from a server secret + routeId; never stored, never sent
  to the client.
- routeId is opaque random (not the channel id, not the token) → no enumeration.
- Constant-time secret comparison.
- Global bot-uniqueness prevents webhook hijacking between workspaces.

## 9. Migration / Rollout

1. One-off migration script (`scripts/apply-telegram-route-id-migration.mjs`,
   journal-drift pattern): `ALTER TABLE social_media_channels ADD COLUMN IF NOT
   EXISTS telegram_webhook_route_id text; CREATE UNIQUE INDEX IF NOT EXISTS ...`.
2. Add `TELEGRAM_WEBHOOK_HMAC_SECRET` to Railway env.
3. Deploy.
4. Existing `mode='shared_bot'` channels: mark/deprecate; users reconnect via the
   new form. (Few/no real users pre-launch.)

## 10. Testing

- Unit: secret derivation + constant-time compare; connect validation (invalid
  token, duplicate); `forToken` client builds correct URLs.
- Manual (live): connect a real BotFather bot → verify webhook set
  (`getWebhookInfo`) → DM the bot → message appears in inbox → reply (text + image +
  voice + file) → delete → disconnect (webhook removed). Repeat with a **second**
  bot in the same workspace to prove multi-bot isolation.
- Build: `npm run build` (backend), `npm run build` (frontend).

## 11. Open Questions

- Should we proactively drop `telegram_chat_bindings` now or in a later cleanup?
  (Proposed: later cleanup migration, keep this change focused.)
- Bot avatar: `getMe` doesn't return a photo; fetching the bot's own avatar needs
  `getUserProfilePhotos` on the bot id. Worth it, or skip avatar for the bot row?
  (Proposed: best-effort fetch; fall back to initials.)
