# Channel Analytics Foundation — Design Spec

**Date:** 2026-05-17
**Status:** Draft — awaiting user approval
**Scope:** Foundation layer for per-channel native analytics + first platform implementation (YouTube)
**Estimated effort:** 10–12 weeks across 10 platforms; this spec covers the foundation + YouTube only (~3 weeks)

---

## 1. Goal & Non-Goals

### Goal
Replace mocked channel detail page UI (header, overview charts, posts list, top posts) with real, per-platform-native data — sourced from a self-tracked snapshot system that does not depend on platforms exposing historical analytics or on paid API tiers.

### Non-Goals
- **NOT** rebuilding the `posts` table into a normalized `content_items + publications + metrics` model — existing `posts.targets` array works.
- **NOT** an event bus, dedicated AnalyticsIntelligenceService, time-series DB abstraction, Redis cache layer, Prometheus, or webhook ingestion in v1 — these are deferred (see `memory/project_analytics_deferred_for_scale.md`).
- **NOT** scraping any platform. Official APIs only.
- **NOT** Phase 2+ platforms (Instagram, Twitter, etc.) — those are subsequent specs.

### Out-of-scope features for v1
- AI virality/anomaly scoring
- Best-posting-time recommendations
- Data export (CSV/PDF)
- Audience demographics deep-dive
- Cross-channel comparison dashboards

---

## 2. Architecture Principles

1. **Append-only snapshots.** Time-series rows are insert-only. No updates. Idempotency via `(channelId, snapshotDate)` unique constraint.
2. **Self-tracked time-series.** Our DB is the source of truth for historical trends; platform APIs are queried only for *current* state. This avoids paid tier dependencies and gives uniform behavior across platforms.
3. **Capabilities-driven UI.** Frontend renders widgets from a per-platform capabilities config. No hardcoded `if (platform === 'youtube')` conditionals in components.
4. **Per-platform adapter pattern.** Each platform implements a strict `PlatformAnalyticsAdapter` interface. Adapters are isolated; one platform's failure does not affect others.
5. **Official API only, quota-aware.** Every platform adapter declares its quota budget; a Redis-based tracker enforces it.
6. **Smart polling.** Polling cadence per content type (story vs post vs video) + engagement-decay (stop polling stable posts).
7. **Graceful degradation.** Missing data shows freshness metadata ("Last synced 12 min ago", "Limited data — tracking since X days") rather than empty charts.
8. **Workspace-scoped multi-tenancy.** Every analytics endpoint validates `channelId` belongs to `workspaceId`.

---

## 3. Backend Data Model

### 3.1 New tables (Drizzle schema files under `src/drizzle/schema/`)

#### `channel_snapshots`
Daily snapshot per channel. Append-only.
```ts
{
  id: serial PK
  channelId: integer NOT NULL FK → channels.id ON DELETE CASCADE
  snapshotDate: date NOT NULL                  // YYYY-MM-DD
  // Common typed columns (most platforms expose these)
  followersCount: integer | null
  followingCount: integer | null
  totalPostsCount: integer | null
  // Platform-specific bag — versioned for forward-compatibility
  platformMetrics: jsonb DEFAULT '{}'          // e.g. { subscriberCount, viewCount, watchTimeMinutes }
  metricsSchemaVersion: integer NOT NULL DEFAULT 1
  // Provenance
  fetchedAt: timestamp NOT NULL
  syncStatus: enum('success','partial','failed') NOT NULL
  syncError: text | null
  createdAt: timestamp NOT NULL DEFAULT now()
}
```
- **Unique:** `(channelId, snapshotDate)` — idempotency
- **Index:** `(channelId, snapshotDate DESC)` — fast time-series queries

