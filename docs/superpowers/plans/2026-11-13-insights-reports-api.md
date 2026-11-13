# Insights Reports API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved Insights reports that a workspace shares by public link, downloads as a PDF, and emails weekly or monthly, with every number computed fresh from the Phase 1 and 2 services.

**Architecture:**
- A new `insight_reports` table stores settings, never numbers. Everything lives in `src/insights/reports/` inside `InsightsModule`, because the payload calls `InsightsService` and `AudienceService` directly.
- `ReportPayloadService.payload(workspaceId, settings, now)` resolves the period, calls `overview` / `signals` / audience `growth` + `channels` with a `ResolvedPeriod`, and keeps only the chosen sections' keys (`SECTION_FIELDS`).
- Public reads go through `/reports/public/:token` (share token, throttled), `/reports/render/:token` (5-minute JWT, for Gotenberg) and `/reports/unsubscribe/:token` (HTML).
- PDFs come from a Gotenberg service printing the frontend's `/r/:renderToken?print=1`. Sends run on a new `reports` BullMQ queue, fed by a 15-minute cron and by Send now.

**Tech Stack:** NestJS 11, Drizzle (Postgres), BullMQ, `@nestjs/schedule`, `@nestjs/throttler` 6, `@nestjs/jwt`, Resend 6.7, class-validator, Jest 30, Node 22 global `fetch`/`FormData`.

**Spec:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-frontend-audience\docs\superpowers\specs\2026-11-13-insights-reports-design.md`. Appendix A is the contract shared with the frontend plan: do not rename or reshape anything in it. Read §6–§9, §13 and Appendix A before any task.

**Worktree:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace-audience`, branch `feat/insights-reports-api`, base `a67eda5` (= origin/main).

## Global Constraints

**Environment**
- `node_modules` is already present in the worktree. Never `npm install`, never add a dependency to `package.json`.
- Never edit `.env`. `.env.example` may gain commented lines (Task 9).
- **Tests never reach a live platform API, Resend, Gotenberg or a prod DB.** HTTP clients take a `fetchImpl`; `EmailService` and `GotenbergClient` are faked in every service spec.
- **DB specs** use `describeDb` + `withRollbackDb` from `src/planner/testing/rollback-db.ts` and the seeders in `src/inbox/testing/inbox-db.ts`, exactly like `src/drizzle/schema/channel-audience.db.spec.ts`. They run only with `PLANNER_DB_TESTS=1`, against the local Postgres from `../socialmedia-workspace/.env` (the harness refuses any non-local host), with `--runInBand`.

**Product rules**
- No LLM anywhere in this code path. "In brief" is the existing rule-based `overview.brief`.
- A number the app would not show never appears: missing totals in email are `—`, never `0`.
- The public payload never carries `workspaceId`, and never another channel than the report's (see Review Focus 3 and 4).
- Exact strings this backend emits:
  - 404 body for an unknown or turned-off token: `{ message: 'This report link is off' }`.
  - 503 body without Gotenberg: `{ message: "PDF export isn't set up on this server." }`.
  - `last_error` and 409 when every channel is gone: `No channels left in this report`.
  - 409 for Send now with nobody to send to: `This report has no one to send to`.
- **"Disconnected" means deleted.** The app's Disconnect (`ChannelService.deleteChannel`) deletes the channel row. A channel whose token merely expired (`connection_status` ≠ `connected`) stays in the report, as it stays on the Insights page.

**Contract details Appendix A leaves open** (the frontend plan must mirror these):
- `GET /` returns a bare `ReportDto[]`, newest `created_at` first.
- `POST /` → 201 `ReportDto`. `PATCH /:id` → 200 `ReportDto`. `DELETE /:id` → 204.
- `POST /:id/share` → 200 `{ url: string | null }`.
- `POST /:id/send` → 202 `{ recipients: number }`.
- `POST /preview` → 200 `ReportPayloadDto`.
- Public, render and preview answer 409 `{ message: 'No channels left in this report' }` when none of the stored channels exists any more.

**Queue**
- New queue `QUEUES.REPORTS = 'reports'`, job name `report-send`.
- **BullMQ job ids contain no `:`.** Slot: `report-${id}-${YYYYMMDDHHmm of next_run_at, UTC}`. Send now: `report-${id}-now-${epochSeconds}`.
- Defaults from `QueueModule` apply: 3 attempts, exponential backoff from 1 s.

**Migration**
- `drizzle/migrations/0064_insight_reports.sql`, hand-written in the style of `0062_channel_audience.sql`:
  - a header with WHY, SAFETY, LOCKS AND COST, ROLLBACK;
  - `SET LOCAL lock_timeout = '10s'` first;
  - `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`;
  - no BEGIN/COMMIT.
- Before committing, re-check that no remote branch took 0064:
  `git for-each-ref refs/remotes --format='%(refname:short)' | xargs -I{} git ls-tree --name-only {} drizzle/migrations/ | grep 0064` (empty on 2026-11-13).

**Verification (every task)**
- Its own specs, plus `npx tsc --noEmit -p tsconfig.json`.
  - The baseline on `a67eda5` is **35 errors, all in 17 unrelated spec files**. After each task the count stays 35, and this prints nothing:
    `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | grep -E "src/(insights|email|queue|workspace|drizzle|first-week)/"`.
  - Spec files are typechecked by this command: a `.spec.ts` that jest passes but tsc rejects is a failure.
- Lint only the touched files: `npx eslint <files>` and `npx prettier --check <files>`. Never `npm run lint`, which `--fix`es the whole repo.
- Keep each file's line endings (most of `src` is CRLF; check with `file <path>` before editing).
- Suites already failing on main (pool-config, billing.controller, price-provisioning, evergreen.service) are not this branch's to fix.

**Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

### Verified against the code (2026-11-13)

These are decisions the recon left open. Each is settled here; tasks rely on them.

1. **92-day windows.** `usual.ts` (`lookbackStartOf`, `periodUsual`, `validStretches`), `series.ts` (`daySeries`), `breakdown.ts`, `brief-inputs.ts` and `LANE_CAP` (a post count, 500) are all generic in `n`. The only 90-day bound is `MAX_CUSTOM_DAYS` in `query.ts`, and it is used only by `parsePeriod`. A 92-day `ResolvedPeriod` passed straight to `overview` works; the lookback grows to 181 days. Reports therefore build their own `ResolvedPeriod` with `customWindow` and never go through `parsePeriod`. Only doc comments change (Task 2).
2. **`signals` requires a user.** `signals(workspaceId, userId: string, …)` passes `userId` to `hiddenSteps`. It is widened to `string | null` (Task 2).
3. **Every channel gone is a leak.** `parseChannels(raw, allowed)` returns **all** allowed channels when `raw` is `''`. Passing `[].join(',')` to `overview` would put every channel of the workspace in a client's report. The payload service narrows first and throws `NoChannelsLeftError` before any Insights call (Task 6).
4. **Logo URLs.** `media_items.file_url` (with `workspace_id`, `type`, `mime_type`, `is_deleted`) is what the Brand Kit and the publishers use. It is a public, unsigned URL (Cloudinary `secure_url`, or R2 under `CLOUDFLARE_R2_PUBLIC_URL`) and is permanent while the row lives.
   - A binned item is purged after 30 days, file included. So a binned item reads as no logo, as in `BrandKitService.logo`.
   - The FK is `ON DELETE SET NULL`.
   - Caveat for the owner: with `CLOUDFLARE_R2_PUBLIC_URL` unset, R2 falls back to the private S3 endpoint, which no anonymous viewer can load.
5. **Tokens.** Reuse the `TikTokMediaProxyService` pattern: `JwtModule.register({})` + `jwtService.sign(payload, { secret: JWT_ACCESS_SECRET, expiresIn })`.
   - Each token kind gets its own `audience` claim (`report-render`, `report-unsubscribe`). A login access token (no `aud`) can never verify as either.
   - A render token used as a Bearer fails `JwtStrategy.validate` (no `sub`).
   - Ruled out: the `zip-ticket.ts` HMAC pattern, which needs a new required secret env var.
6. **Throttling.** It needs `@UseGuards(ThrottlerGuard)` + `@Throttle({ default: { limit: 60, ttl: 60_000 } })` on the route (as in `auth.controller.ts`). There is no global ThrottlerGuard; `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])` is global.
   - Caveat, not fixed here: `main.ts` never sets `trust proxy`, so behind Railway every caller shares the edge IP for every throttled route in the app.
7. **Time zones.** `package.json` has no date library. `luxon` is only a transitive dependency of `cron`, so it is not importable safely. Reuse the in-repo, DST-tested helpers re-exported by `src/planner/lib/workspace-time.ts`: `wallClockToUtc`, `localDateOf`, `addDays`, `safeTimeZone`, `loadWorkspaceTimezone`. Planner, campaigns, recurrence and Insights' `next-free-slot` already use them.
8. **Team.** Owner = `workspace.owner_id`. Members = `workspace_invitations` rows with `status = 'ACCEPTED'` and `user_id` not null, joined to `users` (`email`, `name`, `is_active`). `WorkspaceMembersService.getMembers` needs a request user and is not usable from a job.
9. **Time zone changes** are written only by `WorkspaceService.update` (`src/workspace/workspace.service.ts`), with `...updateWorkspaceDto`. That is the hook point (Task 11).
10. **Launch gate.** `AllowlistGuard` (APP_GUARD) blocks a request that carries the Bearer of a non-allowlisted user. The public controller gets `@SkipLaunchGate()`.

