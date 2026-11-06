import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { datesBetween, utcToday, windowOf } from '../post-performance/period';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import type { InsightsOverviewDto } from './dto/insights.dto';
import { InsightsService } from './insights.service';
import {
  MAX_HIDDEN_STEPS,
  REPOST_CAPTION_CHARS,
  REPOST_MAX_AGE_DAYS,
} from './lib/next-steps';
import type { CompareMode, ResolvedPeriod } from './lib/query';

const DAY = 86_400_000;
const NOW = new Date('2026-10-17T12:00:00Z');

interface Ws {
  userId: string;
  workspaceId: string;
  channel: (n: string, platform?: string) => Promise<number>;
}

async function workspace(client: PoolClient, tag: string): Promise<Ws> {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`u-${tag}-${Math.random().toString(36).slice(2, 8)}@example.test`],
  );
  const userId = u.rows[0].id;
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [tag, `${tag}-${Math.random().toString(36).slice(2, 8)}`, userId],
  );
  const workspaceId = w.rows[0].id;
  const channel = async (n: string, platform = 'twitter') =>
    Number(
      (
        await client.query<{ id: number }>(
          `INSERT INTO social_media_channels
             (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
           VALUES ($1, $4, 'personal', $2, $2, 'x', $3) RETURNING id`,
          [workspaceId, `${tag}-${n}`, userId, platform],
        )
      ).rows[0].id,
    );
  return { userId, workspaceId, channel };
}

async function publish(
  client: PoolClient,
  w: Ws,
  channelIds: number[],
  ageDays: number,
  statusField: 'status' | 'publishStatus' = 'status',
) {
  const at = new Date(NOW.getTime() - ageDays * DAY).toISOString();
  const targets = channelIds.map((c) => ({
    channelId: String(c),
    platform: 'twitter',
    [statusField]: 'published',
  }));
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, content, published_at, targets)
     VALUES ($1, $2, 'published', 'x', $3::timestamptz, $4::jsonb) RETURNING id`,
    [w.workspaceId, w.userId, at, JSON.stringify(targets)],
  );
  return r.rows[0].id;
}

interface Counts {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
}

async function snap(
  client: PoolClient,
  postId: string,
  channelId: number,
  ageHours: number,
  c: Counts,
) {
  const at = new Date(NOW.getTime() - ageHours * 3_600_000).toISOString();
  await client.query(
    `INSERT INTO post_metric_snapshots
       (post_id, channel_id, snapshot_at, age_bucket, likes_count, comments_count, shares_count, impressions_count, fetched_at, sync_status)
     VALUES ($1, $2, $3::timestamptz, '1d', $4, $5, $6, $7, $3::timestamptz, 'ok')`,
    [postId, channelId, at, c.likes, c.comments, c.shares, c.impressions],
  );
}

const counts = (likes: number, impressions: number | null = 100): Counts => ({
  likes,
  comments: 0,
  shares: 0,
  impressions,
});

describeDb('InsightsService.postMetrics', () => {
  const run = (
    fn: (svc: InsightsService, client: PoolClient) => Promise<void>,
  ) =>
    withRollbackDb([], async (db, client) => {
      const svc = new InsightsService(db, new PostPerformanceRepository(db));
      await fn(svc, client);
    });

  it('returns one row per (post, channel) from that channels latest snapshot', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'm1');
      const [c1, c2] = [await w.channel('a'), await w.channel('b')];
      const p = await publish(client, w, [c1, c2], 1);
      await snap(client, p, c1, 48, {
        likes: 1,
        comments: 1,
        shares: 1,
        impressions: 10,
      });
      await snap(client, p, c1, 2, {
        likes: 10,
        comments: 4,
        shares: 1,
        impressions: 500,
      });
      await snap(client, p, c2, 5, {
        likes: 3,
        comments: 0,
        shares: null,
        impressions: null,
      });

      const rows = await svc.postMetrics(w.workspaceId, [p], NOW);
      const byChannel = new Map(rows.map((r) => [r.channelId, r]));
      expect(rows).toHaveLength(2);
      expect(byChannel.get(c1)).toEqual({
        postId: p,
        channelId: c1,
        views: 500,
        likes: 10,
        comments: 4,
        engagements: 15,
        usualMultiplier: null,
      });
      expect(byChannel.get(c2)).toMatchObject({
        views: null,
        likes: 3,
        comments: 0,
        engagements: 3,
      });
    }));

  it('reads a target published under either status field', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'm2');
      const c = await w.channel('a');
      const p = await publish(client, w, [c], 1, 'publishStatus');
      const rows = await svc.postMetrics(w.workspaceId, [p], NOW);
      expect(rows.map((r) => r.channelId)).toEqual([c]);
    }));

  it('gives an unmeasured post null counts and 0 engagements', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'm3');
      const c = await w.channel('a');
      const p = await publish(client, w, [c], 1);
      expect(await svc.postMetrics(w.workspaceId, [p], NOW)).toEqual([
        {
          postId: p,
          channelId: c,
          views: null,
          likes: null,
          comments: null,
          engagements: 0,
          usualMultiplier: null,
        },
      ]);
    }));

  it('compares against the median of the channels measured posts from the last 90 days', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'm4');
      const c = await w.channel('a');
      // Measured in the window: 4,5,5,5,6 plus the target's own 10 -> median 5.
      for (const [i, e] of [4, 5, 5, 5, 6].entries()) {
        const q = await publish(client, w, [c], 5 + i);
        await snap(client, q, c, 1, counts(e));
      }
      // Outside the sample: older than 90 days, and never measured.
      const old = await publish(client, w, [c], 120);
      await snap(client, old, c, 1, counts(1000));
      await publish(client, w, [c], 2);

      const target = await publish(client, w, [c], 1);
      await snap(client, target, c, 1, counts(10));

      const rows = await svc.postMetrics(w.workspaceId, [target], NOW);
      expect(rows[0].usualMultiplier).toBe(2);
    }));

  it('gives an unmeasured post no multiplier even when the channel has a usual', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'm6');
      const c = await w.channel('a');
      for (const [i, e] of [4, 5, 5, 5, 6].entries()) {
        const q = await publish(client, w, [c], 5 + i);
        await snap(client, q, c, 1, counts(e));
      }
      const target = await publish(client, w, [c], 1);
      const rows = await svc.postMetrics(w.workspaceId, [target], NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0].engagements).toBe(0);
      expect(rows[0].usualMultiplier).toBeNull();
    }));

  it('returns nothing for a post id from another workspace', () =>
    run(async (svc, client) => {
      const mine = await workspace(client, 'm5a');
      const theirs = await workspace(client, 'm5b');
      const c = await theirs.channel('a');
      const p = await publish(client, theirs, [c], 1);
      await snap(client, p, c, 1, counts(9, 9));
      expect(await svc.postMetrics(mine.workspaceId, [p], NOW)).toEqual([]);
      expect(await svc.postMetrics(theirs.workspaceId, [p], NOW)).toHaveLength(
        1,
      );
    }));
});

interface Target {
  channelId: number;
  platform: string;
  platformPostUrl?: string;
}

/** A published post with per-platform overrides and post metadata. */
async function publishTo(
  client: PoolClient,
  w: Ws,
  targets: Target[],
  ageDays: number,
  opts: {
    platformContent?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const at = new Date(NOW.getTime() - ageDays * DAY).toISOString();
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, content, published_at, targets, platform_content, metadata)
     VALUES ($1, $2, 'published', 'x', $3::timestamptz, $4::jsonb, $5::jsonb, $6::jsonb) RETURNING id`,
    [
      w.workspaceId,
      w.userId,
      at,
      JSON.stringify(
        targets.map((t) => ({
          ...t,
          channelId: String(t.channelId),
          status: 'published',
        })),
      ),
      JSON.stringify(opts.platformContent ?? {}),
      JSON.stringify(opts.metadata ?? {}),
    ],
  );
  return r.rows[0].id;
}

