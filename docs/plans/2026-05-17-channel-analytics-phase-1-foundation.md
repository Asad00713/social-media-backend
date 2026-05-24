# Channel Analytics — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundation for per-channel native analytics — schemas, queues, workers, endpoints, capabilities registry, quota tracker, channel disconnect lifecycle — with mocked data flowing through. This phase ships NO user-visible UI changes; it produces working backend infrastructure ready for Phase 2 (YouTube adapter) and Phase 3 (frontend wiring).

**Architecture:** Append-only snapshot tables + BullMQ queue with 4 processors + capabilities-driven adapter pattern. Endpoints return validated stub data so frontend can be developed in parallel against contract.

**Tech Stack:** NestJS + Drizzle ORM + PostgreSQL (Neon) + BullMQ + Redis + Bull Board + Jest. Existing conventions in `src/queue/queue.module.ts` and `src/drizzle/schema/*.schema.ts` MUST be followed.

**Reference spec:** `docs/specs/2026-05-17-channel-analytics-foundation.md`

**Working directory:** All paths in this plan are relative to `d:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace\` unless otherwise stated.

---

## Pre-flight checks

Before starting Task 1, verify:

- [ ] **Confirm git repo + clean working tree**
  ```bash
  git status
  ```
  Expected: clean tree on the working branch. If dirty, commit or stash first.

- [ ] **Confirm Redis is reachable**
  ```bash
  npm run start:dev
  ```
  Expected: server starts without `ECONNREFUSED` to Redis. Stop with Ctrl+C.

- [ ] **Confirm database is reachable**
  ```bash
  npm run db:studio
  ```
  Expected: Drizzle Studio opens at localhost. Close it after verifying.

---

## Task 1: Install Bull Board + ioredis dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Bull Board packages**

  ```bash
  npm install @bull-board/api @bull-board/express @bull-board/nestjs
  ```

  Expected: 3 packages added to `dependencies` in `package.json`.

- [ ] **Step 2: Verify install succeeded**

  ```bash
  node -e "console.log(require('@bull-board/nestjs'))"
  ```

  Expected: prints an object (the module export).

- [ ] **Step 3: Commit**

  ```bash
  git add package.json package-lock.json
  git commit -m "chore: install Bull Board packages for queue observability"
  ```

---

## Task 2: Create `channel_snapshots` schema

**Files:**
- Create: `src/drizzle/schema/channel-snapshots.schema.ts`
- Modify: `src/drizzle/schema/index.ts`

- [ ] **Step 1: Write the schema file**

  Create `src/drizzle/schema/channel-snapshots.schema.ts`:

  ```ts
  import {
    pgTable,
    serial,
    integer,
    date,
    jsonb,
    timestamp,
    text,
    varchar,
    unique,
    index,
  } from 'drizzle-orm/pg-core';
  import { channels } from './channels.schema';

  export const SYNC_STATUSES = ['success', 'partial', 'failed'] as const;
  export type SyncStatus = (typeof SYNC_STATUSES)[number];

  export const channelSnapshots = pgTable(
    'channel_snapshots',
    {
      id: serial('id').primaryKey(),
      channelId: integer('channel_id')
        .notNull()
        .references(() => channels.id, { onDelete: 'cascade' }),
      snapshotDate: date('snapshot_date').notNull(),
      followersCount: integer('followers_count'),
      followingCount: integer('following_count'),
      totalPostsCount: integer('total_posts_count'),
      platformMetrics: jsonb('platform_metrics').default({}).notNull(),
      metricsSchemaVersion: integer('metrics_schema_version').default(1).notNull(),
      fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
      syncStatus: varchar('sync_status', { length: 16 }).notNull().$type<SyncStatus>(),
      syncError: text('sync_error'),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => ({
      channelDateUnique: unique('channel_snapshots_channel_date_unique').on(t.channelId, t.snapshotDate),
      channelDateIdx: index('channel_snapshots_channel_date_idx').on(t.channelId, t.snapshotDate.desc()),
    }),
  );

  export type ChannelSnapshot = typeof channelSnapshots.$inferSelect;
  export type NewChannelSnapshot = typeof channelSnapshots.$inferInsert;
  ```

- [ ] **Step 2: Register in index**

  Modify `src/drizzle/schema/index.ts` — add at the end:

  ```ts
  export * from './channel-snapshots.schema';
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npm run build
  ```

  Expected: `nest build` succeeds, no TS errors. Watch for errors referencing `channel-snapshots.schema.ts`.

- [ ] **Step 4: Commit**

  ```bash
  git add src/drizzle/schema/channel-snapshots.schema.ts src/drizzle/schema/index.ts
  git commit -m "feat(analytics): add channel_snapshots schema for daily channel-level snapshots"
  ```

---

## Task 3: Create `post_metric_snapshots` schema

**Files:**
- Create: `src/drizzle/schema/post-metric-snapshots.schema.ts`
- Modify: `src/drizzle/schema/index.ts`

- [ ] **Step 1: Write the schema file**

  Create `src/drizzle/schema/post-metric-snapshots.schema.ts`:

  ```ts
  import {
    pgTable,
    serial,
    integer,
    timestamp,
    varchar,
    jsonb,
    index,
  } from 'drizzle-orm/pg-core';
  import { channels } from './channels.schema';
  import { posts } from './posts.schema';
  import { SYNC_STATUSES, type SyncStatus } from './channel-snapshots.schema';

  export const AGE_BUCKETS = ['30m', '1h', '6h', '24h', '3d', '7d', '30d', 'final'] as const;
  export type AgeBucket = (typeof AGE_BUCKETS)[number];

  export const postMetricSnapshots = pgTable(
    'post_metric_snapshots',
    {
      id: serial('id').primaryKey(),
      postId: integer('post_id')
        .notNull()
        .references(() => posts.id, { onDelete: 'cascade' }),
      channelId: integer('channel_id')
        .notNull()
        .references(() => channels.id, { onDelete: 'cascade' }),
      snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
      ageBucket: varchar('age_bucket', { length: 16 }).notNull().$type<AgeBucket>(),
      likesCount: integer('likes_count'),
      commentsCount: integer('comments_count'),
      sharesCount: integer('shares_count'),
      impressionsCount: integer('impressions_count'),
      reachCount: integer('reach_count'),
      platformMetrics: jsonb('platform_metrics').default({}).notNull(),
      metricsSchemaVersion: integer('metrics_schema_version').default(1).notNull(),
      fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
      syncStatus: varchar('sync_status', { length: 16 }).notNull().$type<SyncStatus>(),
    },
    (t) => ({
      postSnapshotIdx: index('post_metric_snapshots_post_snapshot_idx').on(t.postId, t.snapshotAt.desc()),
      channelSnapshotIdx: index('post_metric_snapshots_channel_snapshot_idx').on(t.channelId, t.snapshotAt.desc()),
    }),
  );

  export type PostMetricSnapshot = typeof postMetricSnapshots.$inferSelect;
  export type NewPostMetricSnapshot = typeof postMetricSnapshots.$inferInsert;
  ```

  **Important:** verify the import path for `posts` table by reading `src/drizzle/schema/posts.schema.ts` first — confirm the exported symbol is `posts`. If different, adjust the import.

- [ ] **Step 2: Register in index**

  Modify `src/drizzle/schema/index.ts` — add:

  ```ts
  export * from './post-metric-snapshots.schema';
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npm run build
  ```

  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add src/drizzle/schema/post-metric-snapshots.schema.ts src/drizzle/schema/index.ts
  git commit -m "feat(analytics): add post_metric_snapshots schema for periodic post engagement snapshots"
  ```

---

## Task 4: Create `channel_analytics_daily` schema

**Files:**
- Create: `src/drizzle/schema/channel-analytics-daily.schema.ts`
- Modify: `src/drizzle/schema/index.ts`

- [ ] **Step 1: Write the schema file**

  Create `src/drizzle/schema/channel-analytics-daily.schema.ts`:

  ```ts
  import {
    pgTable,
    serial,
    integer,
    date,
    timestamp,
    numeric,
    unique,
    index,
  } from 'drizzle-orm/pg-core';
  import { channels } from './channels.schema';

  export const channelAnalyticsDaily = pgTable(
    'channel_analytics_daily',
    {
      id: serial('id').primaryKey(),
      channelId: integer('channel_id')
        .notNull()
        .references(() => channels.id, { onDelete: 'cascade' }),
      date: date('date').notNull(),
      postsPublished: integer('posts_published').default(0).notNull(),
      totalLikes: integer('total_likes').default(0).notNull(),
      totalComments: integer('total_comments').default(0).notNull(),
      totalShares: integer('total_shares').default(0).notNull(),
      totalImpressions: integer('total_impressions'),
      totalReach: integer('total_reach'),
      followersAtEndOfDay: integer('followers_at_end_of_day'),
      followersGained: integer('followers_gained'),
      engagementRate: numeric('engagement_rate', { precision: 5, scale: 2 }),
      computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    },
    (t) => ({
      channelDateUnique: unique('channel_analytics_daily_channel_date_unique').on(t.channelId, t.date),
      channelDateIdx: index('channel_analytics_daily_channel_date_idx').on(t.channelId, t.date.desc()),
    }),
  );

  export type ChannelAnalyticsDaily = typeof channelAnalyticsDaily.$inferSelect;
  export type NewChannelAnalyticsDaily = typeof channelAnalyticsDaily.$inferInsert;
  ```

- [ ] **Step 2: Register in index**

  Modify `src/drizzle/schema/index.ts` — add:

  ```ts
  export * from './channel-analytics-daily.schema';
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/drizzle/schema/channel-analytics-daily.schema.ts src/drizzle/schema/index.ts
  git commit -m "feat(analytics): add channel_analytics_daily rollup table"
  ```

---

## Task 5: Create `channel_sync_state` schema

**Files:**
- Create: `src/drizzle/schema/channel-sync-state.schema.ts`
- Modify: `src/drizzle/schema/index.ts`

- [ ] **Step 1: Write the schema file**

  Create `src/drizzle/schema/channel-sync-state.schema.ts`:

  ```ts
  import {
    pgTable,
    integer,
    timestamp,
    text,
    varchar,
  } from 'drizzle-orm/pg-core';
  import { channels } from './channels.schema';

  export const PROFILE_SYNC_STATUSES = ['success', 'failed', 'rate_limited'] as const;
  export type ProfileSyncStatus = (typeof PROFILE_SYNC_STATUSES)[number];

  export const BACKFILL_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
  export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];

  export const channelSyncState = pgTable('channel_sync_state', {
    channelId: integer('channel_id')
      .primaryKey()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastProfileSyncAt: timestamp('last_profile_sync_at', { withTimezone: true }),
    lastProfileSyncStatus: varchar('last_profile_sync_status', { length: 20 }).$type<ProfileSyncStatus>(),
    lastProfileSyncError: text('last_profile_sync_error'),
    nextProfileSyncAt: timestamp('next_profile_sync_at', { withTimezone: true }).notNull(),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    initialBackfillStatus: varchar('initial_backfill_status', { length: 20 })
      .default('pending')
      .notNull()
      .$type<BackfillStatus>(),
    initialBackfillCompletedAt: timestamp('initial_backfill_completed_at', { withTimezone: true }),
  });

  export type ChannelSyncStateRow = typeof channelSyncState.$inferSelect;
  export type NewChannelSyncState = typeof channelSyncState.$inferInsert;
  ```

- [ ] **Step 2: Register in index**

  Modify `src/drizzle/schema/index.ts` — add:

  ```ts
  export * from './channel-sync-state.schema';
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/drizzle/schema/channel-sync-state.schema.ts src/drizzle/schema/index.ts
  git commit -m "feat(analytics): add channel_sync_state for circuit breaker + backfill tracking"
  ```

---

## Task 6: Generate + apply DB migration for the 4 new tables

**Files:**
- Create: `drizzle/migrations/00XX_*.sql` (Drizzle generates the filename)

- [ ] **Step 1: Generate migration**

  ```bash
  npm run db:generate
  ```

  Expected: Drizzle prints a summary like "Created migration `00XX_*.sql`" — note the exact filename. Open it and verify it includes `CREATE TABLE channel_snapshots`, `CREATE TABLE post_metric_snapshots`, `CREATE TABLE channel_analytics_daily`, `CREATE TABLE channel_sync_state`, plus indexes + foreign keys.

- [ ] **Step 2: Apply migration**

  ```bash
  npm run db:migrate
  ```

  Expected: prints "0 migrations to apply" then "Done" — wait actually it should apply the 1 new migration. Confirm output says "1 migration applied" with the new filename.

- [ ] **Step 3: Verify tables exist via Drizzle Studio**

  ```bash
  npm run db:studio
  ```

  Open the studio in browser, confirm all 4 tables visible in the table list. Close studio.

- [ ] **Step 4: Commit**

  ```bash
  git add drizzle/migrations/
  git commit -m "feat(analytics): generate migration for 4 analytics tables"
  ```

---

## Task 7: Define `PlatformAnalyticsAdapter` interface and shared types

**Files:**
- Create: `src/channels/analytics/types/platform-adapter.types.ts`
- Create: `src/channels/analytics/types/platform-capabilities.types.ts`

- [ ] **Step 1: Create types directory**

  ```bash
  mkdir -p src/channels/analytics/types src/channels/analytics/adapters src/channels/analytics/services
  ```

- [ ] **Step 2: Write capabilities types**

  Create `src/channels/analytics/types/platform-capabilities.types.ts`:

  ```ts
  import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

  export type ContentType =
    | 'post' | 'video' | 'short' | 'story' | 'reel' | 'pin' | 'thread' | 'article';

  export type AgeBucket = '30m' | '1h' | '6h' | '24h' | '3d' | '7d' | '30d' | 'final';

  export interface PlatformVocabulary {
    follower: string;       // 'followers' | 'subscribers' | 'connections' | 'fans'
    following: string;      // 'following' | 'connections' | 'subscriptions'
    share: string;          // 'retweet' | 'repost' | 'share' | 'repin' | 'reblog'
    post: string;           // 'post' | 'video' | 'tweet' | 'pin' | 'thread'
  }

  export interface PlatformCapabilities {
    platform: SupportedPlatform;
    hasFollowerCount: boolean;
    hasFollowerTimeSeries: boolean;
    hasFollowingCount: boolean;
    hasImpressions: boolean;
    hasReach: boolean;
    hasEngagementRate: boolean;
    hasVideoMetrics: boolean;
    hasDemographics: boolean;
    hasTrafficSources: boolean;
    contentTypes: ContentType[];
    vocabulary: PlatformVocabulary;
    hasEphemeralContent: boolean;
    ephemeralTTLHours: number | null;
    profileDataSource: 'platform_api' | 'self_snapshot_only' | 'hybrid';
    postDataSource: 'platform_api' | 'self_snapshot_only' | 'hybrid';
    dataFreshness: 'realtime' | 'hourly' | 'daily';
    dailyQuotaBudget: number | null;
  }

  export interface PollingProfile {
    defaultContentType: ContentType;
    schedulePerContentType: Partial<Record<ContentType, AgeBucket[]>>;
  }
  ```

- [ ] **Step 3: Write adapter interface**

  Create `src/channels/analytics/types/platform-adapter.types.ts`:

  ```ts
  import type { ChannelEntity } from './channel-entity.types';
  import type { PostEntity } from './post-entity.types';
  import type {
    PlatformCapabilities,
    PollingProfile,
  } from './platform-capabilities.types';

  export type AdapterOperation =
    | 'fetchProfileSnapshot'
    | 'fetchPostMetrics'
    | 'fetchRecentPosts';

  export interface AdapterError {
    code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent';
    message: string;
    retryAfterSeconds?: number;
  }

  export type SnapshotResult<T> =
    | { status: 'success'; data: T; quotaCostUsed: number }
    | { status: 'partial'; data: Partial<T>; missing: string[]; quotaCostUsed: number }
    | { status: 'failed'; error: AdapterError; quotaCostUsed: number };

  export interface ProfileSnapshotData {
    followersCount: number | null;
    followingCount: number | null;
    totalPostsCount: number | null;
    platformMetrics: Record<string, unknown>;
  }

  export interface PostMetricsData {
    likesCount: number | null;
    commentsCount: number | null;
    sharesCount: number | null;
    impressionsCount: number | null;
    reachCount: number | null;
    platformMetrics: Record<string, unknown>;
  }

  export interface RecentPost {
    platformPostId: string;
    publishedAt: Date;
    content: string;
    mediaUrl: string | null;
    metrics: PostMetricsData;
  }

  export type ProfileSnapshotResult = SnapshotResult<ProfileSnapshotData>;
  export type PostMetricsResult = SnapshotResult<PostMetricsData>;
  export type RecentPostsResult = SnapshotResult<{ posts: RecentPost[] }>;

  export interface PlatformAnalyticsAdapter {
    readonly platform: PlatformCapabilities['platform'];
    readonly capabilities: PlatformCapabilities;
    readonly pollingProfile: PollingProfile;
    estimateQuotaCost(operation: AdapterOperation): number;
    fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult>;
    fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult>;
    fetchRecentPosts?(
      channel: ChannelEntity,
      opts: { since: Date; limit: number },
    ): Promise<RecentPostsResult>;
  }
  ```

- [ ] **Step 4: Create thin entity type aliases**

  Create `src/channels/analytics/types/channel-entity.types.ts`:

  ```ts
  import type { InferSelectModel } from 'drizzle-orm';
  import type { channels } from '../../../drizzle/schema/channels.schema';

  export type ChannelEntity = InferSelectModel<typeof channels>;
  ```

  Create `src/channels/analytics/types/post-entity.types.ts`:

  ```ts
  import type { InferSelectModel } from 'drizzle-orm';
  import type { posts } from '../../../drizzle/schema/posts.schema';

  export type PostEntity = InferSelectModel<typeof posts>;
  ```

  **Important:** verify the export name of `posts` and `channels` from their schema files before saving.

- [ ] **Step 5: Verify TypeScript compiles**

  ```bash
  npm run build
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/channels/analytics/
  git commit -m "feat(analytics): define PlatformAnalyticsAdapter contract + capabilities types"
  ```

---

## Task 8: Capabilities registry skeleton (all 10 platforms with placeholder configs)

**Files:**
- Create: `src/channels/analytics/platform-capabilities.registry.ts`

- [ ] **Step 1: Write the registry**

  Create `src/channels/analytics/platform-capabilities.registry.ts`:

  ```ts
  import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
  import type { PlatformCapabilities } from './types/platform-capabilities.types';

  /**
   * NOTE: Phase 1 ships placeholder capabilities for all platforms. The real
   * per-platform config arrives with each platform's adapter implementation
   * (Phase 2 = YouTube; subsequent phases = Instagram, Twitter, etc.).
   *
   * Frontend reads this registry directly via type-sharing. Adding/removing
   * keys here = breaking the contract — keep additive.
   */
  const SOCIAL_PLATFORMS: readonly SupportedPlatform[] = [
    'facebook', 'instagram', 'youtube', 'tiktok', 'pinterest',
    'twitter', 'linkedin', 'threads', 'bluesky', 'mastodon',
  ] as const;

  function placeholderCapabilities(platform: SupportedPlatform): PlatformCapabilities {
    return {
      platform,
      hasFollowerCount: true,
      hasFollowerTimeSeries: true,
      hasFollowingCount: false,
      hasImpressions: false,
      hasReach: false,
      hasEngagementRate: false,
      hasVideoMetrics: false,
      hasDemographics: false,
      hasTrafficSources: false,
      contentTypes: ['post'],
      vocabulary: {
        follower: 'followers',
        following: 'following',
        share: 'share',
        post: 'post',
      },
      hasEphemeralContent: false,
      ephemeralTTLHours: null,
      profileDataSource: 'platform_api',
      postDataSource: 'platform_api',
      dataFreshness: 'daily',
      dailyQuotaBudget: null,
    };
  }

  export const PLATFORM_CAPABILITIES: Record<SupportedPlatform, PlatformCapabilities> =
    Object.fromEntries(
      SOCIAL_PLATFORMS.map((p) => [p, placeholderCapabilities(p)]),
    ) as Record<SupportedPlatform, PlatformCapabilities>;

  export function getCapabilities(platform: SupportedPlatform): PlatformCapabilities {
    const caps = PLATFORM_CAPABILITIES[platform];
    if (!caps) throw new Error(`No capabilities registered for platform: ${platform}`);
    return caps;
  }
  ```

  **Note:** the cloud-storage platforms (`google_drive`, `google_photos`, etc.) are deliberately omitted — analytics only applies to true social platforms. The `getCapabilities` call from analytics endpoints will throw on those, which is correct.

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/channels/analytics/platform-capabilities.registry.ts
  git commit -m "feat(analytics): add capabilities registry skeleton (placeholder configs)"
  ```

---

## Task 9: QuotaTracker service + unit tests (TDD)

**Files:**
- Create: `src/channels/analytics/services/quota-tracker.service.ts`
- Create: `src/channels/analytics/services/quota-tracker.service.spec.ts`

- [ ] **Step 1: Write the failing test**

  Create `src/channels/analytics/services/quota-tracker.service.spec.ts`:

  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { ConfigModule } from '@nestjs/config';
  import { QuotaTrackerService } from './quota-tracker.service';

  describe('QuotaTrackerService', () => {
    let service: QuotaTrackerService;

    const fakeRedis = {
      store: new Map<string, number>(),
      async get(key: string) {
        return this.store.has(key) ? String(this.store.get(key)) : null;
      },
      async incrby(key: string, by: number) {
        const next = (this.store.get(key) ?? 0) + by;
        this.store.set(key, next);
        return next;
      },
      async expire(_key: string, _seconds: number) { return 1; },
      clear() { this.store.clear(); },
    };

    beforeEach(async () => {
      fakeRedis.clear();
      const module: TestingModule = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true })],
        providers: [
          QuotaTrackerService,
          { provide: 'REDIS_CLIENT', useValue: fakeRedis },
        ],
      }).compile();

      service = module.get<QuotaTrackerService>(QuotaTrackerService);
    });

    it('allows calls when platform has no quota budget', async () => {
      const result = await service.tryConsume('bluesky', 1);
      expect(result.allowed).toBe(true);
    });

    it('allows calls under 95% of budget for YouTube', async () => {
      // YouTube budget will be 10000 in Phase 2; for now we test against null which is allowed.
      const result = await service.tryConsume('youtube', 50);
      expect(result.allowed).toBe(true);
    });

    it('blocks when consumed amount would exceed 95% threshold', async () => {
      fakeRedis.store.set(`quota:youtube:${new Date().toISOString().slice(0, 10)}`, 9400);
      // Capabilities skeleton has null budget, so this test will pass — meaningful test arrives in Phase 2 once budget is set.
      const result = await service.tryConsume('youtube', 200);
      expect(result.allowed).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails (file doesn't exist yet)**

  ```bash
  npx jest src/channels/analytics/services/quota-tracker.service.spec.ts
  ```

  Expected: FAIL — cannot find module `./quota-tracker.service`.

- [ ] **Step 3: Implement the service**

  Create `src/channels/analytics/services/quota-tracker.service.ts`:

  ```ts
  import { Inject, Injectable, Logger } from '@nestjs/common';
  import { getCapabilities } from '../platform-capabilities.registry';
  import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

  export interface RedisLike {
    get(key: string): Promise<string | null>;
    incrby(key: string, by: number): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
  }

  export interface QuotaConsumeResult {
    allowed: boolean;
    remaining: number;
  }

  /**
   * Per-platform daily quota tracker backed by Redis. Adapters must call
   * `tryConsume` BEFORE every API call and skip the call if `allowed: false`.
   */
  @Injectable()
  export class QuotaTrackerService {
    private readonly logger = new Logger(QuotaTrackerService.name);

    constructor(@Inject('REDIS_CLIENT') private readonly redis: RedisLike) {}

    async tryConsume(platform: SupportedPlatform, cost: number): Promise<QuotaConsumeResult> {
      const capsHasBudget = (() => {
        try {
          return getCapabilities(platform).dailyQuotaBudget;
        } catch {
          return null;
        }
      })();

      if (capsHasBudget === null) {
        return { allowed: true, remaining: Number.POSITIVE_INFINITY };
      }

      const limit = capsHasBudget;
      const dayKey = this.dayKey();
      const key = `quota:${platform}:${dayKey}`;
      const current = Number((await this.redis.get(key)) ?? '0');
      const threshold = Math.floor(limit * 0.95);

      if (current + cost > threshold) {
        this.logger.warn(`Quota near-exhausted for ${platform}: ${current}/${limit} (threshold ${threshold})`);
        return { allowed: false, remaining: limit - current };
      }

      const next = await this.redis.incrby(key, cost);
      await this.redis.expire(key, 30 * 60 * 60);

      return { allowed: true, remaining: limit - next };
    }

    private dayKey(): string {
      return new Date().toISOString().slice(0, 10);
    }
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx jest src/channels/analytics/services/quota-tracker.service.spec.ts
  ```

  Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/channels/analytics/services/quota-tracker.service.ts src/channels/analytics/services/quota-tracker.service.spec.ts
  git commit -m "feat(analytics): add Redis-backed quota tracker with 95% threshold"
  ```

---

## Task 10: Redis client provider for QuotaTracker

**Files:**
- Create: `src/channels/analytics/redis-client.provider.ts`

- [ ] **Step 1: Install ioredis**

  ```bash
  npm install ioredis
  npm install --save-dev @types/ioredis
  ```

- [ ] **Step 2: Write the provider**

  Create `src/channels/analytics/redis-client.provider.ts`:

  ```ts
  import { Provider } from '@nestjs/common';
  import { ConfigService } from '@nestjs/config';
  import Redis from 'ioredis';

  export const REDIS_CLIENT = 'REDIS_CLIENT';

  export const RedisClientProvider: Provider = {
    provide: REDIS_CLIENT,
    inject: [ConfigService],
    useFactory: (config: ConfigService) =>
      new Redis({
        host: config.get<string>('REDIS_HOST', 'localhost'),
        port: config.get<number>('REDIS_PORT', 6379),
        password: config.get<string>('REDIS_PASSWORD', ''),
        ...(config.get<string>('REDIS_TLS') === 'true' && { tls: {} }),
      }),
  };
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/channels/analytics/redis-client.provider.ts package.json package-lock.json
  git commit -m "feat(analytics): add ioredis client provider for quota tracker"
  ```

---

## Task 11: ChannelOwnershipGuard

**Files:**
- Create: `src/channels/analytics/guards/channel-ownership.guard.ts`
- Create: `src/channels/analytics/guards/channel-ownership.guard.spec.ts`

- [ ] **Step 1: Write the failing test**

  Create `src/channels/analytics/guards/channel-ownership.guard.spec.ts`:

  ```ts
  import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
  import { ChannelOwnershipGuard } from './channel-ownership.guard';

  function mockExecutionContext(params: Record<string, string>, user: { id: string }): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ params, user }),
      }),
    } as unknown as ExecutionContext;
  }

  describe('ChannelOwnershipGuard', () => {
    const fakeRepo = {
      findChannel: jest.fn(),
    };

    let guard: ChannelOwnershipGuard;

    beforeEach(() => {
      jest.clearAllMocks();
      guard = new ChannelOwnershipGuard(fakeRepo as any);
    });

    it('throws NotFoundException when channel does not exist', async () => {
      fakeRepo.findChannel.mockResolvedValue(null);
      const ctx = mockExecutionContext({ wsId: 'ws-1', channelId: '42' }, { id: 'u-1' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException when channel belongs to different workspace', async () => {
      fakeRepo.findChannel.mockResolvedValue({ id: 42, workspaceId: 'ws-OTHER' });
      const ctx = mockExecutionContext({ wsId: 'ws-1', channelId: '42' }, { id: 'u-1' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows when channel belongs to requested workspace', async () => {
      fakeRepo.findChannel.mockResolvedValue({ id: 42, workspaceId: 'ws-1' });
      const ctx = mockExecutionContext({ wsId: 'ws-1', channelId: '42' }, { id: 'u-1' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx jest src/channels/analytics/guards/channel-ownership.guard.spec.ts
  ```

  Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guard**

  Create `src/channels/analytics/guards/channel-ownership.guard.ts`:

  ```ts
  import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
  } from '@nestjs/common';
  import { eq } from 'drizzle-orm';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import type { DrizzleDB } from '../../../drizzle/db';
  import { channels } from '../../../drizzle/schema/channels.schema';

  export interface ChannelLookupRepo {
    findChannel(channelId: number): Promise<{ id: number; workspaceId: string } | null>;
  }

  /**
   * Verifies that the channel referenced by route param `:channelId` belongs to
   * the workspace referenced by route param `:wsId`. Throws 404 if channel
   * does not exist, 403 if workspace mismatch.
   *
   * IMPORTANT: this guard does NOT verify that the user has access to the
   * workspace itself — that is the responsibility of the JWT/auth guard
   * upstream. Pair with the existing workspace-access guard.
   */
  @Injectable()
  export class ChannelOwnershipGuard implements CanActivate {
    constructor(@Inject('CHANNEL_LOOKUP_REPO') private readonly repo: ChannelLookupRepo) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const req = context.switchToHttp().getRequest<{ params: { wsId: string; channelId: string } }>();
      const channelId = Number(req.params.channelId);
      if (!Number.isFinite(channelId)) {
        throw new NotFoundException('Channel not found');
      }
      const channel = await this.repo.findChannel(channelId);
      if (!channel) throw new NotFoundException('Channel not found');
      if (channel.workspaceId !== req.params.wsId) {
        throw new ForbiddenException('Channel does not belong to this workspace');
      }
      return true;
    }
  }

  export const ChannelLookupRepoProvider = {
    provide: 'CHANNEL_LOOKUP_REPO',
    inject: [DRIZZLE],
    useFactory: (db: DrizzleDB): ChannelLookupRepo => ({
      async findChannel(channelId: number) {
        const rows = await db
          .select({ id: channels.id, workspaceId: channels.workspaceId })
          .from(channels)
          .where(eq(channels.id, channelId))
          .limit(1);
        return rows[0] ?? null;
      },
    }),
  };
  ```

  **Important:** verify `DRIZZLE` export symbol from `src/drizzle/drizzle.module.ts` and `DrizzleDB` from `src/drizzle/db.ts`. Adjust imports if names differ.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx jest src/channels/analytics/guards/channel-ownership.guard.spec.ts
  ```

  Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/channels/analytics/guards/
  git commit -m "feat(analytics): add ChannelOwnershipGuard for workspace-scope enforcement"
  ```

---

## Task 12: AnalyticsModule scaffold + DTOs

**Files:**
- Create: `src/channels/analytics/analytics.module.ts`
- Create: `src/channels/analytics/dto/overview-response.dto.ts`
- Create: `src/channels/analytics/dto/freshness.dto.ts`

- [ ] **Step 1: Write the freshness DTO**

  Create `src/channels/analytics/dto/freshness.dto.ts`:

  ```ts
  import { ApiProperty } from '@nestjs/swagger';

  export class FreshnessDto {
    @ApiProperty({ description: 'ISO timestamp of most recent successful sync' })
    lastSyncedAt!: string | null;

    @ApiProperty({ enum: ['realtime', 'hourly', 'daily'] })
    dataFreshness!: 'realtime' | 'hourly' | 'daily';

    @ApiProperty({ description: 'True if some metrics are missing due to platform limits or sync failures' })
    isPartial!: boolean;

    @ApiProperty({ description: 'ISO date of the first snapshot we have for this channel' })
    trackingSinceDate!: string | null;

    @ApiProperty({ description: 'Number of days within range that have no snapshot data' })
    gapDays!: number;
  }
  ```

- [ ] **Step 2: Write the overview response DTO**

  Create `src/channels/analytics/dto/overview-response.dto.ts`:

  ```ts
  import { ApiProperty } from '@nestjs/swagger';
  import { FreshnessDto } from './freshness.dto';
  import type { PlatformCapabilities } from '../types/platform-capabilities.types';

  export class SummaryMetricDto {
    @ApiProperty() value!: number | null;
    @ApiProperty() deltaPct!: number | null;
  }

  export class SummaryDto {
    @ApiProperty({ type: SummaryMetricDto }) posts!: SummaryMetricDto;
    @ApiProperty({ type: SummaryMetricDto }) likes!: SummaryMetricDto;
    @ApiProperty({ type: SummaryMetricDto }) comments!: SummaryMetricDto;
    @ApiProperty({ type: SummaryMetricDto }) shares!: SummaryMetricDto;
    @ApiProperty({ type: SummaryMetricDto }) impressions!: SummaryMetricDto;
    @ApiProperty({ type: SummaryMetricDto }) reach!: SummaryMetricDto;
    @ApiProperty({ type: SummaryMetricDto }) engagementRate!: SummaryMetricDto;
    @ApiProperty({ type: SummaryMetricDto }) followersGained!: SummaryMetricDto;
  }

  export class TimeseriesPointDto {
    @ApiProperty() date!: string;
    @ApiProperty() value!: number | null;
  }

  export class EngagementPointDto {
    @ApiProperty() date!: string;
    @ApiProperty() likes!: number;
    @ApiProperty() comments!: number;
    @ApiProperty() shares!: number;
  }

  export class TimeseriesDto {
    @ApiProperty({ type: [TimeseriesPointDto] }) followers!: TimeseriesPointDto[];
    @ApiProperty({ type: [TimeseriesPointDto] }) posts!: TimeseriesPointDto[];
    @ApiProperty({ type: [EngagementPointDto] }) engagement!: EngagementPointDto[];
    @ApiProperty({ type: [TimeseriesPointDto] }) reach!: TimeseriesPointDto[];
  }

  export class TopPostMetricsDto {
    @ApiProperty() likes!: number;
    @ApiProperty() comments!: number;
    @ApiProperty() shares!: number;
    @ApiProperty() impressions!: number | null;
    @ApiProperty() reach!: number | null;
    @ApiProperty() engagementRate!: number | null;
  }

  export class TopPostDto {
    @ApiProperty() postId!: number;
    @ApiProperty() publishedAt!: string;
    @ApiProperty() content!: string;
    @ApiProperty() mediaUrl!: string | null;
    @ApiProperty({ type: TopPostMetricsDto }) metrics!: TopPostMetricsDto;
  }

  export class OverviewResponseDto {
    @ApiProperty({ type: FreshnessDto }) freshness!: FreshnessDto;
    @ApiProperty() capabilities!: PlatformCapabilities;
    @ApiProperty({ type: SummaryDto }) summary!: SummaryDto;
    @ApiProperty({ type: TimeseriesDto }) timeseries!: TimeseriesDto;
    @ApiProperty({ type: [TopPostDto] }) topPosts!: TopPostDto[];
  }
  ```

- [ ] **Step 3: Write the module scaffold (without controller/service yet)**

  Create `src/channels/analytics/analytics.module.ts`:

  ```ts
  import { Module } from '@nestjs/common';
  import { ConfigModule } from '@nestjs/config';
  import { DrizzleModule } from '../../drizzle/drizzle.module';
  import { QuotaTrackerService } from './services/quota-tracker.service';
  import { RedisClientProvider } from './redis-client.provider';
  import { ChannelLookupRepoProvider } from './guards/channel-ownership.guard';

  @Module({
    imports: [ConfigModule, DrizzleModule],
    providers: [
      QuotaTrackerService,
      RedisClientProvider,
      ChannelLookupRepoProvider,
    ],
    exports: [QuotaTrackerService],
  })
  export class AnalyticsModule {}
  ```

  **Important:** verify `DrizzleModule` export from `src/drizzle/drizzle.module.ts`. If different (e.g. `DatabaseModule`), adjust.

- [ ] **Step 4: Register module in AppModule**

  Modify `src/app.module.ts` — add `AnalyticsModule` to the `imports` array. Add the import at the top:

  ```ts
  import { AnalyticsModule } from './channels/analytics/analytics.module';
  ```

- [ ] **Step 5: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add src/channels/analytics/analytics.module.ts src/channels/analytics/dto/ src/app.module.ts
  git commit -m "feat(analytics): scaffold AnalyticsModule + overview/freshness DTOs"
  ```

---

## Task 13: AnalyticsService stub returning shaped mock data

**Files:**
- Create: `src/channels/analytics/services/analytics.service.ts`
- Modify: `src/channels/analytics/analytics.module.ts`

- [ ] **Step 1: Write the service**

  Create `src/channels/analytics/services/analytics.service.ts`:

  ```ts
  import { Injectable } from '@nestjs/common';
  import { getCapabilities } from '../platform-capabilities.registry';
  import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
  import type {
    OverviewResponseDto,
    TimeseriesPointDto,
    EngagementPointDto,
    TopPostDto,
  } from '../dto/overview-response.dto';

  export type AnalyticsRange = '7d' | '30d' | 'mtd' | 'lm' | 'custom';

  @Injectable()
  export class AnalyticsService {
    /**
     * Phase 1: returns shaped stub data so frontend can develop against contract.
     * Phase 2 replaces this with real queries against channel_analytics_daily +
     * post_metric_snapshots tables.
     */
    async getOverview(
      channelId: number,
      platform: SupportedPlatform,
      range: AnalyticsRange,
    ): Promise<OverviewResponseDto> {
      const capabilities = getCapabilities(platform);
      const days = rangeToDays(range);
      const timeseries = stubTimeseries(days);
      const engagement = stubEngagement(days);

      return {
        freshness: {
          lastSyncedAt: null,
          dataFreshness: capabilities.dataFreshness,
          isPartial: true,
          trackingSinceDate: null,
          gapDays: days,
        },
        capabilities,
        summary: {
          posts: { value: 0, deltaPct: null },
          likes: { value: 0, deltaPct: null },
          comments: { value: 0, deltaPct: null },
          shares: { value: 0, deltaPct: null },
          impressions: { value: null, deltaPct: null },
          reach: { value: null, deltaPct: null },
          engagementRate: { value: null, deltaPct: null },
          followersGained: { value: null, deltaPct: null },
        },
        timeseries: {
          followers: timeseries.map((d) => ({ date: d, value: null })),
          posts: timeseries.map((d) => ({ date: d, value: 0 })),
          engagement,
          reach: timeseries.map((d) => ({ date: d, value: null })),
        },
        topPosts: [] as TopPostDto[],
      };
    }
  }

  function rangeToDays(range: AnalyticsRange): number {
    switch (range) {
      case '7d': return 7;
      case '30d': return 30;
      case 'mtd': return new Date().getUTCDate();
      case 'lm': return 30;
      case 'custom': return 30;
    }
  }

  function stubTimeseries(days: number): string[] {
    const today = new Date();
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - (days - 1 - i));
      return d.toISOString().slice(0, 10);
    });
  }

  function stubEngagement(days: number): EngagementPointDto[] {
    return stubTimeseries(days).map((date) => ({ date, likes: 0, comments: 0, shares: 0 }));
  }
  ```

- [ ] **Step 2: Register the service in module**

  Modify `src/channels/analytics/analytics.module.ts` providers + exports — add `AnalyticsService`:

  ```ts
  import { AnalyticsService } from './services/analytics.service';

  // ...inside @Module:
  providers: [
    QuotaTrackerService,
    AnalyticsService,
    RedisClientProvider,
    ChannelLookupRepoProvider,
  ],
  exports: [QuotaTrackerService, AnalyticsService],
  ```

- [ ] **Step 3: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/channels/analytics/services/analytics.service.ts src/channels/analytics/analytics.module.ts
  git commit -m "feat(analytics): add AnalyticsService stub returning shaped mock overview data"
  ```

