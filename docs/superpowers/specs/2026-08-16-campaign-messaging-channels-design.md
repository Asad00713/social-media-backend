# Campaign Messaging Channels (Slack + Discord) — Design Spec

**Date:** 2026-08-16
**Branches:** `feat/campaign-messaging-channels` (both `socialmedia-workspace` and `socialmedia-frontend-campaigns`, each off `main`)
**Type:** Architectural (new backend publish capability + interface change carried through post model + new frontend composer path)

---

## 1. Problem

Campaigns (bulk + drip) can target social platforms (Twitter/FB/IG/LinkedIn/…), but **not** the chat/messaging platforms Slack, Discord, Telegram, WhatsApp. Two independent defects:

1. **They can't publish.** `PublisherFactory` has no publisher for slack/discord/telegram/whatsapp — `getPublisher('slack')` throws `No publisher found for platform: slack`. A campaign slot targeting one fails at fire time.
2. **Wrong composer.** These platforms have `types: []` in `PLATFORM_POST_TYPES`, so selecting one falls back to `'text'` and shows the full **post** composer (mode strip + post-type tabs + rich EditorCard + platform-options). Messaging platforms should get a simple **chat-style** composer: one message + at most one media.

The user's ask: messaging channels should use a chat-style input (not the post composer), and one slot = **one message + one optional media**, in **both** drip and bulk campaigns.

## 2. Scope

**In scope (this effort): Slack + Discord only.**

**Deferred (documented, NOT built here):**
- **WhatsApp** — Cloud API only permits sends inside a 24-hour customer-service window; unsolicited scheduled posts require pre-approved **message templates**, and no template-send code exists in the backend. Cold campaign sends would silently fail. Needs its own effort + Meta template approval.
- **Telegram** — the Bot API cannot enumerate a bot's chats (platform limitation); the only known chat ids are those captured from inbound webhook messages into `inbox_items`. A destination picker would only list "chats that already messaged the bot," which is confusing for a broadcast feature. Needs its own design.

## 3. Key facts the design rests on (verified in code)

- **Send code already exists** (from the inbox feature) — no API clients to write:
  - Slack: `SlackService.postMessage(botToken, { channel, text })` (`src/channels/services/slack.service.ts:90`) and `uploadFile(botToken, { channelId, filename, contentType, buffer, initialComment })` (`:352`).
  - Discord: `DiscordService.createMessage(channelId, { content?, files? })` (`src/channels/services/discord.service.ts:27`); `files: { name, data: Buffer, contentType? }[]`.
- **Destination list endpoints already exist** (both `JwtAuthGuard`, in `src/channels/channels.controller.ts`):
  - Slack: `GET workspaces/:workspaceId/slack/:channelId/conversations` → `{ channels: { id, name, isMember, isPrivate, ... }[], nextCursor }`.
  - Discord: `GET workspaces/:workspaceId/discord/:channelId/channels` → `{ channels: { id, name, type }[] }`.
- **Publisher contract** (`src/posts/publishers/base.publisher.ts`): abstract `platform`, `publish(options: PublishOptions): Promise<PublishResult>`, `validate(options): void`, `supportsMediaTypes(mediaItems): boolean`.
  - `PublishOptions`: `{ content, mediaItems, metadata, accessToken, platformAccountId, channelMetadata, channelId }`.
  - `PublishResult`: `{ platformPostId, platformPostUrl?, metadata? }`.
  - `MediaItem`: `{ url, type, thumbnailUrl?, altText?, ... }` — media is always URL-based; publishers download it.
- **Publish path:** campaign materializer inserts a `posts` row + enqueues `publish-post` → `PostPublishProcessor` → `PostService.publishPost` → per target `publisherFactory.getPublisher(target.platform).publish({...})` (`src/posts/services/post.service.ts:807-818`). A second inline path (`publish-orchestrator.service.ts:148`) uses the same contract.
- **Destination gap:** `PostTarget` (`src/drizzle/schema/posts.schema.ts:52-61`) has only `channelId + platform` — no field for "which Slack channel / Discord channel." This is the one new data-shape change needed.
- **Discord auth model:** `DiscordService` uses a single shared `process.env.DISCORD_BOT_TOKEN` (not a per-channel token). The Discord publisher ignores `PublishOptions.accessToken`. Slack uses the per-channel bot token (decrypted via `channelService.getAccessToken`).
- **Slack public-post:** OAuth scope `chat:write.public` is already granted, so the bot can post to **public** channels without joining. (Decision: post to public channels without join; private/member-only handled by the picker flagging `isMember`.)