#### `post_metric_snapshots`
Multiple rows per post — snapshotted at intervals declared by adapter's pollingProfile.
```ts
{
  id: serial PK
  postId: integer NOT NULL FK → posts.id ON DELETE CASCADE
  channelId: integer NOT NULL FK → channels.id ON DELETE CASCADE  // denormalized for channel rollups
  snapshotAt: timestamp NOT NULL                 // exact time
  ageBucket: varchar(16) NOT NULL                // adapter-declared (e.g. '30m','1h','24h','7d','final')
  // Common typed columns
  likesCount: integer | null
  commentsCount: integer | null
  sharesCount: integer | null
  impressionsCount: integer | null
  reachCount: integer | null
  // Platform-specific (versioned)
  platformMetrics: jsonb DEFAULT '{}'            // { watchTimeMinutes, retentionRate, ... }
  metricsSchemaVersion: integer NOT NULL DEFAULT 1
  fetchedAt: timestamp NOT NULL
  syncStatus: enum('success','partial','failed') NOT NULL
}
```
- **Index:** `(postId, snapshotAt DESC)`
- **Index:** `(channelId, snapshotAt DESC)`

#### `channel_analytics_daily` (pre-aggregated rollup — replaces Redis cache)
One row per channel per day. Populated by a rollup worker after post snapshots. Used by the `/overview` endpoint for fast dashboard loads.
```ts
{
  id: serial PK
  channelId: integer NOT NULL FK → channels.id ON DELETE CASCADE
  date: date NOT NULL                            // UTC day
  postsPublished: integer NOT NULL DEFAULT 0
  totalLikes: integer NOT NULL DEFAULT 0
  totalComments: integer NOT NULL DEFAULT 0
  totalShares: integer NOT NULL DEFAULT 0
  totalImpressions: integer | null
  totalReach: integer | null
  followersAtEndOfDay: integer | null
  followersGained: integer | null                // delta from previous day
  engagementRate: numeric(5,2) | null            // (likes+comments+shares)/reach * 100
  computedAt: timestamp NOT NULL
}
```
- **Unique:** `(channelId, date)`
- **Index:** `(channelId, date DESC)`

#### `channel_sync_state`
One row per channel — circuit breaker + health.
```ts
{
  channelId: integer PK FK → channels.id ON DELETE CASCADE
  lastProfileSyncAt: timestamp | null
  lastProfileSyncStatus: enum('success','failed','rate_limited') | null
  lastProfileSyncError: text | null
  nextProfileSyncAt: timestamp NOT NULL          // for cron scheduling
  consecutiveFailures: integer NOT NULL DEFAULT 0
  pausedUntil: timestamp | null                  // back-off when consecutiveFailures ≥ 5
  initialBackfillStatus: enum('pending','running','completed','failed') NOT NULL DEFAULT 'pending'
  initialBackfillCompletedAt: timestamp | null
}
```

### 3.2 Data retention
- `channel_snapshots`: keep forever (cheap, ~365 rows/year/channel)
- `post_metric_snapshots`: keep all (max ~7 rows per post)
- `channel_analytics_daily`: keep forever (cheap, ~365 rows/year/channel)
- `channel_sync_state`: keep until channel disconnected (then nullify history fields, keep row)

---

## 4. Snapshot Infrastructure

### 4.1 New BullMQ queue: `CHANNEL_SNAPSHOTS`
Lives in `src/queues/channel-snapshots.queue.ts`. Same retry config as existing queues (3 attempts, exponential backoff).

### 4.2 Workers (`src/queues/processors/`)

#### `channel-profile-snapshot.processor.ts`
- **Input:** `{ channelId, workspaceId }`
- **Action:** Calls platform adapter's `fetchProfileSnapshot(channel)`, upserts `channel_snapshots`, updates `channel_sync_state`. Idempotent on `(channelId, today)`.
- **Schedule:** Daily at 02:00 UTC + jitter (per-channel offset spreads load).

#### `post-metric-snapshot.processor.ts`
- **Input:** `{ postId, channelId, ageBucket }`
- **Action:** Calls adapter's `fetchPostMetrics(post)`. Writes to `post_metric_snapshots`. Checks engagement-decay: if last 3 snapshots show no metric changes, marks `ageBucket='final'` and stops scheduling further snapshots.