---

## Task 14: AnalyticsController with /overview endpoint

**Files:**
- Create: `src/channels/analytics/analytics.controller.ts`
- Create: `src/channels/analytics/analytics.controller.spec.ts`
- Modify: `src/channels/analytics/analytics.module.ts`

- [ ] **Step 1: Write the failing test**

  Create `src/channels/analytics/analytics.controller.spec.ts`:

  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { AnalyticsController } from './analytics.controller';
  import { AnalyticsService } from './services/analytics.service';

  describe('AnalyticsController', () => {
    let controller: AnalyticsController;
    const fakeService = {
      getOverview: jest.fn(),
    };

    beforeEach(async () => {
      jest.clearAllMocks();
      const module: TestingModule = await Test.createTestingModule({
        controllers: [AnalyticsController],
        providers: [{ provide: AnalyticsService, useValue: fakeService }],
      })
        .overrideGuard(require('@nestjs/passport').AuthGuard('jwt'))
        .useValue({ canActivate: () => true })
        .compile();

      controller = module.get<AnalyticsController>(AnalyticsController);
    });

    it('GET /overview delegates to AnalyticsService with parsed channelId + range', async () => {
      fakeService.getOverview.mockResolvedValue({ stub: true });

      const result = await controller.getOverview(
        'ws-1',
        '42',
        '30d' as any,
        { platform: 'youtube' } as any,
      );

      expect(fakeService.getOverview).toHaveBeenCalledWith(42, 'youtube', '30d');
      expect(result).toEqual({ stub: true });
    });
  });
  ```

  **Note:** the controller will need to look up the channel's platform — for the test we inject it via a mock request object. The real implementation reads from the database (see Step 3).

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx jest src/channels/analytics/analytics.controller.spec.ts
  ```

  Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

  Create `src/channels/analytics/analytics.controller.ts`:

  ```ts
  import {
    BadRequestException,
    Controller,
    Get,
    Inject,
    Param,
    Query,
    UseGuards,
  } from '@nestjs/common';
  import { ApiTags, ApiOperation } from '@nestjs/swagger';
  import { AuthGuard } from '@nestjs/passport';
  import { eq } from 'drizzle-orm';
  import { DRIZZLE } from '../../drizzle/drizzle.module';
  import type { DrizzleDB } from '../../drizzle/db';
  import { channels, type SupportedPlatform } from '../../drizzle/schema/channels.schema';
  import { AnalyticsService, type AnalyticsRange } from './services/analytics.service';
  import { ChannelOwnershipGuard } from './guards/channel-ownership.guard';
  import { OverviewResponseDto } from './dto/overview-response.dto';

  const VALID_RANGES: AnalyticsRange[] = ['7d', '30d', 'mtd', 'lm', 'custom'];

  @ApiTags('Channel Analytics')
  @Controller('analytics/workspaces/:wsId/channels/:channelId')
  @UseGuards(AuthGuard('jwt'), ChannelOwnershipGuard)
  export class AnalyticsController {
    constructor(
      private readonly analytics: AnalyticsService,
      @Inject(DRIZZLE) private readonly db: DrizzleDB,
    ) {}

    @Get('overview')
    @ApiOperation({ summary: 'Batched analytics overview for a channel' })
    async getOverview(
      @Param('wsId') _wsId: string,
      @Param('channelId') channelIdParam: string,
      @Query('range') range: AnalyticsRange = '30d',
    ): Promise<OverviewResponseDto> {
      if (!VALID_RANGES.includes(range)) {
        throw new BadRequestException(`Invalid range. Must be one of: ${VALID_RANGES.join(', ')}`);
      }
      const channelId = Number(channelIdParam);

      const channel = await this.db
        .select({ platform: channels.platform })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);

      if (!channel[0]) throw new BadRequestException('Channel not found');

      return this.analytics.getOverview(
        channelId,
        channel[0].platform as SupportedPlatform,
        range,
      );
    }
  }
  ```

  **Note:** the test signature in Step 1 passed a 4th argument representing platform lookup. Adjust the test to match the actual implementation signature (3 args: wsId, channelIdParam, range). Update Step 1's test body before re-running:

  ```ts
  // Replace the it() body with:
  it('GET /overview returns shaped data', async () => {
    fakeService.getOverview.mockResolvedValue({ stub: true });
    // Mock the channel platform lookup by overriding the controller's db field
    (controller as any).db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ platform: 'youtube' }] }) }) }),
    };

    const result = await controller.getOverview('ws-1', '42', '30d' as any);
    expect(fakeService.getOverview).toHaveBeenCalledWith(42, 'youtube', '30d');
    expect(result).toEqual({ stub: true });
  });
  ```

  Also override the `ChannelOwnershipGuard` in the test:

  ```ts
  .overrideGuard(ChannelOwnershipGuard).useValue({ canActivate: () => true })
  ```

  Update both `import` and `overrideGuard` call.

