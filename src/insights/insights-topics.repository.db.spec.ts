import type { PoolClient } from 'pg';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { InsightsTopicsRepository } from './insights-topics.repository';
import { InsightsService } from './insights.service';

const DAY = 86_400_000;
/** Sat 17 Oct 2026, 12:00 UTC. */
const NOW = new Date('2026-10-17T12:00:00Z');

interface Ws {
  userId: string;
  workspaceId: string;
}

const rand = () => Math.random().toString(36).slice(2, 8);

async function workspace(client: PoolClient, tag: string): Promise<Ws> {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`u-${tag}-${rand()}@example.test`],
  );
  const userId = u.rows[0].id;
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [tag, `${tag}-${rand()}`, userId],
  );
  return { userId, workspaceId: w.rows[0].id };
}

async function channel(client: PoolClient, w: Ws, name: string) {
  const r = await client.query<{ id: number }>(
    `INSERT INTO social_media_channels
       (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
     VALUES ($1, 'twitter', 'personal', $2, $2, 'x', $3) RETURNING id`,
    [w.workspaceId, `${name}-${rand()}`, w.userId],
  );
  return Number(r.rows[0].id);
}

async function mediaItem(
  client: PoolClient,
  w: Ws,
  url: string,
  tags: unknown,
  deleted = false,
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO media_items (workspace_id, uploaded_by_id, type, name, file_url, tags, is_deleted, deleted_at)
     VALUES ($1, $2, 'image', 'item', $3, $4::jsonb, $5, CASE WHEN $5 THEN now() END) RETURNING id`,
    [w.workspaceId, w.userId, url, JSON.stringify(tags), deleted],
  );
  return r.rows[0].id;
}

interface PostInput {
  media?: { url: string; libraryItemId?: string }[];
  status?: string;
  publishedAt?: Date | null;
  scheduledAt?: Date | null;
  channelIds?: number[];
}

async function post(client: PoolClient, w: Ws, input: PostInput = {}) {
  const status = input.status ?? 'published';
  const targets = (input.channelIds ?? []).map((c) => ({
    channelId: String(c),
    platform: 'twitter',
    status,
  }));
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, content, media_items, targets, published_at, scheduled_at)
     VALUES ($1, $2, $3, 'x', $4::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz) RETURNING id`,
    [
      w.workspaceId,
      w.userId,
      status,
      JSON.stringify((input.media ?? []).map((m) => ({ type: 'image', ...m }))),
      JSON.stringify(targets),
      input.publishedAt === undefined
        ? NOW.toISOString()
        : (input.publishedAt?.toISOString() ?? null),
      input.scheduledAt?.toISOString() ?? null,
    ],
  );
  return r.rows[0].id;
}

async function snap(
  client: PoolClient,
  postId: string,
  channelId: number,
  likes: number,
) {
  await client.query(
    `INSERT INTO post_metric_snapshots
       (post_id, channel_id, snapshot_at, age_bucket, likes_count, comments_count, shares_count, fetched_at, sync_status)
     VALUES ($1, $2, $3::timestamptz, '1d', $4, 0, 0, $3::timestamptz, 'ok')`,
    [postId, channelId, NOW.toISOString(), likes],
  );
}