## Review Focus

1. **A share link turned off.** The old URL 404s at once on `/reports/public/:token`. A render token minted before the change keeps working for its 5 minutes and no longer. Tested in Task 8.
2. **Timezone and DST.**
   - A weekly 9:00 AM send in `America/New_York` stays at 9:00 local across 2026-11-01 and 2027-03-14.
   - "Last month" uses the workspace zone's month: Los Angeles at 2026-11-30 19:00 local is still November, so it gets October.
   - Tested in Task 1.
3. **A deleted channel in `channel_ids`.** The report drops it and still sends. When every channel is gone, nothing is sent, no Insights call is made (no all-channels fallback), and `last_error = 'No channels left in this report'`, with `next_run_at` advanced. Tested in Tasks 6 and 11.
4. **A public payload leak.** A report with only `totals` has an `overview` of exactly `kpis, usual, window, compare, timezone, days, channelIds`, with `signals` and `audience` null. The serialized JSON contains no `series`, `channels`, `standout`, `workspaceId` or the workspace's uuid, and `overview.channelIds` excludes the workspace's other channels. Tested in Task 6.
5. **A signed-out visitor on `/r/:token`.** The public route answers 200 with no `Authorization` header, and with a garbage or non-allowlisted Bearer. It never 401s, so the page never trips a refresh. Tested in Task 8.

---

### Task 1: Report time maths (pure)

**Files:**
- Create: `src/insights/reports/lib/report-period.ts`
- Create: `src/insights/reports/lib/next-run.ts`
- Modify: `src/insights/lib/query.ts`: export the existing private `parseIsoDate` (no behaviour change).
- Test: `src/insights/reports/lib/report-period.spec.ts`, `src/insights/reports/lib/next-run.spec.ts`

**Interfaces:**
- Consumes:
  - `windowOf`, `customWindow`, `spanDays`, `utcToday`, `isoDate`, `addDays` from `src/post-performance/period.ts`;
  - `localDateOf`, `wallClockToUtc`, `safeTimeZone` from `src/planner/lib/workspace-time.ts`;
  - `ResolvedPeriod` from `src/insights/lib/query.ts`.
- Produces (`report-period.ts`):
  - `export const MAX_REPORT_DAYS = 92`
  - `export type ReportPeriodInput = { period: ReportPeriod; customFrom: string | null; customTo: string | null }`. `ReportPeriod` is declared locally here as the union and re-exported by Task 4's `reports.dto.ts`.
  - `export function resolveReportPeriod(p: ReportPeriodInput, timeZone: string, now: Date): ResolvedPeriod`
  - `export function assertCustomRange(from: string | null, to: string | null, now: Date): void`, which throws `BadRequestException`.
- Produces (`next-run.ts`):
  - `export interface ScheduleClock { cadence: 'weekly' | 'monthly'; weekday: number | null; sendMinute: number }`
  - `export function nextRunAt(s: ScheduleClock, timeZone: string, after: Date): Date`
  - `export function slotJobId(reportId: string, dueAt: Date): string`
  - `export function sendNowJobId(reportId: string, now: Date): string`

**Rules:**
- `last_7_days` / `last_30_days`: `windowOf(utcToday(now), n)`, the Insights page's own window, so the numbers match the app.
- `last_month` / `last_quarter`:
  - The month or quarter before the one that contains `localDateOf(now, timeZone)`.
  - `to` is clamped to UTC yesterday (`addDays(isoDate(utcToday(now)), -1)`): rollup days are UTC days, and today's is still being written.
  - `window = customWindow(from, to)`, `days = spanDays(from, to)`, so "previous" is the equal-length span just before (spec §4).
- `custom`: `customWindow(customFrom, customTo)` as stored. A fixed range never expires.
- `assertCustomRange` messages, in check order:
  1. `A custom range needs customFrom and customTo`
  2. `customFrom and customTo must be dates, YYYY-MM-DD` (via `parseIsoDate`)
  3. `customFrom must be on or before customTo`
  4. `customTo must be yesterday or earlier` (UTC yesterday)
  5. `A report range can be at most 92 days`
- `nextRunAt` returns the first instant **strictly after** `after` whose wall clock in `safeTimeZone(timeZone)` is `sendMinute`:
  - weekly: on `weekday` (0 = Sunday);
  - monthly: on the 1st.
  - Scan local dates from `localDateOf(after, tz)` and convert each with `wallClockToUtc(date, 'HH:mm', tz)`. Weekly needs at most 8 dates; monthly, this month's 1st, then next month's.

- [ ] **Step 1: Write the failing tests.**

  `report-period.spec.ts`:
  ```ts
  it('last_7_days is the Insights window')
    // now 2026-11-13T10:00Z → { days: 7, window: windowOf(utcToday(now), 7) }, from 2026-11-06, to 2026-11-12
  it('last_month is the previous calendar month in the workspace zone')
    // Asia/Karachi, now 2026-12-01T04:00Z → from 2026-11-01, to 2026-11-30, days 30, previousFrom 2026-10-02, previousTo 2026-10-31
  it('last_month reads the zone\'s month, not UTC\'s')            // Review Focus 2
    // America/Los_Angeles, now 2026-12-01T03:00Z (Nov 30 local) → 2026-10-01..2026-10-31, days 31
  it('last_month ends at UTC yesterday when the zone is already in the next month')
    // Pacific/Auckland, now 2026-11-30T20:00Z (Dec 1 local) → 2026-11-01..2026-11-29, days 29
  it('last_quarter is the previous calendar quarter, 92 days for Q3')
    // UTC, now 2026-10-01T09:00Z → 2026-07-01..2026-09-30, days 92
  it('last_quarter in January is Q4 of the year before')
    // UTC, now 2027-01-15T09:00Z → 2026-10-01..2026-12-31, days 92
  it('custom uses the stored dates')
    // 2026-07-01..2026-09-30 → days 92, window = customWindow(...)
  it.each([
    [null, '2026-10-01', 'A custom range needs customFrom and customTo'],
    ['2026-02-30', '2026-03-01', 'customFrom and customTo must be dates, YYYY-MM-DD'],
    ['2026-10-02', '2026-10-01', 'customFrom must be on or before customTo'],
    ['2026-11-01', '2026-11-13', 'customTo must be yesterday or earlier'],   // now 2026-11-13T10:00Z
    ['2026-07-01', '2026-10-01', 'A report range can be at most 92 days'],   // 93 days
  ])('assertCustomRange(%s, %s) → 400 %s')
  it('accepts exactly 92 days ending yesterday')   // 2026-08-13..2026-11-12 at now 2026-11-13T10:00Z
  ```

  `next-run.spec.ts` (all values checked against `wallClockToUtc` on 2026-11-13):
  ```ts
  const weekly = (weekday: number, sendMinute = 540) => ({ cadence: 'weekly' as const, weekday, sendMinute })
  const monthly = (sendMinute = 540) => ({ cadence: 'monthly' as const, weekday: null, sendMinute })
  it('a weekly Monday 9:00 New York send stays at 9:00 local across the November change')  // Review Focus 2
    // nextRunAt(weekly(1), 'America/New_York', new Date('2026-10-26T13:00:00Z')) → 2026-11-02T14:00:00.000Z
  it('... and across the March change')
    // after 2027-03-08T14:00:00Z → 2027-03-15T13:00:00.000Z
  it('later the same day when the slot is still ahead')
    // weekly(5), 'Asia/Karachi', after 2026-11-13T03:00Z (Fri 08:00) → 2026-11-13T04:00:00.000Z
  it('is strictly after: a send at its own slot moves a week on')
    // weekly(5), Karachi, after 2026-11-13T04:00:00Z → 2026-11-20T04:00:00.000Z
  it('monthly is the 1st of the next month')
    // monthly(), Karachi, after 2026-11-13T00:00Z → 2026-12-01T04:00:00.000Z
  it('monthly rolls over the year')
    // after 2026-12-01T04:00:00Z → 2027-01-01T04:00:00.000Z
  it('a slot inside a spring-forward gap still lands on that local date')
    // weekly(0, 150) (02:30), New York, after 2027-03-13T12:00Z → localDateOf(result, tz) === '2027-03-14'
  it('an invalid zone is UTC')   // monthly(0), 'Not/AZone', after 2026-11-13 → 2026-12-01T00:00:00.000Z
  it('slotJobId has no colon')    // slotJobId(id, new Date('2026-12-01T04:00:00Z')) === `report-${id}-202612010400`
  it('sendNowJobId has no colon') // `report-${id}-now-1794571200` for 2026-11-13T12:00:00Z
  ```