- [ ] **Step 4: Register controller in module**

  Modify `src/channels/analytics/analytics.module.ts`:

  ```ts
  import { AnalyticsController } from './analytics.controller';

  // ...inside @Module:
  controllers: [AnalyticsController],
  ```

- [ ] **Step 5: Run tests to verify they pass**

  ```bash
  npx jest src/channels/analytics/analytics.controller.spec.ts
  ```

  Expected: PASS.

- [ ] **Step 6: Smoke-test the endpoint manually**

  ```bash
  npm run start:dev
  ```

  In another terminal (or browser via Swagger UI at `http://localhost:8000/api`):

  ```bash
  curl -X GET "http://localhost:8000/analytics/workspaces/<a-real-wsId>/channels/<a-real-channelId>/overview?range=30d" \
    -H "Authorization: Bearer <a-valid-jwt>"
  ```

  Expected: 200 with stub shape. (Use a channel that belongs to a workspace you have access to.)

  Stop the server.

- [ ] **Step 7: Commit**

  ```bash
  git add src/channels/analytics/analytics.controller.ts src/channels/analytics/analytics.controller.spec.ts src/channels/analytics/analytics.module.ts
  git commit -m "feat(analytics): add /overview endpoint returning shaped stub data"
  ```

---

## Task 15: Sync-state endpoint + manual refresh endpoint