/** A snapshot with reach and platform metrics, fetched at the snapshot time. */
async function snapMetrics(
  client: PoolClient,
  postId: string,
  channelId: number,
  ageHours: number,
  c: { likes?: number; reach?: number | null; metrics?: object },
) {
  const at = new Date(NOW.getTime() - ageHours * 3_600_000).toISOString();
  await client.query(
    `INSERT INTO post_metric_snapshots
       (post_id, channel_id, snapshot_at, age_bucket, likes_count, reach_count, platform_metrics, fetched_at, sync_status)
     VALUES ($1, $2, $3::timestamptz, '1d', $4, $5, $6::jsonb, $3::timestamptz, 'ok')`,
    [
      postId,
      channelId,
      at,
      c.likes ?? null,
      c.reach ?? null,
      JSON.stringify(c.metrics ?? {}),
    ],
  );
}

const story = (platform: string) => ({
  [platform]: { platformSpecific: { postType: 'story' } },
});

describeDb('PostPerformanceRepository.hasPublishedBefore', () => {
  it('finds a published post before the date, on the given channels only, never a Story or a draft', () =>
    withRollbackDb([], async (db, client) => {
      await client.query(`SET LOCAL TIME ZONE 'Asia/Karachi'`);
      const repo = new PostPerformanceRepository(db);
      const w = await workspace(client, 'hb');
      const ig = await w.channel('ig', 'instagram');
      const other = await w.channel('other');
      // 2026-03-31: an Instagram Story, then a post on the other channel.
      await publishTo(
        client,
        w,
        [{ channelId: ig, platform: 'instagram' }],
        200,
        {
          platformContent: story('instagram'),
        },
      );
      await publish(client, w, [other], 200);
      // A failed target never went out.
      await client.query(
        `INSERT INTO posts (workspace_id, created_by_id, status, content, published_at, targets)
         VALUES ($1, $2, 'published', 'x', $3::timestamptz, $4::jsonb)`,
        [
          w.workspaceId,
          w.userId,
          new Date(NOW.getTime() - 200 * DAY).toISOString(),
          JSON.stringify([{ channelId: String(ig), status: 'failed' }]),
        ],
      );
      expect(
        await repo.hasPublishedBefore(w.workspaceId, [ig], '2026-10-01'),
      ).toBe(false);
      expect(
        await repo.hasPublishedBefore(w.workspaceId, [other], '2026-10-01'),
      ).toBe(true);
      // The day itself is not "before".
      expect(
        await repo.hasPublishedBefore(w.workspaceId, [other], '2026-03-31'),
      ).toBe(false);
      expect(
        await repo.hasPublishedBefore(w.workspaceId, [], '2026-10-01'),
      ).toBe(false);
    }));
});

describeDb('PostPerformanceRepository.publishedPosts', () => {
  const FROM = '2026-09-01';
  const BEFORE = '2026-10-18';
  const run = (
    fn: (repo: PostPerformanceRepository, client: PoolClient) => Promise<void>,
  ) =>
    withRollbackDb([], async (db, client) => {
      await client.query(`SET LOCAL TIME ZONE 'Asia/Karachi'`);
      await fn(new PostPerformanceRepository(db), client);
    });

  it('excludes an Instagram story and a Facebook story', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 's1');
      const ig = await w.channel('ig', 'instagram');
      const fb = await w.channel('fb', 'facebook');
      await publishTo(
        client,
        w,
        [{ channelId: ig, platform: 'instagram' }],
        2,
        {
          platformContent: story('instagram'),
        },
      );
      await publishTo(client, w, [{ channelId: fb, platform: 'facebook' }], 2, {
        platformContent: story('facebook'),
      });
      const feed = await publishTo(
        client,
        w,
        [{ channelId: ig, platform: 'instagram' }],
        2,
        {
          platformContent: {
            instagram: { platformSpecific: { postType: 'feed' } },
          },
        },
      );
      const plain = await publishTo(
        client,
        w,
        [{ channelId: fb, platform: 'facebook' }],
        2,
      );

      const rows = await repo.publishedPosts(
        w.workspaceId,
        [ig, fb],
        FROM,
        BEFORE,
      );
      expect(rows.map((r) => r.postId).sort()).toEqual([feed, plain].sort());
    }));

  it('keeps a post whose other platform override is story only for that platform row', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 's2');
      const ig = await w.channel('ig', 'instagram');
      const fb = await w.channel('fb', 'facebook');
      const p = await publishTo(
        client,
        w,
        [
          { channelId: ig, platform: 'instagram' },
          { channelId: fb, platform: 'facebook' },
        ],
        2,
        { platformContent: story('instagram') },
      );

      const rows = await repo.publishedPosts(
        w.workspaceId,
        [ig, fb],
        FROM,
        BEFORE,
      );
      expect(rows.map((r) => [r.postId, r.channelId])).toEqual([[p, fb]]);
      expect(
        (await repo.publishedPostsByIds(w.workspaceId, [p])).map(
          (r) => r.channelId,
        ),
      ).toEqual([fb]);
    }));

  it('selects reach and saved from the latest snapshot, not an older one', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 's3');
      const ig = await w.channel('ig', 'instagram');
      const p = await publishTo(
        client,
        w,
        [{ channelId: ig, platform: 'instagram' }],
        3,
      );
      await snapMetrics(client, p, ig, 48, {
        likes: 90,
        reach: 9000,
        metrics: { saved: 900, follows: 90 },
      });
      await snapMetrics(client, p, ig, 2, {
        likes: 10,
        reach: 640,
        metrics: { saved: 12, follows: 3 },
      });
      await snapMetrics(client, p, ig, 30, {
        likes: 50,
        reach: 5000,
        metrics: { saved: 500, follows: 50 },
      });

      const [row] = await repo.publishedPosts(
        w.workspaceId,
        [ig],
        FROM,
        BEFORE,
      );
      expect(row).toMatchObject({
        likes: 10,
        reach: 640,
        saved: 12,
        follows: 3,
        syncedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
      });
    }));

  it('leaves reach, saves, follows and the sync time null before any snapshot', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 's4');
      const ig = await w.channel('ig', 'instagram');
      await publishTo(client, w, [{ channelId: ig, platform: 'instagram' }], 3);
      const [row] = await repo.publishedPosts(
        w.workspaceId,
        [ig],
        FROM,
        BEFORE,
      );
      expect(row).toMatchObject({
        reach: null,
        saved: null,
        follows: null,
        syncedAt: null,
        permalink: null,
      });
    }));

  it('imported post permalink falls back to the snapshot', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 's5');
      const ig = await w.channel('ig', 'instagram');
      const fb = await w.channel('fb', 'facebook');
      const ma = await w.channel('ma', 'mastodon');
      const imported = { metadata: { syncedFrom: 'platform' } };
      const pIg = await publishTo(
        client,
        w,
        [{ channelId: ig, platform: 'instagram' }],
        3,
        imported,
      );
      // The import snapshot names it; a later metrics-only snapshot does not.
      await snapMetrics(client, pIg, ig, 40, {
        metrics: { permalink: 'https://instagram.com/p/abc' },
      });
      await snapMetrics(client, pIg, ig, 2, { likes: 4 });
      const pFb = await publishTo(
        client,
        w,
        [{ channelId: fb, platform: 'facebook' }],
        3,
        imported,
      );
      await snapMetrics(client, pFb, fb, 2, {
        metrics: { permalinkUrl: 'https://facebook.com/1_2' },
      });
      const pMa = await publishTo(
        client,
        w,
        [{ channelId: ma, platform: 'mastodon' }],
        3,
        imported,
      );
      await snapMetrics(client, pMa, ma, 2, {
        metrics: { uri: 'tag:x', url: 'https://mastodon.social/@a/1' },
      });
      // A URL the target recorded wins over the snapshot's.
      const pOwn = await publishTo(
        client,
        w,
        [
          {
            channelId: ig,
            platform: 'instagram',
            platformPostUrl: 'https://instagram.com/p/own',
          },
        ],
        3,
      );
      await snapMetrics(client, pOwn, ig, 2, {
        metrics: { permalink: 'https://instagram.com/p/other' },
      });

      const rows = await repo.publishedPosts(
        w.workspaceId,
        [ig, fb, ma],
        FROM,
        BEFORE,
      );
      const link = new Map(rows.map((r) => [r.postId, r.permalink]));
      expect(link.get(pIg)).toBe('https://instagram.com/p/abc');
      expect(link.get(pFb)).toBe('https://facebook.com/1_2');
      expect(link.get(pMa)).toBe('https://mastodon.social/@a/1');
      expect(link.get(pOwn)).toBe('https://instagram.com/p/own');
    }));
});