- [ ] **Step 2:** `npx jest src/insights/reports/lib`. Expected: FAIL, modules not found.
- [ ] **Step 3:** Implement both files and export `parseIsoDate`.
- [ ] **Step 4:** Re-run: PASS. Then `npx jest src/insights/lib/query.spec.ts` (unchanged, PASS) and tsc.
- [ ] **Step 5:** Commit `feat(insights): report period and send-time maths`.

### Task 2: Insights entry points accept a report

**Files:**
- Modify: `src/insights/insights.service.ts`:
  - `signals(workspaceId, userId: string | null, channels, now?)`, passed through `nextStepsOf` (its param becomes `string | null`).
  - `hiddenSteps(workspaceId, userId: string | null, now)` returns `new Set()` without a query when `userId === null`.
- Modify doc comments only:
  - `ResolvedPeriod.days` in `src/insights/lib/query.ts`: "7, 30 or 90 for a preset, 1 to 90 when picked, 1 to 92 from a report".
  - `InsightsOverviewDto.days` in `src/insights/dto/insights.dto.ts`, the same.
  - Leave `MAX_CUSTOM_DAYS = 90`: the Insights page keeps its cap.
- Test: `src/insights/insights.service.spec.ts` (extend; reuse its `fakeDb`, `repoWith`, `post`, `NOW`).