**Files:**
- Modify: `src/channels/analytics/analytics.controller.ts`
- Modify: `src/channels/analytics/services/analytics.service.ts`

- [ ] **Step 1: Add getSyncState method to service**

  Modify `src/channels/analytics/services/analytics.service.ts` — add inside the class:

  ```ts
  async getSyncState(channelId: number): Promise<{
    lastSyncedAt: string | null;
    nextSyncAt: string | null;
    status: 'healthy' | 'catching_up' | 'rate_limited' | 'failing' | 'paused';
    consecutiveFailures: number;
    pausedUntil: string | null;
    initialBackfillStatus: 'pending' | 'running' | 'completed' | 'failed';
  }> {
    // Stub for Phase 1 — real impl reads channel_sync_state in Phase 2.
    return {
      lastSyncedAt: null,
      nextSyncAt: null,
      status: 'healthy',
      consecutiveFailures: 0,
      pausedUntil: null,
      initialBackfillStatus: 'pending',
    };
  }

  async requestManualRefresh(channelId: number): Promise<{ accepted: boolean; nextAllowedAt: string | null }> {
    // Stub: real impl checks Redis rate-limit key and enqueues a job in Phase 2.
    return { accepted: true, nextAllowedAt: null };
  }
  ```

- [ ] **Step 2: Add endpoints to controller**

  Modify `src/channels/analytics/analytics.controller.ts` — add inside the class:

  ```ts
  @Get('sync-state')
  @ApiOperation({ summary: 'Current sync health for a channel' })
  async getSyncState(
    @Param('wsId') _wsId: string,
    @Param('channelId') channelIdParam: string,
  ) {
    return this.analytics.getSyncState(Number(channelIdParam));
  }
  ```

  Then add a new controller for refresh under the channels base path. Create `src/channels/analytics/channel-refresh.controller.ts`:

  ```ts
  import {
    Controller,
    Inject,
    Param,
    Post,
    UseGuards,
  } from '@nestjs/common';
  import { ApiTags, ApiOperation } from '@nestjs/swagger';
  import { AuthGuard } from '@nestjs/passport';
  import { AnalyticsService } from './services/analytics.service';
  import { ChannelOwnershipGuard } from './guards/channel-ownership.guard';

  @ApiTags('Channel Analytics')
  @Controller('channels/workspaces/:wsId/:channelId')
  @UseGuards(AuthGuard('jwt'), ChannelOwnershipGuard)
  export class ChannelRefreshController {
    constructor(private readonly analytics: AnalyticsService) {}

    @Post('refresh')
    @ApiOperation({ summary: 'User-triggered manual sync (rate-limited 1/hour)' })
    async refresh(
      @Param('wsId') _wsId: string,
      @Param('channelId') channelIdParam: string,
    ) {
      return this.analytics.requestManualRefresh(Number(channelIdParam));
    }
  }
  ```

