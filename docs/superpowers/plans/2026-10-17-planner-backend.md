# Planner Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the redesigned Planner real data for every element: enriched calendar posts, drafts and the "ready" flag, duplicate, paged List, month counts, day notes, per-user preferences, campaign spans, all-calendar external events, per-post metrics and hourly best times.

**Architecture:** Additive, workspace-scoped endpoints. Post-shaped responses all go through one presenter (`PlannerPostDto`) that reads both per-target status fields, derives "partly published" once, and attaches a human failure reason. A new `PlannerModule` (`src/planner/`) holds the endpoints that are not post CRUD (list, counts, notes, preferences, best times); post CRUD additions stay in `PostsModule`. SQL-heavy code takes `@Inject(DRIZZLE)` so it can be proven against local Postgres inside a rolled-back transaction.

**Tech Stack:** NestJS 11, Drizzle ORM (PostgreSQL), BullMQ, class-validator, Jest + supertest (`*.spec.ts` co-located).

**Spec:** `D:/My Documents/MyProjects/FullStackProjects/socialmedia-frontend-shell/docs/superpowers/specs/2026-10-16-planner-redesign-design.md` (§7 backend, §7.5 best times; behaviour in §3, §4, §6, §8, §8.1). Branch `feat/planner-api`, worktree `D:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace-planner`, base main `1386103`.

**State of main (already merged, NOT in this plan):** spec §7.1 (role guards on every post, composer, campaign and drip route, plus Guest rules in `PostService`/`DraftStoreService`) and §7.2 (moved posts publish on time; retry skips published targets, `post.service.ts:569`). `POST /posts/workspaces/:ws/:postId/publish` is therefore already "retry only the failed channels"; no new retry endpoint.

## Global Constraints

Copied from the brief and the spec. Every task includes them.

- **Route guards:** every new workspace route uses `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` plus `@RequireCapability(...)`.
  - The test `src/workspace-members/every-workspace-route-guarded.spec.ts` fails CI otherwise. Never add to its allowlist.
  - Reads need `posts:draft`. Writes that schedule or publish need `posts:publish`. Note reads and preferences need `posts:draft`; note writes need `posts:publish` (spec §7.4). Marking a draft "ready" needs `posts:draft`, and Viewers may mark only their own drafts.
  - Exception already in the code: the metrics endpoint lives in `InsightsController`, whose class-level capability is `analytics:view` (GUEST+); keep it.
  - Adding a handler to `PostsController` or `CampaignsController` also means adding it to the `EXPECTED` table in `src/posts/workspace-guards.spec.ts` (that spec fails on a handler missing from the table).
- **Migrations:** each new table or column ships a Drizzle schema change plus a generated SQL migration in `drizzle/migrations/`, with the journal updated (`npm run db:generate`).
  - Never `db:push`. Never run against prod.
  - Local Postgres is in `.env` (localhost:5432/schedura). Migrations may be applied locally with `npm run db:migrate` for verification.
  - The prod journal has drifted before, so each migration must be idempotent (`IF NOT EXISTS`).
  - **Repo reality that overrides the three lines above** (`package.json:21-25`, `docs/migrations.md`): `db:generate`, `db:migrate` and `db:push` are wired to refuse, and `drizzle/migrations/meta/_journal.json` stops at idx 25. Migrations are hand-written numbered `.sql` files applied by the boot runner (`npm run build && npm run db:migrate:sql`); no journal edit exists or is needed. The local database has an EMPTY `applied_migrations` table, so `db:migrate:sql` locally would replay everything from `0000`. Verify a new migration instead with the rollback harness from Task 3 (applies only that file inside `BEGIN … ROLLBACK`, twice, to prove idempotency). Each migration still ships its Drizzle schema change in `src/drizzle/schema/`. Next free numbers: `0041` onward; renumber at merge if another branch took one (the runner orders by filename).
- **Timezone:** all date bucketing uses the WORKSPACE timezone (spec §4). `workspace.timezone` is free text: an invalid value falls back to UTC (`safeTimeZone`).
- **`draft_ready` notification:** marking a draft Ready notifies every MEMBER+ of the workspace with notification type `draft_ready`. The shell's Approvals tab filters on that type.
- **Testing:**
  - TDD; mutation-check one guard per task.
  - Hard-coded future dates in specs are time bombs: use relative dates or fake timers. (A pure function given explicit instants, e.g. a DST fixture, is not a time bomb; anything that compares to "now" injects the clock.)
  - Verify per task: `npx jest <touched>`, `npm run build`, eslint with no new errors versus `origin/main` on touched files.
  - The final task runs the full `npx jest` (known pre-existing failures: `billing.controller.spec`, `evergreen.service.spec`, `drizzle/pool-config.spec`, `stripe/price-provisioning.spec`) and a boot check: `PORT=3999 timeout 90 node dist/src/main.js` must log "Nest application successfully started" (Redis ECONNREFUSED is expected).
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Spec rules the code must honour:**
  - DTO names: every response type named in a task (`PlannerPostDto`, `PlannerCalendarDto`, `DraftsPageDto`, `PlannerListDto`, `MonthCountsDto`, `PlannerNoteDto`, `CampaignSpanDto`, `ExternalCalendarDto`, `BestTimesDto`, `PostChannelMetricsDto`) is created by the owning task with exactly the fields of the same-named contract interface at the end (the contract drops the `Dto` suffix, e.g. `PlannerPost`).
  - One table, two status fields: a post target is published when `targets[].status` OR `targets[].publishStatus` says `published` (spec §8.1.1). Never read only one.
  - A post counts once per (post, channel) for metrics; engagements = likes + comments + shares (`engagementsOf`, spec §7.5).
  - Keyset pagination compares at millisecond precision on one column type (`timestamptz`), selecting the sort key from SQL rather than recomputing it in JS (spec §7.4, "tz/precision trap").
  - Existing response fields keep their names and meaning; new fields are additive (the old Planner still calls `GET …/calendar` until the frontend PR merges).
  - Validation: global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`. Unknown body or query keys are a 400.
  - New workspace routes validate `:workspaceId` with `ParseUUIDPipe`. Prettier: single quotes, trailing commas.

**Per-task verification, referred to as "V":**
1. `npx jest <the task's spec files>`
2. `npm run build`
3. `npx eslint --no-fix <touched .ts files>`. For each touched file that exists on `origin/main`, compare against `git show origin/main:<file> | npx eslint --no-fix --stdin --stdin-filename <file>`; the error count must not rise. (`npm run lint` auto-fixes the whole repo: do not use it. Never `git stash` to compare.)

**Opt-in DB specs:** files named `*.db.spec.ts` use `describeDb` from Task 3 and run only with `PLANNER_DB_TESTS=1 npx jest <file>` against the localhost database; they are skipped otherwise, so CI is unaffected. Every task that writes raw SQL ships one.

## Review Focus

Failure modes the spec implies that no task's headline tests exercise. Each has its test in the named task.

1. **Invalid stored workspace time zone** (`workspace.timezone = 'Mars/Olympus'`): the calendar, month counts and best times behave as UTC, never a 500. Tests: Task 2 (`zonedClock`, `loadWorkspaceTimezone`) and Task 10 (month counts).
2. **A post id from another workspace** passed to ready, duplicate, single-post read or metrics: 404 / empty, never another tenant's data. Tests: Tasks 4, 6, 7, 17.
3. **Marking ready twice, and ready toggling touching "Edited"**: a second `ready: true` sends no second notification, and neither `ready: true` nor `false` changes `updated_at` (the Drafts panel shows "Edited 2h ago" and sorts on it). Test: Task 6.
4. **Best times with unmeasured or all-zero data**: posts with no snapshot are ignored, a channel median of 0 does not divide by zero, a channel with zero posts or a platform with no published research returns `source: 'general'` with `windows: []`, never invented numbers. Tests: Tasks 18, 19, 20.
5. **External events before the calendar backfill / all-day events**: `external_calendar_events` rows with `calendar_id IS NULL` still serialise (calendar fields fall back to the connection name, never throw), and an all-day event keeps its calendar date. Tests: Tasks 14, 15.

---

## File Structure

New code, by responsibility:

| Path | Responsibility |
|---|---|
| `src/posts/lib/post-status.ts` | Per-target and per-post derived status (reads both fields) |
| `src/posts/lib/post-failure.ts` | Human failure sentence + `needsReconnect` |
| `src/posts/lib/present-post.ts` | Pure: row + context → `PlannerPostDto`; `bucketByDate` |
| `src/posts/dto/planner-post.dto.ts` | `PlannerPostDto` and friends (the response contract) |
| `src/posts/dto/calendar-query.dto.ts`, `draft-ops.dto.ts` | Query/body validation |
| `src/posts/services/planner-posts.service.ts` | Loads authors, presents rows, calendar read, single-post read |
| `src/posts/services/post-drafts.service.ts` | Drafts page, ready flag, duplicate |
| `src/planner/planner.module.ts` + 4 controllers | List/counts, notes, preferences, best times routes under `planner/workspaces/:workspaceId` |
| `src/planner/services/*.ts`, `src/planner/lib/*.ts` | List, notes, preferences, best-times service; cursor, prefs, workspace-time, best-times maths, general-times table |
| `src/planner/testing/rollback-db.ts` | Rolled-back local-Postgres harness for `*.db.spec.ts` |
| `src/drizzle/schema/calendar-notes.schema.ts`, `planner-preferences.schema.ts` | New tables |
| `src/calendar-sync/services/external-calendars.service.ts` | Calendar discovery per connection; list for the API |
| `src/campaigns/lib/campaign-span.ts` | Pure span/cadence maths |
| `src/post-performance/engagement-stats.ts` | `median`, `isMeasured`, `usualMultiplier` (shared by metrics and best times) |
| `drizzle/migrations/0041_post_ready.sql` … `0044_external_calendars.sql` | Hand-written, idempotent |

---

### Task 1: Post status and failure helpers

**Files:**
- Create: `src/posts/lib/post-status.ts`, `src/posts/lib/post-failure.ts`
- Modify: `src/posts/composer/services/composer-error-mapper.service.ts`
- Test: `src/posts/lib/post-status.spec.ts`, `src/posts/lib/post-failure.spec.ts`; existing `composer-error-mapper.service.spec.ts` must still pass

**Interfaces:**
- Produces (`post-status.ts`):
  - `interface TargetLike { status?: string; publishStatus?: string }`
  - `targetStatusOf(target: TargetLike, postStatus: PostStatus): PostStatus`: published if either field says published; else failed if either says failed; else publishing if either says `publishing` or `retry_pending`, or `postStatus === 'publishing'`; else `scheduled` when `postStatus === 'scheduled'`; else `draft`.
  - `derivePostStatus(postStatus: PostStatus, targets: TargetLike[]): PostStatus`: `partially_published` when stored as such, or when `postStatus` is `published`/`failed` and the per-target statuses mix published with failed; otherwise `postStatus` unchanged. Never changes `draft`, `scheduled`, `publishing`.