**Interfaces:**
- Produces: `InsightsService.signals(workspaceId: string, userId: string | null, channels: string | undefined, now?: Date): Promise<InsightsSignalsDto>`. The controller still passes `user.userId`.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it('takes a 92-day report window: 92 series days and a usual from the 181-day lookback')
    // period { days: 92, window: customWindow('2026-06-30', '2026-09-29') } at NOW 2026-09-30
    // → o.days 92, o.series.length 92, o.series[0].date '2026-06-30', o.window.previousFrom '2026-03-30'
    // and repo.publishedPosts called with from = lookbackStartOf('2026-06-30', 92) ('2025-12-31')
  it('signals with no user reads no hidden steps')
    // (svc as any).hiddenSteps('ws1', null, NOW) resolves to an empty Set, and db.select is never called
  ```
- [ ] **Step 2:** `npx jest src/insights/insights.service.spec.ts`. Expected: the first test passes already (it pins verified fact 1); the second FAILS (or fails to typecheck) on `null`.
- [ ] **Step 3:** Widen the two signatures and update the comments.
- [ ] **Step 4:** `npx jest src/insights` and tsc. Expected: PASS, controller spec unchanged.
- [ ] **Step 5:** Commit `feat(insights): overview takes 92-day report windows; signals without a user`.

### Task 3: `insight_reports` table

**Files:**
- Create: `drizzle/migrations/0064_insight_reports.sql`
- Create: `src/drizzle/schema/insight-reports.schema.ts`
- Modify: `src/drizzle/schema/index.ts`, adding `export * from './insight-reports.schema';`.
- Modify: `src/drizzle/migrate/inbox-lock-timeout.spec.ts`. Append `'0064_insight_reports.sql'` to `FILES`, and add to the doc comment: "0064 creates insight_reports with foreign keys to workspace, media_items and users (SHARE ROW EXCLUSIVE on each)."
- Test: `src/drizzle/schema/insight-reports.db.spec.ts`

**Columns** (spec §8; `"insight_reports"`):

| Column | SQL | Notes |
|---|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT gen_random_uuid()` | |
| `workspace_id` | `uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE` | |
| `name` | `text NOT NULL` | CHECK `char_length(name) BETWEEN 1 AND 80` |
| `channel_ids` | `integer[] NOT NULL` | CHECK `cardinality(channel_ids) >= 1` |
| `period` | `text NOT NULL` | CHECK IN (`last_7_days`,`last_30_days`,`last_month`,`last_quarter`,`custom`) |
| `custom_from`, `custom_to` | `date` | CHECK `period <> 'custom' OR (custom_from IS NOT NULL AND custom_to IS NOT NULL AND custom_to - custom_from BETWEEN 0 AND 91)` |
| `compare` | `text NOT NULL` | CHECK IN (`usual`,`previous`,`none`) |
| `chart_metric` | `text NOT NULL` | CHECK IN (`reach`,`views`,`engagements`) |
| `sections` | `text[] NOT NULL` | CHECK `cardinality(sections) >= 1` |
| `note` | `text` | CHECK `note IS NULL OR char_length(note) <= 500` |
| `logo_media_id` | `uuid REFERENCES "media_items"("id") ON DELETE SET NULL` | |
| `opted_out` | `text[] NOT NULL DEFAULT '{}'` | |
| `share_token` | `text UNIQUE` | |
| `cadence` | `text` | CHECK `cadence IS NULL OR cadence IN ('weekly','monthly')` |
| `weekday` | `smallint` | CHECK `weekday IS NULL OR weekday BETWEEN 0 AND 6` |
| `send_minute` | `smallint` | CHECK `send_minute IS NULL OR (send_minute BETWEEN 0 AND 1439 AND send_minute % 15 = 0)` |
| `send_to_team` | `boolean NOT NULL DEFAULT false` | |
| `recipients` | `text[] NOT NULL DEFAULT '{}'` | CHECK `cardinality(recipients) <= 10` |
| `attach_pdf` | `boolean NOT NULL DEFAULT true` | |
| `next_run_at` | `timestamptz` | |
| `last_sent_at` | `timestamptz` | |
| `last_error` | `text` | |
| `created_by`, `updated_by` | `uuid REFERENCES "users"("id") ON DELETE SET NULL` | |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` | timestamptz: the mixed-column trap |

- **Schedule shape CHECK:**
  `(cadence IS NULL AND weekday IS NULL AND send_minute IS NULL) OR (cadence = 'weekly' AND weekday IS NOT NULL AND send_minute IS NOT NULL) OR (cadence = 'monthly' AND weekday IS NULL AND send_minute IS NOT NULL)`
- **Indexes:**
  - `insight_reports_workspace_idx (workspace_id, created_at DESC)`;
  - `insight_reports_due_idx (next_run_at) WHERE cadence IS NOT NULL`;
  - the share_token UNIQUE.
- **Drizzle:**
  - `date(..., { mode: 'string' })` for the custom dates;
  - `integer('channel_ids').array()`, `text(...).array()`;
  - `timestamp(..., { withTimezone: true })`.
  - Export `insightReports`, `type InsightReportRow = typeof insightReports.$inferSelect`, `type NewInsightReportRow = typeof insightReports.$inferInsert`.
  - The CHECKs live in the SQL only, as in 0059.

- [ ] **Step 1: Write the failing DB spec,** following `channel-audience.db.spec.ts` (`withRollbackDb(['0064_insight_reports.sql'], …)`, `seedWorkspace`, `seedChannel`):
  - Insert a full weekly report, read it back, and assert the arrays, `custom_from` as `'2026-07-01'`, and `next_run_at` as a Date.
  - `it.each` of rows each violating one CHECK, each expected to reject:
    - an 81-char name;
    - a custom range of 93 days;
    - custom without `custom_to`;
    - 11 recipients;
    - weekly with `weekday` null;
    - monthly with `weekday` 1;
    - `send_minute` 7;
    - `channel_ids` `{}`;
    - `sections` `{}`;
    - `period` `'yesterday'`.
  - Two rows with the same `share_token` are rejected. Two rows with null `share_token` are both fine.
  - Deleting the media item sets `logo_media_id` null. Deleting the workspace removes the report.
  - Applying the file again is a no-op (idempotent).
- [ ] **Step 2:** `PLANNER_DB_TESTS=1 npx jest src/drizzle/schema/insight-reports.db.spec.ts --runInBand`. Expected: FAIL (file missing).
- [ ] **Step 3:** Write the migration (header as in 0062, ROLLBACK `DROP TABLE IF EXISTS insight_reports;`) and the schema.
- [ ] **Step 4:** Re-run with the flag: PASS. Run `npx jest src/drizzle/migrate/inbox-lock-timeout.spec.ts` (no DB needed): PASS. Run tsc.
- [ ] **Step 5:** Commit `feat(db): 0064 insight_reports, saved Insights reports`.

### Task 4: Contract types, request DTOs, settings normalisation

**Files:**
- Create: `src/insights/reports/reports.dto.ts` (Appendix A, verbatim names)
- Create: `src/insights/reports/dto/report-settings.dto.ts` (class-validator)
- Create: `src/insights/reports/lib/normalize-settings.ts`
- Test: `src/insights/reports/lib/normalize-settings.spec.ts`, `src/insights/reports/dto/report-settings.dto.spec.ts`

**Interfaces:**
- Produces, in `reports.dto.ts`:
  - `REPORT_PERIODS`, `REPORT_COMPARES`, `REPORT_CHART_METRICS`, `REPORT_CADENCES` as `const` tuples, and `REPORT_SECTIONS` in canonical order (`brief, totals, main_chart, channels, what_works, stood_out, best_time, audience, how_we_count`).
  - The types `ReportPeriod`, `ReportCompare`, `ReportChartMetric`, `ReportSection`, and the interfaces `ReportSchedule`, `ReportSettings`, `ReportPerson`, `ReportDto`, `ReportPayloadDto`, all exactly as in Appendix A. `overview` is typed `Partial<InsightsOverviewDto> | null`; `signals` and `audience` use `InsightsSignalsDto` / `AudienceGrowthDto` / `AudienceChannelsDto`.
  - `MAX_REPORT_RECIPIENTS = 10`, `MAX_REPORT_NAME = 80`, `MAX_REPORT_NOTE = 500`.
- Produces, in `report-settings.dto.ts`:
  - `ReportScheduleDto`:
    - `cadence`: `@IsIn(REPORT_CADENCES)`;
    - `weekday`: `@IsOptional() @IsInt() @Min(0) @Max(6)`;
    - `sendMinute`: `@IsInt() @Min(0) @Max(1425) @IsDivisibleBy(15)`;
    - `sendToTeam`: `@IsBoolean()`;
    - `recipients`: `@IsArray() @ArrayMaxSize(10) @IsEmail({}, { each: true })`;
    - `attachPdf`: `@IsBoolean()`.
  - `CreateReportDto`:
    - `name`: `@IsString() @MaxLength(80)`;
    - `channelIds`: `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsInt({ each: true })`;
    - `period`: `@IsIn`;
    - `customFrom`, `customTo`: `@IsOptional() @IsString()`;
    - `compare`, `chartMetric`: `@IsIn`;
    - `sections`: `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsIn(REPORT_SECTIONS, { each: true })`;
    - `note`: `@IsOptional() @IsString() @MaxLength(500)`;
    - `logoMediaId`: `@IsOptional() @IsUUID()`;
    - `schedule`: `@IsOptional() @ValidateNested() @Type(() => ReportScheduleDto)` (null allowed).
  - `UpdateReportDto`: the same fields, each `@IsOptional()`. The repo has no `@nestjs/mapped-types`, so the class is written out.
  - `PreviewReportDto extends CreateReportDto`.
  - `ShareReportDto { @IsBoolean() enabled }`.
- Produces, in `normalize-settings.ts`: `export function normalizeSettings(input: ReportSettings, now: Date): ReportSettings`, pure, throwing `BadRequestException`:
  - `name` is trimmed; empty → `Give the report a name`.
  - `channelIds` are de-duplicated, keeping first-seen order.
  - `sections` are de-duplicated and put in canonical order.
  - Custom: `assertCustomRange(customFrom, customTo, now)`. Any other period stores both dates as `null`.
  - `note` is trimmed; `''` → `null`.
  - A weekly schedule without `weekday` → `Pick a weekday for a weekly report`. Monthly forces `weekday: null`.
  - `recipients` are trimmed, lowercased and de-duplicated.

- [ ] **Step 1: Write the failing tests:**
  - `normalize-settings.spec.ts`:
    - sections `['how_we_count','totals','brief','totals']` → `['brief','totals','how_we_count']`;
    - recipients `[' Sara@Acme.com','sara@acme.com','b@x.io']` → `['sara@acme.com','b@x.io']`;
    - `period: 'last_month'` with `customFrom` set → both dates `null`;
    - `name: '   '` → 400 `Give the report a name`;
    - weekly with `weekday: null` → 400;
    - monthly with `weekday: 3` → `weekday: null`;
    - a 93-day custom range → 400 `A report range can be at most 92 days`;
    - `note: '  '` → `null`.
  - `report-settings.dto.spec.ts`, with `plainToInstance` + `validate`:
    - `sendMinute: 7` is invalid;
    - 11 recipients are invalid;
    - `sections: ['goals']` is invalid;
    - `channelIds: []` is invalid;
    - `channelIds: ['1']` is invalid (strings);
    - a valid full body has no errors;
    - `UpdateReportDto` `{}` has no errors;
    - `UpdateReportDto` `{ schedule: null }` has no errors.
- [ ] **Step 2:** Run them: FAIL.
- [ ] **Step 3:** Implement the three files.
- [ ] **Step 4:** Run them: PASS. Run tsc.
- [ ] **Step 5:** Commit `feat(insights): report contract types, DTOs and settings rules`.

### Task 5: Reports repository

**Files:**
- Create: `src/insights/reports/reports.repository.ts`
- Create: `src/insights/reports/lib/report-dto.ts`
- Test: `src/insights/reports/reports.repository.db.spec.ts` (local PG), `src/insights/reports/lib/report-dto.spec.ts`

**Interfaces:**
- Consumes: `insightReports` (Task 3); `ReportSettings`, `ReportDto`, `ReportPerson` (Task 4).
- Produces, in `report-dto.ts`:
  - `export interface ReportRecord { row: InsightReportRow; logoUrl: string | null; createdBy: ReportPerson | null; updatedBy: ReportPerson | null }`
  - `export function settingsOf(row: InsightReportRow): ReportSettings`. `schedule` is null when `cadence` is null.
  - `export function toReportDto(r: ReportRecord, ctx: { socialIds: ReadonlySet<number>; teamSize: number; frontendUrl: string }): ReportDto`:
    - `channelIds` are narrowed to `socialIds`, keeping stored order;
    - `shareUrl` is `${frontendUrl}/r/${share_token}` or null;
    - instants are ISO strings.
- Produces, `@Injectable() class ReportsRepository` (`@Inject(DRIZZLE) db`):
  - `list(workspaceId: string): Promise<ReportRecord[]>`, newest `created_at` first.
  - `get(workspaceId: string, id: string): Promise<ReportRecord | null>`
  - `getById(id: string): Promise<ReportRecord | null>`
  - `byShareToken(token: string): Promise<ReportRecord | null>`
  - `insert(values: NewInsightReportRow): Promise<string>`
  - `update(workspaceId: string, id: string, patch: Partial<NewInsightReportRow>): Promise<boolean>`
  - `remove(workspaceId: string, id: string): Promise<boolean>`
  - `workspaceInfo(workspaceId: string): Promise<{ name: string; timezone: string; isActive: boolean } | null>`. The timezone goes through `safeTimeZone`.
  - `team(workspaceId: string): Promise<{ userId: string; email: string; isOwner: boolean }[]>`: the owner plus ACCEPTED invitations with a user, `users.is_active = true`, distinct by user.
  - `logoItem(workspaceId: string, mediaId: string): Promise<{ type: string; mimeType: string | null; isDeleted: boolean } | null>`
  - `logoUrl(workspaceId: string, mediaId: string | null): Promise<string | null>`. A binned or missing item is null.
  - `optOut(id: string, email: string): Promise<{ reportName: string; workspaceName: string } | null>`. Idempotent and lowercased: `opted_out = ARRAY(SELECT DISTINCT unnest(opted_out || ARRAY[$email]))`.
  - `due(now: Date, limit = 500): Promise<{ id: string; nextRunAt: Date }[]>`: `cadence IS NOT NULL AND next_run_at <= now`, joined to `workspace.is_active = true`, by `next_run_at`.
    - Ruling: a suspended workspace emails nobody. Its links still work.
  - `recordSent(id: string, sentAt: Date, nextRunAt: Date | undefined): Promise<void>`. It clears `last_error`; `undefined` leaves `next_run_at` as is.
  - `recordError(id: string, message: string, nextRunAt: Date | undefined): Promise<void>`
- **Rows:**
  - `logoUrl`, `createdBy` and `updatedBy` come from left joins to `media_items` (`is_deleted = false`, same workspace) and `users`.
  - A person's name is `coalesce(nullif(users.name, ''), split_part(users.email, '@', 1))`.
  - `recordSent`, `recordError` and `optOut` never touch `updated_at` / `updated_by`: "edited by" means a person changed the settings.

- [ ] **Step 1: Write the failing tests:**
  - `report-dto.spec.ts`:
    - `channelIds [3, 9, 1]` with `socialIds {1, 3}` → `[3, 1]`;
    - `share_token 'abc'`, `frontendUrl 'https://app.schedura.ai'` → `shareUrl 'https://app.schedura.ai/r/abc'`;
    - a null token → `null`;
    - `cadence null` → `schedule: null`;
    - a weekly row maps to `schedule { cadence: 'weekly', weekday: 1, sendMinute: 540, … }`;
    - `nextRunAt` is an ISO string.
  - `reports.repository.db.spec.ts` (`withRollbackDb(['0064_insight_reports.sql'])`):
    - insert, then `get` round trip; `get` from another workspace → null;
    - `team`:
      - owner + an ACCEPTED member (`seedMember`) → 2 rows, the owner flagged;
      - a PENDING invitation is excluded;
      - an `is_active = false` member is excluded;
    - `optOut('…', 'Sara@Acme.com')` twice → `opted_out = ['sara@acme.com']`, and `updated_at` is unchanged;
    - `logoUrl`: a live image → its `file_url`; after `is_deleted = true` → null;
    - `due`:
      - includes a report with `next_run_at` in the past;
      - excludes one in the future, one with `cadence` null, and one whose workspace has `is_active = false`;
    - `byShareToken` finds by token and returns null after the token is set to null.
- [ ] **Step 2:** Run (`PLANNER_DB_TESTS=1 … --runInBand` for the DB spec): FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS. Run tsc.
- [ ] **Step 5:** Commit `feat(insights): reports repository and DTO mapping`.

### Task 6: Payload assembly

**Files:**
- Create: `src/insights/reports/lib/section-fields.ts`
- Create: `src/insights/reports/report-payload.service.ts`
- Test: `src/insights/reports/lib/section-fields.spec.ts`, `src/insights/reports/report-payload.service.spec.ts`

**Interfaces:**
- Consumes:
  - `InsightsService.overview(workspaceId, period, channels, tz, compare, now)` and `InsightsService.signals(workspaceId, null, channels, now)` (Task 2);
  - `AudienceService.growth(workspaceId, period, channels)` and `AudienceService.channels(workspaceId, period, channels, now)`;
  - `InsightsChannelsRepository.socialChannels`;
  - `ReportsRepository.workspaceInfo` and `logoUrl` (Task 5);
  - `resolveReportPeriod` (Task 1).
- Produces, in `section-fields.ts`:
  - `export const SECTION_FIELDS: Partial<Record<ReportSection, readonly (keyof InsightsOverviewDto)[]>>`, exactly Appendix A's map.
  - `export const OVERVIEW_BASE_FIELDS = ['window', 'compare', 'timezone', 'days', 'channelIds'] as const`
  - `export function pickOverview(o: InsightsOverviewDto, sections: ReportSection[]): Partial<InsightsOverviewDto> | null`. It is null when no chosen section maps to overview keys.
  - `export function resolveChartMetric(wanted: ReportChartMetric, freshness: ChannelFreshness[]): ReportChartMetric`:
    - `reach` with no `reportsReach` → `views`;
    - `views` with no `reportsViews` → `engagements`.
- Produces:
  - `export class NoChannelsLeftError extends ConflictException`, with message `No channels left in this report`.
  - `@Injectable() class ReportPayloadService`, method `payload(workspaceId: string, settings: Omit<ReportSettings, 'schedule'>, now?: Date): Promise<ReportPayloadDto>`.
- **Flow:**
  1. Read `socialChannels` and `workspaceInfo`. `kept` = `settings.channelIds` that are social channels, in stored order. If empty, throw `NoChannelsLeftError` **before any Insights or Audience call**.
  2. `period = resolveReportPeriod(settings, tz, now)`. `channels = kept.join(',')`.
  3. Call **only** what the sections need, in parallel:
     - `overview(…, tz, settings.compare, now)` when any section in `SECTION_FIELDS` is chosen;
     - `signals` when `what_works` or `best_time` is chosen;
     - `growth` + `channels` when `audience` is chosen.
  4. Build the result:
     - `overview: pickOverview(...)`;
     - `signals: { timezone, whatWorks?, bestTimes? }` or null;
     - `audience: { growth, channels }` or null;
     - `chartMetric`: `resolveChartMetric` against the full overview's `freshness`, or `settings.chartMetric` when no overview was read;
     - `platforms`: distinct platforms of `kept`, in order;
     - `window: { from, to }`;
     - `timezone: tz`;
     - `generatedAt: now.toISOString()`;
     - `logoUrl: await logoUrl(workspaceId, settings.logoMediaId)`;
     - `name`, `note`, `compare` from the settings.
  5. `sections`: the chosen ones, canonical. `audience` is dropped when `growth.channels` is empty and no audience channel has `status: 'ok'`.
     - Ruling: the only section the server drops. Every other view renders its own empty state.

- [ ] **Step 1: Write the failing tests:**
  - `section-fields.spec.ts`:
    - `pickOverview(full, ['totals'])` has exactly the keys `['channelIds','compare','days','kpis','timezone','usual','window']` (sorted);
    - `['what_works']` → `null`;
    - `['main_chart']` includes `series, comparisonSeries, previousSeries, usual`;
    - the result never has `lane`, `top`, `formats`, `bestTimes`, `firstRun` for any section mix (loop over `REPORT_SECTIONS`);
    - `resolveChartMetric('reach', [{ reportsReach: false, reportsViews: true }])` → `'views'`;
    - `('reach', [{ reportsReach: false, reportsViews: false }])` → `'engagements'`;
    - `('views', [{ reportsReach: true, reportsViews: true }])` → `'views'`.
  - `report-payload.service.spec.ts`, with jest doubles for every dependency and workspace channels `[1 instagram, 2 linkedin, 3 facebook]`:
    - **Review Focus 4:** settings `{ channelIds: [1], sections: ['totals'] }`:
      ```ts
      expect(Object.keys(p.overview!).sort()).toEqual(['channelIds','compare','days','kpis','timezone','usual','window'])
      expect(p.signals).toBeNull(); expect(p.audience).toBeNull()
      const json = JSON.stringify(p)
      for (const k of ['"series"', '"channels"', '"standout"', '"workspaceId"']) expect(json).not.toContain(k)
      expect(json).not.toContain(WS)            // the workspace uuid
      expect(insights.overview).toHaveBeenCalledWith(WS, expect.anything(), '1', 'Asia/Karachi', 'usual', NOW)
      expect(insights.signals).not.toHaveBeenCalled(); expect(audience.growth).not.toHaveBeenCalled()
      ```
      The overview double returns a full `InsightsOverviewDto` fixture that does carry `series`, `channels` and `standout`.
    - **Review Focus 3:**
      - `channelIds: [99]` (deleted) → rejects with `NoChannelsLeftError`; `overview`, `signals`, `growth` and `channels` are never called;
      - `channelIds: [99, 3]` → `overview` called with `'3'`, `platforms: ['facebook']`.
    - `sections: ['what_works','best_time']` → `signals` called with `(WS, null, '1', NOW)`, and `overview` not called.
    - `sections: ['audience']` with `growth.channels: []` and every audience channel `unsupported` → `sections: []`, and `audience` still present.
    - `period: 'last_quarter'` at `2026-10-01T09:00Z` → `overview` gets `{ days: 92, window: customWindow('2026-07-01', '2026-09-30') }`.
    - `platforms` de-duplicates (two instagram channels → `['instagram']`).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS. Run tsc.
- [ ] **Step 5:** Commit `feat(insights): report payload from the Insights and Audience services`.

### Task 7: Reports service and workspace routes (CRUD, share, preview)

**Files:**
- Create: `src/insights/reports/reports.service.ts`, `src/insights/reports/reports.controller.ts`
- Modify: `src/workspace-members/role-capabilities.ts`: add `'reports:manage'` to `Capability`, with the doc "Create, change, share and send Insights reports; they email people outside the workspace". Set it to `'MEMBER'` in `CAPABILITY_MIN_ROLE`.
- Modify: `src/insights/insights.module.ts`: providers `ReportsRepository`, `ReportPayloadService`, `ReportsService`; controller `ReportsController`.
- Test:
  - `src/insights/reports/reports.service.spec.ts`;
  - `src/insights/reports/reports.controller.spec.ts`;
  - `src/workspace-members/role-capabilities.spec.ts` (extend);
  - `src/workspace-members/every-workspace-route-guarded.spec.ts` (must stay green, unchanged).

**Interfaces:**
- Consumes: Tasks 1, 4, 5 and 6; `ConfigService` (`FRONTEND_URL`, trailing `/` stripped, default `'http://localhost:3001'` as elsewhere in the repo).
- Produces, `ReportsService`:
  - `list(workspaceId: string): Promise<ReportDto[]>`. It reads `socialChannels` and `team` once per call.
  - `get(workspaceId: string, id: string): Promise<ReportDto>`. Not found → 404 `Report not found`.
  - `create(workspaceId: string, userId: string, dto: CreateReportDto, now?: Date): Promise<ReportDto>`
  - `update(workspaceId: string, userId: string, id: string, dto: UpdateReportDto, now?: Date): Promise<ReportDto>`
  - `remove(workspaceId: string, id: string): Promise<void>`
  - `setShare(workspaceId: string, id: string, enabled: boolean): Promise<{ url: string | null }>`
  - `preview(workspaceId: string, dto: PreviewReportDto, now?: Date): Promise<ReportPayloadDto>`
  - `static newShareToken(): string`: `randomBytes(32).toString('base64url')` (43 chars, no dot).
- **Save rules** (create, and update after merging the dto over `settingsOf(row)` field by field, where `undefined` = keep):
  1. `normalizeSettings(merged, now)`.
  2. `channelIds` are narrowed to the workspace's social channels; none left → 400 `Pick at least one channel`. Only the narrowed ids are stored, so another workspace's ids never are.
  3. `logoMediaId`, when set, must pass `logoItem`: a live item of this workspace, `type === 'image'`, `mimeType` in `image/png` / `image/jpeg`. Otherwise:
     - missing or binned → 400 `That logo is not in this workspace Library`;
     - wrong type → 400 `A report logo has to be a PNG or JPG`.
  4. Opted-out addresses: an incoming recipient already in `row.opted_out` → 400 `${email} opted out of this report`. A manager can remove one but cannot re-add it.
  5. Next run:
     - when `dto.schedule` is provided (create, or a PATCH carrying the key), `next_run_at` is `nextRunAt(schedule, tz, now)`, or null when the schedule is null;
     - a PATCH without `schedule` leaves `next_run_at` alone.
  6. `created_by` / `updated_by` = `userId`, and `updated_at = now`.
- **`setShare`:**
  - `true` while the link is off mints a new token;
  - `true` while it is on keeps the current token, so the dialog's Copy never kills a link already sent;
  - `false` sets it to null.
  - It does not touch `updated_by`.
- **Preview:** narrowing as save rule 2, logo as rule 3, then `payload.payload(workspaceId, normalized, now)`. The schedule is ignored.
- **Controller:** `@Controller('insights/workspaces/:workspaceId/reports') @UseGuards(JwtAuthGuard, WorkspaceRoleGuard) @RequireCapability('analytics:view')`, `ParseUUIDPipe` on `workspaceId` and `id`.
  - `GET ''` → list;
  - `GET ':id'` → one report;
  - `POST ''` `@RequireCapability('reports:manage')` → 201;
  - `PATCH ':id'` (manage);
  - `DELETE ':id'` (manage) `@HttpCode(204)`;
  - `POST ':id/share'` (manage) `@HttpCode(200)`, body `ShareReportDto`;
  - `POST 'preview'` `@HttpCode(200)` (`analytics:view`), declared before the `:id` routes.

- [ ] **Step 1: Write the failing tests:**
  - `role-capabilities.spec.ts`: `roleCan('MEMBER','reports:manage')` is true and `roleCan('GUEST','reports:manage')` is false.
  - `reports.service.spec.ts`, with doubles:
    - create stores only the social ids (`[1, 77]` → `[1]`);
    - `[77]` → 400 `Pick at least one channel`;
    - an SVG logo (`image/svg+xml`) → 400 `A report logo has to be a PNG or JPG`;
    - weekly Monday 540 in Karachi at `2026-11-13T00:00Z` → stored `next_run_at` `2026-11-16T04:00:00.000Z`;
    - a PATCH of `note` only leaves `next_run_at` untouched;
    - a PATCH with `schedule: null` → `cadence`, `weekday`, `send_minute` and `next_run_at` all null;
    - a PATCH that re-adds an opted-out address → 400;
    - share: `true` on a link that is off → a new 43-char token without `.`; `true` on a link that is on → the same token; `false` → `{ url: null }`;
    - `list` maps `teamSize` = `team().length`.
  - `reports.controller.spec.ts`, modelled on `audience.controller.spec.ts`, with the app's `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`:
    - a non-member → 403 on every route;
    - a GUEST: `GET`, `GET :id` and `POST preview` → 200; `POST`, `PATCH`, `DELETE` and `POST :id/share` → 403;
    - a MEMBER → `POST` 201;
    - an unknown body field → 400;
    - a non-uuid `:id` → 400.
- [ ] **Step 2:** Run `npx jest src/insights/reports src/workspace-members`: FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Run: PASS, including `every-workspace-route-guarded.spec.ts`. Run tsc.
- [ ] **Step 5:** Commit `feat(insights): report CRUD, share link and preview routes; reports:manage at MEMBER`.

### Task 8: Tokens and public routes

**Files:**
- Create: `src/insights/reports/report-tokens.service.ts`
- Create: `src/insights/reports/reports-public.controller.ts`
- Create: `src/insights/reports/lib/report-pages.ts` (the unsubscribe HTML)
- Modify:
  - `reports.service.ts`: the public methods below;
  - `insights.module.ts`: import `JwtModule.register({})`, add `ReportTokensService` and `ReportsPublicController`.
- Test:
  - `src/insights/reports/report-tokens.service.spec.ts`;
  - `src/insights/reports/reports-public.controller.spec.ts`;
  - `src/insights/reports/lib/report-pages.spec.ts`.

**Interfaces:**
- Produces, `ReportTokensService` (`JwtService`, `ConfigService`). The secret is `JWT_ACCESS_SECRET`; minting without it throws, verifying without it returns null.
  - `static isShareToken(t: string): boolean`: `/^[A-Za-z0-9_-]{43}$/`.
  - `renderToken(reportId: string): string`: payload `{ rid }`, `audience: 'report-render'`, `expiresIn: 300`.
  - `verifyRender(token: string): string | null`
  - `unsubscribeToken(reportId: string, email: string): string`: payload `{ rid, email }`, `audience: 'report-unsubscribe'`, no expiry.
    - Ruling: an email can sit in an inbox for a year and its stop link must still work.
  - `verifyUnsubscribe(token: string): { reportId: string; email: string } | null`
- Produces, `ReportsService`:
  - `publicPayload(token: string, now?: Date): Promise<ReportPayloadDto>`. Not a share token, or no row → 404 `This report link is off`.
  - `renderPayload(token: string, now?: Date): Promise<ReportPayloadDto>`. A bad or expired JWT, or a deleted report → 404, the same message. It works while the share link is off.
  - `unsubscribe(token: string): Promise<{ reportName: string; workspaceName: string } | null>`
- Produces, in `report-pages.ts` (all interpolations HTML-escaped; inline styles; no script):
  - `unsubscribedPage(reportName: string, workspaceName: string): string`, title `You're unsubscribed`, body `You won't get "{reportName}" from {workspaceName} any more.`
  - `invalidUnsubscribePage(): string`, title `This link doesn't work`, body `Ask the person who sent you the report to take you off the list.`
