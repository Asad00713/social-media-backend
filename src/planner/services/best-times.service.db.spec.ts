import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../testing/rollback-db';
import { BestTimesService } from './best-times.service';

/** The two queries are protected; the spec reaches them through a subclass. */
class ExposedService extends BestTimesService {
  channels(workspaceId: string) {
    return this.loadActiveChannels(workspaceId);
  }
  latest(workspaceId: string, ids: number[]) {
    return this.latestSnapshotMs(workspaceId, ids);
  }
}

const rnd = () => Math.random().toString(36).slice(2, 8);

async function workspace(client: PoolClient, tag: string) {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`u-${tag}-${rnd()}@example.test`],
  );
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [tag, `${tag}-${rnd()}`, u.rows[0].id],
  );
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

async function channel(
  client: PoolClient,
  userId: string,
  workspaceId: string,
  platform: string,
  isActive = true,
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO social_media_channels
       (connected_by_user_id, workspace_id, platform, account_type, platform_account_id, account_name, access_token, is_active)
     VALUES ($6, $1, $2, 'page', $3, $4, 'tok', $5) RETURNING id`,
    [workspaceId, platform, `acc-${rnd()}`, `n-${rnd()}`, isActive, userId],
  );
  return Number(r.rows[0].id);
}

async function snapshot(
  client: PoolClient,
  w: { userId: string; workspaceId: string },
  channelId: number,
  at: string,
) {
  const p = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, content, targets)
     VALUES ($1, $2, 'published', 'x', '[]'::jsonb) RETURNING id`,
    [w.workspaceId, w.userId],
  );
  await client.query(
    `INSERT INTO post_metric_snapshots
       (post_id, channel_id, snapshot_at, age_bucket, fetched_at, sync_status)
     VALUES ($1, $2, $3::timestamptz, '1h', $3::timestamptz, 'success')`,
    [p.rows[0].id, channelId, at],
  );
}

describeDb('BestTimesService queries', () => {
  const run = (
    fn: (svc: ExposedService, client: PoolClient) => Promise<void>,
  ) =>
    withRollbackDb([], async (db, client) => {
      const svc = new ExposedService(db, {} as never, {} as never);
      await fn(svc, client);
    });

  it('loadActiveChannels returns only this workspace active channels', () =>
    run(async (svc, client) => {
      const a = await workspace(client, 'a');
      const b = await workspace(client, 'b');
      const ig = await channel(client, a.userId, a.workspaceId, 'instagram');
      await channel(client, a.userId, a.workspaceId, 'twitter', false);
      await channel(client, b.userId, b.workspaceId, 'instagram');
      expect(await svc.channels(a.workspaceId)).toEqual([
        { id: ig, platform: 'instagram' },
      ]);
    }));

  it('a non-social channel comes back from SQL and the service drops it', () =>
    run(async (svc, client) => {
      const a = await workspace(client, 'a');
      const ig = await channel(client, a.userId, a.workspaceId, 'instagram');
      const cal = await channel(
        client,
        a.userId,
        a.workspaceId,
        'google_calendar',
      );
      const rows = await svc.channels(a.workspaceId);
      expect(rows.map((r) => r.id).sort()).toEqual([ig, cal].sort());
      // The service itself filters by platform category.
      const res = await new BestTimesService(
        (svc as unknown as { db: never }).db,
        {
          publishedPosts: () => Promise.resolve([]),
        } as never,
        {
          get: () => Promise.resolve({ bestTimesSource: 'own' }),
        } as never,
      ).getForWorkspace(a.workspaceId, a.userId);
      expect(res.channels.map((c) => c.channelId)).toEqual([ig]);
    }));

  it('latestSnapshotMs is a positive ms number, 0 with none', () =>
    run(async (svc, client) => {
      const a = await workspace(client, 'a');
      const ig = await channel(client, a.userId, a.workspaceId, 'instagram');
      expect(await svc.latest(a.workspaceId, [ig])).toBe(0);
      await snapshot(client, a, ig, '2026-06-01T10:00:00Z');
      await snapshot(client, a, ig, '2026-06-03T10:00:00Z');
      const ms = await svc.latest(a.workspaceId, [ig]);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBe(Date.parse('2026-06-03T10:00:00Z'));
    }));

  it('a snapshot on another workspace channel does not move latestSnapshotMs', () =>
    run(async (svc, client) => {
      const a = await workspace(client, 'a');
      const b = await workspace(client, 'b');
      const chA = await channel(client, a.userId, a.workspaceId, 'instagram');
      const chB = await channel(client, b.userId, b.workspaceId, 'instagram');
      await snapshot(client, a, chA, '2026-06-01T10:00:00Z');
      const before = await svc.latest(a.workspaceId, [chA]);
      await snapshot(client, b, chB, '2026-06-09T10:00:00Z');
      expect(await svc.latest(a.workspaceId, [chA])).toBe(before);
      // Even if a foreign id were passed in, the workspace predicate holds.
      expect(await svc.latest(a.workspaceId, [chA, chB])).toBe(before);
    }));
});
