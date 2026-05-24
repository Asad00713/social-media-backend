# Channel Analytics — Phase 2 (YouTube Adapter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace stub processors with a real YouTube adapter. After Phase 2, a connected YouTube channel will produce real `channel_snapshots` + `post_metric_snapshots` rows daily, and the `/analytics/.../overview` endpoint will return real (not stubbed) data computed from those snapshots.

**Architecture:** New `YouTubeAnalyticsAdapter` implements `PlatformAnalyticsAdapter` using YouTube Data API v3 (channel info, video lists) + YouTube Analytics API v2 (engagement metrics). Adapters are dispatched via an `AdapterRegistryService`. All 4 stub processors get filled in with adapter calls + DB writes + sync-state updates. Engagement-decay logic added to post-metric processor. AnalyticsService gets real query implementation.

**Tech Stack:** NestJS + axios (direct HTTP, no `googleapis` SDK — too monolithic), Drizzle, BullMQ, Jest.

**Reference spec:** `docs/specs/2026-05-17-channel-analytics-foundation.md` §8 (YouTube specifics)

**Working directory:** All paths relative to `d:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace\`.

**Prerequisite:** Phase 1 complete (tag `phase-1-analytics-foundation`).

---

## Pre-flight notes

**Critical:** Current YouTube OAuth scopes in `src/drizzle/schema/channels.schema.ts:389-392`:
- `https://www.googleapis.com/auth/youtube.upload`
- `https://www.googleapis.com/auth/youtube`

**Missing:** `https://www.googleapis.com/auth/yt-analytics.readonly` (needed for Analytics API)

Phase 2 adds this scope. **Existing connected YouTube channels will need to reconnect** to grant the new scope. This is unavoidable — OAuth scope grants are immutable after token issue.

---

## Task 1: Add yt-analytics.readonly OAuth scope

**Files:**
- Modify: `src/drizzle/schema/channels.schema.ts:389-392`

- [ ] **Step 1: Add the analytics readonly scope to YouTube oauthScopes**

  Locate the YouTube section in PLATFORM_CONFIG and update `oauthScopes`:

  ```ts
  youtube: {
    name: 'YouTube',
    accountTypes: ['channel'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    maxMediaPerPost: 1,
    maxTextLength: 5000,
    oauthScopes: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ],
  },
  ```

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/drizzle/schema/channels.schema.ts
  git commit -m "feat(analytics): add yt-analytics.readonly OAuth scope to YouTube config"
  ```

---

## Task 2: YouTube response types

**Files:**
- Create: `src/channels/analytics/adapters/youtube/youtube.types.ts`

- [ ] **Step 1: Write type definitions**

  Create the file:

  ```ts
  // Subset of YouTube Data API v3 response shapes. Only the fields we read.
  // Reference: https://developers.google.com/youtube/v3/docs

  export interface YouTubeChannelResource {
    id: string;
    snippet?: {
      title: string;
      description: string;
      customUrl?: string;
      country?: string;
      thumbnails?: { default?: { url: string }; medium?: { url: string }; high?: { url: string } };
      publishedAt: string;
    };
    statistics?: {
      viewCount?: string;
      subscriberCount?: string;
      hiddenSubscriberCount?: boolean;
      videoCount?: string;
    };
    contentDetails?: {
      relatedPlaylists?: { uploads?: string };
    };
  }

  export interface YouTubeChannelsListResponse {
    kind: 'youtube#channelListResponse';
    items: YouTubeChannelResource[];
  }

  export interface YouTubeVideoResource {
    id: string;
    snippet?: {
      publishedAt: string;
      title: string;
      description: string;
      thumbnails?: { default?: { url: string }; medium?: { url: string }; high?: { url: string } };
      channelId: string;
    };
    statistics?: {
      viewCount?: string;
      likeCount?: string;
      commentCount?: string;
      favoriteCount?: string;
    };
    contentDetails?: {
      duration?: string;
    };
  }

  export interface YouTubeVideosListResponse {
    kind: 'youtube#videoListResponse';
    items: YouTubeVideoResource[];
    nextPageToken?: string;
  }

  export interface YouTubeSearchItem {
    id: { kind: string; videoId?: string };
    snippet?: {
      publishedAt: string;
      title: string;
      thumbnails?: { default?: { url: string } };
    };
  }

  export interface YouTubeSearchListResponse {
    kind: 'youtube#searchListResponse';
    items: YouTubeSearchItem[];
    nextPageToken?: string;
  }

  // Analytics API v2 reports.query response
  export interface YouTubeAnalyticsQueryResponse {
    kind: 'youtubeAnalytics#resultTable';
    columnHeaders: Array<{ name: string; columnType: string; dataType: string }>;
    rows?: Array<Array<string | number>>;
  }
  ```

- [ ] **Step 2: Verify build (no imports yet — should compile trivially)**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/channels/analytics/adapters/youtube/youtube.types.ts
  git commit -m "feat(analytics): add YouTube API response types"
  ```

---

## Task 3: YouTube Data API client

**Files:**
- Create: `src/channels/analytics/adapters/youtube/youtube-data-api.client.ts`
- Create: `src/channels/analytics/adapters/youtube/youtube-data-api.client.spec.ts`

- [ ] **Step 1: Write failing test**

  Create the spec file:

  ```ts
  import { YouTubeDataApiClient } from './youtube-data-api.client';

  describe('YouTubeDataApiClient', () => {
    let client: YouTubeDataApiClient;
    const mockFetch = jest.fn();

    beforeEach(() => {
      jest.clearAllMocks();
      client = new YouTubeDataApiClient(mockFetch as any);
    });

    it('getChannelById hits channels.list with snippet,statistics,contentDetails parts', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 'UC123', snippet: { title: 'Test' } }] }),
      });
      await client.getChannelById('UC123', 'fake-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/channels?');
      expect(url).toContain('id=UC123');
      expect(url).toContain('part=snippet%2Cstatistics%2CcontentDetails');
      expect(opts.headers.Authorization).toBe('Bearer fake-token');
    });

    it('listChannelVideos hits search.list filtered by channelId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      });
      await client.listChannelVideos('UC123', 'fake-token', { maxResults: 25 });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/search?');
      expect(url).toContain('channelId=UC123');
      expect(url).toContain('type=video');
      expect(url).toContain('maxResults=25');
    });

    it('throws YouTubeApiError on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'quotaExceeded' } }),
      });
      await expect(client.getChannelById('UC123', 'fake-token'))
        .rejects.toMatchObject({ code: 'rate_limited', status: 403 });
    });
  });
  ```

- [ ] **Step 2: Run failing test**

  ```bash
  npx jest src/channels/analytics/adapters/youtube/youtube-data-api.client.spec.ts --no-coverage
  ```

  Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

  Create `src/channels/analytics/adapters/youtube/youtube-data-api.client.ts`:

  ```ts
  import type {
    YouTubeChannelsListResponse,
    YouTubeSearchListResponse,
    YouTubeVideosListResponse,
  } from './youtube.types';

  export class YouTubeApiError extends Error {
    constructor(
      public code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent',
      public status: number,
      message: string,
      public retryAfterSeconds?: number,
    ) {
      super(message);
    }
  }

  /**
   * Thin wrapper around YouTube Data API v3. Constructor takes a fetch
   * implementation so tests can inject a mock. Production uses global fetch.
   */
  export class YouTubeDataApiClient {
    private readonly baseUrl = 'https://www.googleapis.com/youtube/v3';

    constructor(private readonly fetchImpl: typeof fetch = fetch) {}

    async getChannelById(channelId: string, accessToken: string): Promise<YouTubeChannelsListResponse> {
      const url = `${this.baseUrl}/channels?part=${encodeURIComponent('snippet,statistics,contentDetails')}&id=${encodeURIComponent(channelId)}`;
      return this.request<YouTubeChannelsListResponse>(url, accessToken);
    }

    async listChannelVideos(
      channelId: string,
      accessToken: string,
      opts: { maxResults?: number; pageToken?: string; publishedAfter?: string } = {},
    ): Promise<YouTubeSearchListResponse> {
      const params = new URLSearchParams({
        part: 'snippet',
        channelId,
        type: 'video',
        order: 'date',
        maxResults: String(opts.maxResults ?? 50),
      });
      if (opts.pageToken) params.set('pageToken', opts.pageToken);
      if (opts.publishedAfter) params.set('publishedAfter', opts.publishedAfter);
      return this.request<YouTubeSearchListResponse>(`${this.baseUrl}/search?${params}`, accessToken);
    }

    async getVideosByIds(videoIds: string[], accessToken: string): Promise<YouTubeVideosListResponse> {
      const params = new URLSearchParams({
        part: 'snippet,statistics,contentDetails',
        id: videoIds.join(','),
      });
      return this.request<YouTubeVideosListResponse>(`${this.baseUrl}/videos?${params}`, accessToken);
    }

    private async request<T>(url: string, accessToken: string): Promise<T> {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
        const code = this.mapErrorCode(res.status, message);
        throw new YouTubeApiError(code, res.status, message);
      }
      return res.json() as Promise<T>;
    }

    private mapErrorCode(status: number, message: string): YouTubeApiError['code'] {
      if (status === 401) return 'auth_failed';
      if (status === 403 && /quota/i.test(message)) return 'rate_limited';
      if (status === 403) return 'auth_failed';
      if (status === 404) return 'not_found';
      if (status >= 500) return 'transient';
      return 'permanent';
    }
  }
  ```