- **Controller:** `@Controller('reports') @SkipLaunchGate()`, with no auth guard.
  - Every handler sets `Cache-Control: private, no-store` and `X-Robots-Tag: noindex` before any work, through `@Res({ passthrough: true })`, so a 404 carries them too.
  - `GET 'public/:token'` `@UseGuards(ThrottlerGuard) @Throttle({ default: { limit: 60, ttl: 60_000 } })` → `publicPayload`.
  - `GET 'render/:token'` (not throttled) → `renderPayload`.
  - `GET 'unsubscribe/:token'` → `Content-Type: text/html; charset=utf-8`; 200 `unsubscribedPage`, or 404 `invalidUnsubscribePage`.

- [ ] **Step 1: Write the failing tests:**
  - `report-tokens.service.spec.ts`:
    - render round trip → the id;
    - an unsubscribe token fails `verifyRender`, and a render token fails `verifyUnsubscribe`;
    - a login-style token (`jwtService.sign({ sub: 'u1', email: 'a@b.c' }, { secret })`) fails both;
    - with `jest.useFakeTimers({ now: T })`, a render token verifies at T + 299 s and fails at T + 301 s;
    - `isShareToken`: a minted share token is true; a token with a dot is false; 42 chars is false.
  - `reports-public.controller.spec.ts`, an HTTP app with `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])`, the real `ReportTokensService` and a fake repository + payload service:
    - **Review Focus 1:**
      1. Mint a share token and a render token for report R.
      2. `PATCH`-equivalent: set R's `share_token` null in the fake.
      3. `/reports/public/<old>` → 404 `{ message: 'This report link is off' }`.
      4. `/reports/render/<render>` → 200.
      5. Advance fake time 301 s; `/reports/render/<render>` → 404.
    - **Review Focus 5:** `/reports/public/<live>` with no `Authorization` → 200, and with `Authorization: Bearer garbage` → 200.
    - `Reflector.get(SKIP_LAUNCH_GATE, ReportsPublicController)` is true.
    - Headers `cache-control: private, no-store` and `x-robots-tag: noindex` on a 200 **and** on a 404.
    - The 61st `GET /reports/public/<live>` within a minute → 429. 70 `GET /reports/render/<valid>` → no 429.
    - `/reports/public/abc.def.ghi` → 404, and the repository is never queried.
    - Unsubscribe: a valid token → 200 HTML containing the escaped report name, and `repo.optOut` called with the lowercased email; a garbage token → 404 HTML.
  - `report-pages.spec.ts`: a report named `<b>x</b>` renders as `&lt;b&gt;x&lt;/b&gt;`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx jest src/insights/reports src/workspace-members/every-workspace-route-guarded.spec.ts src/auth/launch-gate-routes.spec.ts`: PASS. Run tsc.
- [ ] **Step 5:** Commit `feat(insights): public report link, render token and unsubscribe page`.

### Task 9: Gotenberg client and PDF download

**Files:**
- Create: `src/insights/reports/gotenberg.client.ts`
- Create: `src/insights/reports/lib/report-format.ts`
- Modify:
  - `reports.service.ts`: `pdf` and `pdfFor`;
  - `reports.controller.ts`: `GET ':id/pdf'`;
  - `insights.module.ts`: the provider `{ provide: GotenbergClient, useFactory: (c: ConfigService) => new GotenbergClient(c.get<string>('GOTENBERG_URL')), inject: [ConfigService] }`;
  - `.env.example`: the dev note below.
- Test: `src/insights/reports/gotenberg.client.spec.ts`, `src/insights/reports/lib/report-format.spec.ts`, plus the service and controller specs (extend).

**Interfaces:**
- Produces, in `gotenberg.client.ts`:
  - `export class GotenbergNotConfiguredError extends ServiceUnavailableException`, message `PDF export isn't set up on this server.`
  - `export class GotenbergError extends Error`
  - `export class GotenbergClient`:
    - `constructor(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000)`
    - `isConfigured(): boolean`
    - `pdfFromUrl(url: string): Promise<Buffer>`
