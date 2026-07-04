# Threads App Review Features — Design Spec

**Date:** 2026-07-04
**Branch:** `feat/threads-app-review` (both repos: `socialmedia-workspace` backend, `socialmedia-frontend` frontend)
**Author:** Schedura team

## Goal

Make three Threads (Meta) capabilities fully implemented and demonstrable so they can be submitted for Meta App Review with a convincing per-permission screencast:

1. **`threads_manage_mentions`** — a Mentions feed (read + reply) inside the existing Inbox. Currently absent end-to-end.
2. **`threads_manage_replies` (hide half)** — hide/unhide replies on the user's Threads posts. Reply already works; hide is missing.
3. **`threads_manage_insights`** — Threads analytics. Backend adapters + frontend dashboard already exist, but the OAuth scope is never requested (a Slack-style scope↔feature mismatch). Fix the scope and verify end-to-end.

`threads_delete` is **out of scope** (dead code today; will be trashed in the Meta App Review request, not implemented here).

## Background — current state (from audit)

- **OAuth scopes requested today (backend `channels.schema.ts` `PLATFORM_CONFIG.threads.oauthScopes`):** `threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies` — 4 total. NOT requested: `threads_manage_insights`, `threads_manage_mentions`, `threads_delete`.
- **Threads is comments-only in the inbox:** `InboxDispatcher` registers `['threads', threads]` in the comment-adapter map with no DM adapter (Threads has no DM API). Frontend `INBOX_COMMENT_PLATFORMS` includes `'threads'`; `INBOX_DM_PLATFORMS` excludes it.
- **Publishing + read-replies + reply are BUILT** (`ThreadsPublisher`, `ThreadsService.getThreadConversation`, `ThreadsInboxAdapter.replyToComment`/`commentOnPost`).
- **Insights code exists but is unscoped:** `ThreadsService.getThreadInsights` + `src/channels/analytics/adapters/threads/*` (`ThreadsAnalyticsAdapter`) are wired and driven by the snapshot scheduler; frontend Insights dashboard already maps `threads`. Channel creation even sets `capabilities.canReadAnalytics: true` while the scope is not requested — a direct mismatch.
- **Mentions absent:** the `src/community/` mentions module registers only a Twitter provider; no Threads mentions code or UI exists. Sidebar nav copy mentions "mentions" aspirationally only.
- **`THREADS_CLIENT_ID` / `THREADS_CLIENT_SECRET`** are read in `oauth.service.ts` but undocumented in `.env.example`.

## Confirmed Threads API endpoints

- **Hide/unhide reply:** `POST /{THREADS_REPLY_ID}/manage_reply` with `hide=true|false` (+ `access_token`). Hiding automatically hides all nested replies. Permission: `threads_manage_replies`.
- **Media (per-post) insights:** `GET /{threads-media-id}/insights?metric=views,likes,replies,reposts,quotes,shares`. Permission: `threads_manage_insights` (+ `threads_basic`).
- **User (account) insights:** `GET /{threads-user-id}/threads_insights?metric=views,likes,replies,reposts,quotes,clicks,followers_count,follower_demographics` with optional `since`/`until` Unix timestamps. Data only available on/after 2024-04-13 (`1712991600`); `follower_demographics` needs 100+ followers.
- **Mentions:** governed by `threads_manage_mentions`, documented on a dedicated Threads API sub-page. Exact endpoint path + response fields + any rolling-window/public-only limitation MUST be pinned during the writing-plans phase against the official docs before implementing feature 1. See Risks.

## Scope

**In scope**
- Mentions feed (read + reply) as a new Inbox tab, backed by ingestion into `inboxItems` as a new `type='mention'`.
- Hide/unhide reply action for Threads (backend `manage_reply` + inbox adapter + controller + frontend action).
- Add `threads_manage_insights` + `threads_manage_mentions` to the requested OAuth scopes; verify the existing insights pipeline end-to-end on a live token.
- Graceful degradation for channels connected before the new scopes (missing-scope calls must not crash; surface a "reconnect for this feature" state).
- Document `THREADS_CLIENT_ID` / `THREADS_CLIENT_SECRET` in `.env.example`.

**Out of scope**
- `threads_delete` (leave existing dead code untouched; trash the scope in Meta App Review).
- Reply-permission controls ("who can reply") — already set at compose time in `threads-panel.tsx`.
- Any new insights UI beyond verifying the existing dashboard renders Threads data.

## Feature 1 — Mentions (Inbox tab, read + reply)

