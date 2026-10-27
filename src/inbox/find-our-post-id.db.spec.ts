import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { findOurPostIdQuery } from './inbox.service';

const MIGRATION = '0045_posts_targets_gin.sql';

async function seed(client: PoolClient) {
  const tag = Math.random().toString(36).slice(2, 10);
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`u-${tag}@example.test`],
  );
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ('ws', $1, $2) RETURNING id`,
    [`ws-${tag}`, u.rows[0].id],
  );
  // pg may hand back the serial id as a string; the service takes a number.
  const channel = async (n: string) =>
    Number(
      (
        await client.query<{ id: number }>(
          `INSERT INTO social_media_channels
           (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
         VALUES ($1, 'instagram', 'business', $2, $2, 'x', $3) RETURNING id`,
          [w.rows[0].id, `${n}-${tag}`, u.rows[0].id],
        )
      ).rows[0].id,
    );
  const post = async (targets: unknown, ageMinutes: number) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO posts (workspace_id, created_by_id, targets, created_at)
         VALUES ($1, $2, $3::jsonb, now() - ($4 || ' minutes')::interval) RETURNING id`,
        [
          w.rows[0].id,
          u.rows[0].id,
          JSON.stringify(targets),
          String(ageMinutes),
        ],
      )
    ).rows[0].id;
  return { channel, post };
}

describeDb('findOurPostId (F3)', () => {
  it('finds the oldest of 60 posts on a channel (no LIMIT 50 miss)', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const s = await seed(client);
      const ch = await s.channel('a');
      const ids: string[] = [];
      for (let n = 0; n < 60; n++) {
        ids.push(
          await s.post(
            [
              {
                channelId: String(ch),
                platformPostId: `p-${n}`,
                platform: 'instagram',
                status: 'published',
              },
            ],
            1000 - n, // post 0 is the oldest
          ),
        );
      }
      const [row] = await findOurPostIdQuery(db, ch, 'p-0');
      expect(row?.id).toBe(ids[0]);
    }));

  it('does not return a post on another channel with the same platformPostId', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const s = await seed(client);
      const ch = await s.channel('a');
      const other = await s.channel('b');
      await s.post([{ channelId: String(other), platformPostId: 'dup' }], 5);
      const rows = await findOurPostIdQuery(db, ch, 'dup');
      expect(rows).toHaveLength(0);
    }));

  it('finds a target stored with a numeric channelId', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const s = await seed(client);
      const ch = await s.channel('a');
      const id = await s.post([{ channelId: ch, platformPostId: 'num' }], 5);
      const [row] = await findOurPostIdQuery(db, ch, 'num');
      expect(row?.id).toBe(id);
    }));

  it('returns nothing for an unknown platform post id', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const s = await seed(client);
      const ch = await s.channel('a');
      await s.post([{ channelId: String(ch), platformPostId: 'x' }], 5);
      expect(await findOurPostIdQuery(db, ch, 'nope')).toHaveLength(0);
    }));

  it('is served by posts_targets_gin_idx', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const s = await seed(client);
      const ch = await s.channel('a');
      await s.post([{ channelId: String(ch), platformPostId: 'x' }], 5);
      // The planner may prefer walking posts_created_at_idx for ORDER BY ..
      // LIMIT 1; force the bitmap path so the predicate's own index shows up.
      await client.query(`SET LOCAL enable_seqscan = off`);
      await client.query(`SET LOCAL enable_indexscan = off`);
      const { sql, params } = findOurPostIdQuery(db, ch, 'x').toSQL();
      const plan = await client.query<Record<string, string>>(
        `EXPLAIN ${sql}`,
        params,
      );
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('posts_targets_gin_idx');
    }));
});