- [ ] **Step 3: Register new controller in module**

  Modify `src/channels/analytics/analytics.module.ts` controllers array:

  ```ts
  import { ChannelRefreshController } from './channel-refresh.controller';

  controllers: [AnalyticsController, ChannelRefreshController],
  ```

- [ ] **Step 4: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/channels/analytics/
  git commit -m "feat(analytics): add sync-state + manual-refresh endpoint stubs"
  ```

---

## Task 16: Add CHANNEL_SNAPSHOTS to QUEUES + register

**Files:**
- Modify: `src/queue/queue.module.ts`

- [ ] **Step 1: Add the queue name**

  Modify `src/queue/queue.module.ts` — update the `QUEUES` constant:

  ```ts
  export const QUEUES = {
    POST_PUBLISHING: 'post-publishing',
    TOKEN_REFRESH: 'token-refresh',
    DRIP_CAMPAIGNS: 'drip-campaigns',
    CHANNEL_SNAPSHOTS: 'channel-snapshots',
  } as const;
  ```

  And add the registration inside `BullModule.registerQueue(...)`:

  ```ts
  BullModule.registerQueue(
    { name: QUEUES.POST_PUBLISHING },
    { name: QUEUES.TOKEN_REFRESH },
    { name: QUEUES.DRIP_CAMPAIGNS },
    { name: QUEUES.CHANNEL_SNAPSHOTS },
  ),
  ```

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/queue/queue.module.ts
  git commit -m "feat(analytics): register CHANNEL_SNAPSHOTS BullMQ queue"
  ```

