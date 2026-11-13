import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { seedChannel, seedWorkspace } from '../../inbox/testing/inbox-db';
import { listWorkspacePosts } from './workspace-posts.query';

const MIN = 60_000;
const T0 = Date.parse('2026-10-01T12:00:00Z');

async function seedPost(
  client: PoolClient,
  ws: string,
  userId: string,
  targets: unknown[],
  minute: number,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, metadata, created_at)
     VALUES ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5) RETURNING id`,
    [
      ws,
      userId,
      JSON.stringify(targets),
      JSON.stringify(metadata),
      new Date(T0 + minute * MIN),
    ],
  );
  return r.rows[0].id;
}

describeDb('listWorkspacePosts channel filter (database)', () => {
  it('filters by channel in SQL: every page is full and total counts only that channel', () =>
    withRollbackDb([], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const a = await seedChannel(client, ws, 'bluesky');
      const b = await seedChannel(client, ws, 'mastodon');
      const t = (id: number) => ({ channelId: String(id), platform: 'x' });

      // Newest first. Channel A's posts sit behind a run of B-only posts,
      // which is exactly what the old JS filter (after LIMIT) dropped.
      const onA: string[] = [];
      for (let i = 0; i < 6; i++)
        await seedPost(client, ws, ownerId, [t(b)], 100 + i);
      onA.push(await seedPost(client, ws, ownerId, [t(b), t(a)], 50)); // multi-target
      onA.push(await seedPost(client, ws, ownerId, [t(a)], 40));
      // A legacy row with a numeric channelId still belongs to the channel.
      onA.push(
        await seedPost(
          client,
          ws,
          ownerId,
          [{ channelId: a, platform: 'x' }],
          30,
        ),
      );
      // A campaign-materialised post is never listed.
      await seedPost(client, ws, ownerId, [t(a)], 20, {
        campaignSlot: { id: 'slot-1' },
      });
      // A post in another workspace on a channel with the same id string
      // must not leak.
      const other = await seedWorkspace(client);
      await seedPost(client, other.workspaceId, other.ownerId, [t(a)], 10);

      const page1 = await listWorkspacePosts(db, ws, {
        channelId: String(a),
        limit: 2,
      });
      expect(page1.total).toBe(3);
      expect(page1.posts.map((p) => p.id)).toEqual(onA.slice(0, 2));

      const page2 = await listWorkspacePosts(db, ws, {
        channelId: String(a),
        limit: 2,
        offset: 2,
      });
      expect(page2.total).toBe(3);
      expect(page2.posts.map((p) => p.id)).toEqual(onA.slice(2));

      const all = await listWorkspacePosts(db, ws, { limit: 50 });
      expect(all.total).toBe(9);
      expect(all.posts).toHaveLength(9);

      const onB = await listWorkspacePosts(db, ws, { channelId: String(b) });
      expect(onB.total).toBe(7);

      const none = await listWorkspacePosts(db, ws, { channelId: '999999' });
      expect(none).toEqual({ posts: [], total: 0 });
    }));
});
