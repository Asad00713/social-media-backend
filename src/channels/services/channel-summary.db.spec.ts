/* eslint-disable @typescript-eslint/require-await -- service doubles */
import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { seedChannel, seedWorkspace } from '../../inbox/testing/inbox-db';
import { ChannelSummaryService } from './channel-summary.service';

const MIGRATIONS = [
  '0063_channel_pause_and_network_requests.sql',
  '0064_channel_nickname_sidebar.sql',
];
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const dayStr = (offset: number) =>
  new Date(NOW.getTime() + offset * DAY).toISOString().slice(0, 10);

const usageOk = (ownerId: string) => ({
  ownerOf: jest.fn(async () => ownerId),
  getUsage: jest.fn(async () => ({ used: 2, limit: 5, available: 3 })),
});

async function seedPost(
  client: PoolClient,
  ws: string,
  userId: string,
  targets: unknown[],
  opts: {
    status: string;
    scheduledAt?: Date | null;
    publishedAt?: Date | null;
    mediaItems?: unknown[];
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, scheduled_at, published_at, media_items)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb) RETURNING id`,
    [
      ws,
      userId,
      opts.status,
      JSON.stringify(targets),
      opts.scheduledAt ?? null,
      opts.publishedAt ?? null,
      JSON.stringify(opts.mediaItems ?? []),
    ],
  );
  return r.rows[0].id;
}

async function seedFollowers(
  client: PoolClient,
  channelId: number,
  table: 'daily' | 'snapshot',
  points: Array<[number, number]>,
) {
  for (const [offset, value] of points) {
    if (table === 'daily') {
      await client.query(
        `INSERT INTO channel_analytics_daily (channel_id, date, followers_at_end_of_day, computed_at)
         VALUES ($1, $2, $3, now())`,
        [channelId, dayStr(offset), value],
      );
    } else {
      await client.query(
        `INSERT INTO channel_snapshots (channel_id, snapshot_date, followers_count, fetched_at, sync_status)
         VALUES ($1, $2, $3, now(), 'success')`,
        [channelId, dayStr(offset), value],
      );
    }
  }
}

async function seedInbox(
  client: PoolClient,
  ws: string,
  channelId: number,
  rows: Array<{
    type: string;
    status: string;
    fromMe?: boolean;
    archived?: boolean;
  }>,
) {
  let n = 0;
  for (const r of rows) {
    await client.query(
      `INSERT INTO inbox_items (workspace_id, channel_id, platform, type, platform_item_id, platform_created_at, status, from_me, archived_at)
       VALUES ($1, $2, 'bluesky', $3, $4, now(), $5, $6, $7)`,
      [
        ws,
        channelId,
        r.type,
        `it-${channelId}-${n++}-${Math.random().toString(36).slice(2)}`,
        r.status,
        r.fromMe ?? false,
        r.archived ? new Date() : null,
      ],
    );
  }
}

describeDb('ChannelSummaryService (database)', () => {
  it('builds every card in one call', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const bsky = await seedChannel(client, ws, 'bluesky');
      const drive = await seedChannel(client, ws, 'google_drive');
      const li = await seedChannel(client, ws, 'linkedin');

      // Followers: daily wins over a snapshot on the same day.
      await seedFollowers(client, bsky, 'daily', [
        [-20, 1000],
        [-1, 1100],
      ]);
      await seedFollowers(client, bsky, 'snapshot', [
        [-20, 999],
        [-10, 1050],
        [-40, 500], // outside the window
      ]);
      // LinkedIn: only an old count -> latest known, no series.
      await seedFollowers(client, li, 'snapshot', [[-60, 42]]);

      const soon = new Date(NOW.getTime() + DAY);
      const later = new Date(NOW.getTime() + 3 * DAY);
      const next = await seedPost(
        client,
        ws,
        ownerId,
        [{ channelId: String(bsky), platform: 'bluesky', status: 'draft' }],
        {
          status: 'scheduled',
          scheduledAt: soon,
          mediaItems: [{ url: 'https://cdn/a.jpg', type: 'image' }],
        },
      );
      await seedPost(
        client,
        ws,
        ownerId,
        [{ channelId: String(bsky), platform: 'bluesky', status: 'draft' }],
        { status: 'scheduled', scheduledAt: later },
      );
      // Held: overdue, still counted, never "next".
      await seedPost(
        client,
        ws,
        ownerId,
        [
          {
            channelId: String(bsky),
            platform: 'bluesky',
            status: 'draft',
            heldAt: new Date().toISOString(),
            heldReason: 'channel_paused',
          },
        ],
        { status: 'scheduled', scheduledAt: new Date(NOW.getTime() - DAY) },
      );
      const publishedAt = new Date(NOW.getTime() - 2 * DAY);
      await seedPost(
        client,
        ws,
        ownerId,
        [
          {
            channelId: String(bsky),
            platform: 'bluesky',
            status: 'published',
          },
        ],
        { status: 'published', publishedAt },
      );

      await seedInbox(client, ws, bsky, [
        { type: 'comment', status: 'unread' },
        { type: 'dm', status: 'unread' },
        { type: 'comment', status: 'unread', fromMe: true },
        { type: 'comment', status: 'done' },
        { type: 'comment', status: 'unread', archived: true },
      ]);

      await client.query(
        `UPDATE social_media_channels SET paused_at = now(), paused_by_user_id = $2 WHERE id = $1`,
        [li, ownerId],
      );
      const erroredAt = new Date(NOW.getTime() - 3 * DAY);
      await client.query(
        `UPDATE social_media_channels SET connection_status = 'revoked', last_error = 'Grant revoked', last_error_at = $2 WHERE id = $1`,
        // As drizzle writes a `timestamp` (no zone): the UTC wall clock.
        [drive, erroredAt.toISOString()],
      );
      await client.query(
        `UPDATE social_media_channels SET nickname = 'Daybreak', show_in_sidebar = true WHERE id = $1`,
        [bsky],
      );

      const svc = new ChannelSummaryService(db, usageOk(ownerId) as never);
      const res = await svc.getSummary(ws, NOW);

      expect(res.usage).toEqual({ used: 2, limit: 5, available: 3 });
      const card = (id: number) =>
        res.channels.find((c) => c.channelId === id)!;

      const b = card(bsky);
      expect(b.followersSeries).toEqual([
        { date: dayStr(-20), value: 1000 },
        { date: dayStr(-10), value: 1050 },
        { date: dayStr(-1), value: 1100 },
      ]);
      expect(b.followers).toBe(1100);
      expect(b.followersChangePct).toBe(10);
      expect(b.scheduledCount).toBe(3);
      expect(b.unreadCount).toBe(2);
      expect(b.nextPost).toEqual({
        postId: next,
        scheduledAt: soon.toISOString(),
        thumbnailUrl: 'https://cdn/a.jpg',
      });
      expect(b.lastPostedAt).toBe(publishedAt.toISOString());
      expect(b.health).toEqual({ kind: 'ok' });
      expect(b).toMatchObject({
        nickname: 'Daybreak',
        displayName: 'Daybreak',
        showInSidebar: true,
      });

      const l = card(li);
      expect(l.followers).toBe(42);
      expect(l.followersSeries).toEqual([]);
      expect(l.followersChangePct).toBeNull();
      expect(l.unreadCount).toBeNull(); // LinkedIn has no inbox
      expect(l.health).toMatchObject({
        kind: 'paused',
        pausedBy: { id: ownerId, name: 'Owner' },
      });

      const d = card(drive);
      expect(d).toMatchObject({
        followers: null,
        followersSeries: [],
        unreadCount: null,
        nextPost: null,
        scheduledCount: 0,
        lastPostedAt: null,
        nickname: null,
        showInSidebar: false,
      });
      expect(d.displayName).toMatch(/^Account acct-/);
      expect(d.health).toEqual({
        kind: 'reconnect',
        reason: 'Grant revoked',
        since: erroredAt.toISOString(),
      });
    }));

  it('a plan-locked channel reads locked; usage is null when it cannot be read', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      await client.query(
        `UPDATE social_media_channels SET is_active = false, paused_at = now() WHERE id = $1`,
        [ch],
      );
      const failing = {
        ownerOf: jest.fn(async () => {
          throw new Error('no owner');
        }),
        getUsage: jest.fn(),
      };
      const res = await new ChannelSummaryService(
        db,
        failing as never,
      ).getSummary(ws, NOW);
      expect(res.usage).toBeNull();
      expect(res.channels).toHaveLength(1);
      expect(res.channels[0].health).toEqual({ kind: 'locked' });
    }));

  it('an empty workspace has no cards', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const res = await new ChannelSummaryService(
        db,
        usageOk(ownerId) as never,
      ).getSummary(ws, NOW);
      expect(res.channels).toEqual([]);
    }));
});