- **Request:** `POST ${baseUrl}/forms/chromium/convert/url` (trailing slash stripped), multipart `FormData`, with fields:
  - `url`
  - `waitForExpression = 'window.__reportReady === true'`
  - `paperWidth = '8.27'`, `paperHeight = '11.7'` (A4, inches)
  - `marginTop = marginBottom = marginLeft = marginRight = '0'`. The page is a fixed 794 px column with its own padding.
  - `printBackground = 'true'`
  - Check these names against the current Gotenberg 8 Chromium docs before writing; if one differs, follow the docs and say so in the report.
- **Errors:**
  - `signal: AbortSignal.timeout(timeoutMs)`;
  - a non-2xx answer, or an abort, throws `GotenbergError` with the status or `timed out after 30s`;
  - unset → `GotenbergNotConfiguredError`.
- Produces, in `report-format.ts` (UTC date formatting, `en-US`):
  - `windowLabel(from: string, to: string): string` → `Nov 1 – Nov 30` (en dash with spaces).
  - `reportSlug(name: string): string`: lowercase; runs of non-`[a-z0-9]` become `-`; trimmed of `-`; at most 60 chars; `'report'` when empty.
  - `pdfFilename(name: string, window: { from: string; to: string }): string` → `${slug}-${from}-${to}.pdf`.
