# Calendar Two-Way Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax. Each task ends with a compiling, testable deliverable.

**Goal:** Scheduled posts sync to the user's connected Google/Outlook primary calendar (app→calendar), external changes flow back (move→reschedule, delete→unschedule), the user's other calendar events import read-only into a unified calendar view, kept fresh by provider webhooks + periodic reconciliation/renewal jobs.

**Architecture:** New `CalendarSyncModule` (NestJS) with push + pull sync services that reuse the existing `GoogleCalendarService`/`OutlookCalendarService`, backed by 3 new Drizzle tables and BullMQ jobs. Provider webhooks enqueue per-connection reconcile jobs that run incremental delta pulls; a repeatable poll + a subscription-renewal job provide the safety net. Conflict resolution is last-write-wins by updated timestamp with etag/`If-Match` guards + echo suppression.

**Tech Stack:** NestJS, Drizzle (Postgres, `platform`/ids are existing conventions), BullMQ + Redis, Google Calendar API v3, Microsoft Graph, Vite+React+shadcn frontend.

## Global Constraints

- **Branch:** `feat/calendar-integrations` (continues the calendar module; connect work is its foundation).
- **No broad migration.** Backend tree carries ~46 unrelated dirty files. Generate/apply a migration for ONLY the 3 new tables, or hand-write + apply targeted SQL (as done for `canva_connections`). NEVER `git add -A`; stage only calendar-sync files. Never stage `.env`.
- **Reuse, never re-author** `GoogleCalendarService`/`OutlookCalendarService`/`ChannelService`/`PostService` — extend with additive methods only (e.g. an optional tag arg on createEvent).
- **Event ownership tag:** every post-event we write carries private props `schedura_post_id` (the post id) + `schedura_workspace_id`. Google: `extendedProperties.private`. Microsoft Graph: a `singleValueExtendedProperties` entry with a fixed named GUID property. Two-way write-back only ever touches events carrying `schedura_post_id`.
- **Conflict = LWW by updated timestamp**, guarded by etag/changeKey `If-Match`; suppress echoes (skip an inbound change whose etag == the link's stored etag OR whose content-hash == the link's `lastPushedHash`).
- **v1 = PRIMARY calendar only** per connection (one delta stream). Multi-calendar is out of scope.
- **Delete semantics:** external delete of a tagged event → set the post back to draft/unscheduled; NEVER hard-delete the post. Title/description edits never change post content.
- **Idempotent, isolated jobs:** per-connection failures must not stall other connections; BullMQ retries with backoff; 410-GONE/invalid-delta → full resync.
- **Backend `platform` values:** calendar connections are channels with `platform` `'google_calendar'`/`'outlook_calendar'`, `accountType 'storage'` (already created by the connect flow). `provider` in sync tables is the short `'google'|'outlook'`.

---

## Task A — Schema (3 tables) + migration + CalendarSyncModule skeleton + queues

**Files:**
- Create: `src/drizzle/schema/calendar-sync.schema.ts` (3 pgTables + relations + inferred types).
- Modify: `src/drizzle/schema/index.ts` (barrel export the new schema).
- Create: `src/calendar-sync/calendar-sync.module.ts` (module skeleton, imports DrizzleModule/ChannelsModule as needed, registers BullMQ queues).
- Create: `src/calendar-sync/calendar-sync.constants.ts` (queue names, tag property keys, defaults).
- Migration: generate targeted SQL for the 3 tables OR hand-write `docs/... ` + apply to local DB.

**Interfaces produced:**
- Tables `calendarPostLinks`, `externalCalendarEvents`, `calendarSyncState` + `$inferSelect`/`$inferInsert` types.
- Constants: `CALENDAR_RECONCILE_QUEUE = 'calendar-reconcile'`, `CALENDAR_RENEWAL_QUEUE = 'calendar-renewal'`, `SCHEDURA_POST_ID_PROP = 'schedura_post_id'`, `SCHEDURA_WORKSPACE_ID_PROP = 'schedura_workspace_id'`, `GRAPH_POST_ID_PROP_ID = 'String {a1b2...} Name schedura_post_id'` (a fixed named MAPI property string), `DEFAULT_RECONCILE_INTERVAL_MS = 15*60*1000`.

**Schema (exact — mirror existing pgTable conventions in `src/drizzle/schema/*`; ids: uuid workspace/channel refs, bigserial pk like billing tables OR uuid — match the channels/canva convention which uses uuid pk defaultRandom for new tables):**