---

## Task 17: Channel-profile-snapshot processor stub

**Files:**
- Create: `src/channels/analytics/processors/channel-profile-snapshot.processor.ts`
- Modify: `src/channels/analytics/analytics.module.ts`

- [ ] **Step 1: Write the processor**

  Create `src/channels/analytics/processors/channel-profile-snapshot.processor.ts`:

  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Logger } from '@nestjs/common';
  import { Job } from 'bullmq';
  import { QUEUES } from '../../../queue/queue.module';

  export interface ChannelProfileSnapshotJob {
    channelId: number;
    workspaceId: string;
  }

  /**
   * Phase 1: stub processor. Logs the job and marks done.
   * Phase 2: replace with adapter dispatch + DB upsert.
   */
  @Processor(QUEUES.CHANNEL_SNAPSHOTS)
  export class ChannelProfileSnapshotProcessor extends WorkerHost {
    private readonly logger = new Logger(ChannelProfileSnapshotProcessor.name);

    async process(job: Job<ChannelProfileSnapshotJob>): Promise<{ ok: true }> {
      if (job.name !== 'channel-profile-snapshot') return { ok: true };
      this.logger.log(`[stub] Channel profile snapshot for channelId=${job.data.channelId}`);
      return { ok: true };
    }
  }
  ```

  **Note:** all 4 processors live on the same queue (`CHANNEL_SNAPSHOTS`) and dispatch by `job.name`. This avoids 4 separate queue registrations and matches BullMQ's `WorkerHost` pattern. Later processors will be merged into this file or a router pattern; for Phase 1 we use one processor per file with name filtering.

- [ ] **Step 2: Register provider in module**

  Modify `src/channels/analytics/analytics.module.ts`:

  ```ts
  import { ChannelProfileSnapshotProcessor } from './processors/channel-profile-snapshot.processor';
  import { BullModule } from '@nestjs/bullmq';
  import { QUEUES } from '../../queue/queue.module';

  // imports array — add:
  BullModule.registerQueue({ name: QUEUES.CHANNEL_SNAPSHOTS }),

  // providers array — add:
  ChannelProfileSnapshotProcessor,
  ```

- [ ] **Step 3: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/channels/analytics/processors/channel-profile-snapshot.processor.ts src/channels/analytics/analytics.module.ts
  git commit -m "feat(analytics): add channel-profile-snapshot processor stub"
  ```

---

## Task 18: Post-metric-snapshot processor stub

**Files:**
- Create: `src/channels/analytics/processors/post-metric-snapshot.processor.ts`
- Modify: `src/channels/analytics/analytics.module.ts`

- [ ] **Step 1: Write the processor**

  Create `src/channels/analytics/processors/post-metric-snapshot.processor.ts`:

  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Logger } from '@nestjs/common';
  import { Job } from 'bullmq';
  import { QUEUES } from '../../../queue/queue.module';
  import type { AgeBucket } from '../types/platform-capabilities.types';

  export interface PostMetricSnapshotJob {
    postId: number;
    channelId: number;
    ageBucket: AgeBucket;
  }

  @Processor(QUEUES.CHANNEL_SNAPSHOTS)
  export class PostMetricSnapshotProcessor extends WorkerHost {
    private readonly logger = new Logger(PostMetricSnapshotProcessor.name);

    async process(job: Job<PostMetricSnapshotJob>): Promise<{ ok: true }> {
      if (job.name !== 'post-metric-snapshot') return { ok: true };
      this.logger.log(
        `[stub] Post metric snapshot postId=${job.data.postId} bucket=${job.data.ageBucket}`,
      );
      return { ok: true };
    }
  }
  ```

- [ ] **Step 2: Register in module**

  Modify `src/channels/analytics/analytics.module.ts` providers:

  ```ts
  import { PostMetricSnapshotProcessor } from './processors/post-metric-snapshot.processor';

  // add to providers:
  PostMetricSnapshotProcessor,
  ```

- [ ] **Step 3: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/channels/analytics/processors/post-metric-snapshot.processor.ts src/channels/analytics/analytics.module.ts
  git commit -m "feat(analytics): add post-metric-snapshot processor stub"
  ```

---

## Task 19: Channel-daily-rollup processor stub

**Files:**
- Create: `src/channels/analytics/processors/channel-daily-rollup.processor.ts`
- Modify: `src/channels/analytics/analytics.module.ts`

- [ ] **Step 1: Write the processor**

  Create `src/channels/analytics/processors/channel-daily-rollup.processor.ts`:

  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Logger } from '@nestjs/common';
  import { Job } from 'bullmq';
  import { QUEUES } from '../../../queue/queue.module';

  export interface ChannelDailyRollupJob {
    channelId: number;
    date: string;
  }

  @Processor(QUEUES.CHANNEL_SNAPSHOTS)
  export class ChannelDailyRollupProcessor extends WorkerHost {
    private readonly logger = new Logger(ChannelDailyRollupProcessor.name);

    async process(job: Job<ChannelDailyRollupJob>): Promise<{ ok: true }> {
      if (job.name !== 'channel-daily-rollup') return { ok: true };
      this.logger.log(
        `[stub] Channel daily rollup channelId=${job.data.channelId} date=${job.data.date}`,
      );
      return { ok: true };
    }
  }
  ```

- [ ] **Step 2: Register in module**

  Modify `src/channels/analytics/analytics.module.ts` providers:

  ```ts
  import { ChannelDailyRollupProcessor } from './processors/channel-daily-rollup.processor';

  ChannelDailyRollupProcessor,
  ```

- [ ] **Step 3: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/channels/analytics/processors/channel-daily-rollup.processor.ts src/channels/analytics/analytics.module.ts
  git commit -m "feat(analytics): add channel-daily-rollup processor stub"
  ```