- Produces (`post-failure.ts`):
  - `interface PostFailure { message: string; needsReconnect: boolean }`
  - `describeFailure(input: { platform: SupportedPlatform; errorCode?: PublishErrorCode; errorMessage?: string | null }): PostFailure`
- Modifies the mapper file: export `classifyPublishError(err: unknown): ClassifiedError` (the existing `classify` body) and make `ComposerErrorMapperService.classify` delegate to it. Add one rule: a message containing `token` together with `expired`, `revoked` or `invalid` classifies `auth_failed` (platform token errors otherwise fall to `permanent` and lose the Reconnect button).
- Platform name: `PLATFORM_CONFIG[platform].name` (`src/drizzle/schema/channels.schema.ts:436`).

- [ ] **Step 1: Write the failing tests**
  - `post-status.spec.ts`:
    - `targetStatusOf({ status: 'published' }, 'published')` is `'published'`; `({ status: 'draft', publishStatus: 'published' }, 'partially_published')` is `'published'` (composer drift); `({ status: 'failed', publishStatus: 'published' }, 'failed')` is `'published'` (the two fields disagree: published wins, so a retried-then-published channel is never shown as failed); `({ publishStatus: 'retry_pending' }, 'scheduled')` is `'publishing'`; `({}, 'scheduled')` is `'scheduled'`; `({}, 'draft')` is `'draft'`.
    - `derivePostStatus('published', [published, failed])` is `'partially_published'`; `('failed', [published, failed])` is `'partially_published'`; `('partially_published', [failed, failed])` stays `'partially_published'`; `('published', [published, published])` stays `'published'`; `('publishing', [published, failed])` stays `'publishing'`; `('scheduled', [])` stays `'scheduled'`; `('failed', [failed])` stays `'failed'`.
  - `post-failure.spec.ts` pins these exact strings (`<P>` = platform display name):
    - `auth_failed`: `"<P> logged you out. Reconnect, then retry. Nothing was posted."`, `needsReconnect: true`. Same result from `errorMessage: '401 Unauthorized'` with no code, and from `'The access token has expired'`.
    - `rate_limited`: `"<P> is limiting how often you can post. Wait a little, then retry."`
    - `media_invalid`: `"<P> rejected the media. Check the file type and size, then edit the post."`
    - `content_rejected`: `"<P> rejected this post. Edit it and try again."`
    - `transient`: `"We couldn't reach <P>. Try again in a moment."`
    - `permanent` with `errorMessage: 'Weird platform thing'`: `message === 'Weird platform thing'`, `needsReconnect: false`.
    - no code and no message: `"<P> could not publish this post."`
    - all non-auth cases have `needsReconnect: false`; `platform: 'facebook'` renders `Facebook`, `'twitter'` renders `X (Twitter)`.
- [ ] **Step 2:** Run `npx jest src/posts/lib`. Expected: FAIL, modules not found.
- [ ] **Step 3:** Implement the signatures above. `describeFailure`: use `errorCode` when present, else `classifyPublishError(errorMessage)`; `permanent` keeps the platform text when non-empty.
- [ ] **Step 4:** Run `npx jest src/posts/lib src/posts/composer/services/composer-error-mapper.service.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Mutation check: make `targetStatusOf` read only `status`; the "composer drift" test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(posts): derive per-target and partly-published status, human failure reasons`

---

### Task 2: Workspace-time helpers

**Files:**
- Create: `src/planner/lib/workspace-time.ts`
- Test: `src/planner/lib/workspace-time.spec.ts`

**Interfaces:**
- Consumes: `safeTimeZone`, `localDateOf`, `wallClockToUtc`, `addDays` from `src/first-week/lib/first-week-slots.ts` (re-exported here so planner code has one import point).
- Produces:
  - `interface ZonedClock { date: string /* yyyy-MM-dd */; weekday: number /* 0=Sun */; hour: number; minute: number }`
  - `zonedClock(at: Date, timeZone: string): ZonedClock` (DST-aware; invalid zone behaves as UTC; map Intl hour `24` to `0`).
  - `loadWorkspaceTimezone(db: DbType, workspaceId: string): Promise<string>`: returns `safeTimeZone(workspace.timezone)`; throws `NotFoundException('Workspace not found')` when the row is missing.

- [ ] **Step 1: Failing tests** (fixed instants; these are pure):
  - New York across fall-back: `2026-11-01T05:30:00Z` and `2026-11-01T06:30:00Z` both give `{ date: '2026-11-01', hour: 1 }`.
  - Kolkata: `2026-06-15T18:45:00Z` gives `{ date: '2026-06-16', weekday: 2, hour: 0, minute: 15 }`.
  - Auckland midnight edge: `2026-06-15T23:59:59.999Z` gives date `2026-06-16`.
  - `zonedClock(x, 'Mars/Olympus')` equals `zonedClock(x, 'UTC')` (Review Focus 1).
  - `loadWorkspaceTimezone`: stored `'Asia/Karachi'` returns it; stored `'Mars/Olympus'` returns `'UTC'`; no row rejects with `NotFoundException`. Use a one-method fake `db` (`select().from().where()` resolving rows).
- [ ] **Step 2:** `npx jest src/planner/lib/workspace-time.spec.ts` → FAIL.
- [ ] **Step 3:** Implement with `Intl.DateTimeFormat(...).formatToParts` (`hourCycle: 'h23'`).
- [ ] **Step 4:** Run the spec → PASS.
- [ ] **Step 5:** Mutation: drop the `% 24`; the New York test (hour `0` vs `24`) or Kolkata test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(planner): workspace time-zone helpers`

---

### Task 3: Rollback-DB harness and the "ready" columns

**Files:**
- Create: `src/planner/testing/rollback-db.ts`, `drizzle/migrations/0041_post_ready.sql`, `src/posts/post-ready.migration.db.spec.ts`
- Modify: `src/drizzle/schema/posts.schema.ts` (columns + partial index), `src/drizzle/schema/notifications.schema.ts` (add `'draft_ready'` before `'system_announcement'`), `src/notifications/notification-emitter.service.ts`

**Interfaces:**
- Produces (`rollback-db.ts`):
  - `describeDb: typeof describe` (`describe` when `process.env.PLANNER_DB_TESTS === '1'`, else `describe.skip`).
  - `withRollbackDb<T>(migrations: string[], fn: (db: DbType, client: PoolClient) => Promise<T>): Promise<T>`: refuses unless `DATABASE_URL` host is `localhost`/`127.0.0.1`; opens a `pg` client, `BEGIN`, `SET LOCAL TIME ZONE 'Asia/Karachi'` (so UTC-vs-local bugs show), executes each named file from `drizzle/migrations/` (twice, to prove idempotency), runs `fn` with `drizzle(client, { schema })`, always `ROLLBACK`s.
- Produces (schema): `posts.readyAt: timestamptz | null`, `posts.readyById: uuid | null` (FK `users.id` `ON DELETE SET NULL`); index `posts_workspace_draft_idx` on `(workspace_id, updated_at DESC) WHERE status = 'draft'`.
- Produces (emitter): `NotificationEmitterService.draftReady(userId: string, args: { workspaceId: string; postId: string; markedByName: string; preview: string }): Promise<Notification>`: type `draft_ready`, priority `medium`, title `Draft ready to schedule`, message `<markedByName> marked a draft ready: "<preview>"`, `actionUrl: /w/<workspaceId>/planner?post=<postId>`, metadata `{ workspaceId, postId, markedByName }`.
- Migration `0041_post_ready.sql` (idempotent, with the repo's WHY/SAFETY/ROLLBACK header): `ADD COLUMN IF NOT EXISTS ready_at / ready_by_id`; `CREATE INDEX IF NOT EXISTS`; `ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'draft_ready' BEFORE 'system_announcement'`; and a trigger `posts_clear_ready` (`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER … BEFORE UPDATE ON posts FOR EACH ROW WHEN (NEW.status <> 'draft' AND NEW.ready_at IS NOT NULL)` setting both columns to NULL). The trigger is how "cleared automatically when the post leaves `draft`" (spec §7.3) holds on every writer (PostService, composer scheduling, publish orchestrator, campaigns, first-week) without touching each.

- [ ] **Step 1: Failing DB spec** (`post-ready.migration.db.spec.ts`, `describeDb`), after applying `0041_post_ready.sql`: (a) `ready_at`, `ready_by_id` exist in `information_schema.columns`; (b) `pg_enum` holds `draft_ready` for `notification_type`; (c) insert a draft with `ready_at = now()`, `UPDATE posts SET status = 'scheduled'`, then `ready_at IS NULL AND ready_by_id IS NULL`; (d) updating a ready draft's `content` only leaves `ready_at` set; (e) deleting the `ready_by_id` user sets `ready_by_id` NULL while `ready_at` stays (use a throwaway user row inside the transaction).
- [ ] **Step 2:** `PLANNER_DB_TESTS=1 npx jest src/posts/post-ready.migration.db.spec.ts` → FAIL (file missing).
- [ ] **Step 3:** Write the harness, migration, schema and emitter method. Also add a plain jest unit test for `draftReady` (fake `NotificationsService`/`NotificationsGateway`): asserts type `draft_ready`, `actionUrl`, and that the unread count is pushed.
- [ ] **Step 4:** Run the DB spec and the unit test → PASS. Run `(echo BEGIN; cat drizzle/migrations/0041_post_ready.sql; echo ROLLBACK;) | "C:/Program Files/PostgreSQL/17/bin/psql.exe" "$DATABASE_URL" -v ON_ERROR_STOP=1` once more by hand; no error.
- [ ] **Step 5:** Mutation: drop the `CREATE TRIGGER`; case (c) must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(posts): ready flag columns, clear-on-leave-draft trigger, draft_ready notification type`

---

### Task 4: Enriched calendar posts and single-post read

**Files:**
- Create: `src/posts/dto/planner-post.dto.ts`, `src/posts/dto/calendar-query.dto.ts`, `src/posts/lib/present-post.ts`, `src/posts/lib/post-status.sql.ts`, `src/posts/services/planner-posts.service.ts`
- Modify: `src/posts/posts.controller.ts` (`getCalendarPosts`, `getPost`), `src/posts/posts.module.ts` (provide + export `PlannerPostsService`), `src/posts/services/post.service.ts` (`getCalendarPosts` reuses the shared predicate)
- Test: `src/posts/lib/present-post.spec.ts`, `src/posts/posts.planner.controller.spec.ts`, `src/posts/services/planner-posts.service.db.spec.ts`