```ts
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, integer, unique, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';
import { socialMediaChannels } from './channels.schema';
import { posts } from './posts.schema';

export const calendarPostLinks = pgTable('calendar_post_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 20 }).notNull(), // 'google' | 'outlook'
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  externalEventId: varchar('external_event_id', { length: 512 }).notNull(),
  externalCalendarId: varchar('external_calendar_id', { length: 512 }),
  etag: varchar('etag', { length: 512 }),               // provider etag / changeKey
  lastPushedHash: varchar('last_pushed_hash', { length: 128 }), // hash of {start,end,summary} we last wrote
  lastExternalUpdatedAt: timestamp('last_external_updated_at'),
  syncStatus: varchar('sync_status', { length: 20 }).notNull().default('synced'), // synced|pending|error
  lastError: text('last_error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  uqChannelPost: unique('cpl_channel_post_uq').on(t.channelId, t.postId),
  ixChannelEvent: index('cpl_channel_event_ix').on(t.channelId, t.externalEventId),
}));

export const externalCalendarEvents = pgTable('external_calendar_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 20 }).notNull(),
  externalCalendarId: varchar('external_calendar_id', { length: 512 }),
  externalEventId: varchar('external_event_id', { length: 512 }).notNull(),
  title: text('title'),
  startsAt: timestamp('starts_at'),
  endsAt: timestamp('ends_at'),
  isAllDay: boolean('is_all_day').default(false).notNull(),
  htmlLink: text('html_link'),
  externalUpdatedAt: timestamp('external_updated_at'),
  raw: jsonb('raw'),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
}, (t) => ({
  uqChannelEvent: unique('ece_channel_event_uq').on(t.channelId, t.externalEventId),
  ixWorkspaceTime: index('ece_workspace_time_ix').on(t.workspaceId, t.startsAt),
}));

export const calendarSyncState = pgTable('calendar_sync_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().unique().references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 20 }).notNull(),
  syncToken: text('sync_token'),          // Google
  deltaLink: text('delta_link'),          // Outlook/Graph
  watchChannelId: varchar('watch_channel_id', { length: 255 }),      // Google push channel id
  watchResourceId: varchar('watch_resource_id', { length: 512 }),
  watchExpiration: timestamp('watch_expiration'),
  subscriptionId: varchar('subscription_id', { length: 255 }),       // Graph subscription id
  subscriptionExpiration: timestamp('subscription_expiration'),
  lastFullSyncAt: timestamp('last_full_sync_at'),
  lastIncrementalSyncAt: timestamp('last_incremental_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// relations: each references socialMediaChannels; add minimal relations() blocks.
export type CalendarPostLink = typeof calendarPostLinks.$inferSelect;
export type NewCalendarPostLink = typeof calendarPostLinks.$inferInsert;
export type ExternalCalendarEvent = typeof externalCalendarEvents.$inferSelect;
export type NewExternalCalendarEvent = typeof externalCalendarEvents.$inferInsert;
export type CalendarSyncStateRow = typeof calendarSyncState.$inferSelect;
export type NewCalendarSyncState = typeof calendarSyncState.$inferInsert;
```

- FIRST read an existing new-table schema (`canva.schema.ts`) + `posts.schema.ts` (confirm `posts` table name + `id` type is uuid; if posts pk is bigserial/int, change `postId` type to match — VERIFY before writing) + `index.ts` barrel to match conventions exactly.
- Migration: run `npm run db:generate` ONLY if it produces a migration touching solely these 3 tables; if it bundles drift, instead hand-write the `CREATE TABLE` SQL and apply to the local DB (like canva). Document the SQL in the task report.
- Module skeleton registers both queues via `BullModule.registerQueue({ name: CALENDAR_RECONCILE_QUEUE }, { name: CALENDAR_RENEWAL_QUEUE })` — mirror how `src/queue/`/existing modules register queues.

**Steps:** read conventions → write schema → barrel → constants → module skeleton → migration (targeted) → `npm run build` passes → commit calendar-sync schema+module files only.

---

## Task B — app→calendar push service + post-lifecycle hooks + backfill + tagging

**Files:**
- Create: `src/calendar-sync/services/calendar-push-sync.service.ts`.
- Create: `src/calendar-sync/calendar-sync.mapper.ts` (post → provider event body incl. tag; content hash).
- Modify: `src/channels/services/google-calendar.service.ts` + `outlook-calendar.service.ts` — extend `createEvent`/`updateEvent` to accept optional `privateProps?: Record<string,string>` and write them (Google `extendedProperties.private`; Graph `singleValueExtendedProperties`). Additive, backward-compatible.
- Modify: the post lifecycle path (find in `src/posts/services/post.service.ts` where a post is scheduled/updated/deleted/publish-status-changes) to call the push service (direct injection or an EventEmitter2 listener — prefer whatever the codebase already uses; if EventEmitter2 is present, emit `post.scheduled`/`post.updated`/`post.deleted` and listen in calendar-sync).
- Create: `src/calendar-sync/calendar-sync.controller.ts` (add `POST /calendar-sync/workspaces/:wsId/backfill` to enqueue push for all currently-scheduled posts of the workspace; called by the frontend after connect, and/or triggered in the connect callback).
- Test: `src/calendar-sync/calendar-sync.mapper.spec.ts` (mapping + hash + tag presence).