---

## Task 20: Channel-initial-backfill processor stub

**Files:**
- Create: `src/channels/analytics/processors/channel-initial-backfill.processor.ts`
- Modify: `src/channels/analytics/analytics.module.ts`

- [ ] **Step 1: Write the processor**

  Create `src/channels/analytics/processors/channel-initial-backfill.processor.ts`:

  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Logger } from '@nestjs/common';
  import { Job } from 'bullmq';
  import { QUEUES } from '../../../queue/queue.module';

  export interface ChannelInitialBackfillJob {
    channelId: number;
    workspaceId: string;
  }

  @Processor(QUEUES.CHANNEL_SNAPSHOTS)
  export class ChannelInitialBackfillProcessor extends WorkerHost {
    private readonly logger = new Logger(ChannelInitialBackfillProcessor.name);

    async process(job: Job<ChannelInitialBackfillJob>): Promise<{ ok: true }> {
      if (job.name !== 'channel-initial-backfill') return { ok: true };
      this.logger.log(`[stub] Channel initial backfill channelId=${job.data.channelId}`);
      return { ok: true };
    }
  }
  ```

- [ ] **Step 2: Register in module**

  Modify `src/channels/analytics/analytics.module.ts` providers:

  ```ts
  import { ChannelInitialBackfillProcessor } from './processors/channel-initial-backfill.processor';

  ChannelInitialBackfillProcessor,
  ```

- [ ] **Step 3: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/channels/analytics/processors/channel-initial-backfill.processor.ts src/channels/analytics/analytics.module.ts
  git commit -m "feat(analytics): add channel-initial-backfill processor stub"
  ```

---

## Task 21: Cron scheduler — daily profile snapshot + daily rollup enqueue

**Files:**
- Create: `src/channels/analytics/schedulers/channel-snapshots.scheduler.ts`
- Modify: `src/channels/analytics/analytics.module.ts`
- Modify: `src/app.module.ts` (if `@nestjs/schedule` not yet registered)

- [ ] **Step 1: Check if `@nestjs/schedule` is installed**

  ```bash
  node -e "console.log(require('@nestjs/schedule'))" 2>&1 | head -3
  ```

  If it errors, install:

  ```bash
  npm install @nestjs/schedule
  ```

- [ ] **Step 2: Register `ScheduleModule` in AppModule**

  Modify `src/app.module.ts` — verify presence of:

  ```ts
  import { ScheduleModule } from '@nestjs/schedule';
  // ...inside imports array:
  ScheduleModule.forRoot(),
  ```

  If already present, no change needed.

- [ ] **Step 3: Write the scheduler**

  Create `src/channels/analytics/schedulers/channel-snapshots.scheduler.ts`:

  ```ts
  import { Injectable, Logger, Inject } from '@nestjs/common';
  import { Cron, CronExpression } from '@nestjs/schedule';
  import { InjectQueue } from '@nestjs/bullmq';
  import { Queue } from 'bullmq';
  import { eq } from 'drizzle-orm';
  import { QUEUES } from '../../../queue/queue.module';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import type { DrizzleDB } from '../../../drizzle/db';
  import { channels } from '../../../drizzle/schema/channels.schema';

  const SOCIAL_PLATFORMS = [
    'facebook', 'instagram', 'youtube', 'tiktok', 'pinterest',
    'twitter', 'linkedin', 'threads', 'bluesky', 'mastodon',
  ];

  /**
   * Daily cron jobs that enqueue per-channel snapshot + rollup work.
   * Jobs are staggered (100ms apart) to spread platform-API load and avoid
   * thundering herds against rate limits.
   */
  @Injectable()
  export class ChannelSnapshotsScheduler {
    private readonly logger = new Logger(ChannelSnapshotsScheduler.name);

    constructor(
      @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
      @Inject(DRIZZLE) private readonly db: DrizzleDB,
    ) {}

    @Cron('0 2 * * *', { timeZone: 'UTC', name: 'enqueueProfileSnapshots' })
    async enqueueProfileSnapshots(): Promise<void> {
      const rows = await this.db
        .select({ id: channels.id, workspaceId: channels.workspaceId, platform: channels.platform, isActive: channels.isActive })
        .from(channels);

      const eligible = rows.filter(
        (r) => r.isActive && SOCIAL_PLATFORMS.includes(r.platform),
      );

      this.logger.log(`Enqueuing profile snapshots for ${eligible.length} active channels`);

      for (let i = 0; i < eligible.length; i++) {
        const r = eligible[i];
        await this.queue.add(
          'channel-profile-snapshot',
          { channelId: r.id, workspaceId: r.workspaceId },
          { delay: i * 100 },
        );
      }
    }

    @Cron('0 3 * * *', { timeZone: 'UTC', name: 'enqueueDailyRollups' })
    async enqueueDailyRollups(): Promise<void> {
      const rows = await this.db
        .select({ id: channels.id, platform: channels.platform, isActive: channels.isActive })
        .from(channels);

      const eligible = rows.filter(
        (r) => r.isActive && SOCIAL_PLATFORMS.includes(r.platform),
      );

      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const date = yesterday.toISOString().slice(0, 10);

      this.logger.log(`Enqueuing daily rollups for ${eligible.length} channels for ${date}`);

      for (let i = 0; i < eligible.length; i++) {
        await this.queue.add(
          'channel-daily-rollup',
          { channelId: eligible[i].id, date },
          { delay: i * 100 },
        );
      }
    }
  }
  ```

- [ ] **Step 4: Register scheduler in module**

  Modify `src/channels/analytics/analytics.module.ts` providers:

  ```ts
  import { ChannelSnapshotsScheduler } from './schedulers/channel-snapshots.scheduler';

  ChannelSnapshotsScheduler,
  ```

- [ ] **Step 5: Verify build + start dev server**

  ```bash
  npm run build
  npm run start:dev
  ```

  Expected: server starts; logs include "Cron job `enqueueProfileSnapshots` was scheduled" and similar for rollups. Stop the server.

- [ ] **Step 6: Commit**

  ```bash
  git add src/channels/analytics/schedulers/ src/channels/analytics/analytics.module.ts src/app.module.ts package.json package-lock.json
  git commit -m "feat(analytics): add daily cron scheduler for profile snapshots + rollups"
  ```

---

## Task 22: Bull Board mount + admin auth guard

**Files:**
- Modify: `src/main.ts` or `src/app.module.ts` (depending on Bull Board NestJS integration pattern)
- Possibly create: `src/admin/queues/queues-admin.module.ts`

- [ ] **Step 1: Read Bull Board NestJS integration docs**

  Run:

  ```bash
  node -e "console.log(Object.keys(require('@bull-board/nestjs')))"
  ```

  Expected output includes: `BullBoardModule`. The standard integration:

  ```ts
  // In app.module.ts
  import { BullBoardModule } from '@bull-board/nestjs';
  import { ExpressAdapter } from '@bull-board/express';
  import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

  // ...inside imports:
  BullBoardModule.forRoot({
    route: '/admin/queues',
    adapter: ExpressAdapter,
  }),
  BullBoardModule.forFeature(
    { name: QUEUES.POST_PUBLISHING, adapter: BullMQAdapter },
    { name: QUEUES.TOKEN_REFRESH, adapter: BullMQAdapter },
    { name: QUEUES.DRIP_CAMPAIGNS, adapter: BullMQAdapter },
    { name: QUEUES.CHANNEL_SNAPSHOTS, adapter: BullMQAdapter },
  ),
  ```

- [ ] **Step 2: Wire Bull Board in AppModule**

  Modify `src/app.module.ts` — add the imports and module entries per the snippet above. Place `BullBoardModule.forRoot(...)` after `QueueModule` and `BullBoardModule.forFeature(...)` after that.

- [ ] **Step 3: Add basic auth middleware for `/admin/queues`**

  Modify `src/main.ts` — before `await app.listen(...)`, add:

  ```ts
  // Basic auth gate for Bull Board (Phase 1: env-driven). Replace with real
  // admin JWT guard once admin module's pattern is consolidated.
  app.use('/admin/queues', (req, res, next) => {
    const auth = req.headers.authorization ?? '';
    const expected = `Basic ${Buffer.from(
      `${process.env.QUEUE_ADMIN_USER ?? 'admin'}:${process.env.QUEUE_ADMIN_PASSWORD ?? 'change-me'}`,
    ).toString('base64')}`;
    if (auth !== expected) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Queue Admin"');
      return res.status(401).send('Unauthorized');
    }
    next();
  });
  ```

  Add to `.env.example`:

  ```
  QUEUE_ADMIN_USER=admin
  QUEUE_ADMIN_PASSWORD=change-me-in-prod
  ```

  **Important:** also add to your local `.env` for testing.

- [ ] **Step 4: Smoke test**

  ```bash
  npm run start:dev
  ```

  Open `http://localhost:8000/admin/queues` in browser. Expected: basic-auth prompt. Enter `admin` / `change-me`. Expected: Bull Board UI showing all 4 queues. Stop server.