describeDb('InsightsService.postMetrics after the usual moved', () => {
  it('Planner multiplier is unchanged after the move', () =>
    withRollbackDb([], async (db, client) => {
      await client.query(`SET LOCAL TIME ZONE 'Asia/Karachi'`);
      const svc = new InsightsService(db, new PostPerformanceRepository(db));
      const w = await workspace(client, 'mv');
      const [a, b] = [await w.channel('a'), await w.channel('b')];
      // Channel a: six measured posts, 3,4,5,5,6,8.
      for (const [i, e] of [3, 4, 5, 5, 6, 8].entries()) {
        const q = await publish(client, w, [a], 4 + i);
        await snap(client, q, a, 1, counts(e));
      }
      // Channel b: three measured posts; with the target's own, four.
      for (const [i, e] of [7, 7, 7].entries()) {
        const q = await publish(client, w, [b], 4 + i);
        await snap(client, q, b, 1, counts(e));
      }
      // Unmeasured posts in the window never join the sample.
      await publish(client, w, [a], 3);
      await publish(client, w, [a], 3);

      const target = await publish(client, w, [a, b], 1);
      await snap(client, target, a, 1, {
        likes: 9,
        comments: 2,
        shares: 1,
        impressions: 400,
      });
      await snap(client, target, b, 1, counts(14));
      const quiet = await publish(client, w, [a], 1);

      const rows = await svc.postMetrics(w.workspaceId, [target, quiet], NOW);
      const of = (postId: string, channelId: number) =>
        rows.find((r) => r.postId === postId && r.channelId === channelId);
      // Sample a: 3,4,5,5,6,8 and the target's own 12 -> median 5 -> 2.4.
      expect(of(target, a)?.usualMultiplier).toBe(2.4);
      // Sample b: 7,7,7 and the target's 14 -> four, under the floor of five.
      expect(of(target, b)?.usualMultiplier).toBeNull();
      expect(of(quiet, a)?.usualMultiplier).toBeNull();
      expect(rows).toHaveLength(3);
    }));
});

/** The overview's 7-day preset at NOW: 2026-10-10 .. 2026-10-16. */
const preset7 = (): ResolvedPeriod => ({
  days: 7,
  window: windowOf(utcToday(NOW), 7),
});

/** One post a day, `fromAge` to `toAge` days ago, each with one snapshot. */
async function daily(
  client: PoolClient,
  w: Ws,
  channelId: number,
  fromAge: number,
  toAge: number,
  c: Counts,
) {
  for (let age = fromAge; age <= toAge; age++) {
    const p = await publish(client, w, [channelId], age);
    await snap(client, p, channelId, 1, c);
  }
}

