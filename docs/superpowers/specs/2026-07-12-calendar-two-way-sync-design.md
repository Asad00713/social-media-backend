# Calendar Two-Way Sync — Design Spec

**Date:** 2026-07-12
**Branch:** `feat/calendar-integrations` (continues the calendar module — connect work already on this branch)
**Status:** Approved-by-delegation (user authorized autonomous, research-driven decisions)

## Goal

Close the calendar module in one pass: scheduled posts automatically appear as events on the user's connected Google/Outlook calendar (app→calendar), external changes flow back (calendar→app), the user's *other* calendar events are pulled in read-only for a unified view, and everything stays fresh via provider webhooks plus a periodic reconciliation/renewal poll.

## Context (already shipped, on this branch)

- Connect for `google_calendar` + `outlook_calendar` (Mode-A OAuth auto-create → a `social_media_channels` row per provider per workspace, `accountType: 'storage'`, tokens server-side).
- `GoogleCalendarService` + `OutlookCalendarService`: CRUD against provider APIs (list/create/update/delete/get/list events, calendars, verifyAccess). Return shapes normalized to a Google-shaped `CalendarEvent`/`Calendar` interface.
- Internal calendar UI: `CalendarItem` discriminated union (`kind: 'post' | 'message' | 'drip'`) aggregated from the app's own scheduled content. No third-party data yet.
- BullMQ + Redis present (queues: POST_PUBLISHING, TOKEN_REFRESH, DRIP_CAMPAIGNS).

## Locked decisions (industry-standard, researched 2026-07-12)

1. **Target calendar = the user's primary calendar; our events tagged, not siloed.** Post-events are written to the primary calendar with a **private extended property** (`schedura_post_id`, `schedura_workspace_id`) so we identify our own events reliably. Google: `extendedProperties.private`. Microsoft Graph: `singleValueExtendedProperties` (a named `String` property) — Graph has no `extendedProperties.private` equivalent. Two-way write-back only ever touches events carrying our tag.
2. **Unified display, source-badged.** External (untagged) events are pulled **read-only** and shown in the internal calendar as a new `kind: 'external'` card with the provider icon (Google/Outlook) + title/time. A filter toggles external events (and by provider). **v1 scope: the user's PRIMARY calendar only** — both our post-events and the external events we import live on the primary calendar, giving one delta stream per connection. Multi-calendar selection is a future enhancement.
3. **Move → reschedule; delete → unschedule.** Moving a tagged event reschedules the post; deleting a tagged event moves the post back to draft/unscheduled (never hard-deletes the post). Title/description edits do NOT change post content (post is authoritative for content).
4. **Conflict = last-write-wins by updated timestamp**, guarded by ETag / Graph `changeKey` optimistic concurrency (`If-Match`), with a stored per-link baseline (last-synced etag + updatedAt) to detect concurrent edits and **suppress echoes** (ignore a change whose etag/updatedAt equals what we last wrote).
5. **Webhooks + polling.** Provider push (Google `events.watch`, Graph subscription) → ping → incremental delta pull (`syncToken` / `deltaLink`). Plus repeatable BullMQ jobs: reconciliation poll (missed pings / 410-GONE resync) and subscription/channel renewal before expiry.

## Architecture (units)

### Data model — 3 new tables (Drizzle, `src/drizzle/schema/calendar-sync.schema.ts`)

- **`calendar_post_links`** — the two-way map between a scheduled post and its external event.
  `id, workspaceId, channelId (calendar connection), provider ('google'|'outlook'), postId, externalEventId, externalCalendarId, etag (last-known provider etag/changeKey), lastPushedHash (hash of the post state we last wrote → echo suppression), lastExternalUpdatedAt, syncStatus ('synced'|'pending'|'error'), lastError, createdAt, updatedAt`. Unique on `(channelId, postId)` and index on `(channelId, externalEventId)`.
- **`external_calendar_events`** — cached read-only external events for unified display.
  `id, workspaceId, channelId, provider, externalCalendarId, externalEventId, title, startsAt, endsAt, isAllDay, htmlLink, updatedAt (provider), raw (jsonb), fetchedAt`. Unique on `(channelId, externalEventId)`. Rows for events carrying our `schedura_post_id` tag are skipped (those are represented as posts, not external).
- **`calendar_sync_state`** — per-connection sync cursors + webhook lifecycle.
  `id, channelId (unique), provider, syncToken (Google) / deltaLink (Outlook), watchChannelId + watchResourceId + watchExpiration (Google), subscriptionId + subscriptionExpiration (Graph), lastFullSyncAt, lastIncrementalSyncAt, createdAt, updatedAt`.

**Migration:** generate a targeted migration for ONLY these 3 tables (or hand-write SQL and apply like the canva table), because the backend tree carries unrelated drift — do NOT run a broad `db:generate` that bundles foreign changes.

### Backend services (`src/calendar-sync/`, new module)