## 4. Design — three layers, backend-first

### Layer 1 — Backend

**1a. Carry the destination through the post model.**
Add an optional field to `PostTarget`:
```ts
destination?: {
  id: string;      // Slack channel id (C0123…) or Discord channel id
  name?: string;   // human label for display/audit (e.g. "#announcements")
};
```
Null/absent for every existing platform → zero behavioural change for them. **Verified:** `targets` is `jsonb('targets').$type<PostTarget[]>()` (`posts.schema.ts:84`) and `PostTarget` is a plain TS interface (`:52`), so adding an optional nested field is a **pure type change — NO DB migration required.**

**1b. `SlackPublisher`** (`src/posts/publishers/slack.publisher.ts`):
- `platform = 'slack'`.
- `validate(options)`: require a destination id in `options.metadata.destination` (materializer copies it there — see 1e); require `content` OR exactly one media item; reject >1 media.
- `supportsMediaTypes`: true iff `mediaItems.length <= 1`.
- `publish`:
  - No media → `slackService.postMessage(accessToken, { channel: destination.id, text: content })`.
  - One media → `fetch(mediaItems[0].url)` → Buffer → `slackService.uploadFile(accessToken, { channelId: destination.id, filename, contentType, buffer, initialComment: content })`.
  - Return `{ platformPostId: ts, platformPostUrl?: undefined }`.

**1c. `DiscordPublisher`** (`src/posts/publishers/discord.publisher.ts`):
- `platform = 'discord'`.
- `validate`: require destination id; content OR one media; reject >1 media.
- `publish`: download media (if any) → Buffer; `discordService.createMessage(destination.id, { content, files })`. Ignores `accessToken` (shared env bot token). Return `{ platformPostId: message.id }`.

**1d. Register both in `PublisherFactory`** (constructor-inject, add to the map). Ensure both are provided by whatever module wires the factory (`PostsModule` / publishers provider list), and that `ChannelsModule`'s `SlackService`/`DiscordService` are importable there (they already are used elsewhere in posts — confirm).

**1e. Campaign materializer carries the destination.**
`campaign-publishing.service.ts`:
- `MaterializeInput` gains `destination?: { id: string; name?: string }`.
- `buildTargets(channelId, platform, destination?)` includes `destination` in the `PostTarget`.
- The publish path (`post.service.ts`) already merges `target` fields into `metadata` before calling the publisher; ensure `destination` reaches `options.metadata.destination` (add to the metadata merge if not automatic).
- The caller that builds `MaterializeInput` from a campaign slot reads the destination from the slot's stored `ChannelDayContent` (see Layer 2 data shape) and threads it through.

### Layer 2 — Frontend

**2a. Post-type config.** In `PLATFORM_POST_TYPES`, give `slack` and `discord` `types: ['message']`, `default: 'message'`, keep their `charLimit` (slack 40000, discord 2000). Add a new `PostType` `'message'` with `composer: 'message'` (new `ComposerKind`). Leave telegram/whatsapp `types: []` (still deferred).

**2b. Slot-content shape.** `ChannelDayContent` gains an optional `destination?: { id: string; name?: string }` (only messaging slots populate it). `isChannelDayFilled` for a `'message'` slot: filled iff `destination` is set AND (`caption` non-empty OR one media). Media cap enforced in the composer, not the type.

**2c. `MessageComposer`** (`src/features/campaigns/components/create/steps/composers/message-composer.tsx`):
- One `Textarea` (shadcn) for the message, char counter against platform limit.
- One optional media attach, **max 1**, reusing the existing media picker/`EditorCard` media path but capped at 1 (or the existing `MediaComposer` with `mediaMax: 1`). No thread, poll, carousel.
- A **destination picker** (shadcn `Select` or `Combobox`) — see 2d.
- **No** mode strip, **no** post-type tabs, **no** platform-options panel, **no** AI/Template.