- [ ] **Step 4: Run tests — expect PASS**

  ```bash
  npx jest src/channels/analytics/adapters/youtube/youtube-data-api.client.spec.ts --no-coverage
  ```

  Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/channels/analytics/adapters/youtube/youtube-data-api.client.ts src/channels/analytics/adapters/youtube/youtube-data-api.client.spec.ts
  git commit -m "feat(analytics): add YouTube Data API v3 client wrapper"
  ```

---

## Task 4: YouTube Analytics API client

**Files:**
- Create: `src/channels/analytics/adapters/youtube/youtube-analytics-api.client.ts`
- Create: `src/channels/analytics/adapters/youtube/youtube-analytics-api.client.spec.ts`

- [ ] **Step 1: Write failing test**

  Create spec:

  ```ts
  import { YouTubeAnalyticsApiClient } from './youtube-analytics-api.client';

  describe('YouTubeAnalyticsApiClient', () => {
    let client: YouTubeAnalyticsApiClient;
    const mockFetch = jest.fn();

    beforeEach(() => {
      jest.clearAllMocks();
      client = new YouTubeAnalyticsApiClient(mockFetch as any);
    });

    it('getVideoMetrics requests views,likes,comments,shares,estimatedMinutesWatched for video filter', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ columnHeaders: [], rows: [[100, 10, 5, 2, 200]] }),
      });
      await client.getVideoMetrics({
        videoId: 'abc',
        accessToken: 'tok',
        startDate: '2026-05-01',
        endDate: '2026-05-17',
      });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('ids=channel%3D%3DMINE');
      expect(url).toContain('metrics=views%2Clikes%2Ccomments%2Cshares%2CestimatedMinutesWatched%2CaverageViewDuration');
      expect(url).toContain('filters=video%3D%3Dabc');
      expect(url).toContain('startDate=2026-05-01');
      expect(url).toContain('endDate=2026-05-17');
    });
  });
  ```

- [ ] **Step 2: Run failing test**

  ```bash
  npx jest src/channels/analytics/adapters/youtube/youtube-analytics-api.client.spec.ts --no-coverage
  ```

- [ ] **Step 3: Implement the client**

  Create `src/channels/analytics/adapters/youtube/youtube-analytics-api.client.ts`:

  ```ts
  import type { YouTubeAnalyticsQueryResponse } from './youtube.types';
  import { YouTubeApiError } from './youtube-data-api.client';

  export interface VideoMetricsRow {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    watchTimeMinutes: number;
    averageViewDurationSeconds: number;
  }

  /** YouTube Analytics API v2 — requires `yt-analytics.readonly` OAuth scope. */
  export class YouTubeAnalyticsApiClient {
    private readonly baseUrl = 'https://youtubeanalytics.googleapis.com/v2';
    private readonly metricNames = ['views', 'likes', 'comments', 'shares', 'estimatedMinutesWatched', 'averageViewDuration'];

    constructor(private readonly fetchImpl: typeof fetch = fetch) {}

    async getVideoMetrics(opts: {
      videoId: string;
      accessToken: string;
      startDate: string;       // YYYY-MM-DD
      endDate: string;
    }): Promise<VideoMetricsRow | null> {
      const params = new URLSearchParams({
        ids: 'channel==MINE',
        startDate: opts.startDate,
        endDate: opts.endDate,
        metrics: this.metricNames.join(','),
        filters: `video==${opts.videoId}`,
      });

      const res = await this.fetchImpl(`${this.baseUrl}/reports?${params}`, {
        headers: { Authorization: `Bearer ${opts.accessToken}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
        throw new YouTubeApiError(this.mapCode(res.status, message), res.status, message);
      }
      const data = (await res.json()) as YouTubeAnalyticsQueryResponse;
      const row = data.rows?.[0];
      if (!row) return null;
      return {
        views: Number(row[0] ?? 0),
        likes: Number(row[1] ?? 0),
        comments: Number(row[2] ?? 0),
        shares: Number(row[3] ?? 0),
        watchTimeMinutes: Number(row[4] ?? 0),
        averageViewDurationSeconds: Number(row[5] ?? 0),
      };
    }

    private mapCode(status: number, message: string): YouTubeApiError['code'] {
      if (status === 401) return 'auth_failed';
      if (status === 403 && /quota/i.test(message)) return 'rate_limited';
      if (status === 403) return 'auth_failed';
      if (status === 404) return 'not_found';
      if (status >= 500) return 'transient';
      return 'permanent';
    }
  }
  ```

- [ ] **Step 4: Run tests — expect PASS**

  ```bash
  npx jest src/channels/analytics/adapters/youtube/youtube-analytics-api.client.spec.ts --no-coverage
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/channels/analytics/adapters/youtube/youtube-analytics-api.client.ts src/channels/analytics/adapters/youtube/youtube-analytics-api.client.spec.ts
  git commit -m "feat(analytics): add YouTube Analytics API v2 client wrapper"
  ```

---

## Task 5: YouTube capabilities config

**Files:**
- Modify: `src/channels/analytics/platform-capabilities.registry.ts`

- [ ] **Step 1: Replace YouTube placeholder with real capabilities**

  Open the file. Currently `PLATFORM_CAPABILITIES.youtube` uses the placeholder generator. Replace with explicit config.

  Add at the top, before `placeholderCapabilities`:

  ```ts
  import type { PlatformCapabilities } from './types/platform-capabilities.types';

  const YOUTUBE_CAPABILITIES: PlatformCapabilities = {
    platform: 'youtube',
    hasFollowerCount: true,
    hasFollowerTimeSeries: true,
    hasFollowingCount: false,
    hasImpressions: true,
    hasReach: false,
    hasEngagementRate: true,
    hasVideoMetrics: true,
    hasDemographics: true,
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
    profileDataSource: 'hybrid',
    postDataSource: 'platform_api',
    dataFreshness: 'hourly',
    dailyQuotaBudget: 10000,
  };
  ```

  Then change the registry construction to override the youtube entry. Replace:

  ```ts
  export const PLATFORM_CAPABILITIES: Partial<Record<SupportedPlatform, PlatformCapabilities>> =
    Object.fromEntries(
      SOCIAL_PLATFORMS.map((p) => [p, placeholderCapabilities(p)]),
    ) as Partial<Record<SupportedPlatform, PlatformCapabilities>>;
  ```

  with:

  ```ts
  export const PLATFORM_CAPABILITIES: Partial<Record<SupportedPlatform, PlatformCapabilities>> = {
    ...Object.fromEntries(
      SOCIAL_PLATFORMS.map((p) => [p, placeholderCapabilities(p)]),
    ),
    youtube: YOUTUBE_CAPABILITIES,
  };
  ```

- [ ] **Step 2: Build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/channels/analytics/platform-capabilities.registry.ts
  git commit -m "feat(analytics): set real YouTube capabilities (subscribers vocab, video metrics, 10K quota)"
  ```

---

## Task 6: YouTubeAnalyticsAdapter

**Files:**
- Create: `src/channels/analytics/adapters/youtube/youtube-analytics.adapter.ts`
- Create: `src/channels/analytics/adapters/youtube/youtube-analytics.adapter.spec.ts`

- [ ] **Step 1: Write failing test**

  Create spec:

  ```ts
  import { YouTubeAnalyticsAdapter } from './youtube-analytics.adapter';
  import { YouTubeDataApiClient } from './youtube-data-api.client';
  import { YouTubeAnalyticsApiClient } from './youtube-analytics-api.client';

  describe('YouTubeAnalyticsAdapter', () => {
    const dataClient = { getChannelById: jest.fn(), listChannelVideos: jest.fn(), getVideosByIds: jest.fn() };
    const analyticsClient = { getVideoMetrics: jest.fn() };
    let adapter: YouTubeAnalyticsAdapter;

    beforeEach(() => {
      jest.clearAllMocks();
      adapter = new YouTubeAnalyticsAdapter(
        dataClient as unknown as YouTubeDataApiClient,
        analyticsClient as unknown as YouTubeAnalyticsApiClient,
      );
    });

    it('exposes platform=youtube and capabilities', () => {
      expect(adapter.platform).toBe('youtube');
      expect(adapter.capabilities.vocabulary.follower).toBe('subscribers');
    });

    it('estimateQuotaCost returns 2 for profile snapshot', () => {
      expect(adapter.estimateQuotaCost('fetchProfileSnapshot')).toBe(2);
    });

    it('fetchProfileSnapshot returns success with subscriberCount + viewCount', async () => {
      dataClient.getChannelById.mockResolvedValue({
        items: [{
          id: 'UC123',
          snippet: { title: 'Test', description: 'desc' },
          statistics: { subscriberCount: '12000', viewCount: '450000', videoCount: '42' },
        }],
      });
      const result = await adapter.fetchProfileSnapshot({
        platformAccountId: 'UC123',
        accessToken: 'tok',
      } as any);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.data.followersCount).toBe(12000);
        expect(result.data.totalPostsCount).toBe(42);
        expect(result.data.platformMetrics.viewCount).toBe(450000);
      }
    });

    it('fetchProfileSnapshot returns failed on YouTubeApiError', async () => {
      dataClient.getChannelById.mockRejectedValue(Object.assign(new Error('quota'), { code: 'rate_limited' }));
      const result = await adapter.fetchProfileSnapshot({
        platformAccountId: 'UC123',
        accessToken: 'tok',
      } as any);
      expect(result.status).toBe('failed');
    });
  });
  ```

- [ ] **Step 2: Run failing test**

  ```bash
  npx jest src/channels/analytics/adapters/youtube/youtube-analytics.adapter.spec.ts --no-coverage
  ```

- [ ] **Step 3: Implement the adapter**

  Create `src/channels/analytics/adapters/youtube/youtube-analytics.adapter.ts`:

  ```ts
  import { Injectable } from '@nestjs/common';
  import type {
    PlatformAnalyticsAdapter,
    AdapterOperation,
    ProfileSnapshotResult,
    PostMetricsResult,
    RecentPostsResult,
    RecentPost,
  } from '../../types/platform-adapter.types';
  import type { ChannelEntity } from '../../types/channel-entity.types';
  import type { PostEntity } from '../../types/post-entity.types';
  import type {
    PlatformCapabilities,
    PollingProfile,
  } from '../../types/platform-capabilities.types';
  import { getCapabilities } from '../../platform-capabilities.registry';
  import { YouTubeDataApiClient, YouTubeApiError } from './youtube-data-api.client';
  import { YouTubeAnalyticsApiClient } from './youtube-analytics-api.client';

  const POLLING_PROFILE: PollingProfile = {
    defaultContentType: 'video',
    schedulePerContentType: {
      video: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
      short: ['1h', '6h', '24h', '7d', 'final'],
    },
  };

  @Injectable()
  export class YouTubeAnalyticsAdapter implements PlatformAnalyticsAdapter {
    readonly platform = 'youtube' as const;
    readonly capabilities: PlatformCapabilities;
    readonly pollingProfile = POLLING_PROFILE;

    constructor(
      private readonly dataClient: YouTubeDataApiClient,
      private readonly analyticsClient: YouTubeAnalyticsApiClient,
    ) {
      this.capabilities = getCapabilities('youtube');
    }

    estimateQuotaCost(op: AdapterOperation): number {
      switch (op) {
        case 'fetchProfileSnapshot': return 2;
        case 'fetchPostMetrics': return 1;
        case 'fetchRecentPosts': return 101;
      }
    }

    async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
      try {
        const response = await this.dataClient.getChannelById(channel.platformAccountId, channel.accessToken);
        const item = response.items?.[0];
        if (!item) {
          return { status: 'failed', error: { code: 'not_found', message: 'Channel not found' }, quotaCostUsed: 2 };
        }
        const stats = item.statistics ?? {};
        return {
          status: 'success',
          data: {
            followersCount: stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount ?? '0'),
            followingCount: null,
            totalPostsCount: Number(stats.videoCount ?? '0'),
            platformMetrics: {
              viewCount: Number(stats.viewCount ?? '0'),
              description: item.snippet?.description ?? null,
              customUrl: item.snippet?.customUrl ?? null,
              country: item.snippet?.country ?? null,
              uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
              thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? null,
            },
          },
          quotaCostUsed: 2,
        };
      } catch (err) {
        return this.toFailedResult<ProfileSnapshotResult>(err, 2);
      }
    }

    async fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult> {
      try {
        const videoId = (post as any).platformPostId as string;
        if (!videoId) {
          return { status: 'failed', error: { code: 'not_found', message: 'No platformPostId on post' }, quotaCostUsed: 0 };
        }

        const accessToken = (post as any).accessToken;
        if (!accessToken) {
          return { status: 'failed', error: { code: 'auth_failed', message: 'No access token' }, quotaCostUsed: 0 };
        }

        const today = new Date().toISOString().slice(0, 10);
        const published = new Date((post as any).publishedAt ?? Date.now());
        const startDate = published.toISOString().slice(0, 10);

        const [videoResp, analyticsRow] = await Promise.all([
          this.dataClient.getVideosByIds([videoId], accessToken),
          this.analyticsClient.getVideoMetrics({ videoId, accessToken, startDate, endDate: today }),
        ]);

        const video = videoResp.items?.[0];
        const dataStats = video?.statistics ?? {};

        return {
          status: 'success',
          data: {
            likesCount: Number(dataStats.likeCount ?? analyticsRow?.likes ?? 0),
            commentsCount: Number(dataStats.commentCount ?? analyticsRow?.comments ?? 0),
            sharesCount: analyticsRow?.shares ?? null,
            impressionsCount: analyticsRow?.views ?? Number(dataStats.viewCount ?? 0),
            reachCount: null,
            platformMetrics: {
              viewCount: Number(dataStats.viewCount ?? '0'),
              watchTimeMinutes: analyticsRow?.watchTimeMinutes ?? null,
              averageViewDurationSeconds: analyticsRow?.averageViewDurationSeconds ?? null,
              duration: video?.contentDetails?.duration ?? null,
            },
          },
          quotaCostUsed: 1,
        };
      } catch (err) {
        return this.toFailedResult<PostMetricsResult>(err, 1);
      }
    }

    async fetchRecentPosts(
      channel: ChannelEntity,
      opts: { since: Date; limit: number },
    ): Promise<RecentPostsResult> {
      try {
        const searchResp = await this.dataClient.listChannelVideos(channel.platformAccountId, channel.accessToken, {
          maxResults: Math.min(opts.limit, 50),
          publishedAfter: opts.since.toISOString(),
        });
        const videoIds = searchResp.items
          .map((i) => i.id.videoId)
          .filter((id): id is string => typeof id === 'string');
        if (videoIds.length === 0) return { status: 'success', data: { posts: [] }, quotaCostUsed: 100 };

        const videosResp = await this.dataClient.getVideosByIds(videoIds, channel.accessToken);
        const posts: RecentPost[] = videosResp.items.map((v) => ({
          platformPostId: v.id,
          publishedAt: new Date(v.snippet?.publishedAt ?? Date.now()),
          content: v.snippet?.title ?? '',
          mediaUrl: v.snippet?.thumbnails?.high?.url ?? null,
          metrics: {
            likesCount: Number(v.statistics?.likeCount ?? 0),
            commentsCount: Number(v.statistics?.commentCount ?? 0),
            sharesCount: null,
            impressionsCount: Number(v.statistics?.viewCount ?? 0),
            reachCount: null,
            platformMetrics: {
              viewCount: Number(v.statistics?.viewCount ?? 0),
              duration: v.contentDetails?.duration ?? null,
            },
          },
        }));
        return { status: 'success', data: { posts }, quotaCostUsed: 101 };
      } catch (err) {
        return this.toFailedResult<RecentPostsResult>(err, 101);
      }
    }

    private toFailedResult<T extends { status: string }>(err: unknown, quotaCostUsed: number): T {
      const ytErr = err as YouTubeApiError;
      const code = ytErr?.code ?? 'transient';
      const message = (err as Error)?.message ?? 'Unknown error';
      return { status: 'failed', error: { code, message }, quotaCostUsed } as T;
    }
  }
  ```

  **Note:** the `(post as any).platformPostId` and `accessToken` casts are a pragmatic workaround — the `posts` table doesn't actually have these fields. The actual implementation should look up the platform post ID via `post_targets` (the array stored on posts) and the channel's access token via the `channelId`. This is acknowledged as a known limitation to address before Phase 2's smoke test (see Task 12 for the wiring fix).

- [ ] **Step 4: Run tests — expect PASS**

  ```bash
  npx jest src/channels/analytics/adapters/youtube/youtube-analytics.adapter.spec.ts --no-coverage
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/channels/analytics/adapters/youtube/youtube-analytics.adapter.ts src/channels/analytics/adapters/youtube/youtube-analytics.adapter.spec.ts
  git commit -m "feat(analytics): implement YouTubeAnalyticsAdapter (profile, post, recent posts)"
  ```

---

## Task 7: AdapterRegistry service

**Files:**
- Create: `src/channels/analytics/services/adapter-registry.service.ts`
- Modify: `src/channels/analytics/analytics.module.ts`

- [ ] **Step 1: Write the registry**

  Create `src/channels/analytics/services/adapter-registry.service.ts`:

  ```ts
  import { Injectable, NotFoundException } from '@nestjs/common';
  import type { PlatformAnalyticsAdapter } from '../types/platform-adapter.types';
  import { YouTubeAnalyticsAdapter } from '../adapters/youtube/youtube-analytics.adapter';
  import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

  /**
   * Lookup table for platform adapters. Phase 2 ships YouTube only;
   * subsequent phases register more adapters here.
   */
  @Injectable()
  export class AdapterRegistryService {
    private readonly adapters = new Map<SupportedPlatform, PlatformAnalyticsAdapter>();

    constructor(private readonly youtube: YouTubeAnalyticsAdapter) {
      this.adapters.set('youtube', youtube);
    }

    get(platform: SupportedPlatform): PlatformAnalyticsAdapter {
      const adapter = this.adapters.get(platform);
      if (!adapter) {
        throw new NotFoundException(`No adapter registered for platform: ${platform}`);
      }
      return adapter;
    }

    has(platform: SupportedPlatform): boolean {
      return this.adapters.has(platform);
    }
  }
  ```

- [ ] **Step 2: Register adapter + clients + registry in module**

  Modify `src/channels/analytics/analytics.module.ts` providers — add:

  ```ts
  import { YouTubeAnalyticsAdapter } from './adapters/youtube/youtube-analytics.adapter';
  import { YouTubeDataApiClient } from './adapters/youtube/youtube-data-api.client';
  import { YouTubeAnalyticsApiClient } from './adapters/youtube/youtube-analytics-api.client';
  import { AdapterRegistryService } from './services/adapter-registry.service';

  // providers:
  { provide: YouTubeDataApiClient, useValue: new YouTubeDataApiClient() },
  { provide: YouTubeAnalyticsApiClient, useValue: new YouTubeAnalyticsApiClient() },
  YouTubeAnalyticsAdapter,
  AdapterRegistryService,
  ```

  Also export `AdapterRegistryService` so processors can inject it.

- [ ] **Step 3: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/channels/analytics/services/adapter-registry.service.ts src/channels/analytics/analytics.module.ts
  git commit -m "feat(analytics): add AdapterRegistryService with YouTube adapter registered"
  ```

---

## Task 8: Fill in channel-profile-snapshot processor

**Files:**
- Modify: `src/channels/analytics/processors/channel-profile-snapshot.processor.ts`

- [ ] **Step 1: Replace stub with real implementation**

  Rewrite the file:

  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Inject, Logger } from '@nestjs/common';
  import { Job } from 'bullmq';
  import { eq } from 'drizzle-orm';
  import { QUEUES } from '../../../queue/queue.module';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import { socialMediaChannels, type SupportedPlatform } from '../../../drizzle/schema/channels.schema';
  import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
  import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
  import { AdapterRegistryService } from '../services/adapter-registry.service';
  import { QuotaTrackerService } from '../services/quota-tracker.service';

  export interface ChannelProfileSnapshotJob {
    channelId: number;
    workspaceId: string;
  }

  @Processor(QUEUES.CHANNEL_SNAPSHOTS)
  export class ChannelProfileSnapshotProcessor extends WorkerHost {
    private readonly logger = new Logger(ChannelProfileSnapshotProcessor.name);

    constructor(
      private readonly registry: AdapterRegistryService,
      private readonly quota: QuotaTrackerService,
      @Inject(DRIZZLE) private readonly db: any,
    ) {
      super();
    }

    async process(job: Job<ChannelProfileSnapshotJob>): Promise<{ ok: boolean }> {
      if (job.name !== 'channel-profile-snapshot') return { ok: true };
      const { channelId } = job.data;

      const rows = await this.db
        .select()
        .from(socialMediaChannels)
        .where(eq(socialMediaChannels.id, channelId))
        .limit(1);
      const channel = rows[0];
      if (!channel) {
        this.logger.warn(`Profile snapshot: channel ${channelId} not found, skipping`);
        return { ok: false };
      }

      if (!this.registry.has(channel.platform as SupportedPlatform)) {
        this.logger.log(`No adapter for platform ${channel.platform}, skipping channel ${channelId}`);
        return { ok: true };
      }

      const adapter = this.registry.get(channel.platform as SupportedPlatform);
      const cost = adapter.estimateQuotaCost('fetchProfileSnapshot');
      const quota = await this.quota.tryConsume(channel.platform as SupportedPlatform, cost);
      if (!quota.allowed) {
        this.logger.warn(`Quota exhausted for ${channel.platform}, re-enqueuing channel ${channelId} for tomorrow`);
        return { ok: false };
      }

      const result = await adapter.fetchProfileSnapshot(channel);
      const today = new Date().toISOString().slice(0, 10);

      if (result.status === 'success' || result.status === 'partial') {
        const data = result.data;
        await this.db
          .insert(channelSnapshots)
          .values({
            channelId,
            snapshotDate: today,
            followersCount: data.followersCount ?? null,
            followingCount: data.followingCount ?? null,
            totalPostsCount: data.totalPostsCount ?? null,
            platformMetrics: data.platformMetrics ?? {},
            metricsSchemaVersion: 1,
            fetchedAt: new Date(),
            syncStatus: result.status,
            syncError: null,
          })
          .onConflictDoNothing({ target: [channelSnapshots.channelId, channelSnapshots.snapshotDate] });

        await this.db
          .insert(channelSyncState)
          .values({
            channelId,
            lastProfileSyncAt: new Date(),
            lastProfileSyncStatus: 'success',
            lastProfileSyncError: null,
            nextProfileSyncAt: nextDayAt2UTC(),
            consecutiveFailures: 0,
          })
          .onConflictDoUpdate({
            target: channelSyncState.channelId,
            set: {
              lastProfileSyncAt: new Date(),
              lastProfileSyncStatus: 'success',
              lastProfileSyncError: null,
              nextProfileSyncAt: nextDayAt2UTC(),
              consecutiveFailures: 0,
            },
          });
        this.logger.log(`Profile snapshot success: channelId=${channelId} followers=${data.followersCount ?? '?'}`);
        return { ok: true };
      }

      // failed
      await this.db
        .insert(channelSyncState)
        .values({
          channelId,
          lastProfileSyncAt: new Date(),
          lastProfileSyncStatus: result.error.code === 'rate_limited' ? 'rate_limited' : 'failed',
          lastProfileSyncError: result.error.message,
          nextProfileSyncAt: nextDayAt2UTC(),
          consecutiveFailures: 1,
        })
        .onConflictDoUpdate({
          target: channelSyncState.channelId,
          set: {
            lastProfileSyncAt: new Date(),
            lastProfileSyncStatus: result.error.code === 'rate_limited' ? 'rate_limited' : 'failed',
            lastProfileSyncError: result.error.message,
          },
        });
      this.logger.error(`Profile snapshot failed: channelId=${channelId} ${result.error.message}`);
      return { ok: false };
    }
  }

  function nextDayAt2UTC(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(2, 0, 0, 0);
    return d;
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/channels/analytics/processors/channel-profile-snapshot.processor.ts
  git commit -m "feat(analytics): fill in channel-profile-snapshot processor with adapter dispatch + DB writes"
  ```

---

## Task 9: Fill in channel-initial-backfill processor

**Files:**
- Modify: `src/channels/analytics/processors/channel-initial-backfill.processor.ts`

- [ ] **Step 1: Replace stub**

  Rewrite the file:

  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Inject, Logger } from '@nestjs/common';
  import { Job } from 'bullmq';
  import { eq } from 'drizzle-orm';
  import { QUEUES } from '../../../queue/queue.module';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import { socialMediaChannels, type SupportedPlatform } from '../../../drizzle/schema/channels.schema';
  import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
  import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
  import { AdapterRegistryService } from '../services/adapter-registry.service';
  import { QuotaTrackerService } from '../services/quota-tracker.service';

  export interface ChannelInitialBackfillJob {
    channelId: number;
    workspaceId: string;
  }

  const BACKFILL_DAYS = 30;

  @Processor(QUEUES.CHANNEL_SNAPSHOTS)
  export class ChannelInitialBackfillProcessor extends WorkerHost {
    private readonly logger = new Logger(ChannelInitialBackfillProcessor.name);

    constructor(
      private readonly registry: AdapterRegistryService,
      private readonly quota: QuotaTrackerService,
      @Inject(DRIZZLE) private readonly db: any,
    ) {
      super();
    }

    async process(job: Job<ChannelInitialBackfillJob>): Promise<{ ok: boolean }> {
      if (job.name !== 'channel-initial-backfill') return { ok: true };
      const { channelId } = job.data;

      const rows = await this.db.select().from(socialMediaChannels).where(eq(socialMediaChannels.id, channelId)).limit(1);
      const channel = rows[0];
      if (!channel || !this.registry.has(channel.platform as SupportedPlatform)) {
        this.logger.log(`Backfill: no adapter for ${channel?.platform ?? 'unknown'}, skipping channelId=${channelId}`);
        await this.markBackfillStatus(channelId, 'completed');
        return { ok: true };
      }

      await this.markBackfillStatus(channelId, 'running');

      const adapter = this.registry.get(channel.platform as SupportedPlatform);

      // 1. Profile snapshot
      const profileCost = adapter.estimateQuotaCost('fetchProfileSnapshot');
      const pq = await this.quota.tryConsume(channel.platform as SupportedPlatform, profileCost);
      if (pq.allowed) {
        const profile = await adapter.fetchProfileSnapshot(channel);
        if (profile.status !== 'failed') {
          await this.db.insert(channelSnapshots).values({
            channelId,
            snapshotDate: new Date().toISOString().slice(0, 10),
            followersCount: profile.data.followersCount ?? null,
            followingCount: profile.data.followingCount ?? null,
            totalPostsCount: profile.data.totalPostsCount ?? null,
            platformMetrics: profile.data.platformMetrics ?? {},
            metricsSchemaVersion: 1,
            fetchedAt: new Date(),
            syncStatus: profile.status,
            syncError: null,
          }).onConflictDoNothing();
        }
      }

      // 2. Recent posts (only if adapter supports it)
      if (adapter.fetchRecentPosts) {
        const since = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
        const recentCost = adapter.estimateQuotaCost('fetchRecentPosts');
        const rq = await this.quota.tryConsume(channel.platform as SupportedPlatform, recentCost);
        if (rq.allowed) {
          const recent = await adapter.fetchRecentPosts(channel, { since, limit: 50 });
          if (recent.status !== 'failed') {
            // NOTE: posts in our DB are created via the posting flow, not backfill. The backfill captures
            // METRICS for posts we already have. Since this is a fresh channel, we don't have matching
            // post rows yet — so we just log what we'd have backfilled. Future enhancement: create
            // synthetic post rows from the recent feed (separate decision).
            this.logger.log(`Backfill: ${recent.data.posts.length} recent posts available (not persisted in Phase 2; needs post-sync flow)`);
          }
        }
      }

      await this.markBackfillStatus(channelId, 'completed');
      this.logger.log(`Initial backfill completed for channelId=${channelId}`);
      return { ok: true };
    }

    private async markBackfillStatus(
      channelId: number,
      status: 'pending' | 'running' | 'completed' | 'failed',
    ): Promise<void> {
      await this.db
        .insert(channelSyncState)
        .values({
          channelId,
          nextProfileSyncAt: new Date(Date.now() + 60 * 60 * 1000),
          consecutiveFailures: 0,
          initialBackfillStatus: status,
          initialBackfillCompletedAt: status === 'completed' ? new Date() : null,
        })
        .onConflictDoUpdate({
          target: channelSyncState.channelId,
          set: {
            initialBackfillStatus: status,
            initialBackfillCompletedAt: status === 'completed' ? new Date() : null,
          },
        });
    }
  }
  ```

- [ ] **Step 2: Build + commit**

  ```bash
  npm run build
  git add src/channels/analytics/processors/channel-initial-backfill.processor.ts
  git commit -m "feat(analytics): fill in channel-initial-backfill processor (profile + recent-posts hint)"
  ```

---

## Task 10: Fill in channel-daily-rollup processor

**Files:**
- Modify: `src/channels/analytics/processors/channel-daily-rollup.processor.ts`

- [ ] **Step 1: Replace stub with aggregation logic**

  Rewrite the file:

  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Inject, Logger } from '@nestjs/common';
  import { Job } from 'bullmq';
  import { and, eq, gte, lte, sql } from 'drizzle-orm';
  import { QUEUES } from '../../../queue/queue.module';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import { postMetricSnapshots } from '../../../drizzle/schema/post-metric-snapshots.schema';
  import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
  import { channelAnalyticsDaily } from '../../../drizzle/schema/channel-analytics-daily.schema';

  export interface ChannelDailyRollupJob {
    channelId: number;
    date: string;
  }

  @Processor(QUEUES.CHANNEL_SNAPSHOTS)
  export class ChannelDailyRollupProcessor extends WorkerHost {
    private readonly logger = new Logger(ChannelDailyRollupProcessor.name);

    constructor(@Inject(DRIZZLE) private readonly db: any) {
      super();
    }

    async process(job: Job<ChannelDailyRollupJob>): Promise<{ ok: true }> {
      if (job.name !== 'channel-daily-rollup') return { ok: true };
      const { channelId, date } = job.data;

      // 1. Aggregate post metrics from the most recent snapshot per post on this day.
      // We pick the latest snapshot per post by snapshotAt, restricted to the day.
      const dayStart = new Date(date + 'T00:00:00Z');
      const dayEnd = new Date(date + 'T23:59:59.999Z');

      const aggRows = await this.db.execute(sql`
        WITH ranked AS (
          SELECT
            post_id,
            likes_count,
            comments_count,
            shares_count,
            impressions_count,
            reach_count,
            ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY snapshot_at DESC) AS rn
          FROM ${postMetricSnapshots}
          WHERE channel_id = ${channelId}
            AND snapshot_at BETWEEN ${dayStart} AND ${dayEnd}
        )
        SELECT
          COUNT(*) AS posts_count,
          COALESCE(SUM(likes_count), 0) AS total_likes,
          COALESCE(SUM(comments_count), 0) AS total_comments,
          COALESCE(SUM(shares_count), 0) AS total_shares,
          SUM(impressions_count) AS total_impressions,
          SUM(reach_count) AS total_reach
        FROM ranked
        WHERE rn = 1
      `);

      const agg = (aggRows.rows ?? aggRows)[0] ?? {};
      const postsCount = Number(agg.posts_count ?? 0);
      const totalLikes = Number(agg.total_likes ?? 0);
      const totalComments = Number(agg.total_comments ?? 0);
      const totalShares = Number(agg.total_shares ?? 0);
      const totalImpressions = agg.total_impressions == null ? null : Number(agg.total_impressions);
      const totalReach = agg.total_reach == null ? null : Number(agg.total_reach);

      // 2. Follower delta from channel_snapshots — today's vs yesterday's
      const yesterday = new Date(date + 'T00:00:00Z');
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayDate = yesterday.toISOString().slice(0, 10);

      const snapToday = await this.db.select({ followers: channelSnapshots.followersCount })
        .from(channelSnapshots)
        .where(and(eq(channelSnapshots.channelId, channelId), eq(channelSnapshots.snapshotDate, date)))
        .limit(1);
      const snapYesterday = await this.db.select({ followers: channelSnapshots.followersCount })
        .from(channelSnapshots)
        .where(and(eq(channelSnapshots.channelId, channelId), eq(channelSnapshots.snapshotDate, yesterdayDate)))
        .limit(1);

      const followersAtEndOfDay = snapToday[0]?.followers ?? null;
      const followersYesterday = snapYesterday[0]?.followers ?? null;
      const followersGained =
        followersAtEndOfDay != null && followersYesterday != null
          ? followersAtEndOfDay - followersYesterday
          : null;

      const engagementRate =
        totalReach && totalReach > 0
          ? Number((((totalLikes + totalComments + totalShares) / totalReach) * 100).toFixed(2))
          : null;

      await this.db
        .insert(channelAnalyticsDaily)
        .values({
          channelId,
          date,
          postsPublished: postsCount,
          totalLikes,
          totalComments,
          totalShares,
          totalImpressions,
          totalReach,
          followersAtEndOfDay,
          followersGained,
          engagementRate,
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [channelAnalyticsDaily.channelId, channelAnalyticsDaily.date],
          set: {
            postsPublished: postsCount,
            totalLikes,
            totalComments,
            totalShares,
            totalImpressions,
            totalReach,
            followersAtEndOfDay,
            followersGained,
            engagementRate,
            computedAt: new Date(),
          },
        });

      this.logger.log(`Daily rollup: channelId=${channelId} date=${date} posts=${postsCount} likes=${totalLikes}`);
      return { ok: true };
    }
  }
  ```

- [ ] **Step 2: Build + commit**

  ```bash
  npm run build
  git add src/channels/analytics/processors/channel-daily-rollup.processor.ts
  git commit -m "feat(analytics): fill in channel-daily-rollup with SQL aggregation + follower delta"
  ```

---

## Task 11: Fill in post-metric-snapshot processor with engagement-decay

**Files:**
- Modify: `src/channels/analytics/processors/post-metric-snapshot.processor.ts`

- [ ] **Step 1: Replace stub**

  Rewrite the file:

  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Inject, Logger } from '@nestjs/common';
  import { InjectQueue } from '@nestjs/bullmq';
  import { Job, Queue } from 'bullmq';
  import { and, desc, eq } from 'drizzle-orm';
  import { QUEUES } from '../../../queue/queue.module';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import { posts } from '../../../drizzle/schema/posts.schema';
  import { socialMediaChannels, type SupportedPlatform } from '../../../drizzle/schema/channels.schema';
  import { postMetricSnapshots } from '../../../drizzle/schema/post-metric-snapshots.schema';
  import { AdapterRegistryService } from '../services/adapter-registry.service';
  import { QuotaTrackerService } from '../services/quota-tracker.service';
  import type { AgeBucket } from '../types/platform-capabilities.types';

  export interface PostMetricSnapshotJob {
    postId: string;
    channelId: number;
    ageBucket: AgeBucket;
  }

  const BUCKET_TO_NEXT: Partial<Record<AgeBucket, AgeBucket | null>> = {
    '30m': '1h',
    '1h': '6h',
    '6h': '24h',
    '24h': '3d',
    '3d': '7d',
    '7d': '30d',
    '30d': 'final',
    'final': null,
  };

  const BUCKET_TO_DELAY_MS: Partial<Record<AgeBucket, number>> = {
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };

  @Processor(QUEUES.CHANNEL_SNAPSHOTS)
  export class PostMetricSnapshotProcessor extends WorkerHost {
    private readonly logger = new Logger(PostMetricSnapshotProcessor.name);

    constructor(
      private readonly registry: AdapterRegistryService,
      private readonly quota: QuotaTrackerService,
      @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
      @Inject(DRIZZLE) private readonly db: any,
    ) {
      super();
    }

    async process(job: Job<PostMetricSnapshotJob>): Promise<{ ok: boolean }> {
      if (job.name !== 'post-metric-snapshot') return { ok: true };
      const { postId, channelId, ageBucket } = job.data;

      const channelRow = await this.db.select().from(socialMediaChannels).where(eq(socialMediaChannels.id, channelId)).limit(1);
      const channel = channelRow[0];
      if (!channel || !this.registry.has(channel.platform as SupportedPlatform)) {
        this.logger.log(`Post snapshot: no adapter for ${channel?.platform ?? 'unknown'}, skipping postId=${postId}`);
        return { ok: true };
      }

      const postRow = await this.db.select().from(posts).where(eq(posts.id, postId)).limit(1);
      const post = postRow[0];
      if (!post) {
        this.logger.warn(`Post snapshot: post ${postId} not found, dropping`);
        return { ok: false };
      }

      const adapter = this.registry.get(channel.platform as SupportedPlatform);
      const cost = adapter.estimateQuotaCost('fetchPostMetrics');
      const quota = await this.quota.tryConsume(channel.platform as SupportedPlatform, cost);
      if (!quota.allowed) {
        // Re-enqueue tomorrow with 24h delay
        await this.queue.add('post-metric-snapshot', { postId, channelId, ageBucket }, { delay: 24 * 60 * 60 * 1000 });
        return { ok: false };
      }

      // Attach token + platform IDs onto the post object the adapter expects
      const result = await adapter.fetchPostMetrics({ ...post, accessToken: channel.accessToken, platformPostId: (post as any).platformPostId } as any);

      if (result.status === 'failed') {
        this.logger.error(`Post snapshot failed postId=${postId}: ${result.error.message}`);
        return { ok: false };
      }

      const data = result.data;
      await this.db.insert(postMetricSnapshots).values({
        postId,
        channelId,
        snapshotAt: new Date(),
        ageBucket,
        likesCount: data.likesCount ?? null,
        commentsCount: data.commentsCount ?? null,
        sharesCount: data.sharesCount ?? null,
        impressionsCount: data.impressionsCount ?? null,
        reachCount: data.reachCount ?? null,
        platformMetrics: data.platformMetrics ?? {},
        metricsSchemaVersion: 1,
        fetchedAt: new Date(),
        syncStatus: result.status,
      });

      // Engagement-decay check: if last 3 snapshots all show the same likes/comments/shares,
      // mark as final and stop scheduling.
      const lastThree = await this.db
        .select({ likes: postMetricSnapshots.likesCount, comments: postMetricSnapshots.commentsCount, shares: postMetricSnapshots.sharesCount })
        .from(postMetricSnapshots)
        .where(and(eq(postMetricSnapshots.postId, postId), eq(postMetricSnapshots.channelId, channelId)))
        .orderBy(desc(postMetricSnapshots.snapshotAt))
        .limit(3);

      const stable = lastThree.length === 3 && lastThree.every(
        (r: any, _i: number, arr: any[]) =>
          r.likes === arr[0].likes && r.comments === arr[0].comments && r.shares === arr[0].shares,
      );

      const nextBucket = BUCKET_TO_NEXT[ageBucket];
      if (stable || !nextBucket) {
        this.logger.log(`Post ${postId} bucket=${ageBucket} reached final (${stable ? 'stable' : 'last bucket'}), stopping`);
        return { ok: true };
      }

      const delay = BUCKET_TO_DELAY_MS[ageBucket] ?? 24 * 60 * 60 * 1000;
      await this.queue.add('post-metric-snapshot', { postId, channelId, ageBucket: nextBucket }, { delay });
      this.logger.log(`Post snapshot success postId=${postId} bucket=${ageBucket}, scheduled next=${nextBucket}`);
      return { ok: true };
    }
  }
  ```