- **`CalendarSyncModule`** — wires the services below + registers BullMQ queues.
- **`CalendarPushSyncService`** (app→calendar) — on post lifecycle events, upsert/delete the external event via the existing provider services, writing the private tag, and maintain `calendar_post_links`. Called from post create/schedule/update/delete/publish paths (hook via an event emitter or direct calls in `PostService` — see Data flow).
- **`CalendarPullSyncService`** (calendar→app + external import) — runs an incremental delta pull for a connection: (a) for tagged events, apply move→reschedule / delete→unschedule to the post with conflict resolution; (b) for untagged events, upsert/delete `external_calendar_events`. Advances `syncToken`/`deltaLink`; on 410-GONE / invalid delta, full resync.
- **`CalendarWebhookService`** + a controller — provider push endpoints (`POST /calendar-sync/webhooks/google`, `POST /calendar-sync/webhooks/outlook`). Validate (Google channel token/id; Graph `validationToken` handshake + `clientState`), then enqueue a reconcile job for the mapped connection. Never trust payload contents — always delta-pull.
- **`CalendarSubscriptionService`** — create the Google watch channel + Graph subscription on connect; renew before expiry; tear down on disconnect.
- **BullMQ processors** — `CALENDAR_RECONCILE` (per-connection delta pull; enqueued by webhook ping + by the repeatable poll), `CALENDAR_RENEWAL` (repeatable; renews channels/subscriptions nearing expiry), and reuse for retries with backoff.

### Conflict resolution + echo suppression (the core correctness unit)

- Every write we make to a provider records `etag` + `lastPushedHash` (hash of {startsAt, endsAt, summary} we wrote) on the link.
- On pull, for a tagged event: if `event.etag === link.etag` OR `hash(event) === link.lastPushedHash` → it's our own echo, skip. Else compare `event.updated` vs the post's `updatedAt`: newer side wins (LWW). If external wins → reschedule/unschedule the post; if app wins → re-push (guarded by `If-Match` on the stored etag; on 412 Precondition Failed, re-fetch and re-resolve).
- All provider writes use `If-Match` where supported so we never silently clobber a concurrent external edit.

### Frontend (`src/features/calendar/`)

- Extend `CalendarItem` union with `kind: 'external'` (id, provider, title, start, end, allDay, htmlLink). Pure adapter from the new `GET /calendar-sync/workspaces/:wsId/external-events?from&to` endpoint.
- New **external event card** (read-only): provider icon (reuse `GoogleCalendarLogo`/`OutlookCalendarLogo`) + title + time; click opens `htmlLink` in a new tab. Visually distinct (muted, "from your calendar" affordance).
- Calendar filter popover: add "External events" toggle + per-provider sub-toggles.
- Post-events already render as `kind: 'post'`; a small "synced to calendar" indicator when a post has a `calendar_post_links` row (optional, from post payload).
- No new connect UI (connect already shipped). Sync is automatic once connected.

## Data flow

- **app→calendar:** post scheduled/updated/deleted → `CalendarPushSyncService` upserts/deletes the event on each connected calendar for the workspace, tags it, updates `calendar_post_links`. On connect, a **backfill** enqueues push for all currently-scheduled posts.
- **calendar→app (push path):** provider ping → webhook validates → enqueue `CALENDAR_RECONCILE(channelId)` → `CalendarPullSyncService` delta-pulls → applies tagged-event changes to posts (LWW) + upserts external events.
- **calendar→app (poll path):** repeatable `CALENDAR_RECONCILE` every N minutes per active connection (safety net) + `CALENDAR_RENEWAL` keeps subscriptions alive.

## Error handling

- Provider token expiry → reuse existing refresh (channel tokens); on hard-auth-fail mark the connection needs-reconnect and stop sync jobs for it.
- 410 GONE (Google syncToken) / invalid deltaLink → full resync from a fresh token.
- 412 Precondition Failed → re-fetch + re-resolve.
- Webhook validation failure → 202/ignore; rely on poll.
- All jobs idempotent + retried with backoff (BullMQ). Per-connection failures isolated (one bad connection doesn't stall others).
- Rate/quota: delta pulls are cheap (changes only); reconcile interval tuned (default 15 min) to bound API volume; webhooks reduce poll need.

## Testing

- Unit: conflict-resolution decision fn (echo/LWW/precondition) with a truth table; the post↔event mappers (post → Graph/Google event body incl. tag; provider event → external-event row); delta cursor advancement + 410 fallback.
- Unit: webhook validation (Graph handshake, Google token check).
- Frontend: pure adapter for `kind: 'external'`; filter logic.

## Scope / phasing (single branch, sequenced tasks)

1. Schema + migration (3 tables) + `CalendarSyncModule` skeleton + queues.
2. app→calendar push service + post-lifecycle hooks + backfill-on-connect + tagging.
3. Pull service: external-events import (read-only) + delta cursors + full-resync fallback.
4. Pull service: tagged-event two-way (move→reschedule, delete→unschedule) + conflict/echo engine.
5. Webhooks (Google watch + Graph subscription) + validation controller + subscription create/renew/teardown + repeatable poll + renewal jobs.
6. Frontend: `kind: 'external'` union + adapter + external card + filter toggles + optional "synced" indicator.

## Out of scope (explicitly)

- Editing external (non-post) events from our app (read-only import).
- Syncing post *content* from calendar edits (only time + existence).
- Recurring-event expansion authored in the external calendar mapping to posts (external recurring events display read-only fine; we don't create recurring post-events).
