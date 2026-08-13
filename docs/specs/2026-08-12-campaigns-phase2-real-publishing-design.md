# Campaigns Phase 2 — Real Publishing (Design)

**Date:** 2026-08-12
**Repos:** `socialmedia-workspace` (backend, primary) + `socialmedia-frontend-campaigns` worktree (frontend, later)
**Branch:** `feat/campaigns-backend` (backend). Frontend swap on its campaigns branch, after backend + user approval.
**Status:** Spec — approved in discussion, ready for implementation plan
**Builds on:** Phase 1 (`docs/specs/2026-08-09-campaigns-backend-persistence-design.md`) — persistence + CRUD. This phase makes `launch` actually publish.

## Goal

Turn a launched campaign from a status-flip into real posts. Today `launch/pause/
resume` only flip `campaigns.status`; nothing is scheduled or published. Phase 2
wires each filled campaign slot to the EXISTING publishing engine so a launched
campaign produces real, scheduled platform posts — and pause/resume actually
control them.

## Core principle — reuse, don't rebuild

There is a blessed reuse seam and an existing precedent:

- **`PostService.publishPost(postId, workspaceId, createdById, opts)`** is the
  engine's real entry point. It owns token decrypt/refresh, rate limiting,
  per-target fan-out, status transitions, `post_history`, and the SSE
  `post.status.changed` event. `PublisherFactory` is one level below and must NOT
  be called directly.
- **`src/drips/` already does exactly this:** for each scheduled occurrence it
  builds `targets`/`platformContent`, inserts a real `posts` row (with a
  `metadata.dripCampaignId` marker), links it back, then calls `publishPost` and
  maps the returned status. **Campaigns Phase 2 mirrors this pattern.**
- The existing `PostPublishProcessor` (`@Processor(QUEUES.POST_PUBLISHING)`)
  consumes `{ postId }` jobs and calls `publishPost`. **Campaign posts reuse the
  same queue + processor — no new processor.**

So Phase 2 adds NO new publishing engine. It adds: per-slot scheduling state, a
launch→materialize→enqueue flow, a slot↔post status sync, and real metrics.

## Scope

**In scope (Phase 2)**
- Schema: per-slot scheduling/result columns on `campaign_slot_content` (+ optional
  campaign-level counters left computed-on-read).
- `launch`: preflight validation → materialize a `posts` row per publishable slot →
  enqueue on `POST_PUBLISHING` with `delay` → record `postId`/`jobId`/`scheduledAt`/
  `status` on the slot.
- `pause`/`resume`/`cancel`: remove/re-enqueue future (not-yet-published) slot jobs.
- Slot↔post status sync so per-slot `status`/`publishedAt`/`platformPostId`/
  `lastError` reflect the real publish outcome.
- Real `computeMetrics` from slot statuses (replaces hardcoded zeros).
- Posts-list pollution guard: campaign-materialized posts carry `metadata.campaignId`
  and are filtered out of the normal composer post list (shown on the calendar with a
  campaign badge, mirroring drips).
- **Bulk (Simple) campaigns only** for the schedule → time computation.
- Timezone honored in slot-time computation (fixes Phase 1's `computeNextRun`
  `TODO(phase-2)` server-local-time gap).

**Out of scope (later)**
- **Phase 3 — real AI generation.** AI slots that are not `approved` are SKIPPED at
  launch (not generated). Autopilot generation/approval notifications stay deferred.
- **drip / evergreen schedule types** and any always-running "daily scanner" cron —
  bulk campaigns are fixed-date, so upfront materialization suffices. Revisit a cron
  only when evergreen/infinite-loop campaigns are built.
- New user-facing notifications on publish/fail — the engine emits only the SSE
  `post.status.changed` event today; campaigns inherit that, nothing new added.

## Background & Constraints (verified)

- Reuse seam + drips precedent as above (verified in code 2026-08-12).
- Slot→channel: `campaign_slot_content.channelId` is a **stringified numeric**
  `socialMediaChannels.id`. `refreshChannelCache` already coerces via `Number()` and
  looks up `socialMediaChannels` for the `platforms` cache — publishing resolves
  platform + token the same way. Tokens (`accessToken`/`refreshToken`) live on the
  channel row; `ChannelService.getAccessToken` does JIT refresh at publish time.
