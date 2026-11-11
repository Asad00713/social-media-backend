# Insights Audience API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Insights Audience tab: follower growth per channel from the existing daily rollup, and each channel's audience breakdown (country, city, age, gender) from a daily cached fetch.

**Architecture:**
- **Growth** reuses the follower rows the Overview already reads. They move into a small shared repository, and a pure function turns them into per-channel cumulative series.
- **Demographics for Instagram, Threads and Facebook:**
  - fetched by a new `channel-audience-refresh` job on the existing `CHANNEL_SNAPSHOTS` queue;
  - enqueued by a 03:30 UTC cron, and on read when a row is stale;
  - stored as one latest row per channel in a new `channel_audience` table.
- **YouTube** is read live for the selected window and cached in Redis for 12h.
- **Routes:** three GET routes in a new controller under `insights/workspaces/:workspaceId/audience`.

**Tech Stack:** NestJS, Drizzle (Postgres), BullMQ, ioredis, Jest.

**Spec:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-frontend-audience\docs\superpowers\specs\2026-11-11-insights-audience-design.md` (FE repo, committed 54ac80aa). Read it before any task.

**Worktree:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace-audience`, branch `feat/insights-audience-api`, base `origin/main` 116b99b.

## Global Constraints

**Worktree and environment**
- **Task 0 (controller, before Task 1):** link `node_modules` to the main checkout's with a junction:
  `cmd //c mklink /J node_modules "..\socialmedia-workspace\node_modules"`.
  - Never `npm install`.
  - Never delete the junction; to remove the worktree, `rmdir` the junction first.
- **Never hit live platforms or a prod DB.** Tests use fetch fakes. DB specs use the local Postgres from the backend `.env`, inside BEGIN…ROLLBACK, like `insights.metrics.db.spec.ts`.
- **Never edit `.env`.** The new flag is read with `process.env.FACEBOOK_REQUEST_READ_INSIGHTS === 'true'` and defaults to off.

**Product rules**
- No LLM in any of this code path. Threads data is never sent to an LLM.
- Platform facts used, verified 2026-11-11:
  - Instagram (`graph.instagram.com`): `follower_demographics` with `metric_type=total_value`, `period=lifetime`, `breakdown` = `country` | `city` | `age` | `gender`.
  - Threads (`graph.threads.net/v1.0/me/threads_insights`): `metric=follower_demographics`, same breakdowns.
  - Facebook Page (`graph.facebook.com/v22.0/{pageId}/insights`): `page_follows_country`, `page_follows_city`. There is no age or gender.
  - YouTube Analytics: `viewerPercentage` by `ageGroup,gender` (client exists); `views` by `country`.
  - Before writing each client method, check the field names against the live Meta and Google docs. If a response shape differs from this plan, follow the docs and record it in your report.
- **The 100-follower rule** is decided from our own latest `channel_snapshots.followers_count`, not from a Meta error string. Instagram or Threads with fewer than 100 followers (or an unknown count) is `below_threshold`, and the fetch is not called.

**Data rules**
- **Display limits:** top 5 countries, top 4 cities, and age buckets in the fixed order `13-17, 18-24, 25-34, 35-44, 45-54, 55+`. 55–64 and 65+ merge into `55+`, and a missing bucket is 0.
- **Genders** are ordered `female, male, unknown`. Meta's `F/M/U` and YouTube's `female/male/user_specified` map onto those three.
- **Percent** is computed by us: a slice's value ÷ the sum of all values in that breakdown × 100, rounded to 1 decimal.
  - YouTube age and gender values are already percentages. They are summed across the other dimension, then rounded.
  - "Unknown" slices are kept, never normalised away.
- **City key** is the text before the first comma, so `"Karachi, Sindh"` becomes `"Karachi"`. Same-named cities are summed.
- **Statuses:** `ok | below_threshold | no_permission | unsupported | failed`.
- **Mapping errors to statuses:**
  - Meta error code `10` or `200`–`299` → `no_permission`.
  - Any other client error (auth, rate, transient, permanent) → `failed`.
- **BullMQ job ids** must not contain `:`. Use `audience-${channelId}-${YYYY-MM-DD}`.

**Migrations**
- `0062_channel_audience.sql`, hand-written in the style of `0060_insight_hidden_steps.sql`:
  - a header comment covering WHY, SAFETY, and LOCKS AND COST;
  - `SET LOCAL lock_timeout = '10s'` first;
  - `CREATE TABLE IF NOT EXISTS`;
  - no BEGIN/COMMIT.