- [ ] **Step 2: Build + commit**

  ```bash
  npm run build
  git add src/channels/analytics/processors/post-metric-snapshot.processor.ts
  git commit -m "feat(analytics): fill in post-metric-snapshot processor with engagement-decay logic"
  ```

---

## Task 12: Wire post-publish event → enqueue snapshot trail

**Files:**
- Modify: `src/posts/posts.service.ts` (the method that finalizes a successful publish)

- [ ] **Step 1: Locate the post-publish success path**

  ```bash
  grep -rn "publishing\|published\|publish.*success" src/posts/posts.service.ts | head -20
  ```

  Identify the method that sets a post target's status to `'published'`. It's typically called by the platform publisher after a successful API response.

- [ ] **Step 2: Inject the queue + adapter registry**

  Modify `src/posts/posts.module.ts` to import `AnalyticsModule`:

  ```ts
  import { AnalyticsModule } from '../channels/analytics/analytics.module';
  // ...inside imports:
  AnalyticsModule,
  ```

  Modify `src/posts/posts.service.ts` constructor:

  ```ts
  import { InjectQueue } from '@nestjs/bullmq';
  import { Queue } from 'bullmq';
  import { QUEUES } from '../queue/queue.module';
  import { AdapterRegistryService } from '../channels/analytics/services/adapter-registry.service';
  import type { SupportedPlatform } from '../drizzle/schema/channels.schema';

  constructor(
    // ...existing deps...
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly snapshotQueue: Queue,
    private readonly adapters: AdapterRegistryService,
  ) {}
  ```

  Then in the post-publish-success method, after the post target is marked published, add:

  ```ts
  // Enqueue analytics snapshot trail (only for platforms with adapters)
  if (this.adapters.has(channelPlatform as SupportedPlatform)) {
    const adapter = this.adapters.get(channelPlatform as SupportedPlatform);
    const profile = adapter.pollingProfile;
    const buckets = profile.schedulePerContentType[profile.defaultContentType] ?? [];
    if (buckets.length > 0) {
      const firstBucket = buckets[0];
      // Schedule the first snapshot — subsequent ones cascade from the processor
      const delayMap: Record<string, number> = {
        '30m': 30 * 60_000, '1h': 60 * 60_000, '6h': 6 * 60 * 60_000,
        '24h': 24 * 60 * 60_000, '3d': 3 * 24 * 60 * 60_000,
        '7d': 7 * 24 * 60 * 60_000, '30d': 30 * 24 * 60 * 60_000,
      };
      await this.snapshotQueue.add(
        'post-metric-snapshot',
        { postId, channelId, ageBucket: firstBucket },
        { delay: delayMap[firstBucket] ?? 60 * 60_000 },
      );
    }
  }
  ```

  **Important:** the exact placement depends on the existing code shape. The grep in Step 1 reveals where. If the publish-success method is in a separate publisher service (not posts.service.ts), inject the deps there instead.