**2d. Destination picker + data hooks.**
- New API wrappers + React Query hooks:
  - Slack: `GET workspaces/:workspaceId/slack/:channelId/conversations` (paginate via `nextCursor`; show name, flag non-member public channels are fine, hide/disable private where `isMember === false`).
  - Discord: `GET workspaces/:workspaceId/discord/:channelId/channels`.
- Selecting a destination writes `{ id, name }` into `ChannelDayContent.destination`.
- Loading/empty/error states per CLAUDE.md Rule 4 (skeleton while fetching, "No channels found" empty, inline error + retry).

**2e. Routing in `ChannelDayComposer`.** When `platform` is a messaging platform (or `postType === 'message'`), render `MessageComposer` instead of the mode strip + `ManualBody` + `PlatformOptions` block. Bulk and drip both flow through `ChannelDayComposer`, so both get it. Non-messaging platforms unchanged (byte-for-byte).

**2f. `ChannelsColumn` add-flow.** Messaging channels already appear in the "+ Add channel" menu. For a `'message'` slot the card meta shows the destination name (e.g. "→ #announcements") instead of a post-type chip; media count still shown (0 or 1).

**2g. Launch validation.** A messaging slot with **no destination** blocks launch (destination is required). Surface it in the existing pre-flight/launch check (`preflight-summary.tsx` or the launch mutation guard): list offending slots ("Pick a destination for <channel> on <date>").

### Layer 3 — Consistency

Because `ChannelDayComposer` routes by platform, **drip and bulk both** get the chat composer with no extra work. Bulk behaviour for non-messaging platforms stays byte-for-byte unchanged (verified by the existing bulk-safety tests + a final review).

## 5. Data flow (Slack example)

```
Composer: user adds Slack channel → MessageComposer →
  picks destination (#announcements, id C0123) + types message + optional 1 media
  → ChannelDayContent { postType:'message', caption, media[0..1], destination:{id:'C0123',name:'#announcements'} }
Launch: materializer → posts row + PostTarget { channelId, platform:'slack', destination:{id,name} }
  → enqueue publish-post { postId } at fire time
Fire: PostPublishProcessor → PostService.publishPost → per target
  → getPublisher('slack').publish({ content, mediaItems, metadata:{destination}, accessToken, ... })
  → SlackService.postMessage / uploadFile → Slack
```

## 6. Error handling

- **No destination:** blocked at launch (validation), not at fire time.
- **>1 media:** prevented in composer (cap); publisher `validate` rejects as defence-in-depth.
- **Empty message AND no media:** slot not "filled"; blocked at launch.
- **Slack private channel, bot not member:** picker disables/hides it; public channels post without join (`chat:write.public`).
- **Discord channel deleted / bot removed:** publish throws → BullMQ retry → slot marked failed with the error (existing runtime-status path).

## 7. Testing

- **Backend:** unit tests for `SlackPublisher` and `DiscordPublisher` (`validate` rejects missing destination / >1 media; `publish` calls the right service method with the destination id; media path downloads + passes buffer). Mock `SlackService`/`DiscordService`. Factory test: `getPublisher('slack')`/`('discord')` returns the publisher (no throw). Materializer test: destination copied into `PostTarget`.
- **Frontend:** `MessageComposer` renders message box + destination picker, caps media at 1, no mode strip / post-type tabs. `isChannelDayFilled` for `'message'`. Destination-picker hooks (loading/empty/error). Launch validation flags a destination-less messaging slot. Bulk non-messaging path unchanged (existing tests stay green).
- **Build:** `npm run build` green both repos.

## 8. Global constraints

- **shadcn-only** UI; theme tokens only (no hex, no arbitrary Tailwind colors).
- **Never** `git add .`/`-A` — surgical `git add <path>` only (tracked `.env` on FE, gitignored `.env` on BE, both hold secrets).
- Commit/push only when the user explicitly asks.
- Assistant runs **no** `db:*`/`psql`/migration commands — the user applies any migration.
- Bulk campaign behaviour for non-messaging platforms stays **byte-for-byte** unchanged.
- Backend-first (Layer 1 before Layer 2).
- Telegram + WhatsApp remain deferred — do not add them to `PLATFORM_POST_TYPES.types` or the factory.