- Before committing, re-check that no remote branch has taken 0062:
  `git for-each-ref refs/remotes --format='%(refname:short)' | xargs -I{} git ls-tree --name-only {} drizzle/migrations/ | grep 0062`.

**Verification**
- Each task runs its own specs plus `npx tsc --noEmit -p tsconfig.json`.
- The final task runs `npm run build` and the whole insights, post-performance and analytics suites.

**Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

## Review Focus

1. **A follower count that goes down.** `change` is negative and the series dips below 0. It must never be clamped to 0. Tested in Task 2.
2. **A channel whose rollup never reported** (a brand-new channel, or Reddit-like). It must appear with `current: null, change: null` and an all-null series, and must not be dropped. It must not add 0 to the total. Tested in Task 2.
3. **Meta answers 200 with an empty `data` array or a missing breakdown** (a new account, privacy limits). The row is `ok` with empty arrays, not `failed`, and nothing throws. Tested in Task 4.
4. **The YouTube cache key ignores the window.** A 7-day view would then serve 90-day numbers. The key must include `from` and `to`. Tested in Task 7.
5. **A non-member hits an audience route.** 403, the same as `/overview`. Tested in Task 7.

---

### Task 1: Shared channel and follower reads

The read logic moves out of `InsightsService` unchanged, so the Audience service can share it.

**Files:**
- Create: `src/insights/insights-channels.repository.ts`
- Modify: `src/insights/insights.service.ts`:
  - the `SocialChannel` interface (~line 168);
  - `socialChannels` (~697) and `followerRows` (~747), which become one-line delegations;
  - the constructor, which gains a 4th param.
- Modify: `src/insights/insights.module.ts`, adding the provider.

**Interfaces:**
- Produces:
  - `export interface SocialChannel { id: number; platform: SupportedPlatform; accountName: string; isActive: boolean; connectionStatus: string }`, moved and exported.
  - `@Injectable() export class InsightsChannelsRepository { constructor(@Inject(DRIZZLE) db: DbType); socialChannels(workspaceId: string): Promise<SocialChannel[]>; followerRows(channelIds: number[], fromIso: string, beforeIso: string): Promise<FollowerRow[]> }`. The bodies are moved verbatim, including their doc comments.
  - `InsightsService` constructor: `(db, postPerformance, topics = new InsightsTopicsRepository(db), channels = new InsightsChannelsRepository(db))`. The defaults keep the two-arg doubles in the existing specs working.

- [ ] **Step 1:** Run the current suite and record the baseline.
  `npx jest src/insights src/post-performance`. Note any failures that already exist on main, and list them in the report.
- [ ] **Step 2:** Create the repository, then make the service's two private methods delegate to it. Register it in `InsightsModule.providers`.
- [ ] **Step 3:** Re-run `npx jest src/insights src/post-performance` and `npx tsc --noEmit -p tsconfig.json`.
  Expected: the same pass/fail set as Step 1.
- [ ] **Step 4:** Commit: `refactor(insights): move channel and follower reads into a shared repository`.

### Task 2: Growth math

**Files:**
- Create: `src/insights/audience/growth.ts`
- Create: `src/insights/audience/audience.dto.ts`, holding all audience DTOs, including the Task 7 ones, so later tasks import a single file.
- Test: `src/insights/audience/growth.spec.ts`

**Interfaces:**
- Consumes: `FollowerRow` (`src/post-performance/followers.ts`), `datesBetween` (`src/post-performance/period.ts`).
- Produces, in `audience.dto.ts`:
  ```ts
  export interface GrowthPoint { date: string; followers: number | null; gained: number | null }
  export interface AudienceGrowthChannelDto { channelId: number; platform: SupportedPlatform; name: string; current: number | null; change: number | null; series: GrowthPoint[] }
  export interface AudienceGrowthDto { window: { from: string; to: string }; total: { current: number | null; change: number | null; series: GrowthPoint[] }; channels: AudienceGrowthChannelDto[] }
  /** `pending` exists only in responses: no row yet. The table's CHECK lists the other five. */
  export type AudienceStatus = 'ok' | 'below_threshold' | 'no_permission' | 'unsupported' | 'failed' | 'pending'
  export interface AudienceSlice { key: string; percent: number }
  export interface AudienceChannelDto { channelId: number; platform: SupportedPlatform; name: string; followerCount: number | null; status: AudienceStatus; reconnectable: boolean; fetchedAt: string | null; measure: 'followers' | 'viewers'; countries: AudienceSlice[]; cities: AudienceSlice[]; ages: AudienceSlice[]; genders: AudienceSlice[] }
  export interface AudienceChannelsDto { channels: AudienceChannelDto[] }
  ```