#### `channel-daily-rollup.processor.ts`
- **Input:** `{ channelId, date }`
- **Action:** Aggregates `post_metric_snapshots` for the day + reads `channel_snapshots` follower delta. Upserts `channel_analytics_daily`.
- **Schedule:** Runs at 03:00 UTC daily (after profile snapshots complete).

#### `channel-initial-backfill.processor.ts`
- **Input:** `{ channelId, workspaceId }`
- **Action:** On new channel connect, fetch last 30 days of posts + current metrics + current profile snapshot. Populates `posts`, `post_metric_snapshots` (with `ageBucket='final'`), and one `channel_snapshots` row. Updates `channel_sync_state.initialBackfillStatus`.
- **Trigger:** Emitted from existing channels module on successful connection.

### 4.3 Cron scheduler
NestJS `@nestjs/schedule` cron jobs in `src/queues/schedulers/channel-snapshots.scheduler.ts`:
- `0 2 * * *` → enqueue profile-snapshot for every active channel (staggered 100ms apart)
- `0 3 * * *` → enqueue daily-rollup for every active channel for yesterday's date

Post-snapshot trail enqueued imperatively from `posts.service.ts` on publish success.

### 4.4 Reliability
- **Circuit breaker:** `channel_sync_state.consecutiveFailures ≥ 5` → set `pausedUntil = now() + 6h`, skip until elapsed.
- **Rate limiter:** Per-platform Redis counter (see Quota tracker, §6).
- **Logging:** Structured JSON log per sync attempt: `{ channelId, platform, jobType, duration, status, error? }`. Existing logger.

### 4.5 Channel disconnect lifecycle
On `DELETE /channels/workspaces/:wsId/:channelId`:
1. Set `channels.isActive = false` (or hard-delete row if user confirms — existing behavior).
2. Cancel pending jobs: `bullmq.removeRepeatable` for channel cron entries.
3. Drain queued post-snapshot jobs filtered by `channelId` (BullMQ `removeJobs`).
4. **Keep** all historical snapshot rows — they are our data.
5. `channel_sync_state` row kept but `nextProfileSyncAt = null`.

### 4.6 Bull Board
Install `@bull-board/express` + `@bull-board/api`. Mount at `/admin/queues` behind admin auth guard. Free observability for all queues.

---

## 5. Platform Adapter Contract

Lives in `src/channels/analytics/platform-adapter.interface.ts`.

```ts
export interface PlatformAnalyticsAdapter {
  platform: SocialPlatform
  capabilities: PlatformCapabilities

  fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult>
  fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult>

  /** Polling schedule per content type. Used by the post-snapshot scheduler. */
  pollingProfile: PollingProfile

  /** Quota cost estimator — used by the quota tracker before each call. */
  estimateQuotaCost(operation: AdapterOperation): number

  /** Used only on initial channel-connect backfill. May be null if adapter doesn't support it. */
  fetchRecentPosts?(channel: ChannelEntity, opts: { since: Date; limit: number }): Promise<RecentPostsResult>
}

export type SnapshotResult<T> =
  | { status: 'success'; data: T; quotaCostUsed: number }
  | { status: 'partial'; data: Partial<T>; missing: string[]; quotaCostUsed: number }
  | { status: 'failed'; error: AdapterError; quotaCostUsed: number }

export type ProfileSnapshotResult = SnapshotResult<{
  followersCount: number | null
  followingCount: number | null
  totalPostsCount: number | null
  platformMetrics: Record<string, unknown>
}>

export type PostMetricsResult = SnapshotResult<{
  likesCount: number | null
  commentsCount: number | null
  sharesCount: number | null
  impressionsCount: number | null
  reachCount: number | null
  platformMetrics: Record<string, unknown>
}>

export interface PollingProfile {
  defaultContentType: ContentType
  schedulePerContentType: Record<ContentType, AgeBucket[]>
}

export type ContentType = 'post' | 'video' | 'short' | 'story' | 'reel' | 'pin' | 'thread' | 'article'
export type AgeBucket = '30m' | '1h' | '6h' | '24h' | '3d' | '7d' | '30d' | 'final'
```

