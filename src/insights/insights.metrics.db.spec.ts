import type { PoolClient } from 'pg';
import { datesBetween, utcToday, windowOf } from '../post-performance/period';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { InsightsService } from './insights.service';
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