- Produces, in `growth.ts`: `export function audienceGrowth(rows: FollowerRow[], channels: { id: number; platform: SupportedPlatform; accountName: string }[], window: { from: string; to: string }): AudienceGrowthDto`.

**Rules the function implements (from the spec):**
- **Carry forward:** each channel's last count is carried over days with no reading.
- **Base:** a row dated before `window.from` is the seed and becomes the base. With no seed, the base is the first in-range reading.
- **Per day:** `followers` is the carried count, or null before any reading. `gained` is `followers − base`, or null.
- **Totals for a channel:** `current` is the carried count on `window.to`. `change` is `current − base`.
- **Total series:** per day, the sum over channels whose value that day is non-null. It is null if there are none.
- **Total current and change:** the sums of the non-null values, or null if there are none.
- **Order:** channels sorted by `change` descending, nulls last, ties by `channelId`.

- [ ] **Step 1: Write the failing tests** in `growth.spec.ts`, with a fixture window `2026-10-01..2026-10-05`:
  ```ts
  it('starts from the seed before the window, so day one can already show a change')
    // seed 10-09-30: 100; in range 10-01: 103 → series[0] = { followers: 103, gained: 3 }; change 3
  it('starts from the first in-range reading when there is no seed')
    // 10-03: 50, 10-05: 55 → series[0..1].gained null; series[2].gained 0; change 5
  it('carries the last count over a missed day')
    // 10-01: 10, 10-03: 12 → series[1] = { followers: 10, gained: 0 }
  it('keeps a drop negative')
    // seed 200, 10-05: 188 → change −12, series[4].gained −12
  it('keeps a channel with no readings, all null, and leaves it out of the total')
    // channel 9 has no rows → { current: null, change: null } and every series point null; total excludes it
  it('sums the total only over channels that have a value that day')
  it('sorts channels by change, largest first, nulls last')
  ```
- [ ] **Step 2:** `npx jest src/insights/audience/growth.spec.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `audienceGrowth` and the DTO file.
- [ ] **Step 4:** Re-run. Expected: PASS. Then run `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5:** Commit: `feat(insights): audience growth series per channel`.

### Task 3: `channel_audience` table

**Files:**
- Create: `drizzle/migrations/0062_channel_audience.sql`
- Create: `src/drizzle/schema/channel-audience.schema.ts`
- Modify: `src/drizzle/schema/index.ts`, exporting it the way `insight-hidden-steps.schema` is exported.
- Test: `src/drizzle/schema/channel-audience.db.spec.ts`

**Columns:**

| Column | Type | Notes |
|---|---|---|
| `channel_id` | integer | PRIMARY KEY, REFERENCES `social_media_channels(id)` ON DELETE CASCADE |
| `status` | text | NOT NULL, CHECK (`status IN ('ok','below_threshold','no_permission','unsupported','failed')`) |
| `follower_count` | integer | NULL |
| `countries` | jsonb | NOT NULL DEFAULT `'[]'` |
| `cities` | jsonb | NOT NULL DEFAULT `'[]'` |
| `ages` | jsonb | NOT NULL DEFAULT `'[]'` |
| `genders` | jsonb | NOT NULL DEFAULT `'[]'` |
| `fetched_at` | timestamptz | NOT NULL DEFAULT `now()` |

- The jsonb columns hold raw `{ key: string; value: number }[]` counts (type `RawSlice`, exported from the schema file).
- Check the real table name of the channels schema before writing the FK.

- [ ] **Step 1: Write a failing DB spec**, against local PG in BEGIN…ROLLBACK, following `insights-topics.repository.db.spec.ts`:
  1. Apply the migration file's SQL.
  2. Insert a row for a temp channel.
  3. Upsert it again with `onConflictDoUpdate` on `channel_id`.
  4. Assert one row with the new values.
  5. Delete the channel and assert the row is gone.
  6. Apply the SQL a second time and assert no error (idempotent).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Write the migration and the Drizzle schema.
- [ ] **Step 4:** Run it. Expected: PASS. Then run tsc.
- [ ] **Step 5:** Commit: `feat(db): 0062 channel_audience, latest audience breakdown per channel`.

### Task 4: Normalisers and status mapping