describeDb('InsightsService.overview', () => {
  const run = (
    fn: (
      svc: InsightsService,
      client: PoolClient,
      repo: PostPerformanceRepository,
    ) => Promise<void>,
  ) =>
    withRollbackDb([], async (db, client) => {
      await client.query(`SET LOCAL TIME ZONE 'Asia/Karachi'`);
      const repo = new PostPerformanceRepository(db);
      await fn(new InsightsService(db, repo), client, repo);
    });

  const overview = (
    svc: InsightsService,
    w: Ws,
    compare: CompareMode,
    channels?: string,
  ) => svc.overview(w.workspaceId, preset7(), channels, 'UTC', compare, NOW);

  /**
   * A post a day from 2026-07-09 to 2026-10-09 (10 likes, 100 views each),
   * so every usual 7 days is 7 posts, 70 engagements, 700 views, a 10% rate.
   * The window has two posts of 50 likes and 100 views.
   */
  async function steady(client: PoolClient, tag: string) {
    const w = await workspace(client, tag);
    const c = await w.channel('a');
    await daily(client, w, c, 8, 100, counts(10));
    for (const age of [2, 3]) {
      const p = await publish(client, w, [c], age);
      await snap(client, p, c, 1, counts(50));
    }
    return { w, c };
  }

  it('compare=usual: KPI previous is the median and deltaPct is against it', () =>
    run(async (svc, client) => {
      const { w } = await steady(client, 'o1');
      const o = await overview(svc, w, 'usual');
      expect(o.kpis.engagements).toEqual({
        value: 100,
        previous: 70,
        deltaPct: 42.9,
      });
      expect(o.kpis.impressions).toEqual({
        value: 200,
        previous: 700,
        deltaPct: -71.4,
      });
      expect(o.kpis.engagementRate).toEqual({
        value: 50,
        previous: 10,
        deltaPts: 40,
      });
      expect(o.kpis.postsPublished).toEqual({
        value: 2,
        previous: 7,
        deltaPct: -71.4,
        deltaAbs: -5,
      });
      // Nothing reports reach: no value, no usual, no delta.
      expect(o.kpis.reach).toEqual({
        value: null,
        previous: null,
        deltaPct: null,
      });
      expect(o.usual).toEqual({
        impressions: { median: 700, p25: 700, p75: 700 },
        reach: null,
        engagements: { median: 70, p25: 70, p75: 70 },
        engagementRate: { median: 10, p25: 10, p75: 10 },
        postsPublished: { median: 7, p25: 7, p75: 7 },
        followersGained: null,
      });
      expect(o.comparisonSeries).toBeNull();
      expect(o.window).toMatchObject({ compareFrom: null, compareTo: null });
      expect(o.stillCollectingFrom).toBe('2026-10-15');
      // Against its own usual too, whatever the toolbar says.
      expect(o.channels[0].vsUsual).toEqual({
        metric: 'impressions',
        deltaPct: -71.4,
        tone: 'down',
      });
    }));

  it('compare=previous: comparisonSeries has the same length by position', () =>
    run(async (svc, client) => {
      const { w } = await steady(client, 'o2');
      const o = await overview(svc, w, 'previous');
      expect(o.kpis.engagements).toEqual({
        value: 100,
        previous: 70,
        deltaPct: 42.9,
      });
      expect(o.usual).toBeNull();
      expect(o.series.map((d) => d.date)).toEqual(
        datesBetween('2026-10-10', '2026-10-16'),
      );
      expect(o.comparisonSeries?.map((d) => d.date)).toEqual(
        datesBetween('2026-10-03', '2026-10-09'),
      );
      expect(o.comparisonSeries?.every((d) => d.engagements === 10)).toBe(true);
      expect(o.window).toMatchObject({
        compareFrom: '2026-10-03',
        compareTo: '2026-10-09',
      });
    }));

  it('posts deltaAbs is absolute', () =>
    run(async (svc, client) => {
      const { w } = await steady(client, 'o3');
      const o = await overview(svc, w, 'previous');
      // 2 posts against 7: a count, not a percentage.
      expect(o.kpis.postsPublished).toEqual({
        value: 2,
        previous: 7,
        deltaPct: -71.4,
        deltaAbs: -5,
      });
    }));

  it('compare=year: reads posts from a year back; none found gives deltaPct null, value kept', () =>
    run(async (svc, client, repo) => {
      const { w, c } = await steady(client, 'o4');
      const read = jest.spyOn(repo, 'publishedPosts');
      const none = await overview(svc, w, 'year');
      expect(read).toHaveBeenCalledWith(
        w.workspaceId,
        [c],
        '2025-10-10',
        '2025-10-17',
      );
      expect(none.kpis.engagements).toEqual({
        value: 100,
        previous: null,
        deltaPct: null,
      });
      expect(none.kpis.postsPublished).toMatchObject({
        value: 2,
        previous: null,
        deltaAbs: null,
      });
      expect(none.kpis.engagementRate.deltaPts).toBeNull();
      // No dashed line of zeros for a year with nothing in it.
      expect(none.comparisonSeries).toBeNull();

      // 2025-10-10, a year before the window's first day.
      const old = await publish(client, w, [c], 372);
      await snap(client, old, c, 1, counts(40, 400));
      const o = await overview(svc, w, 'year');
      expect(o.kpis.engagements).toEqual({
        value: 100,
        previous: 40,
        deltaPct: 150,
      });
      expect(o.kpis.impressions).toEqual({
        value: 200,
        previous: 400,
        deltaPct: -50,
      });
      expect(o.comparisonSeries).toHaveLength(7);
      expect(o.comparisonSeries?.[0]).toMatchObject({
        date: '2025-10-10',
        engagements: 40,
      });
      expect(o.usual).toBeNull();
    }));

  /** Two window posts (50 likes, 100 views each) and older 10-like ones. */
  async function windowAnd(client: PoolClient, tag: string, ages: number[]) {
    const w = await workspace(client, tag);
    const c = await w.channel('a');
    for (const age of [2, 3, ...ages]) {
      const p = await publish(client, w, [c], age);
      await snap(client, p, c, 1, age <= 3 ? counts(50) : counts(10, null));
    }
    return w;
  }

  /** Every comparison value null: "No data to compare yet". */
  const expectNoComparison = (o: InsightsOverviewDto) => {
    expect(o.kpis.postsPublished).toEqual({
      value: 2,
      previous: null,
      deltaPct: null,
      deltaAbs: null,
    });
    expect(o.kpis.engagements).toEqual({
      value: 100,
      previous: null,
      deltaPct: null,
    });
    expect(o.kpis.impressions.previous).toBeNull();
    expect(o.kpis.engagementRate).toEqual({
      value: 50,
      previous: null,
      deltaPts: null,
    });
    expect(o.comparisonSeries).toBeNull();
  };

  /** Real zeros: 2 posts against none, and a flat line at 0. */
  const expectZeros = (o: InsightsOverviewDto) => {
    expect(o.kpis.postsPublished).toEqual({
      value: 2,
      previous: 0,
      deltaPct: null,
      deltaAbs: 2,
    });
    expect(o.kpis.engagements).toEqual({
      value: 100,
      previous: 0,
      deltaPct: null,
    });
    // Nothing in the span reported views: unknown, not 0.
    expect(o.kpis.impressions.previous).toBeNull();
    expect(o.comparisonSeries).toHaveLength(7);
    expect(
      o.comparisonSeries?.every(
        (d) => d.postsPublished === 0 && d.engagements === 0,
      ),
    ).toBe(true);
  };

  it('compare=previous: no post on or before the previous span gives no comparison', () =>
    run(async (svc, client) => {
      // A new account: its first posts are in the window.
      const w = await windowAnd(client, 'p1', []);
      expectNoComparison(await overview(svc, w, 'previous'));
    }));

  it('compare=previous: older history and a quiet previous span are real zeros', () =>
    run(async (svc, client, repo) => {
      // 2026-09-17: in the lookback, before the previous span (10-03..10-09).
      const w = await windowAnd(client, 'p2', [30]);
      const exists = jest.spyOn(repo, 'hasPublishedBefore');
      expectZeros(await overview(svc, w, 'previous'));
      // Already read: no extra query.
      expect(exists).not.toHaveBeenCalled();
    }));

  it('compare=previous: history older than anything read still counts', () =>
    run(async (svc, client, repo) => {
      // 2026-03-31: before the lookback (from 07-06); only the existence
      // check finds it.
      const w = await windowAnd(client, 'p3', [200]);
      const exists = jest.spyOn(repo, 'hasPublishedBefore');
      expectZeros(await overview(svc, w, 'previous'));
      expect(exists).toHaveBeenCalledTimes(1);
    }));

  it('compare=year: no post on or before the year-back span gives no comparison', () =>
    run(async (svc, client) => {
      // 2025-10-20: a year back, but after the span's last day (10-16).
      const w = await windowAnd(client, 'y1', [362]);
      expectNoComparison(await overview(svc, w, 'year'));
    }));

  it('compare=year: older history and a quiet year-back span are real zeros', () =>
    run(async (svc, client) => {
      // 2025-09-12: before the year-back span (2025-10-10 .. 10-16).
      const w = await windowAnd(client, 'y2', [400]);
      expectZeros(await overview(svc, w, 'year'));
    }));

  it('compare=none: previous null, no usual, no comparisonSeries', () =>
    run(async (svc, client) => {
      const { w } = await steady(client, 'o5');
      const o = await overview(svc, w, 'none');
      for (const k of ['impressions', 'reach', 'engagements'] as const) {
        expect(o.kpis[k].previous).toBeNull();
        expect(o.kpis[k].deltaPct).toBeNull();
      }
      expect(o.kpis.engagements.value).toBe(100);
      expect(o.kpis.postsPublished).toEqual({
        value: 2,
        previous: null,
        deltaPct: null,
        deltaAbs: null,
      });
      expect(o.kpis.engagementRate).toEqual({
        value: 50,
        previous: null,
        deltaPts: null,
      });
      expect(o.usual).toBeNull();
      expect(o.comparisonSeries).toBeNull();
      // The channel badge is always against usual.
      expect(o.channels[0].vsUsual.deltaPct).toBe(-71.4);
    }));

  it('a paused channel counts its posts before the pause and has isActive false', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'o6');
      const live = await w.channel('a');
      const paused = await w.channel('b');
      for (const [c, likes] of [
        [live, 3],
        [paused, 7],
      ] as const) {
        const p = await publish(client, w, [c], 5);
        await snap(client, p, c, 1, counts(likes));
      }
      await client.query(
        `UPDATE social_media_channels SET is_active = false WHERE id = $1`,
        [paused],
      );
      const o = await overview(svc, w, 'usual');
      expect(o.channelIds).toEqual([live, paused]);
      expect(o.kpis.engagements.value).toBe(10);
      expect(o.kpis.postsPublished.value).toBe(2);
      expect(o.channels.find((c) => c.channelId === paused)).toMatchObject({
        postsPublished: 1,
        engagements: 7,
      });
      expect(
        o.freshness.map((f) => [f.channelId, f.isActive, f.backfill]),
      ).toEqual([
        [live, true, 'pending'],
        [paused, false, 'pending'],
      ]);
      // Asked for by id, it is still allowed.
      const only = await overview(svc, w, 'usual', String(paused));
      expect(only.channelIds).toEqual([paused]);
    }));

  it('LinkedIn-only workspace: impressions, reach, rate null and engagements real', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'o7');
      const li = await w.channel('li', 'linkedin');
      for (const [age, likes] of [
        [2, 5],
        [4, 3],
      ]) {
        const p = await publishTo(
          client,
          w,
          [{ channelId: li, platform: 'linkedin' }],
          age,
        );
        await snap(client, p, li, 1, counts(likes, null));
      }
      const o = await overview(svc, w, 'usual');
      expect(o.kpis.impressions.value).toBeNull();
      expect(o.kpis.reach.value).toBeNull();
      expect(o.kpis.engagementRate.value).toBeNull();
      expect(o.kpis.engagements.value).toBe(8);
      expect(o.series.every((d) => d.impressions === null)).toBe(true);
      expect(o.series.every((d) => d.reach === null)).toBe(true);
      expect(o.channels[0]).toMatchObject({
        impressions: null,
        reach: null,
        engagementRate: null,
        engagements: 8,
        vsUsual: { metric: 'engagements' },
      });
      expect(o.freshness[0]).toMatchObject({
        reportsViews: false,
        reportsReach: false,
        reportsFollowers: false,
      });
    }));

  it('firstRun true with no post in 90 days, false with one imported post', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'o8');
      const a = await w.channel('a');
      const b = await w.channel('b');
      const firstRun = async (channels?: string) =>
        (await overview(svc, w, 'usual', channels)).firstRun;

      expect(await firstRun()).toBe(true);
      // Older than the 90 days: still the first run.
      await publish(client, w, [a], 120);
      expect(await firstRun()).toBe(true);
      // One post the platform import brought in is enough.
      await publishTo(client, w, [{ channelId: a, platform: 'twitter' }], 30, {
        metadata: { syncedFrom: 'platform' },
      });
      expect(await firstRun()).toBe(false);
      // Any social channel counts, not only the ones selected.
      expect(await firstRun(String(b))).toBe(false);
    }));

  it('a google_business channel does not throw and reports nothing', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'o9');
      const gb = await w.channel('gb', 'google_business');
      const o = await overview(svc, w, 'usual');
      expect(o.channelIds).toEqual([gb]);
      expect(o.freshness).toEqual([
        {
          channelId: gb,
          lastSyncedAt: null,
          failing: false,
          isActive: true,
          connectionStatus: 'connected',
          backfill: 'pending',
          reportsViews: false,
          reportsReach: false,
          reportsFollowers: false,
        },
      ]);
    }));

  it('reads the workspace timezone, UTC when the stored one is not a zone', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'o10');
      await w.channel('a');
      const tz = async (zone: string) => {
        await client.query(`UPDATE workspace SET timezone = $1 WHERE id = $2`, [
          zone,
          w.workspaceId,
        ]);
        return (await overview(svc, w, 'usual')).timezone;
      };
      expect(await tz('Asia/Karachi')).toBe('Asia/Karachi');
      expect(await tz('Mars/Olympus')).toBe('UTC');
    }));
});

