import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { seedChannel, seedWorkspace } from '../../inbox/testing/inbox-db';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { channelAudience, type RawSlice } from './channel-audience.schema';

const MIGRATION = '0062_channel_audience.sql';

describeDb('channel_audience (database)', () => {
  it('upserts one row per channel, cascades on channel delete, and re-applies cleanly', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const channelId = await seedChannel(client, workspaceId, 'instagram');

      const first = {
        channelId,
        status: 'ok' as const,
        followerCount: 120,
        countries: [{ key: 'PK', value: 80 }] as RawSlice[],
        cities: [{ key: 'Karachi', value: 40 }] as RawSlice[],
        ages: [{ key: '18-24', value: 50 }] as RawSlice[],
        genders: [{ key: 'F', value: 70 }] as RawSlice[],
      };
      await db.insert(channelAudience).values(first);

      const second = {
        ...first,
        status: 'below_threshold' as const,
        followerCount: 90,
        countries: [] as RawSlice[],
      };
      await db
        .insert(channelAudience)
        .values(second)
        .onConflictDoUpdate({
          target: channelAudience.channelId,
          set: {
            status: second.status,
            followerCount: second.followerCount,
            countries: second.countries,
          },
        });

      const rows = await db
        .select()
        .from(channelAudience)
        .where(eq(channelAudience.channelId, channelId));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('below_threshold');
      expect(rows[0].followerCount).toBe(90);
      expect(rows[0].countries).toEqual([]);
      expect(rows[0].cities).toEqual([{ key: 'Karachi', value: 40 }]);
      expect(rows[0].fetchedAt).toBeInstanceOf(Date);

      await client.query(`DELETE FROM social_media_channels WHERE id = $1`, [
        channelId,
      ]);
      const gone = await client.query(
        `SELECT 1 FROM channel_audience WHERE channel_id = $1`,
        [channelId],
      );
      expect(gone.rows).toHaveLength(0);

      // Idempotent: a third application of the file (the harness already ran it twice).
      const sql = readFileSync(
        join(process.cwd(), 'drizzle', 'migrations', MIGRATION),
        'utf8',
      );
      await expect(client.query(sql)).resolves.toBeDefined();
    });
  });

  it('defaults the jsonb columns to [] and rejects an unknown status', async () => {
    await withRollbackDb([MIGRATION], async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const channelId = await seedChannel(client, workspaceId, 'threads');
      const r = await client.query(
        `INSERT INTO channel_audience (channel_id, status) VALUES ($1, 'unsupported')
         RETURNING countries, cities, ages, genders, follower_count`,
        [channelId],
      );
      expect(r.rows[0]).toEqual({
        countries: [],
        cities: [],
        ages: [],
        genders: [],
        follower_count: null,
      });

      await client.query('SAVEPOINT bad_status');
      await expect(
        client.query(
          `UPDATE channel_audience SET status = 'nope' WHERE channel_id = $1`,
          [channelId],
        ),
      ).rejects.toThrow(/channel_audience_status_chk/);
      await client.query('ROLLBACK TO SAVEPOINT bad_status');
    });
  });
});