describeDb('InsightsTopicsRepository.tagsByPost', () => {
  const run = (
    fn: (repo: InsightsTopicsRepository, client: PoolClient) => Promise<void>,
  ) =>
    withRollbackDb([], async (db, client) => {
      await fn(new InsightsTopicsRepository(db), client);
    });

  it('reads the tags of the library items a post used, by id', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 't1');
      const a = await mediaItem(client, w, 'https://cdn/a.jpg', ['food']);
      const b = await mediaItem(client, w, 'https://cdn/b.jpg', ['travel']);
      const p = await post(client, w, {
        media: [
          { url: 'https://other/a.jpg', libraryItemId: a },
          { url: 'https://other/b.jpg', libraryItemId: b },
        ],
      });
      const bare = await post(client, w);
      const tags = await repo.tagsByPost(w.workspaceId, [p, bare]);
      expect([...tags.keys()]).toEqual([p]);
      expect([...tags.get(p)!].sort()).toEqual(['food', 'travel']);
    }));

  it('does not read tags from another workspace media item', () =>
    run(async (repo, client) => {
      const mine = await workspace(client, 't2a');
      const theirs = await workspace(client, 't2b');
      const url = 'https://cdn/shared.jpg';
      const foreign = await mediaItem(client, theirs, url, ['secret']);
      const p = await post(client, mine, {
        media: [{ url, libraryItemId: foreign }],
      });
      expect((await repo.tagsByPost(mine.workspaceId, [p])).size).toBe(0);
      // Nor can another workspace read this workspace's post.
      const own = await mediaItem(client, mine, 'https://cdn/own.jpg', ['own']);
      const q = await post(client, mine, {
        media: [{ url: 'https://cdn/own.jpg', libraryItemId: own }],
      });
      expect((await repo.tagsByPost(theirs.workspaceId, [q])).size).toBe(0);
      expect(await repo.tagsByPost(mine.workspaceId, [q])).toEqual(
        new Map([[q, ['own']]]),
      );
    }));

  it('a non-uuid library ref is ignored, not a 500', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 't3');
      const a = await mediaItem(client, w, 'https://cdn/a.jpg', ['food']);
      const p = await post(client, w, {
        media: [
          { url: 'https://pasted/x.jpg', libraryItemId: 'not-a-uuid' },
          { url: 'https://pasted/y.jpg', libraryItemId: a },
        ],
      });
      expect(await repo.tagsByPost(w.workspaceId, [p])).toEqual(
        new Map([[p, ['food']]]),
      );
    }));

  it('matches by media url when libraryItemId is absent', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 't4');
      await mediaItem(client, w, 'https://cdn/legacy.jpg', ['legacy']);
      const p = await post(client, w, {
        media: [{ url: 'https://cdn/legacy.jpg' }],
      });
      expect(await repo.tagsByPost(w.workspaceId, [p])).toEqual(
        new Map([[p, ['legacy']]]),
      );
    }));

  it('a soft-deleted item keeps its tags; an untagged or non-array one adds none', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 't5');
      const gone = await mediaItem(
        client,
        w,
        'https://cdn/gone.jpg',
        ['archive'],
        true,
      );
      const empty = await mediaItem(client, w, 'https://cdn/e.jpg', []);
      const odd = await mediaItem(client, w, 'https://cdn/o.jpg', {
        not: 'an array',
      });
      const p = await post(client, w, {
        media: [
          { url: 'https://cdn/gone.jpg', libraryItemId: gone },
          { url: 'https://cdn/e.jpg', libraryItemId: empty },
          { url: 'https://cdn/o.jpg', libraryItemId: odd },
        ],
      });
      expect(await repo.tagsByPost(w.workspaceId, [p])).toEqual(
        new Map([[p, ['archive']]]),
      );
    }));

  it('takes 40,000 post ids in one call, past the 65,535 bind-parameter cap', () =>
    run(async (repo, client) => {
      const w = await workspace(client, 't6');
      const a = await mediaItem(client, w, 'https://cdn/big.jpg', ['big']);
      const p = await post(client, w, {
        media: [{ url: 'https://cdn/big.jpg', libraryItemId: a }],
      });
      const ids = Array.from(
        { length: 40_000 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      ids[20_000] = p;
      expect(await repo.tagsByPost(w.workspaceId, ids)).toEqual(
        new Map([[p, ['big']]]),
      );
    }));

  it('reads nothing for no ids', () =>
    run(async (repo) => {
      expect(
        await repo.tagsByPost('00000000-0000-4000-8000-000000000000', []),
      ).toEqual(new Map());
    }));
});