- Produces, `ReportsService`:
  - `pdfFor(record: ReportRecord, now?: Date): Promise<{ filename: string; body: Buffer }>`:
    - window from `resolveReportPeriod(settingsOf(row), tz, now)`;
    - URL `${FRONTEND_URL}/r/${tokens.renderToken(row.id)}?print=1`.
  - `pdf(workspaceId: string, id: string, now?: Date)`: 404, then `pdfFor`.
- **Controller:** `@Get(':id/pdf')` (`analytics:view`) → `new StreamableFile(body, { type: 'application/pdf', disposition: \`attachment; filename="${filename}"\` })`.
- **`.env.example`** (CRLF, appended):
  ```
  # PDF export for Insights reports (Gotenberg 8, Chromium). Unset = Download PDF answers 503 and
  # scheduled report emails go link-only. Local: docker run --rm -p 3002:3000 gotenberg/gotenberg:8
  # Chromium runs inside the container, so a local end-to-end PDF needs FRONTEND_URL (and the
  # frontend's API URL) reachable from it, e.g. http://host.docker.internal:3001.
  # GOTENBERG_URL=http://localhost:3002
  ```

- [ ] **Step 1: Write the failing tests:**
  - `gotenberg.client.spec.ts`, with a fetch fake:
    - the URL is `http://g:3000/forms/chromium/convert/url` for base `http://g:3000/`;
    - the body is a `FormData` whose `get('waitForExpression')` is `'window.__reportReady === true'`, `get('printBackground')` is `'true'`, `get('paperWidth')` is `'8.27'`, and `get('url')` is the URL passed in;
    - a 200 with bytes `%PDF-1.7` → a Buffer starting `%PDF`;
    - a 500 → `GotenbergError`;
    - a fetch that never resolves with `timeoutMs = 20` → `GotenbergError` (`timed out`);
    - `new GotenbergClient(undefined).pdfFromUrl('x')` → `GotenbergNotConfiguredError`, and `isConfigured()` is false.
  - `report-format.spec.ts`:
    - `windowLabel('2026-11-01','2026-11-30')` → `'Nov 1 – Nov 30'`;
    - `pdfFilename('Acme · Q3 report!', { from: '2026-07-01', to: '2026-09-30' })` → `'acme-q3-report-2026-07-01-2026-09-30.pdf'`;
    - `reportSlug('***')` → `'report'`.
  - Service: `pdfFor` calls `pdfFromUrl` with `https://app.schedura.ai/r/<jwt>?print=1`, where the JWT verifies with `verifyRender` to the report id.
  - Controller:
    - `GET :id/pdf` → 200, `content-type: application/pdf`, and `content-disposition` `attachment; filename="acme-report-2026-10-01-2026-10-31.pdf"`;
    - with an unconfigured client → 503 `{ message: "PDF export isn't set up on this server." }`;
    - a GUEST may download.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS. Run tsc.
- [ ] **Step 5:** Commit `feat(insights): report PDF through Gotenberg`.

### Task 10: Email attachments and the report email

**Files:**
- Modify: `src/email/email.service.ts`. `sendEmail` gains `attachments?: { filename: string; content: Buffer }[]`, passed to `resend.emails.send` only when non-empty. Nothing else changes.
- Create: `src/insights/reports/lib/report-email.ts`
- Test: `src/email/email.service.spec.ts` (extend), `src/insights/reports/lib/report-email.spec.ts`

**Interfaces:**
- Produces, in `report-email.ts`:
  ```ts
  export interface ReportEmailInput {
    reportName: string; workspaceName: string; window: { from: string; to: string }
    logoUrl: string | null; briefText: string | null
    totals: { reach: number | null; engagements: number | null; followers: number | null; posts: number | null } | null
    shareUrl: string | null; note: string | null; unsubscribeUrl: string
  }
  export function reportEmail(i: ReportEmailInput): { subject: string; html: string; text: string }
  export function briefTextOf(brief: Brief): string   // 'ready' → segments' text joined; 'not_enough' → text
  export function totalsOf(kpis: InsightsOverviewDto['kpis']): NonNullable<ReportEmailInput['totals']>
    // reach.value, engagements.value, followers.value, postsPublished.value
  ```
- **Copy (spec §7):**
  - Subject `${reportName}: ${windowLabel(from, to)}`.
  - The body, in order:
    1. the logo `<img>` (when set);
    2. the name;
    3. the window label;
    4. the In brief text (when given);
    5. the four totals, labelled `Reach`, `Engagements`, `Followers`, `Posts`, with null shown as `—` and numbers as `toLocaleString('en-US')`;
    6. an `Open the report` button (only when `shareUrl`);
    7. the note.
  - Footer `You get this because ${workspaceName} added you to this report.`, then a `Stop receiving this report` link to `unsubscribeUrl`.
  - A plain-text twin with the same content and URLs.
  - Every user-supplied string is HTML-escaped (one local `escapeHtml`; no inline-template copies). Inline styles only, no SVG, no external CSS.