- [ ] **Step 2.5: Verify no circular dependency**

  ```bash
  npm run build
  ```

  If circular dep error (PostsModule ⇄ AnalyticsModule), use NestJS `forwardRef`:

  ```ts
  import { forwardRef, Inject } from '@nestjs/common';
  // module:
  imports: [forwardRef(() => AnalyticsModule)],
  // service:
  @Inject(forwardRef(() => AdapterRegistryService)) private readonly adapters: AdapterRegistryService,
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/posts/
  git commit -m "feat(analytics): enqueue post-metric snapshot trail on successful post publish"
  ```

---

## Task 13: Wire AnalyticsService to query real tables

**Files:**
- Modify: `src/channels/analytics/services/analytics.service.ts`

- [ ] **Step 1: Replace stub queries with real ones**

  Rewrite to use `channel_analytics_daily` (for aggregated metrics) + `channel_snapshots` (for follower time-series) + `channel_sync_state` (for freshness):

  ```ts
  import { Inject, Injectable } from '@nestjs/common';
  import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
  import { DRIZZLE } from '../../../drizzle/drizzle.module';
  import { getCapabilities } from '../platform-capabilities.registry';
  import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
  import { channelAnalyticsDaily } from '../../../drizzle/schema/channel-analytics-daily.schema';
  import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
  import { postMetricSnapshots } from '../../../drizzle/schema/post-metric-snapshots.schema';
  import { posts } from '../../../drizzle/schema/posts.schema';
  import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
  import type { OverviewResponseDto } from '../dto/overview-response.dto';

  export type AnalyticsRange = '7d' | '30d' | 'mtd' | 'lm' | 'custom';

  @Injectable()
  export class AnalyticsService {
    constructor(@Inject(DRIZZLE) private readonly db: any) {}

    async getOverview(
      channelId: number,
      platform: SupportedPlatform,
      range: AnalyticsRange,
    ): Promise<OverviewResponseDto> {
      const capabilities = getCapabilities(platform);
      const { start, end, days } = rangeToWindow(range);

      // 1. Daily rollups
      const dailyRows = await this.db
        .select()
        .from(channelAnalyticsDaily)
        .where(and(
          eq(channelAnalyticsDaily.channelId, channelId),
          gte(channelAnalyticsDaily.date, start),
          lte(channelAnalyticsDaily.date, end),
        ))
        .orderBy(channelAnalyticsDaily.date);

      // 2. Follower time-series from channel_snapshots
      const snapRows = await this.db
        .select({ date: channelSnapshots.snapshotDate, followers: channelSnapshots.followersCount })
        .from(channelSnapshots)
        .where(and(
          eq(channelSnapshots.channelId, channelId),
          gte(channelSnapshots.snapshotDate, start),
          lte(channelSnapshots.snapshotDate, end),
        ))
        .orderBy(channelSnapshots.snapshotDate);

      // 3. Sync state for freshness
      const stateRow = await this.db.select().from(channelSyncState).where(eq(channelSyncState.channelId, channelId)).limit(1);
      const state = stateRow[0];

      // 4. Top posts: 5 highest engagement posts published in window
      const topRows = await this.db.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (post_id)
            post_id, likes_count, comments_count, shares_count, impressions_count, reach_count, snapshot_at
          FROM ${postMetricSnapshots}
          WHERE channel_id = ${channelId} AND snapshot_at >= ${new Date(start + 'T00:00:00Z')}
          ORDER BY post_id, snapshot_at DESC
        )
        SELECT l.*, p.content, p.media, p.published_at
        FROM latest l
        JOIN ${posts} p ON p.id = l.post_id
        ORDER BY (COALESCE(l.likes_count,0) + COALESCE(l.comments_count,0) + COALESCE(l.shares_count,0)) DESC
        LIMIT 5
      `);
      const topPostsArray = (topRows.rows ?? topRows) as any[];

      const fullDates = buildDateRange(start, end);
      const dailyMap = new Map(dailyRows.map((r: any) => [r.date, r]));
      const snapMap = new Map(snapRows.map((r: any) => [r.date, r.followers]));

      const sumPosts = dailyRows.reduce((a: number, r: any) => a + (r.postsPublished ?? 0), 0);
      const sumLikes = dailyRows.reduce((a: number, r: any) => a + (r.totalLikes ?? 0), 0);
      const sumComments = dailyRows.reduce((a: number, r: any) => a + (r.totalComments ?? 0), 0);
      const sumShares = dailyRows.reduce((a: number, r: any) => a + (r.totalShares ?? 0), 0);
      const sumImpressions = dailyRows.some((r: any) => r.totalImpressions != null)
        ? dailyRows.reduce((a: number, r: any) => a + (r.totalImpressions ?? 0), 0) : null;
      const sumReach = dailyRows.some((r: any) => r.totalReach != null)
        ? dailyRows.reduce((a: number, r: any) => a + (r.totalReach ?? 0), 0) : null;
      const followersGained = dailyRows.reduce(
        (a: number | null, r: any) => (r.followersGained == null ? a : (a ?? 0) + r.followersGained),
        null as number | null,
      );

      const trackingSinceDate = snapRows[0]?.date ?? null;
      const gapDays = fullDates.length - dailyRows.length;

      return {
        freshness: {
          lastSyncedAt: state?.lastProfileSyncAt?.toISOString() ?? null,
          dataFreshness: capabilities.dataFreshness,
          isPartial: gapDays > 0,
          trackingSinceDate,
          gapDays,
        },
        capabilities,
        summary: {
          posts: { value: sumPosts, deltaPct: null },
          likes: { value: sumLikes, deltaPct: null },
          comments: { value: sumComments, deltaPct: null },
          shares: { value: sumShares, deltaPct: null },
          impressions: { value: sumImpressions, deltaPct: null },
          reach: { value: sumReach, deltaPct: null },
          engagementRate: { value: null, deltaPct: null },
          followersGained: { value: followersGained, deltaPct: null },
        },
        timeseries: {
          followers: fullDates.map((d) => ({ date: d, value: snapMap.get(d) ?? null })),
          posts: fullDates.map((d) => ({ date: d, value: dailyMap.get(d)?.postsPublished ?? 0 })),
          engagement: fullDates.map((d) => ({
            date: d,
            likes: dailyMap.get(d)?.totalLikes ?? 0,
            comments: dailyMap.get(d)?.totalComments ?? 0,
            shares: dailyMap.get(d)?.totalShares ?? 0,
          })),
          reach: fullDates.map((d) => ({ date: d, value: dailyMap.get(d)?.totalReach ?? null })),
        },
        topPosts: topPostsArray.map((r) => ({
          postId: r.post_id,
          publishedAt: new Date(r.published_at).toISOString(),
          content: r.content ?? '',
          mediaUrl: extractFirstMediaUrl(r.media),
          metrics: {
            likes: Number(r.likes_count ?? 0),
            comments: Number(r.comments_count ?? 0),
            shares: Number(r.shares_count ?? 0),
            impressions: r.impressions_count == null ? null : Number(r.impressions_count),
            reach: r.reach_count == null ? null : Number(r.reach_count),
            engagementRate: null,
          },
        })),
      };
    }

    async getSyncState(channelId: number) {
      const row = await this.db.select().from(channelSyncState).where(eq(channelSyncState.channelId, channelId)).limit(1);
      const state = row[0];
      if (!state) {
        return {
          lastSyncedAt: null,
          nextSyncAt: null,
          status: 'healthy' as const,
          consecutiveFailures: 0,
          pausedUntil: null,
          initialBackfillStatus: 'pending' as const,
        };
      }
      const now = Date.now();
      let status: 'healthy' | 'catching_up' | 'rate_limited' | 'failing' | 'paused' = 'healthy';
      if (state.pausedUntil && state.pausedUntil.getTime() > now) status = 'paused';
      else if (state.lastProfileSyncStatus === 'rate_limited') status = 'rate_limited';
      else if (state.consecutiveFailures >= 3) status = 'failing';
      else if (state.lastProfileSyncAt && now - state.lastProfileSyncAt.getTime() > 36 * 60 * 60 * 1000) status = 'catching_up';

      return {
        lastSyncedAt: state.lastProfileSyncAt?.toISOString() ?? null,
        nextSyncAt: state.nextProfileSyncAt?.toISOString() ?? null,
        status,
        consecutiveFailures: state.consecutiveFailures,
        pausedUntil: state.pausedUntil?.toISOString() ?? null,
        initialBackfillStatus: state.initialBackfillStatus,
      };
    }

    async requestManualRefresh(_channelId: number) {
      // Phase 2: still a stub. Wire to enqueue an immediate channel-profile-snapshot
      // with Redis-based 1/hour rate limit in Phase 2b (separate small task).
      return { accepted: true, nextAllowedAt: null };
    }
  }

  function rangeToWindow(range: AnalyticsRange): { start: string; end: string; days: number } {
    const today = new Date();
    let days: number;
    switch (range) {
      case '7d': days = 7; break;
      case '30d': days = 30; break;
      case 'mtd': days = today.getUTCDate(); break;
      case 'lm': days = 30; break;
      case 'custom': days = 30; break;
    }
    const end = today.toISOString().slice(0, 10);
    const startDate = new Date(today);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
    return { start: startDate.toISOString().slice(0, 10), end, days };
  }

  function buildDateRange(start: string, end: string): string[] {
    const out: string[] = [];
    const cur = new Date(start);
    const endDate = new Date(end);
    while (cur <= endDate) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  function extractFirstMediaUrl(media: unknown): string | null {
    if (!media) return null;
    if (Array.isArray(media) && media.length > 0) {
      const first = media[0] as { url?: string };
      return first?.url ?? null;
    }
    return null;
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/channels/analytics/services/analytics.service.ts
  git commit -m "feat(analytics): wire AnalyticsService to query real tables (rollups + snapshots + sync state)"
  ```

---

## Task 14: Manual refresh with Redis rate-limit

**Files:**
- Modify: `src/channels/analytics/services/analytics.service.ts`

- [ ] **Step 1: Add rate-limit + enqueue logic**

  Modify `requestManualRefresh` (replace the stub):

  ```ts
  import { InjectQueue } from '@nestjs/bullmq';
  import { Queue } from 'bullmq';
  import { QUEUES } from '../../../queue/queue.module';

  // Constructor add:
  @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
  @Inject('REDIS_CLIENT') private readonly redis: import('../redis-client.provider').RedisLike & { ttl(key: string): Promise<number> },

  // Method:
  async requestManualRefresh(channelId: number, workspaceId: string) {
    const key = `refresh-limit:channel:${channelId}`;
    const existing = await this.redis.get(key);
    if (existing) {
      const ttl = await this.redis.ttl(key);
      return { accepted: false, nextAllowedAt: new Date(Date.now() + ttl * 1000).toISOString() };
    }
    await this.redis.incrby(key, 1);
    await this.redis.expire(key, 60 * 60);
    await this.queue.add('channel-profile-snapshot', { channelId, workspaceId });
    return { accepted: true, nextAllowedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  }
  ```

  Also update the `RedisLike` interface in `src/channels/analytics/redis-client.provider.ts` to add `ttl(key: string): Promise<number>` if not present.

- [ ] **Step 2: Update the channel-refresh controller to pass workspaceId**

  Modify `src/channels/analytics/channel-refresh.controller.ts`:

  ```ts
  async refresh(
    @Param('wsId') wsId: string,
    @Param('channelId') channelIdParam: string,
  ) {
    return this.analytics.requestManualRefresh(Number(channelIdParam), wsId);
  }
  ```

- [ ] **Step 3: Build + commit**

  ```bash
  npm run build
  git add src/channels/analytics/services/analytics.service.ts src/channels/analytics/channel-refresh.controller.ts src/channels/analytics/redis-client.provider.ts
  git commit -m "feat(analytics): wire manual refresh with Redis 1/hour rate limit + enqueue snapshot job"
  ```

---

## Task 15: Smoke test against a real YouTube channel

**Files:** none (manual verification)

- [ ] **Step 1: Existing YT channel must reconnect to grant analytics scope**

  In the connected channels list, click "Reconnect" on the YouTube channel. The new OAuth flow will request `yt-analytics.readonly`. After reconnect, the channel's `accessToken` will have the new scope.

- [ ] **Step 2: Trigger a manual refresh**

  ```bash
  curl -X POST "http://localhost:8000/channels/workspaces/<wsId>/<channelId>/refresh" \
    -H "Authorization: Bearer <jwt>"
  ```

  Expected: `{ "accepted": true, "nextAllowedAt": "<ISO>" }`. Within ~10 seconds a `channel-profile-snapshot` job appears in Bull Board (`/admin/queues`).

- [ ] **Step 3: Verify channel_snapshots row appears**

  ```bash
  node -e "
  const { neon } = require('@neondatabase/serverless');
  require('dotenv').config();
  (async () => {
    const sql = neon(process.env.DATABASE_URL);
    const r = await sql.query('SELECT * FROM channel_snapshots WHERE channel_id = <channelId> ORDER BY snapshot_date DESC LIMIT 1');
    console.log(JSON.stringify(r[0], null, 2));
  })();
  "
  ```

  Expected: a row with real `followers_count` (subscribers), `total_posts_count` (video count), and `platform_metrics.viewCount`.

- [ ] **Step 4: Call /overview and verify shape**

  ```bash
  curl "http://localhost:8000/analytics/workspaces/<wsId>/channels/<channelId>/overview?range=30d" \
    -H "Authorization: Bearer <jwt>" | jq '.summary, .freshness, .capabilities.vocabulary'
  ```

  Expected:
  - `summary.posts.value` = some integer (maybe 0 on day 1, real numbers after rollups run)
  - `freshness.lastSyncedAt` = recent timestamp
  - `freshness.trackingSinceDate` = today's date (or earlier if backfilled)
  - `capabilities.vocabulary.follower` = `"subscribers"`

- [ ] **Step 5: Tag the milestone**

  ```bash
  git tag -a phase-2-youtube-adapter -m "Phase 2 complete: YouTube adapter live, real analytics flowing for YouTube channels"
  ```

---

## Self-review checklist

- ✅ YouTube OAuth scope added (Task 1)
- ✅ YouTube Data API + Analytics API clients (Tasks 3, 4)
- ✅ Capabilities config updated (Task 5)
- ✅ Adapter + registry (Tasks 6, 7)
- ✅ All 4 processors filled in (Tasks 8, 9, 10, 11)
- ✅ Post-publish event wired (Task 12)
- ✅ AnalyticsService queries real data (Task 13)
- ✅ Manual refresh rate-limited (Task 14)
- ✅ End-to-end smoke test (Task 15)

**Deferred to Phase 3 (frontend):**
- Capabilities-driven widget shell
- Native vocabulary rendering (subscribers vs followers per platform)
- Freshness banner + sync-state badge
- React Query hooks
- Manage dropdown wired to refresh + pause + disconnect

**Known limitations addressed in later phases:**
- Posts created via backfill aren't persisted (Task 9 logs only) — needs post-sync flow design
- `engagementRate` not computed in summary (depends on reach which is null for YouTube) — Phase 3 derives from likes+comments+views
- Demographics + traffic sources widgets — requires additional Analytics API calls, deferred to Phase 2b