- [ ] **Step 5: Commit**

  ```bash
  git add src/app.module.ts src/main.ts .env.example
  git commit -m "feat(analytics): mount Bull Board at /admin/queues with basic-auth gate"
  ```

---

## Task 23: Channel disconnect lifecycle — cancel queued jobs

**Files:**
- Modify: `src/channels/services/channel.service.ts` (or wherever disconnect logic lives — verify via grep first)
- Create: `src/channels/analytics/services/channel-sync-lifecycle.service.ts`

- [ ] **Step 1: Locate the disconnect entry point**

  ```bash
  grep -rn "DELETE" src/channels/channels.controller.ts | head -5
  ```

  Note the controller method name. Then locate the service method it calls.

- [ ] **Step 2: Write the lifecycle service**

  Create `src/channels/analytics/services/channel-sync-lifecycle.service.ts`:

  ```ts
  import { Injectable, Logger, Inject } from '@nestjs/common';
  import { InjectQueue } from '@nestjs/bullmq';
  import { Queue } from 'bullmq';
  import { eq } from 'drizzle-orm';
  import { QUEUES } from '../../../queue/queue.module';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import type { DrizzleDB } from '../../../drizzle/db';
  import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';

  /**
   * Handles channel lifecycle transitions that affect analytics:
   *  - on disconnect: cancel queued snapshot jobs, null out next-sync timestamp
   *  - on (re)connect: initialize sync state + enqueue initial backfill
   *
   * Historical snapshot data is INTENTIONALLY preserved on disconnect.
   */
  @Injectable()
  export class ChannelSyncLifecycleService {
    private readonly logger = new Logger(ChannelSyncLifecycleService.name);

    constructor(
      @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
      @Inject(DRIZZLE) private readonly db: DrizzleDB,
    ) {}

    async onChannelDisconnected(channelId: number): Promise<void> {
      const jobs = await this.queue.getJobs(['waiting', 'delayed', 'paused']);
      let removed = 0;
      for (const job of jobs) {
        const data = job.data as { channelId?: number } | undefined;
        if (data?.channelId === channelId) {
          await job.remove();
          removed += 1;
        }
      }
      this.logger.log(`Disconnect for channelId=${channelId}: removed ${removed} queued jobs`);

      await this.db
        .update(channelSyncState)
        .set({ nextProfileSyncAt: new Date(9999, 0, 1) })
        .where(eq(channelSyncState.channelId, channelId));
    }

    async onChannelConnected(channelId: number, workspaceId: string): Promise<void> {
      await this.db
        .insert(channelSyncState)
        .values({
          channelId,
          nextProfileSyncAt: nextDayAt2UTC(),
          consecutiveFailures: 0,
          initialBackfillStatus: 'pending',
        })
        .onConflictDoUpdate({
          target: channelSyncState.channelId,
          set: {
            nextProfileSyncAt: nextDayAt2UTC(),
            consecutiveFailures: 0,
            pausedUntil: null,
            initialBackfillStatus: 'pending',
          },
        });

      await this.queue.add('channel-initial-backfill', { channelId, workspaceId });
      this.logger.log(`Connect for channelId=${channelId}: sync state initialized + backfill enqueued`);
    }
  }

  function nextDayAt2UTC(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(2, 0, 0, 0);
    return d;
  }
  ```

- [ ] **Step 3: Register service in module + export**

  Modify `src/channels/analytics/analytics.module.ts` providers + exports:

  ```ts
  import { ChannelSyncLifecycleService } from './services/channel-sync-lifecycle.service';

  providers: [
    // ...existing...
    ChannelSyncLifecycleService,
  ],
  exports: [QuotaTrackerService, AnalyticsService, ChannelSyncLifecycleService],
  ```

- [ ] **Step 4: Wire into channels module**

  Modify `src/channels/channels.module.ts` — add `AnalyticsModule` to imports so the channels service can inject `ChannelSyncLifecycleService`:

  ```ts
  import { AnalyticsModule } from './analytics/analytics.module';

  // imports array — add:
  AnalyticsModule,
  ```

  Then modify the channel service (the one that handles disconnect — found in Step 1) to inject `ChannelSyncLifecycleService` and call `onChannelDisconnected(channelId)` after the disconnect logic completes successfully.

  Example (assuming `ChannelService.disconnect` exists):

  ```ts
  constructor(
    // ...existing deps...
    private readonly syncLifecycle: ChannelSyncLifecycleService,
  ) {}

  async disconnect(workspaceId: string, channelId: number): Promise<{ success: boolean }> {
    // ...existing disconnect logic...
    await this.syncLifecycle.onChannelDisconnected(channelId);
    return { success: true };
  }
  ```

  Also wire `onChannelConnected` at the end of every successful channel-connect flow (Pinterest, LinkedIn, YouTube, Bluesky, Mastodon, FB page connect, Twitter callback, etc.). Use grep:

  ```bash
  grep -rn "channelRepository.create\|.insert(channels)" src/channels/services/ | head -20
  ```

  At each insertion site, after the new channel row is created, call:

  ```ts
  await this.syncLifecycle.onChannelConnected(newChannel.id, newChannel.workspaceId);
  ```

- [ ] **Step 5: Build + smoke test**

  ```bash
  npm run build
  npm run start:dev
  ```

  In another terminal, connect a test channel (or use an existing test channel). Check Bull Board (`http://localhost:8000/admin/queues`) — should see a `channel-initial-backfill` job in the `channel-snapshots` queue. Then disconnect — check that no `channelId=X` jobs remain. Stop server.

- [ ] **Step 6: Commit**

  ```bash
  git add src/channels/analytics/services/channel-sync-lifecycle.service.ts src/channels/analytics/analytics.module.ts src/channels/channels.module.ts src/channels/services/
  git commit -m "feat(analytics): wire channel connect/disconnect to sync lifecycle (cancel jobs, init state, enqueue backfill)"
  ```

---

## Task 24: Smoke-test full Phase 1 contract

**Files:** none (validation only)

- [ ] **Step 1: Build clean**

  ```bash
  npm run build
  ```

  Expected: PASS.

- [ ] **Step 2: Run all unit tests**

  ```bash
  npm test -- --passWithNoTests
  ```

  Expected: all tests PASS (specifically: `QuotaTrackerService`, `ChannelOwnershipGuard`, `AnalyticsController`).

- [ ] **Step 3: Start dev server + verify endpoints exist**

  ```bash
  npm run start:dev
  ```

  In another terminal:

  ```bash
  curl -s http://localhost:8000/api-docs-json | python -m json.tool | grep -E "analytics|refresh|sync-state" | head -20
  ```

  Expected: paths include `/analytics/workspaces/{wsId}/channels/{channelId}/overview`, `/analytics/workspaces/{wsId}/channels/{channelId}/sync-state`, `/channels/workspaces/{wsId}/{channelId}/refresh`.

- [ ] **Step 4: Verify Bull Board shows 4 queues**

  Open `http://localhost:8000/admin/queues` in browser. Authenticate. Expected: queue list shows `post-publishing`, `token-refresh`, `drip-campaigns`, `channel-snapshots`.

- [ ] **Step 5: Final commit + tag**

  ```bash
  git status
  ```

  If clean:

  ```bash
  git tag -a phase-1-analytics-foundation -m "Phase 1 complete: backend foundation for channel analytics"
  ```

---

## Self-review checklist (run before marking plan complete)

After completing all 24 tasks above, verify against the spec (`docs/specs/2026-05-17-channel-analytics-foundation.md`):

- ✅ All 4 tables created (channel_snapshots, post_metric_snapshots, channel_analytics_daily, channel_sync_state)
- ✅ Capabilities registry + adapter interface defined
- ✅ QuotaTracker built and tested
- ✅ ChannelOwnershipGuard built and tested
- ✅ AnalyticsModule wired with controller, service, 3 endpoints (`/overview`, `/sync-state`, `/refresh`)
- ✅ CHANNEL_SNAPSHOTS queue registered with 4 processors
- ✅ Daily cron scheduler (profile snapshots @ 02:00 UTC, rollups @ 03:00 UTC)
- ✅ Bull Board mounted at `/admin/queues` with basic-auth gate
- ✅ Channel disconnect cancels pending jobs; channel connect initializes sync state + enqueues backfill
- ✅ Type sharing strategy NOT YET implemented (deferred to Phase 3 — frontend wiring)

**Deferred to Phase 2 (YouTube adapter):**
- YouTube adapter implementation
- Real `fetchProfileSnapshot` / `fetchPostMetrics` / `fetchRecentPosts` for YouTube
- Capabilities registry update for YouTube
- Initial backfill processor real implementation
- Per-post snapshot scheduling on post publish

**Deferred to Phase 3 (frontend wiring):**
- All frontend code
- openapi-typescript codegen
- Capabilities-driven widget shell
- Real React Query hooks
- Native vocabulary system
- Manage dropdown wiring
- Posts tab real data

---

## Phase 1 success criteria (from spec §15)

After Phase 1 alone, NONE of the spec's success criteria are end-to-end satisfied — that requires Phases 2 and 3. Phase 1 success is:

- ✅ TypeScript compiles cleanly
- ✅ All new tables exist in database
- ✅ All 4 BullMQ processors registered and visible in Bull Board
- ✅ Cron schedulers active on startup
- ✅ `/analytics/.../overview` returns shaped 200 response with stub data + capabilities + freshness fields
- ✅ Connect → see backfill job appear; disconnect → see queued jobs removed