**Files:**
- Create: `src/insights/audience/normalize.ts`
- Test: `src/insights/audience/normalize.spec.ts`

**Interfaces:**
- Consumes: `RawSlice` (Task 3), `AudienceSlice` (Task 2).
- Produces:
  - `metaBreakdown(body: unknown, breakdown: 'country'|'city'|'age'|'gender'): RawSlice[]`
    - Reads Meta's `data[0].total_value.breakdowns[0].results[].{dimension_values[0], value}`.
    - A missing or empty structure returns `[]`; it never throws.
    - It applies the city-key rule.
  - `facebookLocation(body: unknown): RawSlice[]` reads the newest `values[].value` object of `page_follows_country` / `page_follows_city` (a `{ key: count }` map). Missing data returns `[]`.
  - `youtubeAges(rows: DemographicsRow[]): RawSlice[]` and `youtubeGenders(rows: DemographicsRow[]): RawSlice[]` sum `viewerPercentage` across the other dimension, with `age13-17 → '13-17'` … and `age55-64` + `age65-` → `'55+'`.
  - `toShares(raw: RawSlice[], kind: 'countries'|'cities'|'ages'|'genders', alreadyPercent = false): AudienceSlice[]` applies the Global Constraints on percent, order and top-N.
  - `statusOfError(err: unknown): Extract<AudienceStatus, 'no_permission'|'failed'>` reads `metaCode` (Task 5) from any of the three Meta error classes.