### 5.1 Capabilities registry
Single shared file: `src/channels/analytics/platform-capabilities.ts`. Each platform exports its `PlatformCapabilities`. Frontend imports the same shape (via shared types — see §10).

```ts
export interface PlatformCapabilities {
  // Identity
  platform: SocialPlatform

  // Metric availability
  hasFollowerCount: boolean
  hasFollowerTimeSeries: boolean       // can we build via daily snapshots?
  hasFollowingCount: boolean
  hasImpressions: boolean
  hasReach: boolean
  hasEngagementRate: boolean
  hasVideoMetrics: boolean             // watchTime, retention, avgDuration
  hasDemographics: boolean
  hasTrafficSources: boolean

  // Content types supported
  contentTypes: ContentType[]

  // Vocabulary mapping (UI labels)
  vocabulary: {
    follower: string                   // 'followers' | 'subscribers' | 'connections' | 'fans'
    following: string                  // 'following' | 'connections' | null
    share: string                      // 'retweet' | 'repost' | 'share' | 'repin' | 'reblog'
    post: string                       // 'post' | 'video' | 'tweet' | 'pin' | 'thread'
  }

  // Ephemeral content support
  hasEphemeralContent: boolean
  ephemeralTTLHours: number | null

  // Data sources
  profileDataSource: 'platform_api' | 'self_snapshot_only' | 'hybrid'
  postDataSource: 'platform_api' | 'self_snapshot_only' | 'hybrid'
  dataFreshness: 'realtime' | 'hourly' | 'daily'

  // Quota
  dailyQuotaBudget: number | null      // null = no quota tracking needed
}
```

---

## 6. Quota Tracker (Redis-based)

Lives in `src/channels/analytics/quota-tracker.service.ts`.

```ts
class QuotaTracker {
  async tryConsume(platform: SocialPlatform, cost: number): Promise<{ allowed: boolean; remaining: number }> {
    const key = `quota:${platform}:${todayUTC()}`
    const current = await redis.get(key) ?? '0'
    const limit = CAPABILITIES[platform].dailyQuotaBudget
    if (limit === null) return { allowed: true, remaining: Infinity }
    if (Number(current) + cost > limit * 0.95) {
      // 95% threshold — defer to next day
      return { allowed: false, remaining: limit - Number(current) }
    }
    const next = await redis.incrby(key, cost)
    await redis.expire(key, 60 * 60 * 30)  // 30h TTL (handles UTC boundary)
    return { allowed: true, remaining: limit - next }
  }
}
```

Adapters call this before each API call. If denied, the snapshot job is re-enqueued for the next day (no failure logged — just deferred).

---

## 7. API Surface

All endpoints live under `src/analytics/analytics.controller.ts`. New `AnalyticsModule`.

### 7.1 Endpoints

#### `GET /analytics/workspaces/:wsId/channels/:channelId/overview?range=30d`
**Batched response** — single round trip for all dashboard widgets.
```ts
{
  freshness: {
    lastSyncedAt: string                          // ISO
    dataFreshness: 'realtime' | 'hourly' | 'daily'
    isPartial: boolean
    trackingSinceDate: string                     // ISO
    gapDays: number                               // days with no snapshot
  }
  capabilities: PlatformCapabilities              // for frontend widget filtering
  summary: {
    posts: { value: number, deltaPct: number | null }
    likes: { value: number, deltaPct: number | null }
    comments: { value: number, deltaPct: number | null }
    shares: { value: number, deltaPct: number | null }
    impressions: { value: number | null, deltaPct: number | null }
    reach: { value: number | null, deltaPct: number | null }
    engagementRate: { value: number | null, deltaPct: number | null }
    followersGained: { value: number | null, deltaPct: number | null }
  }
  timeseries: {
    followers: Array<{ date: string; value: number | null }>
    posts: Array<{ date: string; value: number }>
    engagement: Array<{ date: string; likes: number; comments: number; shares: number }>
    reach: Array<{ date: string; value: number | null }>
  }
  topPosts: Array<{
    postId: number
    publishedAt: string
    content: string
    mediaUrl: string | null
    metrics: { likes, comments, shares, impressions, reach, engagementRate }
  }>
}
```