describeDb('InsightsService next steps and hiding', () => {
  const MIGRATION = '0060_insight_hidden_steps.sql';
  const HOUR = 3_600_000;

  interface Ctx {
    svc: InsightsService;
    client: PoolClient;
    w: Ws;
    /** The workspace's channel with the base posts. */
    c: number;
    /** A second member of the workspace. */
    other: string;
  }

  interface MediaPost {
    status?: 'published' | 'scheduled' | 'draft' | 'failed';
    /** Days before NOW it went out; negative: days after NOW it is scheduled. */
    ageDays: number;
    content?: string;
    media?: { type: 'video' | 'image'; url: string }[];
  }

  /** A post on `channelId`; published ones also get a snapshot of `likes`. */
  async function mediaPost(
    client: PoolClient,
    w: Ws,
    channelId: number,
    o: MediaPost,
    likes: number | null = null,
  ): Promise<string> {
    const status = o.status ?? 'published';
    const at = new Date(NOW.getTime() - o.ageDays * DAY).toISOString();
    const published = status === 'published';
    // A draft can carry a time too; only a scheduled post takes the slot.
    const scheduled = o.ageDays < 0;
    const r = await client.query<{ id: string }>(
      `INSERT INTO posts (workspace_id, created_by_id, status, content, media_items, targets, published_at, scheduled_at, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz, $8::timestamptz, $9::timestamptz) RETURNING id`,
      [
        w.workspaceId,
        w.userId,
        status,
        o.content ?? 'x',
        JSON.stringify(o.media ?? []),
        JSON.stringify([
          { channelId: String(channelId), platform: 'twitter', status },
        ]),
        published ? at : null,
        scheduled ? at : null,
        at,
      ],
    );
    if (published && likes !== null) {
      await snap(client, r.rows[0].id, channelId, 2, counts(likes, null));
    }
    return r.rows[0].id;
  }

  /**
   * A workspace whose channel `c` posted 6 videos at 30 engagements (3 to 8
   * days old) and 6 text posts at 10 (9 to 14 days old): a 3.0x format gap.
   */
  const run = (fn: (ctx: Ctx) => Promise<void>) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const svc = new InsightsService(db, new PostPerformanceRepository(db));
      const w = await workspace(client, 'steps');
      const c = await w.channel('c');
      const o = await client.query<{ id: string }>(
        `INSERT INTO users (email) VALUES ($1) RETURNING id`,
        [`o-${Math.random().toString(36).slice(2, 8)}@example.test`],
      );
      for (let i = 0; i < 6; i++) {
        await mediaPost(
          client,
          w,
          c,
          {
            ageDays: 3 + i,
            media: [{ type: 'video', url: `https://cdn/v${i}.mp4` }],
          },
          30,
        );
        await mediaPost(client, w, c, { ageDays: 9 + i }, 10);
      }
      await fn({ svc, client, w, c, other: o.rows[0].id });
    });

  const ids = async (ctx: Ctx, user: string, at = NOW) =>
    (
      await ctx.svc.signals(ctx.w.workspaceId, user, undefined, at)
    ).nextSteps.map((s) => s.id);

  it('a format gap from the composer media, worded from S7.2', () =>
    run(async (ctx) => {
      const s = await ctx.svc.signals(
        ctx.w.workspaceId,
        ctx.w.userId,
        undefined,
        NOW,
      );
      expect(s.measuredPosts).toBe(12);
      expect(s.nextSteps).toEqual([
        {
          id: 'format_gap',
          rule: 'format_gap',
          title: 'Videos get 3.0× more engagement than text posts',
          body: expect.stringMatching(
            /^Median engagement per post on .+\. No video is planned this week\.$/,
          ) as string,
          why: 'Your videos get the most engagement on your own posts, and none is scheduled in the next 7 days.',
          bars: [
            { format: 'video', median: 30 },
            { format: 'text', median: 10 },
          ],
          cta: { label: 'Plan a video' },
        },
      ]);
    }));

  it('a hidden step is gone until hidden_until, another user still sees it', () =>
    run(async (ctx) => {
      const { svc, client, w, other } = ctx;
      await svc.hideStep(w.workspaceId, w.userId, 'format_gap', 'later', NOW);
      expect(await ids(ctx, w.userId)).toEqual([]);
      expect(await ids(ctx, other)).toEqual(['format_gap']);

      const row = await client.query<{ hidden_until: Date; reason: string }>(
        `SELECT hidden_until, reason FROM insight_hidden_steps WHERE user_id = $1`,
        [w.userId],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].reason).toBe('later');
      expect(row.rows[0].hidden_until.toISOString()).toBe(
        new Date(NOW.getTime() + 30 * DAY).toISOString(),
      );

      // Hidden through the 30th day, back after it. (A month on, the quiet
      // channel card may have joined it: look at this one card only.)
      expect(
        await ids(ctx, w.userId, new Date(NOW.getTime() + 30 * DAY - HOUR)),
      ).not.toContain('format_gap');
      expect(
        await ids(ctx, w.userId, new Date(NOW.getTime() + 30 * DAY + HOUR)),
      ).toContain('format_gap');
    }));

  it('not useful hides for 180 days; hiding again replaces the earlier choice', () =>
    run(async (ctx) => {
      const { svc, client, w } = ctx;
      const rows = async () =>
        (
          await client.query<{ hidden_until: Date; reason: string }>(
            `SELECT hidden_until, reason FROM insight_hidden_steps WHERE user_id = $1`,
            [w.userId],
          )
        ).rows;
      await svc.hideStep(
        w.workspaceId,
        w.userId,
        'format_gap',
        'not_useful',
        NOW,
      );
      let r = await rows();
      expect(r[0].hidden_until.toISOString()).toBe(
        new Date(NOW.getTime() + 180 * DAY).toISOString(),
      );
      await svc.hideStep(w.workspaceId, w.userId, 'format_gap', 'later', NOW);
      r = await rows();
      expect(r).toHaveLength(1);
      expect(r[0].reason).toBe('later');
      expect(r[0].hidden_until.toISOString()).toBe(
        new Date(NOW.getTime() + 30 * DAY).toISOString(),
      );
    }));

  it('another workspace id cannot hide into this workspace', () =>
    run(async (ctx) => {
      const { svc, client, w } = ctx;
      // The same person hides in a second workspace.
      const w2 = await client.query<{ id: string }>(
        `INSERT INTO workspace (name, slug, owner_id) VALUES ('second', $1, $2) RETURNING id`,
        [`second-${Math.random().toString(36).slice(2, 8)}`, w.userId],
      );
      await svc.hideStep(
        w2.rows[0].id,
        w.userId,
        'format_gap',
        'not_useful',
        NOW,
      );
      expect(await ids(ctx, w.userId)).toEqual(['format_gap']);
      const rows = await client.query(
        `SELECT workspace_id FROM insight_hidden_steps`,
      );
      expect(rows.rows).toEqual([{ workspace_id: w2.rows[0].id }]);
    }));

  describe('the hidden-steps cap', () => {
    /** `n` live rows for the person, with made-up but valid ids. */
    const fill = (client: PoolClient, w: Ws, n: number, until: Date) =>
      client.query(
        `INSERT INTO insight_hidden_steps (user_id, workspace_id, step_id, hidden_until, reason)
         SELECT $1, $2, 'quiet_channel:' || g, $3::timestamptz, 'later'
         FROM generate_series(1, $4) g`,
        [w.userId, w.workspaceId, until.toISOString(), n],
      );
    const live = new Date(NOW.getTime() + 10 * DAY);

    it('refuses a new id at the cap with a 400, and stores nothing', () =>
      run(async ({ svc, client, w }) => {
        await fill(client, w, MAX_HIDDEN_STEPS, live);
        await expect(
          svc.hideStep(w.workspaceId, w.userId, 'format_gap', 'later', NOW),
        ).rejects.toBeInstanceOf(BadRequestException);
        const n = await client.query(
          `SELECT 1 FROM insight_hidden_steps WHERE user_id = $1`,
          [w.userId],
        );
        expect(n.rowCount).toBe(MAX_HIDDEN_STEPS);
      }));

    it('lets a held id be hidden again at the cap, renewing it', () =>
      run(async ({ svc, client, w }) => {
        await fill(client, w, MAX_HIDDEN_STEPS, live);
        await svc.hideStep(
          w.workspaceId,
          w.userId,
          'quiet_channel:7',
          'not_useful',
          NOW,
        );
        const r = await client.query(
          `SELECT reason FROM insight_hidden_steps WHERE user_id = $1 AND step_id = 'quiet_channel:7'`,
          [w.userId],
        );
        expect(r.rows).toEqual([{ reason: 'not_useful' }]);
      }));

    it('drops expired rows first, so they never count against the cap', () =>
      run(async ({ svc, client, w }) => {
        await fill(client, w, MAX_HIDDEN_STEPS, new Date(NOW.getTime() - DAY));
        await svc.hideStep(w.workspaceId, w.userId, 'format_gap', 'later', NOW);
        const r = await client.query(
          `SELECT step_id FROM insight_hidden_steps WHERE user_id = $1`,
          [w.userId],
        );
        expect(r.rows).toEqual([{ step_id: 'format_gap' }]);
      }));

    it('counts per person and per workspace', () =>
      run(async ({ svc, client, w, other }) => {
        await fill(client, w, MAX_HIDDEN_STEPS, live);
        await svc.hideStep(w.workspaceId, other, 'format_gap', 'later', NOW);
        const r = await client.query(
          `SELECT 1 FROM insight_hidden_steps WHERE user_id = $1`,
          [other],
        );
        expect(r.rowCount).toBe(1);
      }));
  });

  it('hideStep refuses an id the rules cannot emit', () =>
    run(async ({ svc, client, w }) => {
      for (const id of ['', 'nonsense', 'quiet_channel:', 'repost_hit:x:1']) {
        await expect(
          svc.hideStep(w.workspaceId, w.userId, id, 'later', NOW),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      const n = await client.query(`SELECT 1 FROM insight_hidden_steps`);
      expect(n.rowCount).toBe(0);
    }));

  it('N1 reads the composer media of posts scheduled in the next 7 days', () =>
    run(async (ctx) => {
      const { client, w, c } = ctx;
      const video = [{ type: 'video' as const, url: 'https://cdn/next.mp4' }];
      const image = [{ type: 'image' as const, url: 'https://cdn/next.jpg' }];
      // Outside the week, a draft, an image: none is a video this week.
      await mediaPost(client, w, c, {
        status: 'scheduled',
        ageDays: -8,
        media: video,
      });
      await mediaPost(client, w, c, {
        status: 'draft',
        ageDays: -2,
        media: video,
      });
      await mediaPost(client, w, c, {
        status: 'scheduled',
        ageDays: -2,
        media: image,
      });
      expect(await ids(ctx, w.userId)).toEqual(['format_gap']);
      // A video scheduled in the week takes the card away.
      await mediaPost(client, w, c, {
        status: 'scheduled',
        ageDays: -6,
        media: video,
      });
      expect(await ids(ctx, w.userId)).toEqual([]);
    }));

  it('N2 reads health and followers; it names the quiet channel', () =>
    run(async (ctx) => {
      const { client, w } = ctx;
      const q = await w.channel('q');
      // Weekly, the newest 20 days ago (27 Sep).
      for (let i = 0; i < 4; i++) {
        await mediaPost(client, w, q, { ageDays: 20 + i * 7 }, 5);
      }
      // +2 a day for the 28 days up to the last post, flat since.
      const last = '2026-09-27';
      let count = 400;
      for (
        let d = Date.parse('2026-08-30');
        d <= Date.parse('2026-10-16');
        d += DAY
      ) {
        const date = new Date(d).toISOString().slice(0, 10);
        const gained = date > last ? 0 : 2;
        if (date > '2026-08-30') count += gained;
        await client.query(
          `INSERT INTO channel_analytics_daily (channel_id, date, followers_at_end_of_day, followers_gained, computed_at)
           VALUES ($1, $2::date, $3, $4, now())`,
          [q, date, count, gained],
        );
      }
      const steps = (
        await ctx.svc.signals(w.workspaceId, w.userId, undefined, NOW)
      ).nextSteps;
      const quiet = steps.find((s) => s.rule === 'quiet_channel')!;
      expect(quiet).toMatchObject({
        id: `quiet_channel:${q}`,
        channelId: q,
        lastPostOn: last,
        body: 'Followers grew about 2 a day while you posted weekly. Since Sep 27 they have stayed at 456.',
      });
      expect(quiet.title).toMatch(/ has been quiet for 20 days$/);
      // Order: the format gap, then the quiet channel.
      expect(steps.map((s) => s.rule)).toEqual(['format_gap', 'quiet_channel']);

      // A broken connection is a different problem: no quiet card for it.
      await client.query(
        `UPDATE social_media_channels SET connection_status = 'expired' WHERE id = $1`,
        [q],
      );
      expect(await ids(ctx, w.userId)).toEqual(['format_gap']);
    }));

  describe('N3 repost hit', () => {
    /** A hit 50 days old at 100 engagements: well over twice the usual. */
    const withHit = (
      fn: (ctx: Ctx, hit: string) => Promise<void>,
      content = 'Our best day yet',
    ) =>
      run(async (ctx) => {
        const hit = await mediaPost(
          ctx.client,
          ctx.w,
          ctx.c,
          { ageDays: 50, content },
          100,
        );
        await fn(ctx, hit);
      });

    it('finds it, worded from S7.2', () =>
      withHit(async (ctx, hit) => {
        const steps = (
          await ctx.svc.signals(ctx.w.workspaceId, ctx.w.userId, undefined, NOW)
        ).nextSteps;
        expect(steps.map((s) => s.id)).toEqual([
          'format_gap',
          `repost_hit:${hit}:${ctx.c}`,
        ]);
        expect(steps[1]).toMatchObject({
          title: 'Your August hit is ready to post again',
          postTitle: 'Our best day yet',
          cta: { label: 'Repost' },
        });
        expect(steps[1].body).toMatch(
          /^Our best day yet got 100 engagements, \d+\.\d× your usual\. It is 7 weeks old\.$/,
        );
      }));

    it('is gone once a later post repeats the caption, even a draft; not a failed or an earlier one', () =>
      withHit(async (ctx, hit) => {
        const { client, w, c } = ctx;
        const repost = `repost_hit:${hit}:${c}`;
        // A failed post never went out; an earlier one is not a repost.
        await mediaPost(client, w, c, {
          status: 'failed',
          ageDays: 5,
          content: 'our BEST day   yet',
        });
        await mediaPost(client, w, c, {
          ageDays: 60,
          content: 'Our best day yet',
        });
        expect(await ids(ctx, w.userId)).toContain(repost);
        await mediaPost(client, w, c, {
          status: 'draft',
          ageDays: 1,
          content: ' our best DAY yet ',
        });
        expect(await ids(ctx, w.userId)).not.toContain(repost);
      }));

    it('is gone once a later post shares its media', () =>
      withHit(async (ctx, hit) => {
        const { client, w, c } = ctx;
        await client.query(
          `UPDATE posts SET media_items = $2::jsonb WHERE id = $1`,
          [
            hit,
            JSON.stringify([{ type: 'image', url: 'https://cdn/hit.jpg' }]),
          ],
        );
        expect(await ids(ctx, w.userId)).toContain(`repost_hit:${hit}:${c}`);
        await mediaPost(client, w, c, {
          status: 'scheduled',
          ageDays: -3,
          content: 'different words',
          media: [{ type: 'image', url: 'https://cdn/hit.jpg' }],
        });
        expect(await ids(ctx, w.userId)).not.toContain(
          `repost_hit:${hit}:${c}`,
        );
      }));

    it('is gone when a later post repeats a caption longer than the compared prefix', () =>
      withHit(async (ctx, hit) => {
        const { client, w, c } = ctx;
        const long = 'Long caption. '.repeat(400);
        await client.query(`UPDATE posts SET content = $2 WHERE id = $1`, [
          hit,
          long,
        ]);
        expect(await ids(ctx, w.userId)).toContain(`repost_hit:${hit}:${c}`);
        await mediaPost(client, w, c, { ageDays: 2, content: long });
        expect(await ids(ctx, w.userId)).not.toContain(
          `repost_hit:${hit}:${c}`,
        );
      }));

    describe('the later posts read is bounded', () => {
      type Later = {
        laterPosts(
          ws: string,
          after: Date,
          now: Date,
          limit?: number,
        ): Promise<{ postId: string; at: string; content: string }[]>;
      };
      const later = (ctx: Ctx) => ctx.svc as unknown as Later;

      it('cuts a caption to the compared prefix and reads no other column', () =>
        run(async (ctx) => {
          const { client, w, c } = ctx;
          const id = await mediaPost(client, w, c, {
            ageDays: 1,
            content: 'a'.repeat(REPOST_CAPTION_CHARS + 500),
          });
          const rows = await later(ctx).laterPosts(
            w.workspaceId,
            new Date(NOW.getTime() - 3 * DAY),
            NOW,
          );
          const row = rows.find((r) => r.postId === id)!;
          expect(row.content).toHaveLength(REPOST_CAPTION_CHARS);
          expect(Object.keys(row).sort()).toEqual([
            'at',
            'content',
            'mediaUrls',
            'postId',
          ]);
        }));

      it('keeps the newest posts when there are more than the limit', () =>
        run(async (ctx) => {
          const { client, w, c } = ctx;
          const old = await mediaPost(client, w, c, { ageDays: 3 });
          const mid = await mediaPost(client, w, c, { ageDays: 2 });
          const fresh = await mediaPost(client, w, c, { ageDays: 1 });
          const rows = await later(ctx).laterPosts(
            w.workspaceId,
            new Date(NOW.getTime() - 4 * DAY),
            NOW,
            2,
          );
          expect(rows.map((r) => r.postId)).toEqual([fresh, mid]);
          expect(rows.map((r) => r.postId)).not.toContain(old);
        }));

      it('never reads earlier than the rule horizon, nor a failed post', () =>
        run(async (ctx) => {
          const { client, w, c } = ctx;
          const ancient = await mediaPost(client, w, c, {
            ageDays: REPOST_MAX_AGE_DAYS + 5,
          });
          const failed = await mediaPost(client, w, c, {
            ageDays: 1,
            status: 'failed',
          });
          const ok = await mediaPost(client, w, c, { ageDays: 1 });
          const rows = await later(ctx).laterPosts(
            w.workspaceId,
            new Date(NOW.getTime() - 400 * DAY),
            NOW,
          );
          const got = rows.map((r) => r.postId);
          expect(got).toContain(ok);
          expect(got).not.toContain(ancient);
          expect(got).not.toContain(failed);
        }));
    });

    it('hiding it is per person', () =>
      withHit(async (ctx, hit) => {
        const id = `repost_hit:${hit}:${ctx.c}`;
        await ctx.svc.hideStep(
          ctx.w.workspaceId,
          ctx.w.userId,
          id,
          'not_useful',
          NOW,
        );
        expect(await ids(ctx, ctx.w.userId)).toEqual(['format_gap']);
        expect(await ids(ctx, ctx.other)).toContain(id);
      }));
  });

  it('without the hidden-steps table signals still answers, with nothing hidden', () =>
    run(async (ctx) => {
      // Postgres would abort the harness transaction on a real 42P01, so the
      // hidden-steps read alone fails the way an unmigrated database does.
      const real = (ctx.svc as unknown as { db: DbType }).db;
      const flaky = new Proxy(real, {
        get(target, key, receiver) {
          if (key === 'select') {
            return (fields?: Record<string, unknown>) =>
              fields && Object.keys(fields).join() === 'stepId'
                ? {
                    from: () => ({
                      where: () =>
                        Promise.reject(
                          Object.assign(new Error('Failed query'), {
                            cause: Object.assign(new Error('missing'), {
                              code: '42P01',
                            }),
                          }),
                        ),
                    }),
                  }
                : target.select(fields as never);
          }
          const v = Reflect.get(target, key, receiver) as unknown;
          return typeof v === 'function' ? (v.bind(target) as unknown) : v;
        },
      });
      const svc = new InsightsService(
        flaky,
        new PostPerformanceRepository(real),
      );
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        const s = await svc.signals(
          ctx.w.workspaceId,
          ctx.w.userId,
          undefined,
          NOW,
        );
        // Best time and What works are intact, and the card is shown.
        expect(s.measuredPosts).toBe(12);
        expect(s.whatWorks.format.map((b) => b.key)).toEqual(['video', 'text']);
        expect(s.nextSteps.map((n) => n.id)).toEqual(['format_gap']);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    }));

  it('a workspace under 10 measured posts gets no next steps', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const svc = new InsightsService(db, new PostPerformanceRepository(db));
      const w = await workspace(client, 'few');
      const c = await w.channel('c');
      for (let i = 0; i < 9; i++) {
        await mediaPost(client, w, c, { ageDays: 3 + i }, 10);
      }
      const s = await svc.signals(w.workspaceId, w.userId, undefined, NOW);
      expect(s.measuredPosts).toBe(9);
      expect(s.nextSteps).toEqual([]);
    }));
});