- `PostTarget.channelId` in the `posts.targets` JSONB is a stringified numeric id
  (`parseInt`-ed before publish) — keep that convention when building targets.
- Backend patterns: Service-Controller-Module; `class-validator` DTOs + global
  `ValidationPipe`; Drizzle schema in `src/drizzle/schema/`; BullMQ via
  `QUEUES.POST_PUBLISHING` (attempts 3, exponential backoff). Auth `JwtAuthGuard` +
  `@CurrentUser()`.
- **No migration file committed to the branch** (Phase 1 lesson: `db:generate`
  bundles unrelated pre-existing drift). Ship the schema file only; the columns are
  applied to the target DB out-of-band before go-live.
- **No push / no PR / no merge** without explicit user request. Never `git add -A`;
  the frontend `.env` is git-tracked with secrets — surgical staging only. Never run
  a `db:*`/migration command.

## Architecture

### Data model additions — `campaign_slot_content`

Add per-slot scheduling + result columns (all nullable / defaulted so existing rows
are valid):

- `scheduledAt timestamptz` — computed publish time for this slot (null until launch)
- `slotStatus varchar(20)` default `'pending'` — one of
  `pending | scheduled | publishing | published | failed | skipped`
- `postId uuid` (nullable, FK→posts set null) — the materialized post for this slot
- `jobId varchar(120)` (nullable) — BullMQ job id (for cancel/reschedule)
- `publishedAt timestamptz` (nullable)
- `lastError text` (nullable)

`campaigns` table: no new stored counters — metrics stay computed-on-read from slot
statuses (no drift). A `launchedAt timestamptz` may be added for display.

### Launch flow (`campaigns.service.launch`)

Replaces the status-only flip:

1. **Preflight** (throws `BadRequestException` with a clear message on failure):
   - at least one publishable slot exists (filled, non-skipped day, not an
     unapproved AI slot);
   - every referenced channel resolves to a connected `socialMediaChannels` row;
   - reject relaunch of a campaign that already has live scheduled jobs (idempotency).
