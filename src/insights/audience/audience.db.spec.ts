import type { PoolClient } from 'pg';
import { customWindow } from '../../post-performance/period';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { InsightsChannelsRepository } from '../insights-channels.repository';
import type { ResolvedPeriod } from '../lib/query';
import { AudienceService } from './audience.service';

const MIGRATION = '0062_channel_audience.sql';
const NOW = new Date('2026-10-20T12:00:00Z');
const WEEK: ResolvedPeriod = {
  days: 7,
  window: customWindow('2026-10-13', '2026-10-19'),
};

async function workspace(client: PoolClient, tag: string) {
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
  const channel = async (n: string, platform: string) =>
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
  return { workspaceId, channel };
}

const rollup = (
  client: PoolClient,
  channelId: number,
  date: string,
  followers: number,
) =>
  client.query(
    `INSERT INTO channel_analytics_daily (channel_id, date, followers_at_end_of_day, followers_gained, computed_at)
     VALUES ($1, $2::date, $3, 0, now())`,
    [channelId, date, followers],
  );

describeDb('AudienceService against Postgres', () => {
  const run = (
    fn: (
      svc: AudienceService,
      client: PoolClient,
      queue: { add: jest.Mock },
    ) => Promise<void>,
  ) =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const queue = { add: jest.fn().mockResolvedValue({}) };
      const svc = new AudienceService(
        new InsightsChannelsRepository(db),
        db,
        {} as never,
        { status: 'ready', get: jest.fn(), set: jest.fn() },
        queue as never,
      );
      await fn(svc, client, queue);
    });

  it('growth matches the hand-computed change, never clamped, LinkedIn left out', () =>
    run(async (svc, client) => {
      const w = await workspace(client, 'g1');
      const up = await w.channel('up', 'instagram');
      const down = await w.channel('down', 'twitter');
      const quiet = await w.channel('quiet', 'bluesky');
      const li = await w.channel('li', 'linkedin');

      // up: seed 100 before the window, 110 on the 14th, 130 on the 19th.
      await rollup(client, up, '2026-10-05', 100);
      await rollup(client, up, '2026-10-14', 110);
      await rollup(client, up, '2026-10-19', 130);
      // A reading after the window must not leak in.
      await rollup(client, up, '2026-10-20', 999);
      // down: seed 50, then 44 -> change -6.
      await rollup(client, down, '2026-10-12', 50);
      await rollup(client, down, '2026-10-16', 44);
      // LinkedIn reported, but has no follower count capability.
      await rollup(client, li, '2026-10-14', 5);

      const dto = await svc.growth(w.workspaceId, WEEK, undefined);

      const byId = new Map(dto.channels.map((c) => [c.channelId, c]));
      expect([...byId.keys()].sort((a, b) => a - b)).toEqual(
        [up, down, quiet].sort((a, b) => a - b),
      );
      expect(byId.get(up)).toMatchObject({ current: 130, change: 30 });
      expect(byId.get(down)).toMatchObject({ current: 44, change: -6 });
      expect(byId.get(down)?.series[2]).toEqual({
        date: '2026-10-15',
        followers: 50,
        gained: 0,
      });
      expect(byId.get(down)?.series[6].gained).toBe(-6);
      expect(byId.get(quiet)).toMatchObject({ current: null, change: null });
      expect(dto.total).toMatchObject({ current: 174, change: 24 });
      expect(dto.channels[0].channelId).toBe(up);
      expect(dto.channels[dto.channels.length - 1].channelId).toBe(quiet);
    }));

  it('channels reads the stored row, converts raw counts, and flags a missing one pending', () =>
    run(async (svc, client, queue) => {
      const w = await workspace(client, 'c1');
      const withRow = await w.channel('row', 'instagram');
      const without = await w.channel('none', 'threads');
      await client.query(
        `INSERT INTO channel_snapshots (channel_id, snapshot_date, followers_count, fetched_at, sync_status)
         VALUES ($1, '2026-10-19', 321, now(), 'success')`,
        [withRow],
      );
      await client.query(
        `INSERT INTO channel_audience (channel_id, status, follower_count, countries, cities, ages, genders, fetched_at)
         VALUES ($1, 'ok', 321, $2::jsonb, '[]'::jsonb, $3::jsonb, '[]'::jsonb, $4)`,
        [
          withRow,
          JSON.stringify([
            { key: 'US', value: 3 },
            { key: 'PK', value: 1 },
          ]),
          JSON.stringify([{ key: '65+', value: 1 }]),
          new Date(NOW.getTime() - 3_600_000),
        ],
      );

      const { channels } = await svc.channels(
        w.workspaceId,
        WEEK,
        undefined,
        NOW,
      );
      const [row, pending] = channels;
      expect(row).toMatchObject({
        channelId: withRow,
        status: 'ok',
        followerCount: 321,
        countries: [
          { key: 'US', percent: 75 },
          { key: 'PK', percent: 25 },
        ],
        cities: [],
      });
      expect(row.ages[5]).toEqual({ key: '55+', percent: 100 });
      expect(pending).toMatchObject({
        channelId: without,
        status: 'pending',
        fetchedAt: null,
        followerCount: null,
      });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'channel-audience-refresh',
        { channelId: without },
        { jobId: `audience-${without}-2026-10-20` },
      );
    }));
});