describeDb('PostPerformanceRepository.snapshotsWithin', () => {
  const HOUR = 3_600_000;
  const run = (
    fn: (
      repo: PostPerformanceRepository,
      svc: InsightsService,
      client: PoolClient,
    ) => Promise<void>,
  ) =>
    withRollbackDb([], async (db, client) => {
      const repo = new PostPerformanceRepository(db);
      await fn(repo, new InsightsService(db, repo), client);
    });

  const publishedAtOf = (ageDays: number) =>
    new Date(NOW.getTime() - ageDays * DAY);

  /** A snapshot `h` hours after the post went out. */
  async function snapAfter(
    client: PoolClient,
    postId: string,
    channelId: number,
    ageDays: number,
    h: number,
    reach: number,
  ) {
    const at = new Date(publishedAtOf(ageDays).getTime() + h * HOUR);
    await client.query(
      `INSERT INTO post_metric_snapshots
         (post_id, channel_id, snapshot_at, age_bucket, likes_count, comments_count, shares_count, impressions_count, reach_count, fetched_at, sync_status)
       VALUES ($1, $2, $3::timestamptz, '1h', 1, 0, 0, $4, $4, $3::timestamptz, 'ok')`,
      [postId, channelId, at.toISOString(), reach],
    );
  }

  it('returns snapshots up to the hour limit after publishing, oldest first, one channel only', () =>
    run(async (repo, _svc, client) => {
      const w = await workspace(client, 'sw1');
      const [c1, c2] = [await w.channel('a'), await w.channel('b')];
      const p = await publish(client, w, [c1, c2], 5);
      await snapAfter(client, p, c1, 5, 30, 30);
      await snapAfter(client, p, c1, 5, 1, 10);
      await snapAfter(client, p, c1, 5, 48, 48);
      await snapAfter(client, p, c1, 5, 49, 49); // past the limit
      await snapAfter(client, p, c2, 5, 2, 99); // other channel

      const rows = await repo.snapshotsWithin([p], c1, 48);
      expect(rows.map((r) => Number(r.reach))).toEqual([10, 30, 48]);
      expect(rows[0]).toMatchObject({
        post_id: p,
        likes: 1,
        comments: 0,
        shares: 0,
        impressions: 10,
      });
      expect(await repo.snapshotsWithin([], c1, 48)).toEqual([]);
    }));

  it('reads only the 100 most recent posts', () =>
    run(async (repo, _svc, client) => {
      const w = await workspace(client, 'sw2');
      const c = await w.channel('a');
      const ids: string[] = [];
      for (let i = 0; i < 101; i++) {
        // age 1..101 days: the last one is the oldest
        const p = await publish(client, w, [c], i + 1);
        await snapAfter(client, p, c, i + 1, 1, 5);
        ids.push(p);
      }
      const rows = await repo.snapshotsWithin(ids, c, 48);
      expect(rows).toHaveLength(100);
      expect(rows.some((r) => r.post_id === ids[100])).toBe(false);
      expect(rows.some((r) => r.post_id === ids[0])).toBe(true);
    }));

  it('takes a very long id list as one array parameter', () =>
    run(async (repo, _svc, client) => {
      const w = await workspace(client, 'sw4');
      const c = await w.channel('a');
      const p = await publish(client, w, [c], 5);
      await snapAfter(client, p, c, 5, 1, 10);
      const filler = Array.from(
        { length: 70_000 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      const rows = await repo.snapshotsWithin([...filler, p], c, 48);
      expect(rows.map((r) => r.post_id)).toEqual([p]);
    }));

  it('postDetail reads a real post end to end; another workspace gets 404', () =>
    run(async (_repo, svc, client) => {
      const w = await workspace(client, 'sw3');
      const other = await workspace(client, 'sw3b');
      const c = await w.channel('a');
      const p = await publish(client, w, [c], 5);
      for (const h of [1, 5, 30]) await snapAfter(client, p, c, 5, h, h * 10);
      await snap(client, p, c, 24, counts(7, 140));

      const d = await svc.postDetail(w.workspaceId, p, c, NOW);
      expect(d.post.postId).toBe(p);
      expect(d.timeline.status).toBe('ok');
      expect(d.timeline.metric).toBe('impressions');
      expect(d.timeline.values.slice(0, 3)).toEqual([0, 10, 10]);
      expect(d.tiles.map((t) => t.key)).toContain('views');

      await expect(
        svc.postDetail(other.workspaceId, p, c, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.postDetail(w.workspaceId, p, c + 1000, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
    }));
});