describeDb('InsightsService.signals', () => {
  /**
   * A Karachi workspace whose channel A posted 10 times on Thursday at 19:00
   * PKT (best: Thu slot 6), plus channel B.
   */
  const run = (
    fn: (
      svc: InsightsService,
      client: PoolClient,
      ctx: { w: Ws; a: number; b: number },
    ) => Promise<void>,
  ) =>
    withRollbackDb([], async (db, client) => {
      const svc = new InsightsService(
        db,
        new PostPerformanceRepository(db),
        new InsightsTopicsRepository(db),
      );
      const w = await workspace(client, 'sig');
      await client.query(
        `UPDATE workspace SET timezone = 'Asia/Karachi' WHERE id = $1`,
        [w.workspaceId],
      );
      const a = await channel(client, w, 'a');
      const b = await channel(client, w, 'b');
      for (let i = 0; i < 10; i++) {
        // Thu 8 Oct 2026 14:00 UTC, then each week back (all past settling).
        const at = new Date(Date.parse('2026-10-08T14:00:00Z') - i * 7 * DAY);
        const p = await post(client, w, { publishedAt: at, channelIds: [a] });
        await snap(client, p, a, 10 + i);
      }
      await fn(svc, client, { w, a, b });
    });

  it('builds the grid in the workspace timezone and suggests the next Thursday', () =>
    run(async (svc, _client, { w, a }) => {
      const s = await svc.signals(w.workspaceId, String(a), NOW);
      expect(s.timezone).toBe('Asia/Karachi');
      expect(s.measuredPosts).toBe(10);
      expect(s.minPosts).toBe(10);
      expect(s.bestTimes.slots).toBe(8);
      expect(s.bestTimes.engagement.best).toEqual({ weekday: 3, slot: 6 });
      expect(s.bestTimes.reach.available).toBe(false);
      expect(s.bestTimes.usedNightSlots).toBe(false);
      expect(s.bestTimes.useSlot).toEqual({
        weekday: 3,
        slot: 6,
        nextFreeDate: '2026-10-22',
        suggestedAt: '2026-10-22T14:00:00.000Z',
      });
      expect(s.whatWorks.format).toEqual([
        { key: 'text', posts: 10, median: 14.5 },
      ]);
      expect(s.whatWorks.topic).toEqual({
        bars: [],
        untaggedPosts: 10,
        hasAnyTag: false,
      });
      expect(s.nextSteps).toEqual([]);
    }));

  it('next free skips a slot with a scheduled post on a selected channel, not on another channel', () =>
    run(async (svc, client, { w, a, b }) => {
      // Thu 22 Oct 19:30 PKT on channel B only: A is selected, so still free.
      const thu = new Date('2026-10-22T14:30:00Z');
      await post(client, w, {
        status: 'scheduled',
        publishedAt: null,
        scheduledAt: thu,
        channelIds: [b],
      });
      expect(
        (await svc.signals(w.workspaceId, String(a), NOW)).bestTimes.useSlot
          ?.nextFreeDate,
      ).toBe('2026-10-22');
      // Selecting both channels makes B's post count.
      expect(
        (await svc.signals(w.workspaceId, `${a},${b}`, NOW)).bestTimes.useSlot
          ?.nextFreeDate,
      ).toBe('2026-10-29');
      // A draft in the slot on A does not take it; a scheduled post does.
      await post(client, w, {
        status: 'draft',
        publishedAt: null,
        scheduledAt: thu,
        channelIds: [a],
      });
      expect(
        (await svc.signals(w.workspaceId, String(a), NOW)).bestTimes.useSlot
          ?.nextFreeDate,
      ).toBe('2026-10-22');
      await post(client, w, {
        status: 'scheduled',
        publishedAt: null,
        scheduledAt: thu,
        channelIds: [a],
      });
      expect(
        (await svc.signals(w.workspaceId, String(a), NOW)).bestTimes.useSlot
          ?.nextFreeDate,
      ).toBe('2026-10-29');
    }));

  it('topics come from the library tags of the posts in the sample', () =>
    run(async (svc, client, { w, a }) => {
      const item = await mediaItem(client, w, 'https://cdn/f.jpg', ['food']);
      for (let i = 0; i < 3; i++) {
        const p = await post(client, w, {
          // 3 to 5 days old: past settling.
          publishedAt: new Date(NOW.getTime() - (i + 3) * DAY),
          channelIds: [a],
          media: [{ url: 'https://cdn/f.jpg', libraryItemId: item }],
        });
        await snap(client, p, a, 100);
      }
      const s = await svc.signals(w.workspaceId, String(a), NOW);
      expect(s.measuredPosts).toBe(13);
      expect(s.whatWorks.topic).toEqual({
        bars: [{ key: 'food', posts: 3, median: 100 }],
        untaggedPosts: 10,
        hasAnyTag: true,
      });
    }));

  it('a settling post counts in no grid, format, topic or post count', () =>
    run(async (svc, client, { w, a }) => {
      const item = await mediaItem(client, w, 'https://cdn/s.jpg', ['fresh']);
      // 1 h and 47 h old (SETTLING_DAYS is 2), 0 engagements each. The 47 h
      // one is Thu 18:00 PKT, inside the best cell it would drag down.
      for (const hoursAgo of [1, 47]) {
        const p = await post(client, w, {
          publishedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
          channelIds: [a],
          media: [{ url: 'https://cdn/s.jpg', libraryItemId: item }],
        });
        await snap(client, p, a, 0);
      }
      const s = await svc.signals(w.workspaceId, String(a), NOW);
      expect(s.measuredPosts).toBe(10);
      const cells = s.bestTimes.engagement.cells;
      expect(cells.reduce((n, c) => n + c.posts, 0)).toBe(10);
      expect(cells.find((c) => c.weekday === 3 && c.slot === 6)).toEqual({
        weekday: 3,
        slot: 6,
        posts: 10,
        value: 14.5,
      });
      expect(s.whatWorks.format).toEqual([
        { key: 'text', posts: 10, median: 14.5 },
      ]);
      expect(s.whatWorks.topic).toEqual({
        bars: [],
        untaggedPosts: 10,
        hasAnyTag: false,
      });
    }));
});
