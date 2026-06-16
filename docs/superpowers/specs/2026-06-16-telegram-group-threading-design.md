# Telegram Group Threading — Next-Phase Design

**Status:** Planned (not implemented). Captured 2026-06-16 alongside the Telegram
inbox enablement (DM + media + avatars). Group threading was explicitly deferred
to a later phase but **must be done**.

## Problem

Telegram groups/supergroups can already be bound to a workspace (via the bot
being added → inline-keyboard workspace pick → `telegram_chat_bindings` row with
`chatType` = `group` | `supergroup`). Messages from those groups **are ingested**
through the same webhook path as DMs (`TelegramIngestProcessor.ingestPlainMessage`).

The gap: a group is currently surfaced in the inbox as if it were a 1:1 DM
conversation. All members' messages collapse into one flat `conversationId`
(the chat id) with no notion of:

- **Who is who** beyond per-message author labels (we now store
  `authorDisplayName` + `authorAvatarUrl` per message, so multi-sender
  attribution already renders via `DmMessageBubble`'s `showSenderHeader`).
- **Topics / forum threads** — supergroups with "Topics" enabled
  (`message_thread_id`) are not modelled at all.
- **Reply chains** — `reply_to_message` is stored as `platformParentId` but the
  UI renders a flat list, not nested reply context.

## Scope of the next phase

1. **Forum topics (supergroup "Topics").** Telegram sends `message_thread_id` on
   messages in topic-enabled supergroups. Model each topic as its own
   conversation/sub-thread so the inbox doesn't merge unrelated topics.
   - Ingest: capture `message.message_thread_id` (and `is_topic_message`).
   - Storage: extend the DM conversation key for telegram groups from
     `<channelId>:<chatId>` to `<channelId>:<chatId>:<threadId>` (threadId
     optional — absent for non-topic groups, preserving current behaviour).
   - Topic name: `forum_topic_created` service messages carry the topic name;
     ingest and store it as the conversation display name.

2. **Reply-context rendering.** Use the already-stored `platformParentId`
   (`reply_to_message.message_id`) to show a quoted snippet of the parent
   message above a reply bubble (Telegram/Slack pattern). Backend already has
   the data; this is mostly a frontend `dm-thread` enhancement.

3. **Group conversation metadata.** Replace the adapter's hardcoded
   `"Telegram group"` participant label with the real group title (available on
   `my_chat_member` / message `chat.title`). Store group title on the binding
   row or channel metadata; surface in `listConversations` + the conversation
   header.

4. **Outbound replies in topics.** When replying into a topic-threaded
   supergroup, pass `message_thread_id` to `sendMessage` so the reply lands in
   the correct topic, not the General channel.
   `TelegramService.sendMessage` already accepts an options object — add
   `messageThreadId`.

5. **(Optional) reply-to a specific message.** Wire the existing
   `replyToMessageId` option through `TelegramDmAdapter.sendDm` so inbox replies
   can quote a specific group message.

## Out of scope (explicit)

- Reactions ingest/send (Bot API reaction support is limited).
- Typing/presence indicators (not exposed to bots).
- Per-member read receipts (not exposed).
- Channel (broadcast) support — only group/supergroup, matching the binding
  schema which excludes `channel`.

## Data model changes (anticipated)

- `telegram_chat_bindings`: add `title varchar` (group display name) — nullable,
  backfilled from the next message's `chat.title`.
- No new table needed for topics if the conversationId composite key approach is
  used; if topics need richer metadata (name, icon), consider a
  `telegram_group_topics` table keyed by `(binding_id, message_thread_id)`.

## Risks / notes

- Composite conversationId change must stay backward compatible: existing group
  rows have `conversationId = <chatId>`; the migration/logic should treat a
  missing threadId as the group's "General" topic so no history is orphaned.
- Topic detection requires the supergroup to have Topics enabled; most groups
  don't. The non-topic path must remain the default and unchanged.
- Frontend `INBOX_DM_PLATFORMS` already includes `telegram`; group threading is
  additive rendering, no gating change.

## References

- Current ingest: `src/inbox/processors/telegram-ingest.processor.ts`
- Adapter: `src/inbox/adapters/telegram-dm.adapter.ts`
- Bot API: `getUpdates` message fields `message_thread_id`, `is_topic_message`,
  `forum_topic_created`; `sendMessage` param `message_thread_id`.