#### `GET /analytics/workspaces/:wsId/channels/:channelId/posts/:postId/metrics`
Detailed metric history for one post (all snapshot buckets).

#### `POST /channels/workspaces/:wsId/:channelId/refresh`
User-triggered manual sync. Rate-limited to 1/hour per channel via Redis. Enqueues an immediate `channel-profile-snapshot` + `post-metric-snapshot` for recent posts.

#### `GET /channels/workspaces/:wsId/:channelId/sync-state`
Returns `channel_sync_state` row + computed status badge (`healthy | catching_up | rate_limited | failing | paused`).

### 7.2 Workspace scope enforcement
Every endpoint guards: `channel.workspaceId === params.wsId AND user has workspace access`. Centralized in a `ChannelOwnershipGuard`.

---

## 8. YouTube Adapter — Specifics

Lives in `src/channels/analytics/adapters/youtube-analytics.adapter.ts`.

### 8.1 Three APIs used
| API | Used for | Quota |
|---|---|---|
| **Data API v3** | Channel info (`channels.list`), video list (`search.list`, `videos.list`) | 10,000 units/day |
| **Analytics API v2** | Per-video metrics (`reports.query` with `metrics=views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration`) | Separate quota, generous |
| **Reporting API** | Bulk historical data for initial backfill (CSV download via scheduled job) | Best for daily snapshots; we'll use it for backfill only in v1 |

### 8.2 Quota cost estimates per operation
- `fetchProfileSnapshot`: `channels.list` = 1 unit + `channels.list?part=statistics` = 1 unit → **2 units**
- `fetchPostMetrics`: `videos.list?part=statistics,contentDetails` = 1 unit + `reports.query` (Analytics) → **1 Data API unit + 1 Analytics call**
- `fetchRecentPosts` (backfill): `search.list?channelId=X&order=date&maxResults=50` = 100 units + `videos.list` for batched detail = 1 unit per batch of 50 → **101 units per 50 videos**

### 8.3 Capabilities for YouTube
```ts
{
  platform: 'youtube',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,        // via our snapshots
  hasFollowingCount: false,           // YouTube channels don't "follow"
  hasImpressions: true,               // via Analytics API
  hasReach: false,                    // not a YT concept
  hasEngagementRate: true,            // computed: (likes+comments) / views
  hasVideoMetrics: true,              // watchTime, retention, avgDuration
  hasDemographics: true,              // Analytics API geo/age/gender
  hasTrafficSources: true,
  contentTypes: ['video', 'short'],
  vocabulary: {
    follower: 'subscribers',
    following: 'subscriptions',
    share: 'share',
    post: 'video',
  },
  hasEphemeralContent: false,
  ephemeralTTLHours: null,
  profileDataSource: 'hybrid',        // current state from API, time-series self-tracked
  postDataSource: 'platform_api',
  dataFreshness: 'hourly',
  dailyQuotaBudget: 10000,
}
```

### 8.4 Polling profile
```ts
{
  defaultContentType: 'video',
  schedulePerContentType: {
    video: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
    short: ['1h', '6h', '24h', '7d', 'final'],   // shorts have steeper decay
  }
}
```

### 8.5 OAuth scopes (verify existing connect flow has these)
- `https://www.googleapis.com/auth/youtube.readonly` — channel + video reads
- `https://www.googleapis.com/auth/yt-analytics.readonly` — Analytics API
- If missing: surface as `connectionStatus = 'error'` and prompt reconnect.

---

## 9. Frontend Architecture

### 9.1 Capabilities-driven widget shell
`src/features/channel-overview/components/channel-overview-shell.tsx` replaces today's `channel-overview-view.tsx`. Logic:

