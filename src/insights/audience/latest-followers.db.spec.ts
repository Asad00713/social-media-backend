import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { latestFollowerCounts } from './latest-followers';

async function channel(client: PoolClient, tag: string): Promise<number> {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`u-${tag}-${Math.random().toString(36).slice(2, 8)}@example.test`],
  );
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [tag, `${tag}-${Math.random().toString(36).slice(2, 8)}`, u.rows[0].id],
  );
  const c = await client.query<{ id: number }>(
    `INSERT INTO social_media_channels
       (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
     VALUES ($1, 'instagram', 'personal', $2, $2, 'x', $3) RETURNING id`,
    [w.rows[0].id, `${tag}-acct`, u.rows[0].id],
  );
  return Number(c.rows[0].id);
}

async function snap(
  client: PoolClient,
  channelId: number,
  date: string,
  followers: number | null,
) {
  await client.query(
    `INSERT INTO channel_snapshots (channel_id, snapshot_date, followers_count, fetched_at, sync_status)
     VALUES ($1, $2, $3, now(), 'success')`,
    [channelId, date, followers],
  );
}

describeDb('latestFollowerCounts', () => {
  it('returns an empty Map for an empty id list', () =>
    withRollbackDb([], async (db) => {
      expect((await latestFollowerCounts(db, [])).size).toBe(0);
    }));

  it('gives each channel its newest known count, null when it has none', () =>
    withRollbackDb([], async (db, client) => {
      const a = await channel(client, 'a');
      const b = await channel(client, 'b');
      const c = await channel(client, 'c');
      await snap(client, a, '2026-11-09', 80);
      await snap(client, a, '2026-11-11', 120);
      await snap(client, a, '2026-11-10', 100);
      await snap(client, b, '2026-11-10', 500);
      await snap(client, b, '2026-11-11', null);
      const got = await latestFollowerCounts(db, [a, b, c]);
      expect(got.get(a)).toBe(120);
      expect(got.get(b)).toBe(500);
      expect(got.has(c)).toBe(true);
      expect(got.get(c)).toBeNull();
    }));
});