**Interfaces produced:**
- `CalendarPushSyncService.syncPost(postId): Promise<void>` (upsert event on every connected calendar of the post's workspace, maintain `calendar_post_links`), `.removePostEvent(postId): Promise<void>` (delete external events + links), `.backfillWorkspace(workspaceId): Promise<void>`.
- Mapper: `postToEventInput(post): { summary, startTime, endTime, privateProps }`, `contentHash(input): string`.

**Key logic:** for each active calendar channel in the post's workspace: if a link exists → `updateEvent(eventId, body, { ifMatch: link.etag, privateProps })`; else `createEvent(primaryCalendarId, body, { privateProps })` then insert link. Store returned `etag` + `lastPushedHash = contentHash(body)`. Only schedule/reschedule posts (has a future `scheduledAt`) produce events; publish-status change updates the event's status text; delete removes it.

**Steps:** read post.service scheduling path + provider createEvent/updateEvent → extend provider services with privateProps → write mapper + spec → write push service → hook lifecycle → backfill endpoint → `npm run build` + spec pass → commit.

---

## Task C — pull service: external-events read-only import + delta cursors + resync fallback

**Files:**
- Create: `src/calendar-sync/services/calendar-pull-sync.service.ts` (external-import half only in this task; two-way in Task D).
- Create: `src/calendar-sync/providers/google-delta.util.ts` + `outlook-delta.util.ts` (incremental list using syncToken/deltaLink; return `{ changed: NormalizedExternalEvent[], deleted: string[], nextCursor, needsFullResync }`).
- Modify: `google-calendar.service.ts`/`outlook-calendar.service.ts` — add a delta-list method if not present (Google `events.list({ syncToken })`; Graph `/me/calendarView/delta`), returning raw + next cursor; additive.
- Create: `src/calendar-sync/services/external-events.service.ts` (read side: `listExternalEvents(workspaceId, from, to)` for the frontend) + controller route `GET /calendar-sync/workspaces/:wsId/external-events?from&to`.
- Test: delta util specs (cursor advance, 410/invalid → needsFullResync; tagged events excluded from external import).

**Interfaces produced:**
- `CalendarPullSyncService.reconcile(channelId): Promise<void>` (this task: only imports external + advances cursor; Task D adds tagged-event handling).
- `ExternalEventsService.listExternalEvents(workspaceId, fromISO, toISO): Promise<ExternalEventDto[]>` where `ExternalEventDto = { id, provider, title, startsAt, endsAt, isAllDay, htmlLink }`.

**Key logic:** delta-pull the primary calendar; for each changed event WITHOUT `schedura_post_id` → upsert `external_calendar_events`; for deletions → delete the row; events WITH our tag are skipped here (handled in Task D). Persist `syncToken`/`deltaLink` to `calendar_sync_state`. On 410-GONE (Google) / invalid deltaLink (Graph) → clear cursor, do a bounded full list (e.g. now-30d … now+90d), repopulate, store fresh cursor.

**Steps:** read provider list methods → delta utils + specs → pull service (external half) → external-events read service + endpoint → build + specs pass → commit.

---

## Task D — pull service: two-way (move→reschedule, delete→unschedule) + conflict/echo engine

**Files:**
- Create: `src/calendar-sync/calendar-conflict.ts` (pure decision function + content hash reuse).
- Modify: `calendar-pull-sync.service.ts` — for changed events WITH `schedura_post_id`, run the conflict engine and apply to the post.
- Modify: `post.service.ts` — reuse its existing reschedule + set-to-draft methods (do NOT re-implement; find `reschedulePost`/`updateScheduledAt`/status transitions).
- Test: `src/calendar-sync/calendar-conflict.spec.ts` — truth table.

**Interfaces produced:** `resolveConflict({ link, externalEvent, post }): 'skip_echo' | 'apply_external' | 'repush_app' | 'noop'`.

**Conflict truth table (implement exactly):**
```
if externalEvent.deleted:                      -> 'apply_external' (unschedule post -> draft)
else if externalEvent.etag === link.etag
     || contentHash(externalEvent) === link.lastPushedHash:  -> 'skip_echo'
else if externalEvent.updated > post.updatedAt: -> 'apply_external' (reschedule post to event.start)
else:                                           -> 'repush_app' (re-write event from post, If-Match link.etag; on 412 refetch+re-resolve)
```
`apply_external` reschedule: update the post's `scheduledAt` to the event start (guard: future + >2min like the existing calendar reschedule rule). `apply_external` delete: move post to draft/unscheduled via post.service; then delete the link. After any apply, refresh `link.etag`/`lastExternalUpdatedAt`/`lastPushedHash`.

**Steps:** read post.service reschedule/draft methods → conflict fn + spec (truth table) → wire into pull service → build + spec pass → commit.

---

## Task E — webhooks (Google watch + Graph subscription) + validation + renewal/poll jobs

**Files:**
- Create: `src/calendar-sync/services/calendar-subscription.service.ts` (create/renew/teardown Google watch + Graph subscription; persist ids/expiry to `calendar_sync_state`).
- Create: `src/calendar-sync/calendar-webhook.controller.ts` — `POST /calendar-sync/webhooks/google` (validate `X-Goog-Channel-ID`/token vs stored; 200) + `POST /calendar-sync/webhooks/outlook` (echo `validationToken` on subscription-validation handshake; verify `clientState`; 202). Both enqueue `CALENDAR_RECONCILE` for the mapped channel. NEVER trust payload — always delta-pull.
- Create: `src/calendar-sync/processors/calendar-reconcile.processor.ts` (BullMQ; calls `CalendarPullSyncService.reconcile(channelId)`) + `calendar-renewal.processor.ts` (renews subscriptions/channels within the expiry window; recreates on failure).
- Create: `src/calendar-sync/calendar-sync.scheduler.ts` — register repeatable jobs: reconcile every `DEFAULT_RECONCILE_INTERVAL_MS` per active calendar channel; renewal check hourly. Mirror how existing repeatable/cron BullMQ jobs are registered in the repo (find TOKEN_REFRESH scheduling).
- Modify: connect callback / `CalendarSubscriptionService` invocation on connect (subscribe on connect) + disconnect (teardown). Hook where the calendar channel is created (`channels.controller.ts` Mode-A branch) and deleted (`useDisconnectChannel` backend delete path).
- Config: `API_PUBLIC_URL` for webhook callback base (reuse existing env used by TikTok/webhooks). Google push requires the callback host to be a verified domain; Graph requires HTTPS + validation handshake — document the ops prerequisite in the report.
- Test: webhook validation unit (Graph `validationToken` echo; Google channel-id match); subscription expiry-window logic.

**Interfaces produced:** `CalendarSubscriptionService.subscribe(channelId)`, `.renewDueSoon()`, `.teardown(channelId)`.

**Steps:** read existing BullMQ repeatable/cron registration + API_PUBLIC_URL usage → subscription service → webhook controller + validation specs → processors → scheduler → subscribe-on-connect / teardown-on-disconnect hooks → build + specs pass → commit.

---

## Task F — frontend: kind:'external' union + adapter + external card + filter toggles

**Files:**
- Modify: `src/features/calendar/types.ts` — add `kind: 'external'` variant to `CalendarItem` (`{ kind:'external'; id; provider:'google'|'outlook'; title; start; end; allDay; htmlLink }`).
- Create: `src/features/calendar/api/external-events.api.ts` — `getExternalEvents(workspaceId, fromISO, toISO)` → `ExternalEventDto[]` from `GET /calendar-sync/workspaces/:wsId/external-events`.
- Modify: `src/features/calendar/hooks/use-calendar-data.ts` — fetch external events (React Query) and adapt into the `CalendarItem[]` stream (pure adapter), gated by the filter.
- Create: `src/features/calendar/components/external-event-card.tsx` — read-only card: provider icon (`GoogleCalendarLogo`/`OutlookCalendarLogo`) + title + time; click → open `htmlLink` new tab. Visually muted/distinct; not draggable.
- Modify: the calendar item renderer + `calendar-filter-popover.tsx` — render `kind:'external'` via the new card; add an "External events" filter toggle (+ per-provider) to the filter state/store.
- Follow shadcn-only, theme tokens, responsive, existing calendar patterns.

**Interfaces consumed:** `GET /calendar-sync/workspaces/:wsId/external-events?from&to` (Task C).

**Steps:** read `types.ts` union + `use-calendar-data.ts` adapters + filter store + an existing item card → add union variant → api + query + adapter → external card → filter toggle + renderer branch → `npm run build` passes → commit.

---

## Self-review (run before final review)
- Every spec section maps to a task: schema→A, app→calendar→B, external import→C, two-way+conflict→D, webhooks/poll/renewal→E, frontend cards→F. ✅
- Tag property names consistent across B/C/D (`schedura_post_id`). Cursor fields consistent (syncToken/deltaLink) across C/E. Conflict fn signature consistent D. 
- No broad migration; targeted only. No `.env` staged. Provider services extended additively, not re-authored.
- Destructive path (delete→unschedule) never hard-deletes a post; flag for live validation before trusting in prod.