```tsx
function ChannelOverviewShell({ channelId, platform }: Props) {
  const { data, isLoading } = useChannelOverview(channelId)
  const widgets = getWidgetConfigForPlatform(platform)   // capabilities-driven

  return (
    <>
      <FreshnessBanner freshness={data.freshness} />
      <TimeRangeSelector />
      {widgets.map(({ key, Component, requires }) =>
        requires(data.capabilities) ? <Component data={data} /> : null
      )}
    </>
  )
}
```

### 9.2 Widget registry
`src/features/channel-overview/widgets/registry.ts`:
```ts
export const ALL_WIDGETS = {
  summary: { Component: SummaryCardsWidget, requires: () => true },
  followerGrowth: { Component: FollowerGrowthChart, requires: (c) => c.hasFollowerTimeSeries },
  postsPublished: { Component: PostsPublishedChart, requires: () => true },
  reach: { Component: ReachChart, requires: (c) => c.hasReach },
  impressions: { Component: ImpressionsChart, requires: (c) => c.hasImpressions },
  engagement: { Component: EngagementBarsChart, requires: () => true },
  topPosts: { Component: TopPostsWidget, requires: () => true },
  videoMetrics: { Component: VideoMetricsWidget, requires: (c) => c.hasVideoMetrics },
  audienceDemographics: { Component: DemographicsWidget, requires: (c) => c.hasDemographics },
  trafficSources: { Component: TrafficSourcesWidget, requires: (c) => c.hasTrafficSources },
}

export const PLATFORM_WIDGET_ORDER: Record<SocialPlatform, (keyof typeof ALL_WIDGETS)[]> = {
  youtube: ['summary', 'followerGrowth', 'videoMetrics', 'engagement', 'topPosts', 'audienceDemographics', 'trafficSources'],
  // future platforms add their own order here
}
```

### 9.3 Native vocabulary system
`src/features/channel-overview/utils/vocabulary.ts`:
```ts
export function vocab(platform: SocialPlatform): PlatformVocabulary {
  return CAPABILITIES[platform].vocabulary
}
// Usage: vocab('youtube').follower → 'subscribers'
```
Replaces hardcoded "Followers" strings in widgets.

### 9.4 Freshness banner
Top of overview tab. Shows:
- "Synced 12 min ago" (success)
- "Catching up — last sync 4h ago" (degraded but recovering)
- "Sync paused — too many failures. Reconnect channel." (failed)
- "Tracking since 2026-05-10 — charts will get richer over time." (sparse data, < 14 days)

### 9.5 React Query hooks
- `useChannelOverview(channelId, range)` → batched `/overview` endpoint
- `usePostMetrics(channelId, postId)` → per-post detail
- `useChannelSyncState(channelId)` → for refresh button + freshness banner
- `useRefreshChannel(channelId)` → mutation for manual sync (with 1/hour rate limit feedback)

### 9.6 Manage dropdown — actually wired
- **Pause channel** → `PUT /channels/:id` with `isActive: false`. Confirm dialog.
- **Refresh data** → `POST /channels/:id/refresh`. Toast + freshness banner update.
- **Disconnect channel** → existing endpoint. Confirm dialog with "this keeps historical data" note.
- **Reconnect** → existing redirect to settings page.

### 9.7 Posts tab (real data)
Replace `use-channel-posts.ts` (mock generator) with `useChannelPostsByStatus(channelId, status, range)` calling `GET /posts/workspaces/:wsId?channelId=X&status=Y`. Status enum maps from backend (`draft|scheduled|publishing|published|failed|partially_published`) to UI tabs (Queue=scheduled, Drafts=draft, Sent=published, Failed=failed). "Approvals" tab — backend doesn't have `awaiting_approval` status. **Decision:** Hide Approvals tab in v1 (will be re-added when approval workflow ships with agent runtime).

---

## 10. Backend ↔ Frontend Type Sharing

CLAUDE.md mandates full-stack type consistency. Strategy:

1. Backend exports a `@app/shared-types` workspace package (or use openapi-typescript on the NestJS Swagger doc).
2. Frontend imports `PlatformCapabilities`, `ChannelOverviewResponse`, `FreshnessMetadata` from this shared source.
3. Single source of truth: capabilities registry lives in `socialmedia-workspace/src/channels/analytics/platform-capabilities.ts`, exported in shared package.

