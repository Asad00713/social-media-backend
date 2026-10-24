import type { PoolClient } from 'pg';
import { posts, type PostStatus } from '../../drizzle/schema/posts.schema';
import { derivePostStatus, type TargetLike } from '../../posts/lib/post-status';
import { isPartlyPublishedSql } from '../../posts/lib/post-status.sql';
import { PlannerPostsService } from '../../posts/services/planner-posts.service';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../testing/rollback-db';
import type { ListTab } from '../dto/planner-list.dto';
import { encodeListCursor } from '../lib/list-cursor';
import { PlannerListService } from './planner-list.service';

const MIGRATION = '0041_post_ready.sql';
const HOUR = 3600_000;

async function workspace(client: PoolClient, tag: string) {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`u-${tag}-${Math.random().toString(36).slice(2, 8)}@example.test`],
  );
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [tag, `${tag}-${Math.random().toString(36).slice(2, 8)}`, u.rows[0].id],
  );
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

interface PostOpts {
  status: string;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  targets?: unknown[];
}

async function post(
  client: PoolClient,
  w: { userId: string; workspaceId: string },
  o: PostOpts,
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, content, scheduled_at, published_at, targets)
     VALUES ($1, $2, $3, 'x', $4::timestamptz, $5::timestamptz, $6::jsonb) RETURNING id`,
    [
      w.workspaceId,
      w.userId,
      o.status,
      o.scheduledAt ?? null,
      o.publishedAt ?? null,
      JSON.stringify(
        (o.targets ?? []).map((t) => ({
          platform: 'twitter',
          ...(t as object),
        })),
      ),
    ],
  );
  return r.rows[0].id;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ids = (page: { rows: { id: string }[] }) => page.rows.map((r) => r.id);

describeDb('PlannerListService.list', () => {
  const run = (
    fn: (
      svc: PlannerListService,
      client: PoolClient,
      now: Date,
      db: DbType,
    ) => Promise<void>,
  ) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const svc = new PlannerListService(db, new PlannerPostsService(db));
      await fn(svc, client, new Date(), db);
    });

  /** Walks every page of `tab` at `limit`, returning ids in order and the page count. */
  async function walk(
    svc: PlannerListService,
    workspaceId: string,
    tab: ListTab,
    limit: number,
    now: Date,
  ) {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await svc.list(workspaceId, { tab, limit, cursor }, now);
      seen.push(...ids(page));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    return { seen, pages };
  }

  it('an empty workspace gives an empty page', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'a');
      await expect(
        svc.list(w.workspaceId, { tab: 'all', limit: 30 }),
      ).resolves.toEqual({
        rows: [],
        total: 0,
        nextCursor: null,
        counts: { upcoming: 0, failed: 0 },
      });
    }));

  it('each tab returns the right rows and the counts ignore the tab', () =>
    run(async (svc, client, now) => {
      const t = now.getTime();
      const w = await workspace(client, 'a');
      const other = await workspace(client, 'b');
      await post(client, other, {
        status: 'scheduled',
        scheduledAt: iso(t + HOUR),
      });
      await post(client, w, { status: 'draft', scheduledAt: iso(t + HOUR) });
      const soon = await post(client, w, {
        status: 'scheduled',
        scheduledAt: iso(t + HOUR),
      });
      const later = await post(client, w, {
        status: 'scheduled',
        scheduledAt: iso(t + 5 * HOUR),
      });
      const publishing = await post(client, w, {
        status: 'publishing',
        scheduledAt: iso(t - HOUR),
      });
      // An immediate publish carries no scheduled_at at all.
      const publishingNoTime = await post(client, w, { status: 'publishing' });
      const passed = await post(client, w, {
        status: 'scheduled',
        scheduledAt: iso(t - 2 * HOUR),
      });
      const pub1 = await post(client, w, {
        status: 'published',
        publishedAt: iso(t - 3 * HOUR),
        targets: [{ channelId: '1', status: 'published' }],
      });
      const pub2 = await post(client, w, {
        status: 'published',
        publishedAt: iso(t - 4 * HOUR),
        targets: [{ channelId: '1', publishStatus: 'published' }],
      });
      const mixed = await post(client, w, {
        status: 'published',
        publishedAt: iso(t - 5 * HOUR),
        targets: [
          { channelId: '1', status: 'published' },
          { channelId: '2', publishStatus: 'failed' },
        ],
      });
      const failed = await post(client, w, {
        status: 'failed',
        scheduledAt: iso(t - 6 * HOUR),
        targets: [{ channelId: '1', status: 'failed' }],
      });
      const partlyStored = await post(client, w, {
        status: 'partially_published',
        publishedAt: iso(t - 7 * HOUR),
      });

      const counts = { upcoming: 4, failed: 3 };

      const up = await svc.list(
        w.workspaceId,
        { tab: 'upcoming', limit: 30 },
        now,
      );
      expect(new Set(ids(up))).toEqual(
        new Set([publishing, publishingNoTime, soon, later]),
      );
      expect(ids(up).indexOf(soon)).toBeLessThan(ids(up).indexOf(later));
      expect(up.total).toBe(4);
      expect(up.counts).toEqual(counts);
      expect(ids(up)).not.toContain(passed);

      const pub = await svc.list(
        w.workspaceId,
        { tab: 'published', limit: 30 },
        now,
      );
      expect(ids(pub)).toEqual([pub1, pub2]);
      expect(pub.total).toBe(2);

      const fail = await svc.list(
        w.workspaceId,
        { tab: 'failed', limit: 30 },
        now,
      );
      expect(ids(fail)).toEqual([mixed, failed, partlyStored]);
      expect(fail.total).toBe(3);

      const all = await svc.list(w.workspaceId, { tab: 'all', limit: 30 }, now);
      expect(all.total).toBe(10);
      expect(all.rows).toHaveLength(10);
      expect(ids(all)).toContain(passed);
      expect(all.rows.find((r) => r.id === mixed)?.displayStatus).toBe(
        'partially_published',
      );

      for (const tab of [
        'upcoming',
        'published',
        'failed',
        'all',
      ] as ListTab[]) {
        const p = await svc.list(w.workspaceId, { tab, limit: 1 }, now);
        expect(p.counts).toEqual(counts);
      }
    }));

  it('"partly published" in SQL equals derivePostStatus on a status x targets matrix', () =>
    run(async (svc, client, now, db) => {
      const w = await workspace(client, 'a');
      const t = now.getTime();
      const statuses = [
        'scheduled',
        'publishing',
        'published',
        'failed',
        'partially_published',
      ];
      const kinds: Record<string, unknown[]> = {
        none: [],
        pub: [{ channelId: '1', status: 'published' }],
        pubViaPublishStatus: [{ channelId: '1', publishStatus: 'published' }],
        fail: [{ channelId: '1', status: 'failed' }],
        failViaPublishStatus: [{ channelId: '1', publishStatus: 'failed' }],
        mixed: [
          { channelId: '1', status: 'published' },
          { channelId: '2', status: 'failed' },
        ],
        mixedCross: [
          { channelId: '1', publishStatus: 'published' },
          { channelId: '2', status: 'failed' },
        ],
        publishedWinsOverFailed: [
          { channelId: '1', status: 'failed', publishStatus: 'published' },
          { channelId: '2', status: 'published' },
        ],
        failedWinsNothing: [
          { channelId: '1', status: 'published', publishStatus: 'failed' },
        ],
        pending: [
          { channelId: '1', status: 'published' },
          { channelId: '2', status: 'scheduled' },
        ],
      };
      const expected = new Map<string, PostStatus>();
      for (const status of statuses) {
        for (const targets of Object.values(kinds)) {
          const id = await post(client, w, {
            status,
            scheduledAt: iso(t + HOUR),
            targets,
          });
          expected.set(
            id,
            derivePostStatus(status as PostStatus, targets as TargetLike[]),
          );
        }
      }
      const partly = await db
        .select({ id: posts.id })
        .from(posts)
        .where(isPartlyPublishedSql());
      const sqlSet = new Set<string>(partly.map((r: { id: string }) => r.id));
      const jsSet = new Set(
        [...expected]
          .filter(([, s]) => s === 'partially_published')
          .map(([id]) => id),
      );
      expect(sqlSet).toEqual(jsSet);
      expect(jsSet.size).toBeGreaterThan(5);

      // The tabs follow the same truth: a derived-partly post is failed, never published.
      const failedTab = new Set(
        (await walk(svc, w.workspaceId, 'failed', 100, now)).seen,
      );
      const publishedTab = new Set(
        (await walk(svc, w.workspaceId, 'published', 100, now)).seen,
      );
      for (const id of jsSet) {
        expect(failedTab.has(id)).toBe(true);
        expect(publishedTab.has(id)).toBe(false);
      }
    }));

  it('pages 7 rows within one millisecond (differing microseconds) with no repeat and no gap', () =>
    run(async (svc, client, now) => {
      const w = await workspace(client, 'a');
      const base = iso(now.getTime() - 24 * HOUR).replace(/\.\d+Z$/, '');
      // One millisecond (.123), different microseconds, two exact twins.
      const micros = [
        '123001',
        '123400',
        '123500',
        '123900',
        '123900',
        '123999',
        '123000',
      ];
      const made: string[] = [];
      for (const m of micros) {
        made.push(
          await post(client, w, {
            status: 'published',
            publishedAt: `${base}.${m}+00`,
            targets: [{ channelId: '1', status: 'published' }],
          }),
        );
      }
      for (const tab of ['published', 'all'] as ListTab[]) {
        const { seen, pages } = await walk(svc, w.workspaceId, tab, 2, now);
        expect(pages).toBe(4);
        expect(seen).toHaveLength(7);
        expect(new Set(seen)).toEqual(new Set(made));
      }
    }));

  it('pages the ascending upcoming tab cleanly too', () =>
    run(async (svc, client, now) => {
      const w = await workspace(client, 'a');
      const base = iso(now.getTime() + 24 * HOUR).replace(/\.\d+Z$/, '');
      const made: string[] = [];
      for (const m of ['500001', '500900', '500900', '500100', '500999']) {
        made.push(
          await post(client, w, {
            status: 'scheduled',
            scheduledAt: `${base}.${m}+00`,
          }),
        );
      }
      const { seen, pages } = await walk(
        svc,
        w.workspaceId,
        'upcoming',
        2,
        now,
      );
      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(made));
    }));

  it('a row count that is an exact multiple of limit ends with nextCursor null', () =>
    run(async (svc, client, now) => {
      const w = await workspace(client, 'a');
      const t = now.getTime();
      for (let i = 1; i <= 4; i++) {
        await post(client, w, {
          status: 'published',
          publishedAt: iso(t - i * HOUR),
          targets: [{ channelId: '1', status: 'published' }],
        });
      }
      const first = await svc.list(
        w.workspaceId,
        { tab: 'all', limit: 2 },
        now,
      );
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const last = await svc.list(
        w.workspaceId,
        { tab: 'all', limit: 2, cursor: first.nextCursor ?? undefined },
        now,
      );
      expect(last.rows).toHaveLength(2);
      expect(last.nextCursor).toBeNull();
      const one = await svc.list(w.workspaceId, { tab: 'all', limit: 4 }, now);
      expect(one.rows).toHaveLength(4);
      expect(one.nextCursor).toBeNull();
    }));

  it('a cursor from another tab is a 400, never a silent wrong page', () =>
    run(async (svc, client, now) => {
      const w = await workspace(client, 'a');
      const t = now.getTime();
      for (let i = 1; i <= 3; i++) {
        await post(client, w, {
          status: 'published',
          publishedAt: iso(t - i * HOUR),
          targets: [{ channelId: '1', status: 'published' }],
        });
      }
      const page = await svc.list(w.workspaceId, { tab: 'all', limit: 1 }, now);
      await expect(
        svc.list(
          w.workspaceId,
          { tab: 'published', limit: 1, cursor: page.nextCursor ?? undefined },
          now,
        ),
      ).rejects.toThrow('Invalid cursor');
    }));

  it('an out-of-range cursor key is a 400, not a database error', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'a');
      const cursor = encodeListCursor({
        key: '99999999999999999999',
        id: '33333333-3333-4333-8333-333333333333',
        tab: 'all',
      });
      await expect(
        svc.list(w.workspaceId, { tab: 'all', limit: 2, cursor }),
      ).rejects.toThrow('Invalid cursor');
    }));

  it('rejects a malformed cursor', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'a');
      await expect(
        svc.list(w.workspaceId, { tab: 'all', limit: 2, cursor: '!!' }),
      ).rejects.toThrow('Invalid cursor');
    }));
});