**Interfaces:**
- Consumes: Task 1 `targetStatusOf`, `derivePostStatus`, `describeFailure`; Task 2 `zonedClock`, `loadWorkspaceTimezone`.
- Produces (`post-status.sql.ts`): `occurredAtSql: SQL` (`COALESCE(posts.published_at, posts.scheduled_at)`), `NON_DRAFT_STATUSES = ['scheduled','publishing','published','failed','partially_published'] as const`, `calendarRangeWhere(workspaceId: string, from: Date, to: Date): SQL` (workspace match, non-draft status, `occurredAtSql` between the bounds), extracted from `PostService.getCalendarPosts` (:1128), which now calls it.
- Produces: the DTOs in the **API contract** (`PlannerPostDto`, `PlannerPostTargetDto`, `PlannerUserRef`, `PlannerCalendarDto`).
  - `presentPost(row: PostRow, ctx: { users: Map<string, UserRef> }): PlannerPostDto` where `type PostRow = typeof posts.$inferSelect`.
  - `bucketByDate(posts: PlannerPostDto[], timeZone: string): Record<string, PlannerPostDto[]>` keyed by the workspace-local date of `occurredAt`.
  - `class CalendarQueryDto { @IsISO8601() from: string; @IsISO8601() to: string }`
  - `PlannerPostsService`: `constructor(@Inject(DRIZZLE) db: DbType)`; `present(rows: PostRow[]): Promise<PlannerPostDto[]>` (one batched `users` query for authors and `readyBy`); `getCalendar(workspaceId: string, from: Date, to: Date): Promise<PlannerCalendarDto>` (uses `calendarRangeWhere`); `getOne(workspaceId: string, postId: string): Promise<PlannerPostDto>` (404 when the id is not in that workspace).
- Behaviour:
  - `displayStatus = derivePostStatus(status, targets)`; `status` stays the stored value. Each target keeps its raw fields and gains normalized `status` plus `failure` (non-null only when its status is `failed`; uses `target.errorCode ?? classify(target.errorMessage ?? post.lastError)`).
  - `occurredAt = publishedAt ?? scheduledAt`; `campaignId = metadata.campaignId ?? null`; `author.name = users.name ?? email local part`; `jobId` is not exposed.
  - `getCalendarPosts` handler: missing/invalid `from` or `to`, `from > to`, or a span over 100 days is a 400 (today it throws a bare `Error`: `posts.controller.ts:103`). `byDate` keys now use the workspace timezone (were UTC: `posts.controller.ts:120`); response gains `timezone`.
  - `getPost` handler returns `{ post: PlannerPostDto }` (the dialog deep link `?post=` needs the enriched shape).

- [ ] **Step 1: Failing tests**
  - `present-post.spec.ts`: row with composer targets (`publishStatus: 'failed'`, `errorCode: 'auth_failed'`) gives `failure.needsReconnect === true` and `displayStatus` unchanged; published+failed targets on a `published` row gives `displayStatus === 'partially_published'` and `status === 'published'`; legacy target `errorMessage: '429 too many requests'` gives the rate-limit sentence; published target has `failure === null`; `campaignId` lifted; raw fields (`platformPostUrl`, `retryCount`, `metadata`) preserved; `jobId` absent; `bucketByDate` puts `2026-06-15T23:30:00Z` under `2026-06-16` for `Asia/Karachi` and under `2026-06-15` for `UTC`.
  - `posts.planner.controller.spec.ts` (supertest, pattern of `insights.controller.spec.ts`, with `ValidationPipe` installed): `calendar` without `from` → 400; `from=banana` → 400; `from` after `to` → 400; a 120-day span → 400; GUEST → 200; non-member (`getRole` null, not super admin) → 403 and the service is not called.
  - `planner-posts.service.db.spec.ts` (`describeDb`): range excludes drafts; a `scheduled_at`-only post and a published-now post (only `published_at`) are both returned; `getOne` with a post id belonging to another workspace rejects `NotFoundException` (Review Focus 2).
- [ ] **Step 2:** Run the three specs → FAIL.
- [ ] **Step 3:** Implement the DTO file (interfaces + `class CalendarQueryDto`), `presentPost`, `bucketByDate`, the service, controller edits and module wiring.
- [ ] **Step 4:** Run the specs (`PLANNER_DB_TESTS=1` for the DB one) → PASS. Also run `npx jest src/posts/workspace-guards.spec.ts` → PASS (handler names unchanged).
- [ ] **Step 5:** Mutation: remove `@RequireCapability('posts:draft')` from `getCalendarPosts`; `workspace-guards.spec` and the new 403 test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(posts): enriched calendar posts, workspace-timezone buckets, single-post read`

---

### Task 5: Drafts page

**Files:**
- Create: `src/posts/services/post-drafts.service.ts` (`constructor(@Inject(DRIZZLE) db: DbType, planner: PlannerPostsService)`; Task 6 adds the notification emitter), `src/posts/dto/draft-ops.dto.ts`, `src/posts/lib/draft-cursor.ts`
- Modify: `src/posts/posts.controller.ts` (`listDrafts`, declared **before** the `:postId` routes), `src/posts/posts.module.ts` (provide + export `PostDraftsService`), `src/posts/workspace-guards.spec.ts` (add `listDrafts: 'posts:draft'`)
- Test: `src/posts/lib/draft-cursor.spec.ts`, `src/posts/services/post-drafts.list.db.spec.ts`, extend `posts.planner.controller.spec.ts`

**Interfaces:**
- Consumes: Task 4 `PlannerPostsService.present`.
- Produces:
  - `encodeDraftCursor(c: { ready: 0 | 1; updatedMs: string; id: string }): string` / `decodeDraftCursor(raw: string): { ready: 0 | 1; updatedMs: string; id: string }` (base64url JSON; any malformed input throws `BadRequestException('Invalid cursor')`).
  - `class ListDraftsQueryDto { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number /* default 30 */; @IsOptional() @IsString() cursor?: string }`
  - `PostDraftsService.list(workspaceId: string, q: { limit: number; cursor?: string }): Promise<DraftsPageDto>`: `status = 'draft'` only; order `(ready_at IS NOT NULL) DESC, updated_at DESC, id DESC`; `total` is the unpaged count; `nextCursor` null on the last page. The key `floor(extract(epoch from updated_at) * 1000)::bigint` is selected from SQL and echoed in the cursor (never recomputed in JS).

- [ ] **Step 1: Failing tests**
  - `draft-cursor.spec.ts`: round trip; `'!!'`, `''`, valid base64 of non-JSON, and JSON with a non-uuid `id` each throw `BadRequestException`.
  - DB spec: seed 5 drafts (2 ready) plus a scheduled post and a published post → `total === 5`, ready ones first, others by `updated_at` desc; page size 2 walks all 5 with no duplicate and no gap; **two drafts with the identical `updated_at` to the microsecond** split across a page boundary appear once each; another workspace's drafts never appear.
  - HTTP: `GET …/drafts?limit=0` → 400; `limit=101` → 400; `cursor=%%%` → 400; GUEST → 200; the request reaches `listDrafts`, not `getPost` (route-order regression).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Compare keysets with a row-value predicate on `(ready int, updated_ms bigint, id uuid) < (cursor…)`.
- [ ] **Step 4:** Run (with `PLANNER_DB_TESTS=1`) → PASS.
- [ ] **Step 5:** Mutation: reverse the `id` tiebreak direction; the identical-`updated_at` test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(posts): paged drafts endpoint, ready drafts first`

---

### Task 6: Ready flag

**Files:**
- Modify: `src/posts/services/post-drafts.service.ts`, `src/posts/dto/draft-ops.dto.ts`, `src/posts/posts.controller.ts` (`setReady`), `src/posts/workspace-guards.spec.ts` (`setReady: 'posts:draft'`)
- Test: `src/posts/services/post-drafts.ready.spec.ts` (fake db), extend `posts.planner.controller.spec.ts`, extend the Task 5 DB spec

**Interfaces:**
- Consumes: Task 3 columns and `NotificationEmitterService.draftReady`; `isViewer`, `CallerRole` (`src/posts/guest-rules.ts`); `@CurrentWorkspaceRole()`.
- Produces:
  - `class SetReadyDto { @IsBoolean() ready: boolean }`
  - `PostDraftsService.setReady(workspaceId: string, postId: string, userId: string, role: CallerRole, ready: boolean): Promise<PlannerPostDto>`
  - Route `POST /posts/workspaces/:workspaceId/:postId/ready`, `@RequireCapability('posts:draft')`.
- Behaviour:
  - 404 when the post is not in the workspace; 400 `Only drafts can be marked ready` when `status !== 'draft'`; a Viewer who is not the creator gets 403 (reuse the `assertViewerOwnsDraft` message).
  - `ready: true` sets `ready_at = now()`, `ready_by_id = userId`; `false` clears both. **Neither writes `updated_at`.** A repeat `ready: true` changes nothing and notifies nobody. A history row is recorded (`marked_ready` / `unmarked_ready`, `performedById`).
  - On a real false→true transition, notify the workspace owner and every `ACCEPTED` member whose role is `ADMIN` or `MEMBER`, excluding the caller (nobody is told about their own click), via `draftReady`. Failures are logged, never thrown.