**v1 implementation:** Use openapi-typescript script. Backend already has Swagger module. Add npm script `generate:types` in frontend that pulls from `http://localhost:8000/api-docs-json`.

---

## 11. Phasing (YouTube-first, 3 weeks)

### Week 1 — Foundation (backend-only, no UI changes)
- New Drizzle schemas + migrations
- `AnalyticsModule` skeleton + 4 endpoints (return mocked data for now)
- `CHANNEL_SNAPSHOTS` queue + 4 processors + cron scheduler
- Bull Board mounted
- QuotaTracker service
- PlatformAdapter interface + capabilities registry
- Channel disconnect lifecycle wired

### Week 2 — YouTube adapter (backend)
- YouTubeAnalyticsAdapter (3 API integrations)
- Initial backfill processor
- Verify quota tracking under realistic load
- Integration tests with mocked YouTube responses
- Backfill kicked off for any existing YouTube channels

### Week 3 — Frontend (capabilities-driven shell + YouTube wiring)
- Shared types package + openapi-typescript codegen script
- `ChannelOverviewShell` + widget registry + all widgets
- `vocab()` system + replace hardcoded labels
- Freshness banner
- Real React Query hooks → replace mock data sources
- Manage dropdown wired (pause, refresh, disconnect)
- Posts tab real data + hide Approvals tab
- E2E test: connect a YouTube channel, verify backfill, see real charts within 24h

---

## 12. Migration Plan

1. **DB migrations** — 4 new tables. Drizzle migration files. Backward compatible (purely additive). Run via `npm run db:migrate`.
2. **Module registration** — `AnalyticsModule` added to `AppModule`. `CHANNEL_SNAPSHOTS` queue registered. Bull Board route guarded behind admin auth.
3. **Frontend deploy** — capabilities registry must be available before any widget renders. Block deploy if `generate:types` fails.
4. **Rollout** — Backfill jobs run automatically for existing YouTube channels. No user-visible breaking change; charts simply transition from mock → real over 24-48h.

---

## 13. Open Questions

1. **Bull Board auth.** Current admin auth uses JWT — confirm route mounting plays nice with NestJS guards.
2. **YouTube OAuth scope verification.** Need to verify the current `youtube.connect` flow requests `yt-analytics.readonly`. If not, existing connected channels will need reconnect prompt.
3. **Reporting API for backfill.** Reporting API delivers CSV files via cloud storage — adds complexity. Decision: v1 uses Data API + Analytics API only for backfill (slightly slower but no extra infra). Revisit if backfill quota becomes a bottleneck.
4. **Time range presets.** Current UI has 7d/30d/MTD/LM/Custom. Confirm backend `range` param accepts all five.

---

## 14. Non-Goals Recap (explicit deferrals)

See `memory/project_analytics_deferred_for_scale.md` for full list with revisit triggers:
- Event bus, AnalyticsIntelligenceService, content_items refactor, TimescaleDB, Redis cache, Prometheus, webhooks, full schema versioning, dedicated TokenHealthService, data export.

---

## 15. Success Criteria

This spec is "done" when:
- ✅ A YouTube channel connected today shows real follower count, real video list, real engagement metrics within 5 minutes of connection (via initial backfill).
- ✅ After 7 days of running, follower growth chart shows real time-series data.
- ✅ "Pause channel" stops snapshot jobs within 1 cron cycle.
- ✅ "Refresh" button updates `lastSyncedAt` within 30 seconds.
- ✅ Disconnecting a channel cancels pending jobs but keeps historical snapshots queryable in DB.
- ✅ Quota tracker prevents YouTube API calls when 95% of daily 10K units consumed.
- ✅ Bull Board accessible to admins at `/admin/queues` showing all 4 queues.
- ✅ All endpoints return 200 with `freshness` metadata even when underlying data sparse.
- ✅ TypeScript compiles cleanly on both backend and frontend with shared types.
- ✅ No `if (platform === 'youtube')` conditionals in frontend widget components.
