import type { PoolClient } from 'pg';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { InsightsService } from './insights.service';

const DAY = 86_400_000;
const NOW = new Date('2026-10-17T12:00:00Z');

interface Ws {
  userId: string;
  workspaceId: string;
  channel: (n: string) => Promise<number>;
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
  const channel = async (n: string) =>
    Number(
      (
        await client.query<{ id: number }>(
          `INSERT INTO social_media_channels
             (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
           VALUES ($1, 'twitter', 'personal', $2, $2, 'x', $3) RETURNING id`,
          [workspaceId, `${tag}-${n}`, userId],
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
