import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { PlannerPostsService } from './planner-posts.service';
import { PostDraftsService } from './post-drafts.service';

const MIGRATION = '0041_post_ready.sql';

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

async function post(
  client: PoolClient,
  w: { userId: string; workspaceId: string },
  o: { status?: string; ready?: boolean; updatedAt: string; label?: string },
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, content, ready_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz) RETURNING id`,
    [
      w.workspaceId,
      w.userId,
      o.status ?? 'draft',
      o.label ?? 'x',
      o.ready ? '2026-01-01T00:00:00Z' : null,
      o.updatedAt,
    ],
  );
  return r.rows[0].id;
}

describeDb('PostDraftsService.list', () => {
  const run = (
    fn: (svc: PostDraftsService, client: PoolClient) => Promise<void>,
  ) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const svc = new PostDraftsService(db, new PlannerPostsService(db));
      await fn(svc, client);
    });

  it('lists only drafts, ready first, then newest edit first; total is unpaged', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'a');
      const other = await workspace(client, 'b');
      const oldReady = await post(client, w, {
        ready: true,
        updatedAt: '2026-03-01T10:00:00Z',
      });
      const newReady = await post(client, w, {
        ready: true,
        updatedAt: '2026-03-02T10:00:00Z',
      });
      const newest = await post(client, w, {
        updatedAt: '2026-03-05T10:00:00Z',
      });
      const oldest = await post(client, w, {
        updatedAt: '2026-03-03T10:00:00Z',
      });
      const mid = await post(client, w, { updatedAt: '2026-03-04T10:00:00Z' });
      await post(client, w, {
        status: 'scheduled',
        updatedAt: '2026-03-09T10:00:00Z',
      });
      await post(client, w, {
        status: 'published',
        updatedAt: '2026-03-09T10:00:00Z',
      });
      await post(client, other, { updatedAt: '2026-03-09T10:00:00Z' });

      const page = await svc.list(w.workspaceId, { limit: 30 });
      expect(page.total).toBe(5);
      expect(page.nextCursor).toBeNull();
      expect(page.drafts.map((d) => d.id)).toEqual([
        newReady,
        oldReady,
        newest,
        mid,
        oldest,
      ]);
      expect(page.drafts[0].readyAt).not.toBeNull();
      expect(page.drafts[2].readyAt).toBeNull();
    }));

  it('pages with no duplicate and no gap, incl. identical updated_at to the microsecond', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'a');
      const other = await workspace(client, 'b');
      await post(client, other, { updatedAt: '2026-03-09T10:00:00Z' });
      await post(client, w, { ready: true, updatedAt: '2026-03-01T10:00:00Z' });
      await post(client, w, { ready: true, updatedAt: '2026-03-02T10:00:00Z' });
      await post(client, w, { updatedAt: '2026-03-05T10:00:00Z' });
      // Two drafts tied to the microsecond; they straddle the page 2 / 3 boundary.
      const tied = '2026-03-04 10:00:00.123456+00';
      await post(client, w, { updatedAt: tied });
      await post(client, w, { updatedAt: tied });

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await svc.list(w.workspaceId, { limit: 2, cursor });
        expect(page.total).toBe(5);
        seen.push(...page.drafts.map((d) => d.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    }));

  it('rejects a malformed cursor', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'a');
      await expect(
        svc.list(w.workspaceId, { limit: 2, cursor: '!!' }),
      ).rejects.toThrow('Invalid cursor');
    }));
});
