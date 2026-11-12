import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { seedWorkspace } from '../../inbox/testing/inbox-db';
import { syncHeldDripPost } from './held-drip-sync';

const MIGRATION = '0063_channel_pause_and_network_requests.sql';

async function seedHeldDrip(
  client: PoolClient,
  ws: string,
  userId: string,
  dripStatus = 'scheduled',
) {
  const c = await client.query<{ id: string }>(
    `INSERT INTO drip_campaigns
       (workspace_id, created_by_id, name, niche, occurrence_type, start_date, end_date, publish_time, target_channel_ids, completed_occurrences)
     VALUES ($1, $2, 'Drip', 'tech', 'daily', current_date, current_date + 7, '09:00', '["7"]'::jsonb, 4)
     RETURNING id`,
    [ws, userId],
  );
  const campaignId = c.rows[0].id;
  const p = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, scheduled_at, metadata)
     VALUES ($1, $2, 'scheduled', '[]'::jsonb, now(), $3::jsonb) RETURNING id`,
    [ws, userId, JSON.stringify({ dripCampaignId: campaignId })],
  );
  const postId = p.rows[0].id;
  const d = await client.query<{ id: string }>(
    `INSERT INTO drip_posts
       (drip_campaign_id, occurrence_number, scheduled_date, scheduled_time, scheduled_at,
        ai_generation_at, email_notification_at, status, post_id)
     VALUES ($1, 5, current_date, '09:00', now(), now(), now(), $2, $3) RETURNING id`,
    [campaignId, dripStatus, postId],
  );
  const dripPostId = d.rows[0].id;
  const metadata = { dripCampaignId: campaignId, dripPostId };
  return { campaignId, postId, dripPostId, metadata };
}

const dripState = async (client: PoolClient, dripPostId: string) =>
  (
    await client.query<{ status: string; published_at: Date | null }>(
      `SELECT status, published_at FROM drip_posts WHERE id = $1`,
      [dripPostId],
    )
  ).rows[0];

const completed = async (client: PoolClient, campaignId: string) =>
  (
    await client.query<{ n: number }>(
      `SELECT completed_occurrences AS n FROM drip_campaigns WHERE id = $1`,
      [campaignId],
    )
  ).rows[0].n;

describeDb('syncHeldDripPost (database)', () => {
  it('a held occurrence that went out on resume is published and counted, once', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const s = await seedHeldDrip(client, ws, ownerId);
      const post = {
        id: s.postId,
        status: 'published' as const,
        metadata: s.metadata,
        lastError: null,
      };

      expect(await syncHeldDripPost(db, post)).toBe(true);
      const after = await dripState(client, s.dripPostId);
      expect(after.status).toBe('published');
      expect(after.published_at).not.toBeNull();
      expect(await completed(client, s.campaignId)).toBe(5);
      const h = await client.query<{ action: string; new_status: string }>(
        `SELECT action, new_status FROM drip_campaign_history WHERE drip_post_id = $1`,
        [s.dripPostId],
      );
      expect(h.rows).toEqual([
        { action: 'published', new_status: 'published' },
      ]);

      // Again (a retried job): nothing more.
      expect(await syncHeldDripPost(db, post)).toBe(false);
      expect(await completed(client, s.campaignId)).toBe(5);
    }));

  it('a failure on resume marks the drip post failed without counting it', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const s = await seedHeldDrip(client, ws, ownerId);
      await syncHeldDripPost(db, {
        id: s.postId,
        status: 'partially_published',
        metadata: s.metadata,
        lastError: 'Some channels failed to publish',
      });
      expect((await dripState(client, s.dripPostId)).status).toBe('failed');
      expect(await completed(client, s.campaignId)).toBe(4);
    }));

  it('leaves a drip post the processor is handling itself, and non-drip posts', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const s = await seedHeldDrip(client, ws, ownerId, 'publishing');
      expect(
        await syncHeldDripPost(db, {
          id: s.postId,
          status: 'published',
          metadata: s.metadata,
          lastError: null,
        }),
      ).toBe(false);
      expect((await dripState(client, s.dripPostId)).status).toBe('publishing');
      expect(
        await syncHeldDripPost(db, {
          id: s.postId,
          status: 'published',
          metadata: {},
          lastError: null,
        }),
      ).toBe(false);
    }));
});