2. For each **publishable** slot (filled + day not skipped + not AI-pending):
   - compute `scheduledAt` from `campaigns.schedule` honoring `timezone`,
     `perDayTimes ?? defaultTime`, `skipWeekends`, `blackoutDates`;
   - build `targets` (single target: the slot's channel, stringified numeric id) +
     `platformContent` from the slot `content` (caption/media/threadParts/poll/
     platformSpecific);
   - insert a `posts` row: `status: 'scheduled'`, `scheduledAt`, `metadata.campaignId`
     (+ `metadata.campaignSlot: {date, channelId}`);
   - enqueue on `POST_PUBLISHING` with `delay = scheduledAt - now` and a unique
     `jobId` (`campaign-<campaignId>-<date>-<channelId>`);
   - update the slot: `postId`, `jobId`, `scheduledAt`, `slotStatus: 'scheduled'`.
   - A slot whose `scheduledAt` is already in the past is either published-now or
     marked `skipped` with a reason (decision: **skip past-due slots** at launch and
     surface the count — don't silently back-date).
3. Campaign `status → 'active'`, set `launchedAt`.

### Publish execution — existing engine

Campaign posts flow through the **existing** `PostPublishProcessor` unchanged (same
`{ postId }` job, same `publishPost`). No campaign processor.

### Slot ↔ post status sync

The engine already emits `post.status.changed` (via `AnalyticsEventEmitter`) on
`publishing` and final status. Add a small campaign listener that, for a post carrying
`metadata.campaignId`, writes the outcome back to the matching slot row
(`slotStatus`, `publishedAt`, `platformPostId` from the target, `lastError`). This
keeps campaign metrics/UI truthful without polling. (If a listener seam is awkward,
the equivalent write can be done inline in `publishPost`'s finalizer guarded by the
`campaignId` marker — the plan picks the cleaner of the two after inspecting the
emitter wiring.)

### Pause / Resume / Cancel

- **Pause:** for every slot still `scheduled` (job not yet run), remove its BullMQ job
  (`queue.getJob(jobId).remove()`), set `slotStatus → 'pending'`, and set the linked
  post back to `draft`/removed so it won't publish. Already-`published`/`publishing`
  slots untouched. Campaign `status → 'paused'`.
- **Resume:** re-enqueue every `pending` future slot (recompute delay; past-due →
  skip), set `slotStatus → 'scheduled'`. Campaign `status → 'active'`.
- **Auto-complete:** when no slot remains `scheduled`/`publishing`, campaign
  `status → 'completed'`.
- **Cancel:** Phase 1's `CAMPAIGN_STATUSES` has no `cancelled` value, so Phase 2 does
  NOT add one. "Cancel" = pause (remove all future jobs) followed by the existing
  `remove()` delete. No new status enum value in this phase.

### Metrics (real, computed-on-read)

`computeMetrics` counts slot statuses: `postsScheduled`, `postsPublished`,
`postsFailed`, `postsSkipped`, `postsPlanned` (total publishable). No stored counter.

### Posts-list pollution guard

Campaign-materialized posts carry `metadata.campaignId`. The normal post-list query
(`getWorkspacePosts`) and composer views filter these out (mirroring how drip posts
are handled). The calendar still shows them, tagged with a campaign badge, so the
user sees campaign activity in context without cluttering the composer list.

## Error handling

- Launch preflight failures → `400` with a specific message (empty campaign, no
  connected channel, unapproved AI slot count, already-launched).
- A channel that can't publish at runtime → the engine writes that target `failed`
  and the post becomes `failed`/`partially_published`; the slot sync reflects
  `failed` + `lastError`. Campaign continues; metrics show the failure.
- Past-due slots at launch → `skipped` with a surfaced count, never back-dated.
- Timezone: compute in the campaign's `schedule.timezone`; a missing/invalid tz falls
  back to UTC with a logged warning (never silently server-local).
- BullMQ retry/backoff is inherited (attempts 3, exponential) — no campaign-specific
  retry layer.

## Testing

- **Service unit (Jest):** launch materializes N posts + enqueues N jobs (mock queue +
  `publishPost`); preflight rejects empty / disconnected-channel / already-launched;
  pause removes future jobs and resets slots; resume re-enqueues; past-due slot →
  skipped; timezone-correct `scheduledAt`; `computeMetrics` reflects slot statuses;
  slot-sync writes outcome from a `post.status.changed` payload.
- **Reuse:** the publish path itself is already covered by existing post tests — only
  the campaign-specific wiring (materialize/enqueue/sync) is new.
- **Frontend (later):** launch/pause show real per-slot status badges + live metrics;
  calendar shows campaign posts with a badge; composer list excludes them.
- **Full-stack (CLAUDE.md rule 4):** backend `npm run build` + `npm run test` green;
  frontend `npm run build` green when the FE slice lands.

## Sequencing

1. **Backend first** (this spec): schema columns → launch materialize+enqueue →
   pause/resume/cancel → slot-sync → real metrics → tests. All on
   `feat/campaigns-backend`.
2. **Then, with user approval** (CLAUDE.md workflow rule): frontend slice — surface
   per-slot statuses, real metrics, calendar badge, composer-list exclusion — on the
   campaigns frontend branch.

## Risks

- **Timezone correctness across the three schedule shapes.** Bulk-only scope limits
  blast radius; a single tz helper is unit-tested against DST edges.
- **Double-enqueue on relaunch.** The idempotency preflight (reject if live jobs
  exist) + deterministic `jobId` per (campaign,date,channel) prevent duplicates.
- **Slot↔post sync drift.** Reconciled on read where possible (slot can also derive
  status from its linked post if the event was missed); the listener is the fast path,
  the post row is the source of truth.
- **Posts-list pollution.** Marker + filter mirrors the proven drips approach; the
  risk is a missed filter site — enumerate composer/list/calendar queries in the plan.
- **DB columns applied out-of-band.** Same operational step as Phase 1 (no migration
  in branch); the plan calls it out explicitly as a go-live prerequisite.