**Backend**
- Add `threads_manage_mentions` to `PLATFORM_CONFIG.threads.oauthScopes`.
- `ThreadsService.getMentions(userId, accessToken, paging?)` — fetch posts where the connected account is @mentioned; map to a normalized shape (`externalId`, `authorUsername`, `text`, `permalink`, `timestamp`, `mediaType`).
- Ingest mentions into the existing `inboxItems` table with a new discriminator value `type='mention'` (reuse the DM/comment plumbing; a mention is a first-class inbox item so the existing list/thread UI can render it). Confirm the exact discriminator column and enum during planning by reading `inboxItems` schema.
- Extend the inbox poller (`inbox-poll.scheduler.ts`) to poll Threads mentions for each connected Threads channel, deduped by external id.
- **Reply** reuses `ThreadsInboxAdapter.replyToComment` / `commentOnPost` (a reply to a mention is a `createTextThread` with `reply_to_id` = the mention's thread id) — no new publish path, uses `threads_content_publish`.

**Frontend**
- New **Mentions** tab in the inbox next to DMs/Comments; add `INBOX_MENTION_PLATFORMS = ['threads']` in `src/features/inbox/constants.ts`.
- Reuse `conversation-list.tsx` + thread view + `rich-reply-composer.tsx`; add a mentions segment to the inbox query in `inbox.api.ts` / the inbox view.
- Sidebar "mentions" copy becomes real.

## Feature 2 — Hide/unhide replies

**Backend**
- `ThreadsService.manageReply(replyId, hide, accessToken)` → `POST /{replyId}/manage_reply`.
- Implement `setCommentHidden(commentId, hidden)` on `ThreadsInboxAdapter`; expose via the inbox service + a controller endpoint (e.g. `POST inbox/.../comments/:id/hide`).
- Persist `isHidden` on the inbox item so the UI reflects state without a refetch.

**Frontend**
- Per-reply **Hide / Unhide** action in `comment-thread.tsx` (shadcn dropdown-menu or button) with optimistic update + toast + error rollback.
- Gate the action to platforms that support hide (Threads now; others later).

## Feature 3 — Insights (scope fix + verify)

**Backend**
- Add `threads_manage_insights` to `PLATFORM_CONFIG.threads.oauthScopes`; the existing `canReadAnalytics: true` now matches a requested scope.
- Verify `ThreadsService.getThreadInsights` and the `ThreadsAnalyticsAdapter` (`fetchProfileSnapshot` / `fetchPostMetrics` / `fetchRecentPosts`) succeed on a live token with the new scope. Fix anything broken surfaced by the live run.

**Frontend**
- Verify the Insights dashboard renders real Threads snapshots (follower count, per-post metrics). No new UI unless a gap surfaces.

## Shared — scopes, reconnect, degradation, config

- `oauthScopes` for Threads goes 4 → 6: add `threads_manage_mentions`, `threads_manage_insights`.
- **Existing connected Threads channels must reconnect** to receive the new scopes; surface this clearly (reconnect CTA / feature-locked state), do not silently fail.
- **Graceful degradation:** insights/mentions/hide calls made with a token lacking the scope must be caught and turned into a "reconnect to enable" state (mirror the Slack missing-scope degradation pattern), never an unhandled 500.
- Add `THREADS_CLIENT_ID` and `THREADS_CLIENT_SECRET` to `.env.example` with a short comment.

## Error handling

- All new Graph calls: on `missing_scope` / permission errors, degrade to the reconnect state rather than throwing.
- Mentions poller: a failing fetch for one channel must not break polling for others (isolate per channel, log, continue).
- Hide/unhide: optimistic UI rolls back on API error and shows a toast.

## Testing

- **Backend unit tests:** `getMentions` response parsing → normalized shape; `manageReply` request shape; insights metric mapping; adapter `setCommentHidden` state transition; missing-scope degradation path.
- **Live verification (also produces the App Review screencasts):** connect a Threads account with the 6 scopes, then confirm — a mention ingests into the Mentions tab and can be replied to; a reply can be hidden/unhidden and reflects on Threads; the Insights dashboard shows real Threads metrics.

## Risks

- **Mentions API shape/limits unknown.** The exact endpoint, fields, and any rolling-window or public-only constraint must be pinned against the official Threads mentions sub-page during writing-plans. If the API returns materially less than a usable feed, feature 1's design is revisited (features 2 and 3 are independent and proceed regardless).
- **Reconnect friction.** New scopes require every existing Threads channel to reconnect; must be communicated in-product.

## Rollout

- Branch `feat/threads-app-review` on both repos (already created off `main`).
- **Backend-first, then frontend** per repo rules, with a checkpoint before starting the frontend.