- [ ] **Step 1: Write the failing tests:**
  - IG country and city bodies (copy one real response shape from Meta's docs into the fixture) map to slices, with `"Karachi, Sindh"` → `"Karachi"`.
  - An empty `data: []` → `[]`.
  - `toShares` gives top 5 countries and top 4 cities, with a percent of value ÷ total of ALL slices.
  - Ages give 6 fixed buckets, with `55-64` + `65+` merged and a missing bucket at 0.
  - Genders `F/M/U` → `female/male/unknown`, in that order.
  - YouTube age/gender rows sum correctly.
  - Facebook takes the newest `values` entry.
  - `statusOfError`: `metaCode: 10` → `no_permission`, `metaCode: 200` → `no_permission`, `metaCode: 190` → `failed`, a plain `Error` → `failed`.
- [ ] **Step 2:** Run it and see it fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and see it pass, then run tsc.
- [ ] **Step 5:** Commit: `feat(insights): normalise platform audience breakdowns`.

### Task 5: Client methods

**Files:**
- Modify: `src/channels/analytics/adapters/instagram/instagram-api.client.ts`
  - Add `metaCode?: number` to `InstagramApiError`, set from `body.error.code` in `request`.
  - Add `getFollowerDemographics(igUserId: string, accessToken: string, breakdown: 'country'|'city'|'age'|'gender'): Promise<unknown>`.
- Modify: `src/channels/analytics/adapters/threads/threads-api.client.ts`
  - Add `metaCode?: number` the same way.
  - Add `getFollowerDemographics(accessToken: string, breakdown: …): Promise<unknown>`, which calls `/me/threads_insights`.
- Modify: `src/channels/analytics/adapters/facebook/facebook-api.client.ts`
  - Add `metaCode?: number`.
  - Add `getPageFollowsLocation(pageId: string, accessToken: string, metric: 'page_follows_country'|'page_follows_city'): Promise<unknown>`.
- Modify: `src/channels/analytics/adapters/youtube/youtube-analytics-api.client.ts`
  - Add `getViewsByCountry(opts: { accessToken: string; startDate: string; endDate: string }): Promise<RawSlice[]>`, which returns `[{ key: countryCode, value: views }]`.
- Test: the four existing `*.client.spec.ts` files, using their fetch-fake pattern.

- [ ] **Step 1: Write the failing tests.** Each new method:
  - requests the exact URL and params listed in Global Constraints;
  - sends the token the same way that client already does;
  - on a Meta error body `{ error: { code: 10 } }`, throws the client's error with `metaCode === 10`.

  YouTube country rows map to slices.
- [ ] **Step 2:** Run the four specs and see them fail.
- [ ] **Step 3:** Implement. Existing `mapCode` results must not change.
- [ ] **Step 4:** Run them and see them pass, together with the rest of `src/channels/analytics`. Run tsc.
- [ ] **Step 5:** Commit: `feat(analytics): audience breakdown calls for Instagram, Threads, Facebook and YouTube`.

### Task 6: Refresh job, cron and Facebook scope flag

**Files:**
- Create: `src/channels/analytics/handlers/channel-audience-refresh.handler.ts`, which holds `ChannelAudienceRefreshJob { channelId: number }`.
- Create: `src/insights/audience/refresh.ts`, a pure orchestrator.
- Modify:
  - `processors/channel-snapshots-dispatcher.processor.ts`: add a `case 'channel-audience-refresh'`.
  - `analytics.module.ts`: add the handler to providers.
  - `schedulers/channel-snapshots.scheduler.ts`: add a cron.
  - `src/channels/services/oauth.service.ts`: `facebookScopesFor`.
- Test:
  - `src/insights/audience/refresh.spec.ts`
  - `src/channels/services/oauth.service.spec.ts` (create it if absent; otherwise add to the existing spec that covers `facebookScopesFor`)
  - the scheduler: one test asserting the job name, the platforms and the jobId format.

**Interfaces:**
- `refresh.ts` exports:
  ```ts
  export interface RefreshDeps {
    instagram: Pick<InstagramApiClient,'getFollowerDemographics'>
    threads: Pick<ThreadsApiClient,'getFollowerDemographics'>
    facebook: Pick<FacebookApiClient,'getPageFollowsLocation'>
  }
  export interface AudienceRow { status: AudienceStatus; followerCount: number | null; countries: RawSlice[]; cities: RawSlice[]; ages: RawSlice[]; genders: RawSlice[] }
  export async function refreshAudience(channel: { platform: SupportedPlatform; platformAccountId: string; accessToken: string /* decrypted */; followersCount: number | null }, deps: RefreshDeps): Promise<AudienceRow>
  ```
- **Rules:**
  - Instagram and Threads:
    - under 100 or null followers → `below_threshold`, with no call;
    - otherwise 4 breakdown calls via `Promise.all`.
  - Facebook: 2 calls, with ages and genders `[]`.
  - Any other platform → `unsupported`.
  - Any thrown error → `statusOfError`, with all arrays `[]`.
  - Partial failure is all-or-nothing: if one call throws, the row takes that error's status.
- **Handler** (`ChannelAudienceRefreshHandler.handle(job)`):
  1. Loads the channel and its latest `channel_snapshots.followers_count`.
  2. Decrypts the token the way the other handlers do.
  3. Calls `refreshAudience`.
  4. Upserts `channel_audience`, setting `fetched_at = now()`.
  5. Returns `{ ok: true }` and never throws on platform errors. Only a DB error throws, so BullMQ retries it.
- **Cron:** `@Cron('30 3 * * *', { timeZone: 'UTC', name: 'enqueueAudienceRefresh' })`.
  - It enqueues `'channel-audience-refresh'` for active channels on `instagram`, `threads` and `facebook`.
  - It passes `{ jobId: audience-${id}-${UTC date}, delay: i * 200 }`.
- **Scope flag:** `facebookScopesFor('connect')` returns `[...PLATFORM_CONFIG.facebook.oauthScopes, 'read_insights']` when `process.env.FACEBOOK_REQUEST_READ_INSIGHTS === 'true'`, and the list unchanged otherwise. The `'ads'` intent is untouched.

- [ ] **Step 1: Write the failing tests:**
  - `refreshAudience`:
    - IG with 99 followers → `below_threshold` and 0 calls;
    - IG with 500 → 4 calls and `ok`;
    - Facebook → 2 calls, ages `[]`;
    - TikTok → `unsupported`;
    - one IG call throwing `metaCode: 10` → `no_permission` with empty arrays.
  - Scope flag: off → no `read_insights`; `'true'` → included; `'ads'` → never included. Restore `process.env` after each test.
  - Scheduler: only the three platforms are enqueued, and every jobId matches `/^audience-\d+-\d{4}-\d{2}-\d{2}$/`.
- [ ] **Step 2:** Run them and see them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and see them pass, together with all of `src/channels`. Run tsc.
- [ ] **Step 5:** Commit: `feat(analytics): daily audience refresh job; read_insights behind a flag`.

### Task 7: Audience routes

**Files:**
- Create: `src/insights/audience/audience.service.ts`, `src/insights/audience/audience.controller.ts`, `src/insights/audience/audience-csv.ts`
- Modify:
  - `src/insights/insights.module.ts`: register the controller and service, and import what they need.
  - `src/channels/analytics/analytics.module.ts`: add `YouTubeAnalyticsApiClient` and `REDIS_CLIENT` to `exports`.
  - `src/channels/analytics/platform-capabilities.registry.ts`: Threads `hasDemographics: true`; the Facebook comment changes to `page_follows_country/city; age and gender removed by Meta (Mar 2024)`.
- Test: `audience.service.spec.ts`, `audience.controller.spec.ts`, `audience-csv.spec.ts`, and `audience.db.spec.ts` (local PG).

**Interfaces:**
- **Controller:** `@Controller('insights/workspaces/:workspaceId/audience') @UseGuards(JwtAuthGuard, WorkspaceRoleGuard) @RequireCapability('analytics:view')`. Params are parsed exactly as in `insights.controller.ts`: `periodOf`, `single(channels)`.
  - `GET growth?days|from&to&channels` → `AudienceGrowthDto`.
  - `GET growth/export?days|from&to&channels` → CSV with `Content-Type: text/csv; charset=utf-8`.
    - Filename: `schedura-audience-${from}-${to}.csv`.
    - Columns: `date,channel,platform,followers,gained_since_start`. This is a ruling: the spec's `gained` renamed to say it is cumulative.
    - One row per channel per day. `csvCell` comes from `insights/lib/content-table.ts`.
  - `GET channels?days|from&to&channels` → `AudienceChannelsDto`.
- **`AudienceService.growth(workspaceId, period: ResolvedPeriod, channels: string|undefined): Promise<AudienceGrowthDto>`:**
  1. Runs `parseChannels` over `InsightsChannelsRepository.socialChannels`.
  2. Keeps platforms where `getCapabilities(p).hasFollowerCount`.
  3. Calls `followerRows(ids, window.from, addDays(window.to, 1))`.
  4. Returns `audienceGrowth(...)`.
- **`AudienceService.channels(workspaceId, period, channels): Promise<AudienceChannelsDto>`.** For each filtered social channel, in `socialChannels` order:
  - **Instagram, Threads, Facebook:** read the `channel_audience` row and map it with `toShares`.
    - If the row is missing, or `fetched_at` is older than 24h, enqueue `channel-audience-refresh` with jobId `audience-${id}-${today}` without awaiting it, and return the stored row.
    - A missing row returns `status: 'pending'`, `fetchedAt: null`, empty arrays.

      Ruling: a channel connected today has no row yet, and "couldn't load" would be false. `pending` is a response-only status; the DB never stores it.
  - **YouTube:**
    - Redis key `audience:yt:${channelId}:${from}:${to}` with a 43200s TTL.
    - On a miss: `getDemographics` + `getViewsByCountry`, then `measure: 'viewers'`.
    - An error → `failed`, which is not cached.
  - **Everything else:** `status: 'unsupported'`, empty arrays.
  - **`followerCount`:** the latest `channel_snapshots.followers_count`.
  - **`reconnectable`:** `platform === 'facebook' && status === 'no_permission' && process.env.FACEBOOK_REQUEST_READ_INSIGHTS === 'true'`.
  - **`measure`:** `'followers'` except YouTube.

- [ ] **Step 1: Write the failing tests:**
  - Service, with fakes:
    - LinkedIn is excluded from growth;
    - the channel filter is applied to both methods;
    - a stale row enqueues exactly once with the right jobId;
    - a fresh row enqueues nothing;
    - YouTube cache keys differ for two windows, and a hit makes no client call;
    - a YouTube error is `failed` and is not written to Redis;
    - `reconnectable` follows the flag.
  - Controller: a non-member gets 403 on all three routes, as in `insights.controller.spec.ts`. A repeated `days` param gets 400.
  - CSV: header line exact; a null `followers` is an empty cell; a channel name with a comma is quoted.
  - DB spec: `growth` against seeded `channel_analytics_daily` rows matches the hand-computed `change`.
- [ ] **Step 2:** Run them and see them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx jest src/insights src/post-performance src/channels`, then tsc, then `npm run build`.
- [ ] **Step 5:** Commit: `feat(insights): audience growth, channels and CSV routes`.

### Task 8: Whole-branch check (controller runs it)

- [ ] Run `npm run build` and `npx jest src/insights src/post-performance src/channels src/drizzle`. Compare with the Task 1 baseline.
- [ ] Prove the migration on local PG: apply it twice inside BEGIN…ROLLBACK and show it is idempotent.
- [ ] Confirm that `git diff origin/main --stat` touches no `.env` and no unrelated module.
- [ ] Hand over to the final whole-branch review (opus).