- [ ] **Step 1: Failing tests**
  - Fake-db unit spec: Guest on another user's draft → `ForbiddenException`; Guest on own draft → ok; Member on any draft → ok; scheduled post → `BadRequestException`; the captured `update().set()` payload for both `true` and `false` has no `updatedAt` key (Review Focus 3); second `true` call → `draftReady` called 0 additional times; first call with recipients owner + 1 MEMBER + 1 GUEST + the caller → `draftReady` called exactly for owner and the MEMBER (GUEST and caller excluded); a throwing `draftReady` does not fail the call.
  - HTTP: body `{ ready: 'yes' }` → 400; extra key → 400; GUEST → 200.
  - DB spec addition: ready on a post id from another workspace rejects `NotFoundException` (Review Focus 2).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Recipient lookup is a private `memberUserIds(workspaceId)` (owner from `workspace.ownerId` plus `workspace_invitations` where `status='ACCEPTED'` and `role IN ('ADMIN','MEMBER')`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: delete the `assertViewerOwnsDraft` call; the "Guest on another user's draft" test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(posts): mark a draft ready, notify members`

---

### Task 7: Duplicate

**Files:**
- Modify: `src/posts/services/post-drafts.service.ts`, `src/posts/posts.controller.ts` (`duplicatePost`), `src/posts/workspace-guards.spec.ts` (`duplicatePost: 'posts:draft'`)
- Create: `src/posts/lib/duplicate-post.ts`
- Test: `src/posts/lib/duplicate-post.spec.ts`, extend the Task 5 DB spec and the controller spec

**Interfaces:**
- Produces:
  - `buildDuplicate(source: PostRow, userId: string): typeof posts.$inferInsert`: status `draft`; `scheduledAt`/`publishedAt`/`jobId`/`lastError` null; `retryCount '0'`; `readyAt`/`readyById` null; `createdById = userId`; targets rebuilt as `{ channelId, platform, status: 'draft', publishStatus: 'queued', retryCount: 0 }` plus the source's `destination` and `contentOverride` only; `metadata` keeps everything except `campaignId`, `schedule`, `firstWeekSlot`, `suggestedAt`, `imageCredit`, and `source` when it is `first_week` (becomes `composer`); `content`, `mediaItems`, `platformContent` copied.
  - `PostDraftsService.duplicate(workspaceId: string, postId: string, userId: string): Promise<PlannerPostDto>`; route `POST /posts/workspaces/:workspaceId/:postId/duplicate`, `@RequireCapability('posts:draft')`, status 201 body `{ post }`. A Guest may duplicate any post in their workspace (that is "Copy to a new draft").

- [ ] **Step 1: Failing tests**
  - Unit: a published, campaign-tagged, first-week post with `platformPostId`, `errorMessage`, `errorCode`, `scheduledAt` → result has none of those; media and caption preserved; `createdById` is the caller; targets carry both `status: 'draft'` and `publishStatus: 'queued'`.
  - DB: duplicate persists a `draft` row with a new id; cross-workspace id rejects `NotFoundException` and inserts nothing (Review Focus 2).
  - HTTP: GUEST → 201 (mock service); non-member → 403.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: stop stripping `campaignId`; the unit test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(posts): duplicate a post into a new draft`

---

### Task 8: Machine-readable refusals; no delete of partly published posts

**Files:**
- Modify: `src/posts/services/post.service.ts` (`updatePost` refusal at :317, `deletePost` at :443-470, `schedulePublishJob` refusal at :1016)
- Test: create `src/posts/services/post.service.refusals.spec.ts` (same mock style as `post.service.guest-rules.spec.ts`)

**Interfaces:**
- Produces error bodies (HTTP 400, JSON `{ statusCode, message, error, code }`):
  - `code: 'POST_ALREADY_PUBLISHED'` for the update refusal and the delete-published refusal.
  - `code: 'SCHEDULE_IN_PAST'` for "Cannot schedule a post in the past".
  - `code: 'POST_PARTLY_PUBLISHED'` for a new refusal: `deletePost` on a post whose `derivePostStatus(...)` is `partially_published` (message `Some channels already published this post. Delete it from each platform instead.`; deleting would orphan live posts: spec §6.5). The frontend maps these three codes to its Undo toasts (spec §8.1.8). Existing `message` strings stay unchanged.

- [ ] **Step 1: Failing tests:** `updatePost` on a published post rejects with `getResponse()` containing `code: 'POST_ALREADY_PUBLISHED'` and the original message; a `scheduledAt` one minute ago → `SCHEDULE_IN_PAST`; `deletePost` on `partially_published` → `POST_PARTLY_PUBLISHED`, and on a `published`-status row whose targets mix published/failed → also refused; deleting `failed` (all targets failed) and `scheduled` posts still works; the existing Guest tests still pass.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Throw `new BadRequestException({ message, code })`.
- [ ] **Step 4:** Run `npx jest src/posts/services` → PASS.
- [ ] **Step 5:** Mutation: remove the partly-published check; its test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(posts): refusal codes for moves and deletes, protect partly published posts`

---

### Task 9: Planner module and the List endpoint

**Files:**
- Create: `src/planner/planner.module.ts`, `src/planner/planner.controller.ts`, `src/planner/services/planner-list.service.ts`, `src/planner/dto/planner-list.dto.ts`, `src/planner/lib/list-cursor.ts`
- Modify: `src/app.module.ts` (import `PlannerModule`), `src/posts/lib/post-status.sql.ts` (add `isPartlyPublishedSql`)
- Test: `src/planner/lib/list-cursor.spec.ts`, `src/planner/services/planner-list.service.db.spec.ts`, `src/planner/planner.controller.spec.ts`

**Interfaces:**
- Consumes: Task 4 `PlannerPostsService.present`; Task 1 `derivePostStatus`.
- Produces:
  - `isPartlyPublishedSql(): SQL` (added to `post-status.sql.ts`; uses `NON_DRAFT_STATUSES` and `occurredAtSql` from Task 4): `posts.status = 'partially_published'` OR (some target counts published, per either field, AND some target not published whose either field says failed). Its truth table equals `derivePostStatus === 'partially_published'`; the DB spec proves parity on a fixture matrix.
  - `encodeListCursor(c: { key: string; id: string }): string` / `decodeListCursor(raw: string): { key: string; id: string }` (malformed → `BadRequestException('Invalid cursor')`; `key` must match `/^-?\d+$/`).
  - `type ListTab = 'upcoming' | 'published' | 'failed' | 'all'`
  - `class PlannerListQueryDto { @IsIn(['upcoming','published','failed','all']) tab: ListTab; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number /* 30 */; @IsOptional() @IsString() cursor?: string }`
  - `PlannerListService.list(workspaceId: string, q: { tab: ListTab; limit: number; cursor?: string }, now?: Date): Promise<PlannerListDto>`; the module `PlannerModule` imports `WorkspaceRoleModule` and `PostsModule`; `PlannerController` is `@Controller('planner/workspaces/:workspaceId')` with `@Get('list')`, `@RequireCapability('posts:draft')`.
- Tab rules (posts only, drip posts and replies never appear; `occurred = COALESCE(published_at, scheduled_at)`; non-draft statuses only):
  - `upcoming`: `status = 'publishing'` OR (`status = 'scheduled'` AND `scheduled_at >= now`); ascending.
  - `published`: `status = 'published'` AND NOT partly; descending.
  - `failed`: `status = 'failed'` OR partly; descending.
  - `all`: scheduled, publishing, published, failed, partially_published; descending.
  - Keyset on `(floor(extract(epoch from occurred)*1000)::bigint, id)`; the key is selected from SQL. `total` is the tab's unpaged count; `counts` always carries `{ upcoming, failed }`.

- [ ] **Step 1: Failing tests**
  - cursor spec: round trip; malformed forms throw.
  - DB spec (inject `now` relative to the real clock, seed relative offsets): each tab returns the right rows; a `published`-status post with one failed target appears in `failed` and not `published` (parity with `derivePostStatus`); 7 rows with **identical `occurred` to the microsecond but differing sub-millisecond digits** page cleanly at `limit=2` with no row repeated or skipped (the keyset trap); `counts.upcoming/failed` ignore the requested tab; a scheduled post whose time has passed is absent from `upcoming` and present in `all`; empty workspace gives `{ rows: [], total: 0, nextCursor: null, counts: { upcoming: 0, failed: 0 } }`.
  - HTTP: `tab=nope` → 400; `limit=0` → 400; `cursor=%%%` → 400; GUEST → 200; non-member → 403.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `sql` fragments (drizzle `db.select({ post: posts, key: sql<string>… })`).
- [ ] **Step 4:** Run (with `PLANNER_DB_TESTS=1`) → PASS. `npx jest src/workspace-members/every-workspace-route-guarded.spec.ts` → PASS.
- [ ] **Step 5:** Mutation: use `ms` truncated in JS for the cursor key; the sub-millisecond paging test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(planner): paged List endpoint with keyset pagination`

---

### Task 10: Month counts, next post, last post time

**Files:**
- Modify: `src/planner/planner.controller.ts`, `src/planner/services/planner-list.service.ts` (or create `src/planner/services/planner-lookup.service.ts` if the file passes ~250 lines), `src/planner/dto/planner-list.dto.ts`
- Test: `src/planner/services/planner-lookup.db.spec.ts`, extend `src/planner/planner.controller.spec.ts`

**Interfaces:**
- Consumes: Task 2 `loadWorkspaceTimezone`.
- Produces (all `@RequireCapability('posts:draft')`, `GET`):
  - `month-counts?year=2026` → `MonthCountsDto`: always 12 entries, counted in the workspace zone via `AT TIME ZONE`, non-draft posts only (including campaign posts). `year` is an integer in 2000..2100 (else 400). Spec lists a `tz` query param; the workspace zone is the source of truth, so the param is NOT accepted (a `tz` key would be a 400 under `forbidNonWhitelisted`).
  - `next-post?after=<ISO>` → `{ scheduledAt: string | null }`: the earliest `occurred` strictly after `after` over non-draft posts (the name is the spec's; it may be a published instant).
  - `last-post-time?channelIds=1,2` → `{ at: string | null }`: `occurred` of the most recently CREATED non-draft post whose targets include any listed channel (feeds "Same time as your last post", spec §6.3; the spec names the option but lists no endpoint). `channelIds` is 1..50 comma-separated integers.
  - Service methods: `monthCounts(workspaceId: string, year: number)`, `nextPost(workspaceId: string, after: Date)`, `lastPostTime(workspaceId: string, channelIds: number[])`.

- [ ] **Step 1: Failing tests**
  - DB (session zone is Karachi by the harness, workspace zones set per case): a post at `2026-12-31T23:30:00Z` counts in **January 2027** for a `Pacific/Auckland` workspace and **December 2026** for `UTC`; invalid stored zone `Mars/Olympus` counts as UTC (Review Focus 1); a draft and another workspace's post are not counted; a workspace with nothing returns 12 zeros; `next-post` ignores drafts and returns null when nothing is later; `last-post-time` picks the newest by `created_at`, ignores drafts and posts on other channels, returns null for none.
  - HTTP: `year=1999`, `year=abc` → 400; `tz=UTC` → 400; `after=banana` → 400; `channelIds=a,b` → 400; 51 ids → 400; GUEST → 200.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: group by UTC month instead of `AT TIME ZONE`; the Auckland case must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(planner): month counts, next post and last post time`

---

### Task 11: Day notes

**Files:**
- Create: `drizzle/migrations/0042_calendar_notes.sql`, `src/drizzle/schema/calendar-notes.schema.ts`, `src/planner/services/planner-notes.service.ts`, `src/planner/planner-notes.controller.ts`, `src/planner/dto/planner-notes.dto.ts`
- Modify: `src/drizzle/schema/index.ts`, `src/planner/planner.module.ts`
- Test: `src/planner/services/planner-notes.service.spec.ts`, `src/planner/planner-notes.controller.spec.ts`, `src/planner/services/planner-notes.db.spec.ts`

**Interfaces:**
- Produces:
  - Table `calendar_notes` (spec §7.3): `id uuid pk`, `workspace_id uuid` FK cascade, `date date`, `body text` with `CHECK (char_length(body) BETWEEN 1 AND 500)`, `color varchar(16)` with `CHECK (color IN ('amber','blue','green','red'))`, `created_by_id uuid` FK users `SET NULL`, `updated_by_id uuid null` FK users `SET NULL`, `created_at`/`updated_at timestamptz`; `UNIQUE (workspace_id, date)` (created as `CREATE UNIQUE INDEX IF NOT EXISTS`); constraints added in `DO $$ … EXCEPTION WHEN duplicate_object` guards as in `0040`. Drizzle export `calendarNotes`.
  - `NOTE_COLORS = ['amber','blue','green','red'] as const`.
  - `class CreateNoteDto { @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string; @IsString() @Length(1,500) body: string; @IsIn(NOTE_COLORS) color: NoteColor }`, `class UpdateNoteDto { @IsOptional() @IsString() @Length(1,500) body?: string; @IsOptional() @IsIn(NOTE_COLORS) color?: NoteColor }`, `class ListNotesQueryDto { from: string; to: string }` (same date pattern).
  - `PlannerNotesService`: `list(workspaceId: string, from: string, to: string): Promise<PlannerNoteDto[]>`, `create(workspaceId: string, userId: string, role: CallerRole, dto: CreateNoteDto): Promise<PlannerNoteDto>`, `update(workspaceId: string, id: string, userId: string, role: CallerRole, dto: UpdateNoteDto): Promise<PlannerNoteDto>`, `remove(workspaceId: string, id: string, userId: string, role: CallerRole): Promise<void>`.
  - Routes under `planner/workspaces/:workspaceId/notes`: `GET` (`from`,`to`) `posts:draft`; `POST`, `PATCH :id`, `DELETE :id` `posts:publish` (spec §7.4).
- Rules: a calendar-invalid `date` (`2026-02-30`) → 400; a second note on the same day → `ConflictException('A note for this day already exists')` (map pg `23505`); list span over 100 days → 400; `author` is `{ id, name }` from `users` (null when the creator was deleted); notes keep their date when the workspace zone changes (no tz maths here).

- [ ] **Step 1: Failing tests**
  - Service (fake db): `2026-02-30` → `BadRequestException`; body 501 chars → rejected by DTO (HTTP spec); duplicate day → `ConflictException`; Member updating or deleting another member's note → ok (notes are shared workspace annotations).
  - HTTP: `colour: 'pink'` → 400; extra key → 400; empty body → 400; GUEST `POST` → 403; MEMBER `POST` → 201; non-member → 403; `GET` without `from` → 400.
  - DB: unique index rejects the second note for the same `(workspace, date)` but allows the same date in another workspace; `body` length 0 and 501 and colour `pink` violate the CHECKs; deleting the creator sets `created_by_id` NULL; update sets `updated_by_id`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Write migration (header with WHY/SAFETY/ROLLBACK `DROP TABLE IF EXISTS calendar_notes`), schema, service, controller, wiring.
- [ ] **Step 4:** Run (DB with the harness applying `0042_calendar_notes.sql`) → PASS; `every-workspace-route-guarded.spec.ts` PASS.
- [ ] **Step 5:** Mutation: change one write route's capability to `posts:draft`; the guard-metadata test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(planner): shared day notes`

---

### Task 12: Planner preferences

**Files:**
- Create: `drizzle/migrations/0043_planner_preferences.sql`, `src/drizzle/schema/planner-preferences.schema.ts`, `src/planner/lib/planner-prefs.ts`, `src/planner/dto/planner-prefs.dto.ts`, `src/planner/services/planner-preferences.service.ts`, `src/planner/planner-preferences.controller.ts`
- Modify: `src/drizzle/schema/index.ts`, `src/planner/planner.module.ts`
- Test: `src/planner/lib/planner-prefs.spec.ts`, `src/planner/planner-preferences.controller.spec.ts`, `src/planner/services/planner-preferences.db.spec.ts`

**Interfaces:**
- Produces:
  - Table `planner_preferences(user_id uuid, workspace_id uuid, prefs jsonb NOT NULL DEFAULT '{}', updated_at timestamptz)`, PK `(user_id, workspace_id)`, both FKs cascade.
  - `interface PlannerPrefs { postSize: 'comfortable'|'compact'; colorBy: 'status'|'channel'|'campaign'; show: { media: boolean; campaigns: boolean; notes: boolean; events: boolean; weekends: boolean }; publishedPosts: 'show'|'fade'|'hide'; weekStartsOn: 0 | 1; visibleCalendarIds: string[] | null; eventDisplay: 'full'|'busy'; bestTimesInWeek: boolean; bestTimesSource: 'own'|'general'; suggestBestTime: boolean }`.
  - `PLANNER_PREF_DEFAULTS: PlannerPrefs` = comfortable, status, all `show` true, fade, `0`, `null`, full, `false`, own, `true` (spec §6.9: best times off by default, suggestions on).
  - `resolvePrefs(stored: unknown): PlannerPrefs` (defaults filled; unknown or wrongly-typed stored keys dropped, never thrown on); `mergePrefs(stored: unknown, patch: UpdatePlannerPrefsDto): Record<string, unknown>` (shallow merge; `show` merged per key; `visibleCalendarIds: null` removes the key).
  - `class UpdatePlannerPrefsDto`: every field optional, class-validator enums, `show` as a nested `ShowPrefsDto` (`@ValidateNested @Type`), `visibleCalendarIds` `@IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true })` and nullable.
  - `PlannerPreferencesService.get(userId: string, workspaceId: string): Promise<PlannerPrefs>` and `update(userId: string, workspaceId: string, patch: UpdatePlannerPrefsDto): Promise<PlannerPrefs>` (read-modify-write inside `db.transaction` with `FOR UPDATE`, upsert).
  - Routes `GET` and `PUT planner/workspaces/:workspaceId/preferences`, `posts:draft`. `PUT` MERGES the patch (the View menu toggles write one key at a time) and returns the full prefs.

- [ ] **Step 1: Failing tests**
  - Pure: `resolvePrefs(undefined)` equals the defaults; `resolvePrefs({ postSize: 'huge', colorBy: 'channel' })` keeps `colorBy: 'channel'` and defaults `postSize`; `mergePrefs({ show: { notes: false } }, { show: { media: false } })` keeps both; `visibleCalendarIds: null` clears.
  - HTTP: `{ unknownKey: 1 }` → 400; `{ show: { bogus: true } }` → 400; `{ weekStartsOn: 2 }` → 400; `{ visibleCalendarIds: ['x'] }` → 400; GUEST `PUT` → 200; each user sees only their own row (service called with the caller's id, not a body field).
  - DB: first `PUT` creates, second merges and keeps untouched keys; two users in one workspace stay independent; deleting the user cascades.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; migration header WHY/SAFETY/ROLLBACK.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: let the controller take `userId` from the body; the "own row" test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(planner): per-user calendar preferences`

---

### Task 13: Campaign spans

**Files:**
- Create: `src/campaigns/lib/campaign-span.ts`, `src/campaigns/dto/spans-query.dto.ts`
- Modify: `src/campaigns/campaigns.service.ts` (`listSpans`), `src/campaigns/campaigns.controller.ts` (`spans`, declared **before** `@Get('workspaces/:workspaceId/:id')`), `src/posts/workspace-guards.spec.ts` (`spans: 'posts:draft'`)
- Test: `src/campaigns/lib/campaign-span.spec.ts`, `src/campaigns/campaigns.spans.db.spec.ts`, extend `src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: Task 2 workspace-time helpers; existing `CampaignsService.computeMetrics`.
- Produces:
  - `interface Cadence { kind: 'daily' | 'weekdays' | 'custom'; weekdays: number[] /* 0=Sun */; times: string[] /* HH:mm */ }`
  - `cadenceOf(schedule: CampaignScheduleJson): Cadence` (bulk: `skipWeekends` → weekdays, else daily, one time `defaultTime`; drip/evergreen: 7 days → daily; Mon-Fri exactly → weekdays; else custom).
  - `computeSpan(input: { campaign: Campaign; slots: Pick<CampaignSlotContent,'date'|'time'|'scheduledAt'|'slotStatus'>[]; skippedDates: Set<string>; workspaceTz: string; now: Date }): { startDate: string; endDate: string | null; nextPostAt: string | null }` — dates are the WORKSPACE-local dates of the first and last slot instants (instant = `scheduledAt`, else `wallClockToUtc(date, time, schedule.timezone)`); slots on skipped days or with status `skipped` ignored; no slots falls back to `schedule.startDate`/`endDate` at their first time; `endDate` is `null` for evergreen and for drip with `schedule.endDate === null`; `nextPostAt` = earliest `scheduledAt` among `scheduled` slots after `now`.
  - `CampaignsService.listSpans(workspaceId: string, from: Date, to: Date, now?: Date): Promise<CampaignSpanDto[]>`: campaigns with status not `draft` whose span overlaps `[from, to]` (open-ended spans overlap anything after their start); two grouped queries for days and slots, not per campaign.
  - Route `GET /campaigns/workspaces/:workspaceId/spans?from&to`, `posts:draft`; `SpansQueryDto { @IsISO8601() from; @IsISO8601() to }`, span over 400 days → 400.
- Why not reuse `computeNextRun`: it ignores `schedule.timezone` (`campaigns.service.ts:257` TODO).

- [ ] **Step 1: Failing tests**
  - Pure: bulk campaign in `Asia/Karachi` with a slot at `23:30` local on `2026-07-01` viewed from a `UTC` workspace gives `startDate: '2026-07-01'`; from a `Pacific/Auckland` workspace the same slot gives the next local date (instant-based); skipped day and `skipped` slot ignored; open-ended drip gives `endDate: null`; empty slots fall back to schedule dates; `cadenceOf` cases (bulk skipWeekends, drip all 7, Mon-Fri, Mon/Wed/Fri); `nextPostAt` ignores past and non-`scheduled` slots.
  - DB: overlap filter (campaign wholly before `from` excluded, spanning `from` included, draft excluded, other workspace excluded); `postsPlanned`/`postsPublished` equal `computeMetrics`.
  - HTTP: GUEST → 200; missing `from` → 400; `/campaigns/workspaces/:ws/spans` reaches `spans`, not `getOne` (route order).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; `npx jest src/posts/workspace-guards.spec.ts` PASS.
- [ ] **Step 5:** Mutation: use `schedule.startDate` instead of slot instants in `computeSpan`; the Auckland case must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(campaigns): lean span endpoint for the calendar bars`

---

### Task 14: External calendars: discovery and per-calendar pull

**Files:**
- Create: `drizzle/migrations/0044_external_calendars.sql`, `src/calendar-sync/services/external-calendars.service.ts`
- Modify: `src/drizzle/schema/calendar-sync.schema.ts`, `src/calendar-sync/providers/delta.types.ts`, `google-delta.util.ts`, `outlook-delta.util.ts`, `src/calendar-sync/services/calendar-pull-sync.service.ts`, `src/calendar-sync/calendar-sync.module.ts`, `src/channels/services/outlook-calendar.service.ts`
- Test: `src/calendar-sync/services/external-calendars.service.spec.ts`, extend `google-delta.util.spec.ts`, `outlook-delta.util.spec.ts`, `calendar-pull-sync.reconcile.spec.ts`, `src/calendar-sync/services/external-calendars.db.spec.ts`

**Interfaces:**
- Produces (schema, migration `0044`): table `external_calendars(id uuid pk default gen_random_uuid(), workspace_id uuid FK cascade, channel_id integer FK social_media_channels cascade, provider_calendar_id varchar(512), name text, color varchar(16) null, is_primary boolean default false, account_email text null, sync_token text null, delta_link text null, last_full_sync_at timestamptz null, created_at timestamptz, updated_at timestamptz)`, `UNIQUE (channel_id, provider_calendar_id)`; and `ALTER TABLE external_calendar_events ADD COLUMN IF NOT EXISTS calendar_id uuid REFERENCES external_calendars(id) ON DELETE CASCADE`, `… ADD COLUMN IF NOT EXISTS attendee_count integer`, index on `calendar_id`. New `timestamptz` columns only (the existing `external_calendar_events.starts_at/ends_at` are `timestamp` WITHOUT zone: `calendar-sync.schema.ts:111-112`; do not change them here).
- Produces (providers): `NormalizedExternalEvent.attendeeCount?: number | null` (Google `attendees.length`, Graph `attendees.length`; null when absent); `CalendarDeltaOptions.isPrimary?: boolean` (default `true`). With `isPrimary === false` the Outlook initial URL is `/me/calendars/{calendarId}/calendarView/delta?…`; primary keeps `/me/calendarView/delta` untouched (`outlook-delta.util.ts:169`, which ignores `calendarId` today, so non-primary Outlook calendars need this). Google already honours `calendarId`.
- Produces: `OutlookCalendarService.getAccountEmail(accessToken: string): Promise<string | null>` (`GET /me?$select=mail,userPrincipalName`; `User.Read` is already requested).
- Produces: `ExternalCalendarsService`:
  - `syncCalendarList(channel: { id: number; workspaceId: string; platform: string }, accessToken: string): Promise<{ calendars: ExternalCalendarRow[]; primaryIsNew: boolean }>`: lists provider calendars (cap `MAX_CALENDARS_PER_CONNECTION = 25`, primary first), upserts rows by `(channel_id, provider_calendar_id)` with name, colour (`backgroundColor`) and `is_primary`; account email = Google primary calendar id when it contains `@`, else Outlook `getAccountEmail`; deletes rows (cascading their events) for calendars the provider no longer lists.
  - `listForWorkspace(workspaceId: string): Promise<ExternalCalendarRow[]>`.
- Behaviour change in `CalendarPullSyncService.reconcile`: after resolving the primary calendar, call `syncCalendarList`. If `primaryIsNew`, clear the primary cursor once (one-time full resync fills `calendar_id`/`attendee_count`; this is the "backfill" for existing connections, driven by the existing 15-minute scheduler, no one-off script). Primary events are upserted with `calendarId` and `attendeeCount`; on first sight run `UPDATE external_calendar_events SET calendar_id = $row WHERE channel_id = $c AND external_calendar_id = $provider_id AND calendar_id IS NULL`. Then, for each non-primary calendar, run a **secondary pull**: own cursor in the calendar row, 7-day full-resync rule from `last_full_sync_at`, bounded full window, prune after a complete full list, and **no ownership/two-way handling** (Schedura only ever writes to the primary calendar; all events there are external). Push stays primary-only. A failure in one calendar is logged and does not stop the others.
- Provider push subscriptions stay on the primary calendar; secondary calendars refresh on the 15-minute poll (acceptable: documented in the module comment).

- [ ] **Step 1: Failing tests**
  - Providers: Google item with 3 `attendees` → `attendeeCount: 3`, none → `null`; Outlook non-primary URL contains `/me/calendars/<encoded id>/calendarView/delta`, primary URL unchanged.
  - `ExternalCalendarsService` (fake db + fake provider services): upserts rows from a 3-calendar list with the primary first; cap at 25; calendar missing from a later list is deleted; `primaryIsNew` true only on first creation; Google email from `primary.id` containing `@`; Outlook email via `getAccountEmail`; a provider failure does not delete rows.
  - Reconcile spec: a new primary row clears the primary cursor exactly once; a secondary calendar failing does not abort the next; secondary events are upserted with that calendar's `calendarId` and never routed through `applyOwnedChange`; the secondary full-resync rule uses `last_full_sync_at`; existing primary behaviour tests still pass.
  - DB: migration idempotent (harness applies it twice); deleting a calendar row cascades its events; backfill `UPDATE` only touches `calendar_id IS NULL` rows of that channel.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; header WHY/SAFETY/ROLLBACK on the migration (`DROP TABLE … CASCADE` after dropping the two columns).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: route secondary events through `applyOwnedChange`; the "never routed" test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(calendar-sync): pull every calendar of a connection`

---

### Task 15: Calendars list and extended external events

**Files:**
- Modify: `src/calendar-sync/calendar-sync.controller.ts` (`listCalendars`), `src/calendar-sync/services/external-events.service.ts`
- Test: `src/calendar-sync/calendar-sync.controller.spec.ts` (new), `src/calendar-sync/services/external-events.service.spec.ts` (new), `src/calendar-sync/services/external-events.db.spec.ts`

**Interfaces:**
- Consumes: Task 14 `ExternalCalendarsService.listForWorkspace`.
- Produces:
  - `GET /calendar-sync/workspaces/:workspaceId/calendars` → `ExternalCalendarDto[]` (`posts:draft`): `{ id, channelId, provider, accountEmail, name, color, isPrimary }`. `channelId` is added to the spec's shape: the Accounts menu (Reconnect, Disconnect) calls the channels API with it.
  - `ExternalEventDto` gains `calendarId: string | null`, `calendarName: string`, `calendarColor: string | null`, `accountEmail: string | null`, `attendeeCount: number | null`. Events whose `calendar_id` is NULL (not yet re-synced) fall back to `calendarName = channel.account_name`, other fields null (Review Focus 5). The anti-join and overlap logic is unchanged. All-day events keep `startsAt` at UTC midnight of their calendar date (documented in the contract; no conversion).

- [ ] **Step 1: Failing tests**
  - Controller (supertest): GUEST → 200 on `calendars`; non-member → 403; `external-events` without `from` → 400 (existing behaviour kept).
  - Service: a row with `calendar_id` NULL serialises with `calendarName` from the connection and no throw; a row with null title serialises `title: ''`; a row with `attendee_count` 4 returns `4`.
  - DB: events from a non-primary calendar are returned; events of two calendars carry their own `calendarName`; an event linked in `calendar_item_links` is still excluded.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: remove `@RequireCapability` from `listCalendars`; `every-workspace-route-guarded.spec.ts` and the 403 test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(calendar-sync): calendars list and per-calendar event fields`

---

### Task 16: Scheduled inbox replies by date range

**Files:**
- Modify: `src/inbox/dto/list-scheduled-messages.dto.ts`, `src/inbox/services/scheduled-messages.service.ts` (`list`, :568)
- Test: `src/inbox/services/scheduled-messages.list.spec.ts` (new)

**Interfaces:**
- `ListScheduledMessagesDto` gains `@IsOptional() @IsISO8601() from?: string` and `to?: string`; `list` adds `scheduled_at >= from` / `<= to` when given. Without them behaviour is unchanged (default statuses `pending` + `failed`). The calendar needs this to stay bounded (spec ruling C3; the endpoint had no range).

- [ ] **Step 1: Failing tests** (fake db capturing conditions): with `from`/`to` the query is bounded (assert the generated SQL via the `where` argument or run the DB variant with the harness); `from=banana` is a 400 at the HTTP layer; with neither param the old result set is returned.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: ignore `to`; the bound test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(inbox): range filter on scheduled replies`

---

### Task 17: Per-post metrics

**Files:**
- Create: `src/post-performance/engagement-stats.ts`
- Modify: `src/post-performance/post-performance.repository.ts` (extract the SELECT into a private builder; add `publishedPostsByIds`), `src/insights/insights.controller.ts` (`metrics`), `src/insights/insights.service.ts` (`postMetrics`), `src/insights/dto/insights.dto.ts`
- Test: `src/post-performance/engagement-stats.spec.ts`, extend `post-performance.repository.spec.ts`, extend `src/insights/insights.controller.spec.ts`, `src/insights/insights.metrics.db.spec.ts`

**Interfaces:**
- Produces (`engagement-stats.ts`):
  - `isMeasured(p: PublishedPost): boolean` (any of likes, comments, shares, impressions non-null).
  - `median(values: number[]): number | null` (null when empty; mean of the two middle values for even length).
  - `MIN_POSTS_FOR_USUAL = 5`; `usualMultiplier(engagements: number, channelEngagements: number[]): number | null`: null when fewer than 5 samples or the median is 0; else `round2(engagements / median)`.
- Produces: `PostPerformanceRepository.publishedPostsByIds(workspaceId: string, postIds: string[]): Promise<PublishedPost[]>` (same row shape and the same both-fields published rule as `publishedPosts`, no date or channel filter).
- Produces: `InsightsService.postMetrics(workspaceId: string, postIds: string[], now?: Date): Promise<PostChannelMetricsDto[]>`: for each (post, channel) row from the latest snapshot: `{ postId, channelId, views: impressions, likes, comments, engagements: engagementsOf(p), usualMultiplier }`; the usual sample is the channel's measured posts published in the last 90 days (`publishedPosts` for those channels).
- Route `GET /insights/workspaces/:workspaceId/posts/metrics?postIds=a,b` (class capability `analytics:view`) returns `{ metrics: PostChannelMetricsDto[] }`: 1..50 uuids, else 400; ids from another workspace return no rows.

- [ ] **Step 1: Failing tests**
  - Stats: `median([])` null; `median([1,3,2])` 2; `median([1,2,3,4])` 2.5; `usualMultiplier(10, [5,5,5,5])` null (4 samples); `usualMultiplier(10, [4,5,5,5,6])` is `2` ; median 0 gives null; `isMeasured` false for all-null.
  - HTTP: 51 ids → 400; `postIds=notauuid` → 400; missing → 400; GUEST (analytics:view) → 200; non-member → 403.
  - DB: a post published to two channels returns two rows with each channel's own latest snapshot (older snapshot ignored); an unmeasured post has null `views/likes/comments` and `engagements: 0`; a foreign-workspace post id returns `[]` (Review Focus 2); the repository's existing `publishedPosts` tests still pass after the refactor.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: drop the `workspace_id` predicate in `publishedPostsByIds`; the foreign-workspace test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(insights): per-post metrics with the channel's usual engagement`

---

### Task 18: General best-times table

**Files:**
- Create: `src/planner/lib/general-times.ts`
- Test: `src/planner/lib/general-times.spec.ts`

**Interfaces:**
- Produces: `interface GeneralWindow { weekday: number /* 0=Sun */; hour: number /* 0-23, local audience time */ }`; `GENERAL_TIMES: Partial<Record<SupportedPlatform, GeneralWindow[]>>`; `generalWindowsFor(platform: SupportedPlatform): GeneralWindow[]` (empty array when the platform has no published research).
- Research step (real reference data, never invented): use `WebSearch`/`WebFetch` to read the current Sprout Social and Hootsuite "best times to post" benchmark reports (2025-2026) for each social platform in `CHANNEL_CATEGORY`. Record 3 to 6 windows per platform where a reputable source gives them, with the source name and URL in a comment above that platform's block. Platforms with no reputable published benchmark (expected: bluesky, mastodon, reddit, google_business, threads if unsourced) are left out of the table and listed in a `NO_PUBLISHED_RESEARCH` comment; they return `[]`. Where a report states times in a specific zone, record them as local audience time and say so in the file header (they are applied as workspace-local hours).

- [ ] **Step 1: Failing tests:** every key of `GENERAL_TIMES` is a social platform per `CHANNEL_CATEGORY`; every window has integer `weekday` 0..6 and `hour` 0..23; no duplicate `(weekday, hour)` within a platform; each present platform has between 3 and 6 windows; `generalWindowsFor('reddit')` is `[]` when unsourced; the file text contains at least one `https://` URL per sourced platform (read the file with `fs` and check each platform block is preceded by a URL comment).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Research and write the table. **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: set one window's `hour` to 25; the range test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(planner): curated general best-times table with sources`

---

### Task 19: Best-times algorithm

**Files:**
- Create: `src/planner/lib/best-times.ts`
- Test: `src/planner/lib/best-times.spec.ts`

**Interfaces:**
- Consumes: Task 2 `zonedClock`; Task 17 `isMeasured`, `median`; `engagementsOf` from `src/post-performance/post-performance.ts`; Task 18 `generalWindowsFor`.
- Produces:
  - Constants `BEST_TIMES_WINDOW_DAYS = 90`, `MIN_POSTS_FOR_OWN = 15`, `MIN_POSTS_PER_BUCKET = 2`.
  - `interface BestTimeWindow { weekday: number; hour: number; multiplier: number | null }`
  - `computeOwnBestTimes(posts: PublishedPost[], timeZone: string, now: Date): { postCount: number; windows: BestTimeWindow[] }`: keep posts published within 90 days before `now`, then only `isMeasured` ones; `postCount` is that count; bucket by workspace-local `(weekday, hour)` of `publishedAt`; a bucket needs at least 2 posts; `multiplier = round2(median(bucket engagements) / max(median(channel engagements), 1))` (a zero channel median uses 1 so it never divides by zero); windows sorted by multiplier desc, then bucket size desc, then weekday, then hour, so the best three come first.
  - `resolveBestTimes(args: { platform: SupportedPlatform; posts: PublishedPost[]; timeZone: string; now: Date; forceGeneral: boolean }): { source: 'own' | 'general'; postCount: number; windowDays: 90; windows: BestTimeWindow[] }`: `general` when `forceGeneral` or `postCount < 15`; general windows carry `multiplier: null` (a general time has no "× your usual", so the contract's `multiplier` is nullable where the spec had a plain number).

- [ ] **Step 1: Failing tests** (explicit `now`, instants derived from it with day offsets):
  - 14 measured posts → `source: 'general'`; 15 → `'own'`; 20 posts with 6 unmeasured count as 14 → general (Review Focus 4).
  - `forceGeneral` with 40 posts → general.
  - A bucket with one post is excluded; two posts qualify.
  - Posts 91 days old are excluded; 89 days old included.
  - Weekday/hour use the workspace zone: `Asia/Karachi` post at 20:30Z lands on the next local weekday, hour 1.
  - DST: Sunday 09:00 local on both sides of the New York spring change (instants 14:00Z before, 13:00Z after) share one bucket with 2 posts.
  - Multiplier = bucket median ÷ channel median, 2 decimals (bucket median 6 over channel median 3 → `2`); channel median 0 divides by 1 (no `Infinity`/`NaN`); sorted desc with the tie order above; `windows` empty when no bucket qualifies yet the source is still `'own'` at 15 posts.
  - A platform with no research and fewer than 15 posts → `source: 'general'`, `windows: []`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: bucket by UTC hour; the Karachi test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(planner): own-data best-times maths`

---

### Task 20: Best-times endpoint and cache

**Files:**
- Create: `src/planner/services/best-times.service.ts`, `src/planner/planner-best-times.controller.ts`, `src/planner/lib/best-times-cache.ts`
- Modify: `src/planner/planner.module.ts` (import `PostPerformanceModule`)
- Test: `src/planner/lib/best-times-cache.spec.ts`, `src/planner/services/best-times.service.spec.ts`, `src/planner/planner-best-times.controller.spec.ts`

**Interfaces:**
- Consumes: Task 19 `resolveBestTimes`; Task 12 `PlannerPreferencesService.get` (`bestTimesSource`); Task 2 `loadWorkspaceTimezone`; `PostPerformanceRepository.publishedPosts` (all active social channels, last 90 days); `CHANNEL_CATEGORY`.
- Produces:
  - `class BestTimesCache<V>`: `constructor(ttlMs: number, maxEntries: number, now: () => number)`; `get(key: string, version: string): V | undefined` (miss when expired or `version` differs); `set(key: string, version: string, value: V): void` (FIFO eviction at `maxEntries`).
  - `BestTimesService.getForWorkspace(workspaceId: string, userId: string, now?: Date): Promise<BestTimesDto>` — see the contract. Per workspace: load tz, active social channels, the caller's `bestTimesSource`; the cache holds the own-data computation per `(workspaceId, tz)` for 6 hours (`ttlMs = 6 * 3600_000`, 500 entries) and its `version` is the latest `post_metric_snapshots.snapshot_at` (ms) across the workspace's social channels, so a new snapshot invalidates it; the user's `forceGeneral` is applied after the cache, so it never pollutes it. (Per workspace rather than per channel: one query pulls every channel's posts; the invalidation behaviour matches the spec.)
  - Route `GET /planner/workspaces/:workspaceId/best-times`, `posts:draft`.

- [ ] **Step 1: Failing tests**
  - Cache: hit within TTL; miss after TTL (inject clock); miss when version changes; eviction at capacity.
  - Service (fake repository, fake prefs): second call with unchanged snapshot version does not call `publishedPosts` again; a newer snapshot version recomputes; `bestTimesSource: 'general'` returns `general` without invalidating the cached own data; a workspace with no channels returns `{ timezone, channels: [] }`; a channel with zero posts returns `source: 'general'`, `postCount: 0`; a channel on a platform with no research returns `windows: []`; non-social channels (calendars, storage, Slack) are absent; invalid stored zone computes as UTC (Review Focus 1).
  - HTTP: GUEST → 200; non-member → 403; `workspaceId` not a uuid → 400.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Mutation: drop the version comparison; the "newer snapshot recomputes" test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `feat(planner): best-times endpoint with six-hour cache`

---

### Task 21: Whole-branch verification

**Files:** none (fixes only if something fails).

- [ ] **Step 1:** `npx jest` (full). The only failures allowed are the known pre-existing ones: `billing.controller.spec`, `evergreen.service.spec`, `drizzle/pool-config.spec`, `stripe/price-provisioning.spec`. Expected: everything else PASS, including `every-workspace-route-guarded.spec.ts` and `src/posts/workspace-guards.spec.ts`.
- [ ] **Step 2:** `PLANNER_DB_TESTS=1 npx jest planner posts calendar-sync campaigns insights post-performance --testPathPattern '\.db\.spec\.ts$'` against localhost. Expected: PASS; then confirm nothing leaked: `"C:/Program Files/PostgreSQL/17/bin/psql.exe" "$DATABASE_URL" -c "select to_regclass('public.calendar_notes')"` returns NULL.
- [ ] **Step 3:** `npm run build`, then `PORT=3999 timeout 90 node dist/src/main.js`. Expected: log line `Nest application successfully started` (Redis `ECONNREFUSED` noise is expected); then stop the process.
- [ ] **Step 4:** `npx eslint --no-fix` on every file this branch touched (`git diff --name-only origin/main...HEAD -- '*.ts'`) and compare with the `origin/main` baselines per V. Expected: no new errors.
- [ ] **Step 5:** `git log --oneline origin/main..HEAD` shows 20 commits, each ending in the required `Co-Authored-By` trailer.
- [ ] **Step 6:** Do not push. Report the migration numbers `0041`-`0044` so the product owner can apply them with the boot migrator before deploy.

---

## API contract

Single source of truth for the frontend. Base URL is the API root. Auth: bearer access token (existing). Every route below is behind `JwtAuthGuard` + `WorkspaceRoleGuard`; "Cap" is the required workspace capability (GUEST can `posts:draft` and `analytics:view`; MEMBER and above can `posts:publish`). Errors are standard Nest bodies `{ statusCode, message, error }`; refusals listed under "Codes" also carry `code`. Timestamps are ISO-8601 UTC strings. Dates `yyyy-MM-dd` are workspace-local calendar dates unless stated.

```ts
type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'partially_published';

interface PlannerUserRef { id: string; name: string; avatarUrl: string | null }

interface PostFailure { message: string; needsReconnect: boolean }

interface PlannerPostTarget {
  channelId: string;                 // numeric channel id as a string (unchanged)
  platform: string;                  // SupportedPlatform
  status: PostStatus;                // normalized: reads status AND publishStatus; published wins over failed
  platformPostId?: string;
  platformPostUrl?: string;
  publishedAt?: string;
  errorMessage?: string;
  errorCode?: 'rate_limited' | 'auth_failed' | 'media_invalid' | 'content_rejected' | 'transient' | 'permanent';
  destination?: { id: string; name?: string };
  contentOverride?: { text?: string; mediaItems?: MediaItem[]; metadata?: Record<string, unknown> };
  failure: PostFailure | null;       // non-null only when status === 'failed'
}

interface MediaItem {
  url: string; type: 'image' | 'video' | 'gif' | 'carousel';
  thumbnailUrl?: string; altText?: string; width?: number; height?: number; duration?: number;
}

interface PlannerPost {
  id: string;
  workspaceId: string;
  createdById: string;
  content: string | null;
  mediaItems: MediaItem[];
  targets: PlannerPostTarget[];
  status: PostStatus;                // stored value
  displayStatus: PostStatus;         // derived: 'partially_published' when targets mix published and failed. USE THIS for chips/filters.
  scheduledAt: string | null;
  publishedAt: string | null;
  occurredAt: string | null;         // publishedAt ?? scheduledAt: the instant the post sits on the calendar
  platformContent: Record<string, { text?: string; mediaItems?: MediaItem[]; metadata?: Record<string, unknown> }>;
  metadata: Record<string, unknown> & { title?: string; hashtags?: string[]; firstComment?: string };
  campaignId: string | null;         // = metadata.campaignId
  lastError: string | null;
  retryCount: string | null;
  createdAt: string;
  updatedAt: string;                 // "Edited …" and Drafts ordering
  author: PlannerUserRef;
  readyAt: string | null;             // non-null only for drafts marked ready
  readyBy: { id: string; name: string } | null;
}
```

### Posts

**GET `/posts/workspaces/:workspaceId/calendar?from=&to=`** (changed). Cap `posts:draft`.
- Query: `from`, `to` ISO-8601, both required, `from <= to`, span at most 100 days; else 400 (was 500).
- Response:
  ```ts
  interface PlannerCalendar {
    posts: PlannerPost[];                       // non-draft; range on occurredAt
    byDate: Record<string, PlannerPost[]>;      // key yyyy-MM-dd in the WORKSPACE zone (was UTC)
    total: number;
    timezone: string;                           // IANA, invalid stored zones come back as 'UTC'
  }
  ```

**GET `/posts/workspaces/:workspaceId/:postId`** (changed). Cap `posts:draft`. Response `{ post: PlannerPost }`; 404 when the id is not in this workspace.

**GET `/posts/workspaces/:workspaceId/drafts?limit=&cursor=`** (new). Cap `posts:draft`.
- Query: `limit` 1..100 (default 30), `cursor` opaque. Malformed cursor, bad limit: 400.
- Response `DraftsPage`: `{ drafts: PlannerPost[]; total: number; nextCursor: string | null }`. `status = 'draft'` only, ready first, then `updatedAt` desc. `total` is the topbar "Drafts · N".

**POST `/posts/workspaces/:workspaceId/:postId/ready`** (new). Cap `posts:draft`; a Viewer may act only on their own draft (else 403).
- Body: `{ ready: boolean }`. Response: `{ post: PlannerPost }` (200). 400 when the post is not a draft; 404 when not in this workspace. Does not change `updatedAt`. On the first `true` it notifies the workspace owner and every ADMIN/MEMBER except the caller with notification type `draft_ready`:
  ```ts
  interface DraftReadyNotification {            // existing notification row shape
    type: 'draft_ready'; title: 'Draft ready to schedule';
    message: string;                            // '<name> marked a draft ready: "<preview>"'
    actionUrl: string;                          // '/w/<workspaceId>/planner?post=<postId>'
    metadata: { workspaceId: string; postId: string; markedByName: string };
  }
  ```

**POST `/posts/workspaces/:workspaceId/:postId/duplicate`** (new). Cap `posts:draft` (a Viewer may duplicate any post in the workspace).
- Body: none. Response (201): `{ post: PlannerPost }`, a new draft: content, media, platformContent and channels kept; time, platform ids, errors, campaign and first-week tags dropped; `createdById` = caller. 404 when not in this workspace.

**DELETE `/posts/workspaces/:workspaceId/:postId`** (changed refusals, same route/cap `posts:draft`). A post that is partly published is now refused. Codes (HTTP 400, body also has `code`):
- `POST_ALREADY_PUBLISHED`: update or delete of a published post.
- `POST_PARTLY_PUBLISHED`: delete of a partly published post.
- `SCHEDULE_IN_PAST`: schedule/reschedule/undo to a time in the past (`PUT` with `scheduledAt`).

**Reused unchanged** (shapes as today): `PUT /posts/workspaces/:ws/:postId` with `{ scheduledAt: string | null }` (reschedule, schedule a draft, move to drafts; Viewer → 403; `targetChannelIds` must NOT be sent for moves), `POST /posts/workspaces/:ws/:postId/publish` (cap `posts:publish`; retries only the failed channels), `POST /composer/workspaces/:ws/...`. A Viewer sending `scheduledAt` gets 403 `Only members can schedule posts`.

### Planner

All under `/planner/workspaces/:workspaceId`, cap `posts:draft`.

**GET `/list?tab=&limit=&cursor=`**
- `tab`: `'upcoming' | 'published' | 'failed' | 'all'` (required). `limit` 1..100 (default 30). Posts only (no drip posts, no replies).
  - `upcoming`: scheduled from now on, plus publishing. Ascending. `published`: fully published. `failed`: failed plus partly published. `all`: every non-draft. Descending except `upcoming`.
- Response:
  ```ts
  interface PlannerList {
    rows: PlannerPost[];
    nextCursor: string | null;
    total: number;                              // unpaged size of the requested tab
    counts: { upcoming: number; failed: number }; // always present, for the tab badges
  }
  ```

**GET `/month-counts?year=2026`**: `year` 2000..2100 (no `tz`; the workspace zone is used).
```ts
interface MonthCounts { months: { month: number /* 1..12 */; count: number }[] } // always 12 entries
```

**GET `/next-post?after=<ISO>`** → `{ scheduledAt: string | null }`: the earliest non-draft post instant strictly after `after`.

**GET `/last-post-time?channelIds=1,2`** → `{ at: string | null }`: instant of the most recently created non-draft post on any listed channel. `channelIds` 1..50 integers. The client takes the time of day in the workspace zone ("Same time as your last post").

**Notes**: `GET` caps `posts:draft`; `POST`, `PATCH`, `DELETE` cap `posts:publish` (Viewers read notes only).
```ts
type NoteColor = 'amber' | 'blue' | 'green' | 'red';
interface PlannerNote { id: string; date: string /* yyyy-MM-dd */; body: string /* 1..500 */; color: NoteColor;
  author: { id: string; name: string } | null; updatedAt: string }
```
- `GET /notes?from=yyyy-MM-dd&to=yyyy-MM-dd` (span at most 100 days) → `PlannerNote[]`
- `POST /notes` body `{ date: string; body: string; color: NoteColor }` → 201 `PlannerNote`; 409 `A note for this day already exists`; 400 on an impossible date.
- `PATCH /notes/:id` body `{ body?: string; color?: NoteColor }` → `PlannerNote`
- `DELETE /notes/:id` → `{ message: string }`. Undo = `POST` again.

**Preferences** (per user, per workspace):
```ts
interface PlannerPrefs {
  postSize: 'comfortable' | 'compact';
  colorBy: 'status' | 'channel' | 'campaign';
  show: { media: boolean; campaigns: boolean; notes: boolean; events: boolean; weekends: boolean };
  publishedPosts: 'show' | 'fade' | 'hide';
  weekStartsOn: 0 | 1;                          // 0 = Sunday
  visibleCalendarIds: string[] | null;          // ExternalCalendar.id values; null = all visible
  eventDisplay: 'full' | 'busy';
  bestTimesInWeek: boolean;                     // default false
  bestTimesSource: 'own' | 'general';           // default 'own'
  suggestBestTime: boolean;                     // default true
}
type PlannerPrefsPatch = DeepPartial<PlannerPrefs>; // every field optional; show merges per key; visibleCalendarIds: null resets to all
```
- `GET /preferences` → `PlannerPrefs` (defaults filled). `PUT /preferences` body `PlannerPrefsPatch` → `PlannerPrefs` (merged). Unknown keys → 400.

**GET `/best-times`**
```ts
interface BestTimes {
  timezone: string;
  channels: {
    channelId: number;                          // NOTE: number (matches the channels API and insights), unlike target.channelId
    platform: string;
    source: 'own' | 'general';                  // 'general' = curated industry table, never the user's data
    postCount: number;                          // measured posts in the window
    windowDays: 90;
    windows: { weekday: number /* 0=Sun */; hour: number /* 0-23, workspace zone */;
               multiplier: number | null /* null when source is 'general' */ }[]; // best three first
  }[];
}
```
Honours the caller's `bestTimesSource` preference. A platform with no published research returns `windows: []` with `source: 'general'`.

### Campaigns

**GET `/campaigns/workspaces/:workspaceId/spans?from=&to=`**: cap `posts:draft`; `from`, `to` ISO; span at most 400 days. Non-draft campaigns overlapping the window.
```ts
interface CampaignSpan {
  id: string; name: string;
  type: 'bulk' | 'drip' | 'evergreen';
  status: 'scheduled' | 'active' | 'paused' | 'completed' | 'failed';
  startDate: string;                  // yyyy-MM-dd, WORKSPACE zone, from the first slot instant
  endDate: string | null;             // workspace zone; null = open-ended
  timezone: string;                   // the campaign's own zone (decides when slots fire only)
  channelIds: string[];
  postsPlanned: number; postsPublished: number;
  nextPostAt: string | null;          // next scheduled slot instant
  cadence: { kind: 'daily' | 'weekdays' | 'custom'; weekdays: number[] /* 0=Sun */; times: string[] /* HH:mm */ };
}
```
Response is `CampaignSpan[]`.

### Calendar sync

**GET `/calendar-sync/workspaces/:workspaceId/calendars`** (new): cap `posts:draft`.
```ts
interface ExternalCalendar { id: string; channelId: number; provider: 'google' | 'outlook';
  accountEmail: string | null; name: string; color: string | null; isPrimary: boolean }
```
Response `ExternalCalendar[]`. `channelId` drives Reconnect/Disconnect through the existing channels API.

**GET `/calendar-sync/workspaces/:workspaceId/external-events?from=&to=`** (changed): cap `posts:draft`; `from`, `to` ISO required. Now includes events from every calendar of each connection.
```ts
interface ExternalEvent {
  id: string; provider: 'google' | 'outlook'; title: string;
  startsAt: string; endsAt: string; isAllDay: boolean; htmlLink?: string;
  calendarId: string | null;          // ExternalCalendar.id; null only until the connection's next sync
  calendarName: string; calendarColor: string | null;
  accountEmail: string | null; attendeeCount: number | null;
}
```
For `isAllDay`, take the calendar date from the UTC date of `startsAt` and treat `endsAt` as exclusive; do NOT convert it into the workspace zone.

### Inbox

**GET `/inbox/workspaces/:workspaceId/scheduled?from=&to=`** (changed): existing route and capability; adds optional ISO `from`/`to` bounding `scheduledAt`. Without them the result is unchanged.

### Insights

**GET `/insights/workspaces/:workspaceId/posts/metrics?postIds=a,b`**: cap `analytics:view` (GUEST+); 1..50 uuids, else 400. Posts of other workspaces yield no rows.
```ts
interface PostChannelMetrics {
  postId: string; channelId: number;
  views: number | null; likes: number | null; comments: number | null;  // 'Views' = impressions
  engagements: number;                       // likes + comments + shares
  usualMultiplier: number | null;            // engagements / channel's 90-day median; null below 5 measured posts or when the median is 0
}
```
Response `{ metrics: PostChannelMetrics[] }`, one entry per (post, published channel).