- [ ] **Step 1: Write the failing tests:**
  - `email.service.spec.ts`:
    - with `RESEND_API_KEY` set in the config fake and `(service as any).resend = { emails: { send: jest.fn().mockResolvedValue({ data: { id: 'm1' } }) } }`, `sendEmail({ …, attachments: [{ filename: 'r.pdf', content: Buffer.from('%PDF') }] })` calls `send` with that `attachments` array and `replyTo`;
    - without attachments, the call has no `attachments` key.
  - `report-email.spec.ts`:
    - subject `'Acme report: Nov 1 – Nov 30'`;
    - name `<script>x</script>` and note `a & b` are escaped in the HTML;
    - `shareUrl: null` → no `Open the report` in the HTML or the text;
    - `totals.followers: null` → the Followers tile reads `—`, and the HTML never shows `>0<` for it;
    - the footer sentence is exact, and `unsubscribeUrl` appears in both the HTML and the text;
    - `briefTextOf` of a ready brief with segments `['Reach ', 'rose 12%', '.']` → `'Reach rose 12%.'`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx jest src/email src/insights/reports/lib`: PASS. Run tsc.
- [ ] **Step 5:** Commit `feat(email): attachments; the scheduled report email`.

### Task 11: Sending: queue, handler, cron, Send now, time zone changes

**Files:**
- Modify:
  - `src/queue/queue.module.ts`: `REPORTS: 'reports'` in `QUEUES`, and `{ name: QUEUES.REPORTS }` in `registerQueue`.
  - `src/first-week/first-week.processor.ts`: re-export `isFinalAttempt` from its new home (its spec stays as is).
- Create: `src/queue/is-final-attempt.ts`, holding the moved `isFinalAttempt`.
- Create:
  - `src/insights/reports/lib/recipients.ts`
  - `src/insights/reports/report-send.service.ts`
  - `src/insights/reports/reports.processor.ts`
  - `src/insights/reports/reports.scheduler.ts`
  - `src/insights/reports/lib/reschedule.ts`
- Modify:
  - `reports.service.ts`: `sendNow`, and `@InjectQueue(QUEUES.REPORTS)`;
  - `reports.controller.ts`: `POST ':id/send'`;
  - `insights.module.ts`: import `EmailModule`; `BullModule.registerQueue({ name: QUEUES.REPORTS })`; providers `ReportSendService`, `ReportsProcessor`, `ReportsScheduler`.
  - `src/workspace/workspace.service.ts`, in `update`: when `updateWorkspaceDto.timezone !== undefined` and it differs from `existingWorkspace.timezone`, after the row is written, call `await rescheduleWorkspaceReports(this.db, workspaceId, updateWorkspaceDto.timezone, new Date())` inside `try/catch` with a `warn` log. A failed reschedule never fails the settings save.
- Test:
  - `src/insights/reports/lib/recipients.spec.ts`
  - `src/insights/reports/report-send.service.spec.ts`
  - `src/insights/reports/reports.processor.spec.ts`
  - `src/insights/reports/reports.scheduler.spec.ts`
  - `src/insights/reports/lib/reschedule.db.spec.ts`
  - `src/workspace/workspace.timezone-reports.spec.ts`, modelled on `workspace.samples.spec.ts`, with `jest.mock('../insights/reports/lib/reschedule')`
  - the controller spec (extend)

**Interfaces:**
- Produces:
  - `export interface ReportSendJob { reportId: string; kind: 'scheduled' | 'now'; sent?: string[] }`
  - `export const REPORT_SEND_JOB = 'report-send'`
  - `export function resolveRecipients(r: { sendToTeam: boolean; recipients: string[]; optedOut: string[] }, team: { email: string }[]): string[]`: team first, lowercased, de-duplicated, minus `optedOut`.
  - `ReportSendService`:
    - `run(job: { data: ReportSendJob; updateData(d: ReportSendJob): Promise<void> }, now?: Date): Promise<'sent' | 'gone' | 'unscheduled' | 'no_channels' | 'no_recipients'>`
    - `markFailed(data: ReportSendJob, error: Error, now?: Date): Promise<void>`
    - `protected pause(ms: number): Promise<void>`, which specs stub.
  - `ReportsProcessor`: `@Processor(QUEUES.REPORTS, { concurrency: 2 }) extends WorkerHost`. `process` delegates to `run`; `@OnWorkerEvent('failed')` calls `markFailed` only when `isFinalAttempt(job)`.
  - `ReportsScheduler.enqueueDue(now = new Date()): Promise<number>`, decorated `@Cron('*/15 * * * *', { timeZone: 'UTC', name: 'enqueueDueReports' })`. For each `repo.due(now)` row it calls `queue.add(REPORT_SEND_JOB, { reportId, kind: 'scheduled' }, { jobId: slotJobId(id, nextRunAt), delay: i * 2000 })`.
  - `ReportsService.sendNow(workspaceId: string, id: string, now?: Date): Promise<{ recipients: number }>`:
    - no schedule, or `resolveRecipients(...)` empty → 409 `This report has no one to send to`;
    - otherwise `queue.add(REPORT_SEND_JOB, { reportId, kind: 'now' }, { jobId: sendNowJobId(id, now) })`.
    - It does not move `next_run_at`.
  - `rescheduleWorkspaceReports(db: DbType, workspaceId: string, timeZone: string, now: Date): Promise<number>`: recompute `next_run_at = nextRunAt(…, timeZone, now)` for the workspace's scheduled reports, and return the count.
  - Controller: `POST ':id/send'` `@RequireCapability('reports:manage') @HttpCode(202)`.
- **`run` steps:**
  1. `getById`. Missing → `'gone'`. `kind === 'scheduled'` with `cadence` null → `'unscheduled'`. Neither throws.
  2. `workspaceInfo` and `team`. `recipients = resolveRecipients(...)`, minus `job.data.sent`.
     - None at all (before removing `sent`) → `recordError(id, 'No one left to send this report to', next)` → `'no_recipients'`.
     - Here and in step 3, `next` = `nextRunAt(schedule, tz, now)` for scheduled, `undefined` for now.
  3. `payload.payload(...)`. A `NoChannelsLeftError` → `recordError(id, 'No channels left in this report', next)` → `'no_channels'`, with no email and no PDF.
  4. PDF when `attachPdf`:
     - configured → `reports.pdfFor(record, now)`; a failure throws (BullMQ retries);
     - unset → `logger.warn(\`Report ${id}: GOTENBERG_URL is unset, sending link only\`)`, no attachment.
  5. For each remaining address, in order:
     - `emailService.sendEmail({ to, ...reportEmail(...), replyTo: ownerEmail, attachments })`;
       - the unsubscribe URL is `${API_PUBLIC_URL || APP_URL}/reports/unsubscribe/${unsubscribeToken(id, to)}`;
       - `shareUrl` is null when the link is off;
       - brief and totals are filled only when those sections are on and `payload.overview` has them;
     - on success, `job.updateData({ ...data, sent: [...sent, to] })`;
     - `pause(600)` between sends (Resend's default 2 requests/s; batch sends carry no attachments).
     - After the loop, any failure throws `Error(\`Couldn't email ${failed} of ${total} people: ${firstError}\`)`, so a retry re-sends only the unsent.
  6. Success → `recordSent(id, now, next)` → `'sent'`.
     - `next` is computed from `now`, never from the old `next_run_at`, so missed slots are never back-filled.
- **`markFailed`:** `recordError(id, error.message.slice(0, 200), kind === 'scheduled' ? nextRunAt(…, tz, now) : undefined)`. The schedule keeps moving after a bad week.

- [ ] **Step 1: Write the failing tests:**
  - `recipients.spec.ts`:
    - team `[Owner@x.com]` + recipients `['b@y.com', 'owner@x.com']`, `sendToTeam: true` → `['owner@x.com', 'b@y.com']`;
    - an opted-out team member is skipped;
    - `sendToTeam: false` ignores the team.
  - `report-send.service.spec.ts`, with all doubles and `pause` stubbed:
    - **Review Focus 3:**
      - every channel gone (`payload` rejects with `NoChannelsLeftError`) → `'no_channels'`; `sendEmail` and `pdfFor` are never called; `recordError(id, 'No channels left in this report', <nextRunAt Date>)`; no throw;
      - one channel left → sent.
    - Two recipients, the second failing once:
      - the first run throws, and `updateData` was called with `sent: ['a@x.com']`;
      - a retry with that data emails only `b@y.com`.
    - Gotenberg unset → emails with no `attachments`, and a warn is logged. Configured and `pdfFor` rejecting → `run` rejects.
    - A scheduled send processed 3 weeks late (`now = due + 21 d`) → `recordSent(id, now, nextRunAt(schedule, tz, now))`, which is after `now`.
    - `kind: 'now'` → `recordSent(id, now, undefined)`.
    - The link off → the email input has `shareUrl: null`. `replyTo` is the owner's email.
    - The unsubscribe URL verifies with `verifyUnsubscribe` to `{ reportId, email: to }`.
  - `reports.processor.spec.ts`: `onFailed` with `attemptsMade: 2` of 3 → no `markFailed`; with `3` of 3 → `markFailed(data, err)`.
  - `reports.scheduler.spec.ts`:
    - two due rows → two `add` calls named `report-send`;
    - jobIds match `/^report-[0-9a-f-]{36}-\d{12}$/` and contain no `:`;
    - delays are `0` and `2000`.
  - Controller and service:
    - `POST :id/send` by a MEMBER → 202 `{ recipients: 2 }`, and `queue.add` jobId matches `/^report-[0-9a-f-]{36}-now-\d+$/`;
    - no schedule → 409 `This report has no one to send to`;
    - a GUEST → 403.
  - `reschedule.db.spec.ts` (local PG): a weekly Monday 540 report rescheduled from UTC to `Asia/Karachi` at `2026-11-13T00:00Z` → `next_run_at = 2026-11-16T04:00:00Z`; an unscheduled report is untouched.
  - `workspace.timezone-reports.spec.ts`:
    - updating `timezone` from `UTC` to `Asia/Karachi` calls `rescheduleWorkspaceReports(db, id, 'Asia/Karachi', expect.any(Date))`;
    - the same timezone, or no timezone in the dto → not called;
    - a rejecting reschedule still resolves the update.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement, register, and move `isFinalAttempt`.
- [ ] **Step 4:** Run `npx jest src/insights src/queue src/first-week src/workspace src/email` (and the two DB specs with the flag, `--runInBand`): PASS. Run tsc.
- [ ] **Step 5:** Commit `feat(insights): scheduled and on-demand report sends`.

### Task 12: Whole-branch check (controller runs it)

- [ ] `npm run build`. Expected: success.
- [ ] `npx jest src/insights src/email src/queue src/first-week src/workspace src/workspace-members src/drizzle src/auth/launch-gate-routes.spec.ts`. Expected: only the pre-existing failures listed in Global Constraints.
- [ ] `PLANNER_DB_TESTS=1 npx jest src/drizzle/schema/insight-reports.db.spec.ts src/insights/reports --runInBand`. Expected: PASS.
- [ ] tsc count is still 35, and none of the errors are in a touched directory.
- [ ] Prove 0064 on local PG twice inside BEGIN…ROLLBACK (idempotent), and re-run the remote 0064 collision check.
- [ ] `git diff a67eda5 --stat` touches no `.env`, no `package.json`, no unrelated module.
- [ ] Hand over to the final whole-branch review (opus), naming the Review Focus list, and the owner notes:
  - Gotenberg on Railway, `GOTENBERG_URL`;
  - `CLOUDFLARE_R2_PUBLIC_URL` must be set for logos;
  - `trust proxy` for throttling;
  - the unsubscribe GET can be triggered by mail link scanners.
