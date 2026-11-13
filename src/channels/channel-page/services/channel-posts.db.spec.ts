import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
} from '../../../planner/testing/rollback-db';
import type { DbType } from '../../../planner/testing/rollback-db';
import {
  INBOX_MIGRATIONS,
  seedChannel,
  seedMember,
  seedWorkspace,
} from '../../../inbox/testing/inbox-db';
import { PlannerPostsService } from '../../../posts/services/planner-posts.service';
import type {
  ChannelPostsQueryDto,
  ChannelPostsResponse,
} from '../dto/channel-page.dto';
import { ChannelPostsService } from './channel-posts.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const at = (days: number) => new Date(NOW + days * DAY);

interface SeedPost {
  status: string;
  targets: unknown[];
  scheduledAt?: Date | null;
  publishedAt?: Date | null;
  createdBy?: string;
  updatedAt?: Date;
  mediaItems?: unknown[];
  platformContent?: unknown;
  metadata?: unknown;
  content?: string;
}

async function seedPost(
  client: PoolClient,
  ws: string,
  ownerId: string,
  p: SeedPost,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, scheduled_at, published_at,
                        media_items, platform_content, metadata, content, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
     RETURNING id`,
    [
      ws,
      p.createdBy ?? ownerId,
      p.status,
      JSON.stringify(p.targets),
      p.scheduledAt ?? null,
      p.publishedAt ?? null,
      JSON.stringify(p.mediaItems ?? []),
      JSON.stringify(p.platformContent ?? {}),
      JSON.stringify(p.metadata ?? {}),
      p.content ?? 'caption',
      p.updatedAt ?? new Date(),
    ],
  );
  return r.rows[0].id;
}

async function seedSnapshot(
  client: PoolClient,
  postId: string,
  channelId: number,
  m: {
    likes: number;
    impressions: number | null;
    ageDays: number;
    reach?: number;
  },
) {
  await client.query(
    `INSERT INTO post_metric_snapshots
       (post_id, channel_id, snapshot_at, age_bucket, likes_count, comments_count,
        shares_count, impressions_count, reach_count, fetched_at, sync_status)
     VALUES ($1, $2, $3::timestamptz, '24h', $4, 1, 0, $5, $6, $3::timestamptz, 'ok')`,
    [
      postId,
      channelId,
      at(-m.ageDays).toISOString(),
      m.likes,
      m.impressions,
      m.reach ?? null,
    ],
  );
}

/** Every page of a listing, concatenated, following nextCursor. */
async function allPages(
  svc: ChannelPostsService,
  ws: string,
  ch: number,
  q: ChannelPostsQueryDto,
): Promise<{ ids: string[]; pages: ChannelPostsResponse[] }> {
  const pages: ChannelPostsResponse[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await svc.list(ws, ch, { ...q, cursor });
    pages.push(res);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return { ids: pages.flatMap((p) => p.rows.map((r) => r.id)), pages };
}

interface World {
  db: DbType;
  svc: ChannelPostsService;
  ws: string;
  owner: string;
  member: string;
  ig: number;
  bsky: number;
  ids: Record<string, string>;
}

async function seedWorld(db: DbType, client: PoolClient): Promise<World> {
  const { workspaceId: ws, ownerId: owner } = await seedWorkspace(client);
  const member = await seedMember(client, ws, 'MEMBER', { name: 'Ali Raza' });
  const ig = await seedChannel(client, ws, 'instagram');
  const bsky = await seedChannel(client, ws, 'bluesky');
  const IG = (over: Record<string, unknown> = {}) => ({
    channelId: String(ig),
    platform: 'instagram',
    status: 'draft',
    ...over,
  });
  const BS = (over: Record<string, unknown> = {}) => ({
    channelId: String(bsky),
    platform: 'bluesky',
    status: 'draft',
    ...over,
  });
  const img = [{ url: 'https://cdn/a.jpg', type: 'image' }];
  const ids: Record<string, string> = {};

  // Scheduled tab: upcoming, upcoming on two channels, and one held.
  ids.s1 = await seedPost(client, ws, owner, {
    status: 'scheduled',
    scheduledAt: at(1),
    targets: [IG()],
    mediaItems: img,
  });
  ids.s2 = await seedPost(client, ws, owner, {
    status: 'scheduled',
    scheduledAt: at(2),
    targets: [BS(), IG()],
  });
  ids.held = await seedPost(client, ws, owner, {
    status: 'scheduled',
    scheduledAt: at(-1),
    targets: [
      IG({ heldAt: at(-1).toISOString(), heldReason: 'channel_paused' }),
    ],
  });
  // One post, two channels, two outcomes: failed on Instagram (composer
  // field), published on Bluesky (legacy field).
  ids.mixed = await seedPost(client, ws, owner, {
    status: 'partially_published',
    publishedAt: at(-4),
    targets: [
      IG({ status: 'scheduled', publishStatus: 'failed', errorMessage: 'x' }),
      BS({ status: 'published' }),
    ],
  });
  // Sent: rated 5%, rated 20%, unrated, and a legacy row (numeric
  // channelId, no target status) that follows its post.
  ids.sent5 = await seedPost(client, ws, owner, {
    status: 'published',
    publishedAt: at(-3),
    targets: [IG({ publishStatus: 'published' })],
  });
  await seedSnapshot(client, ids.sent5, ig, {
    likes: 40,
    impressions: 1000,
    ageDays: 5,
  });
  await seedSnapshot(client, ids.sent5, ig, {
    likes: 50,
    impressions: 1000,
    reach: 300,
    ageDays: 1,
  }); // the latest wins
  ids.sent20 = await seedPost(client, ws, owner, {
    status: 'published',
    publishedAt: at(-2),
    targets: [IG({ status: 'published' })],
  });
  await seedSnapshot(client, ids.sent20, ig, {
    likes: 20,
    impressions: 100,
    reach: 80,
    ageDays: 1,
  });
  // A snapshot of the same post on ANOTHER channel must not be read.
  await seedSnapshot(client, ids.sent20, bsky, {
    likes: 99,
    impressions: 100,
    ageDays: 0,
  });
  ids.sentNone = await seedPost(client, ws, owner, {
    status: 'published',
    publishedAt: at(-1),
    targets: [IG({ status: 'published' })],
  });
  ids.legacy = await seedPost(client, ws, owner, {
    status: 'published',
    publishedAt: at(-6),
    targets: [{ channelId: ig, platform: 'instagram' }],
  });
  // Drafts: a Reel by the member, one approved, one awaiting approval.
  ids.reel = await seedPost(client, ws, owner, {
    status: 'draft',
    createdBy: member,
    updatedAt: at(-1),
    targets: [IG()],
    mediaItems: [{ url: 'https://cdn/v.mp4', type: 'video' }],
    platformContent: { instagram: { platformSpecific: { postType: 'reel' } } },
  });
  ids.approved = await seedPost(client, ws, owner, {
    status: 'draft',
    updatedAt: at(-2),
    targets: [IG()],
    metadata: {
      approval: {
        required: true,
        requestedById: member,
        requestedAt: at(-3).toISOString(),
        approvedById: owner,
        approvedAt: at(-2).toISOString(),
        approvedFingerprint: 'f',
      },
    },
  });
  ids.awaiting = await seedPost(client, ws, owner, {
    status: 'draft',
    createdBy: member,
    targets: [IG()],
    metadata: {
      approval: {
        required: true,
        requestedById: member,
        requestedAt: at(-1).toISOString(),
        approvedById: null,
        approvedAt: null,
        approvedFingerprint: null,
      },
    },
  });
  // Never on Instagram: Bluesky only, and another workspace's post naming
  // the same channel id.
  ids.bskyOnly = await seedPost(client, ws, owner, {
    status: 'scheduled',
    scheduledAt: at(1),
    targets: [BS()],
  });
  const other = await seedWorkspace(client);
  await seedPost(client, other.workspaceId, other.ownerId, {
    status: 'scheduled',
    scheduledAt: at(1),
    targets: [IG()],
  });

  const svc = new ChannelPostsService(db, new PlannerPostsService(db));
  return { db, svc, ws, owner, member, ig, bsky, ids };
}

const run = (fn: (w: World) => Promise<void>) =>
  withRollbackDb(INBOX_MIGRATIONS, async (db, client) =>
    fn(await seedWorld(db, client)),
  );

describeDb('ChannelPostsService (database)', () => {
  it('counts every tab of this channel only, each post in exactly one tab', () =>
    run(async ({ svc, ws, ig, bsky }) => {
      const res = await svc.list(ws, ig, {});
      expect(res.counts).toEqual({
        scheduled: 3,
        drafts: 2,
        approval: 1,
        sent: 4,
        failed: 1,
      });
      expect(res.total).toBe(3); // default tab: scheduled

      const onBsky = await svc.list(ws, bsky, {});
      expect(onBsky.counts).toEqual({
        scheduled: 2,
        drafts: 0,
        approval: 0,
        sent: 1,
        failed: 0,
      });
    }));

  it('pages the scheduled tab soonest first with a full page every time', () =>
    run(async ({ svc, ws, ig, ids }) => {
      const p1 = await svc.list(ws, ig, { tab: 'scheduled', limit: 2 });
      expect(p1.rows.map((r) => r.id)).toEqual([ids.held, ids.s1]);
      expect(p1.total).toBe(3);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await svc.list(ws, ig, {
        tab: 'scheduled',
        limit: 2,
        cursor: p1.nextCursor!,
      });
      expect(p2.rows.map((r) => r.id)).toEqual([ids.s2]);
      expect(p2.nextCursor).toBeNull();

      // The held target says so; the multi-channel row carries THIS
      // channel's target, not the first one in the post.
      expect(p1.rows[0].target).toMatchObject({
        channelId: String(ig),
        status: 'scheduled',
      });
      expect(typeof p1.rows[0].target.heldAt).toBe('string');
      expect(p2.rows[0].target.channelId).toBe(String(ig));
      expect(p2.rows[0].targets).toHaveLength(2);
      expect(p1.rows[1].format).toBe('image');
    }));

  it('reads the status of this channel’s target on a multi-channel post', () =>
    run(async ({ svc, ws, ig, bsky, ids }) => {
      const failedIg = await svc.list(ws, ig, { tab: 'failed' });
      expect(failedIg.rows.map((r) => r.id)).toEqual([ids.mixed]);
      expect(failedIg.rows[0].target).toMatchObject({
        channelId: String(ig),
        status: 'failed',
      });
      expect(failedIg.rows[0].target.failure).not.toBeNull();

      const sentBsky = await svc.list(ws, bsky, { tab: 'sent' });
      expect(sentBsky.rows.map((r) => r.id)).toEqual([ids.mixed]);
      expect(sentBsky.rows[0].target).toMatchObject({
        channelId: String(bsky),
        status: 'published',
      });
    }));

  it('keeps awaiting approval apart from drafts', () =>
    run(async ({ svc, ws, ig, ids }) => {
      const approval = await svc.list(ws, ig, { tab: 'approval' });
      expect(approval.rows.map((r) => r.id)).toEqual([ids.awaiting]);
      const drafts = await svc.list(ws, ig, { tab: 'drafts' });
      // Newest edit first.
      expect(drafts.rows.map((r) => r.id)).toEqual([ids.reel, ids.approved]);
    }));

  it('filters by format and author in SQL, with facets per the other filter', () =>
    run(async ({ svc, ws, ig, ids, member, owner }) => {
      const reels = await svc.list(ws, ig, { tab: 'drafts', format: ['reel'] });
      expect(reels.rows.map((r) => r.id)).toEqual([ids.reel]);
      expect(reels.rows[0].format).toBe('reel');
      expect(reels.total).toBe(1);
      expect(reels.counts.drafts).toBe(1);
      expect(reels.counts.scheduled).toBe(0); // no scheduled reel
      // The format facet ignores the format filter itself.
      expect(reels.facets.format).toEqual({ reel: 1, text: 1 });
      expect(reels.facets.createdBy).toEqual([
        {
          user: { id: member, name: 'Ali Raza', avatarUrl: null },
          count: 1,
        },
      ]);

      const byOwner = await svc.list(ws, ig, {
        tab: 'drafts',
        createdBy: [owner],
      });
      expect(byOwner.rows.map((r) => r.id)).toEqual([ids.approved]);
      expect(byOwner.facets.format).toEqual({ text: 1 });
      expect(byOwner.facets.createdBy.map((f) => f.user.id).sort()).toEqual(
        [member, owner].sort(),
      );
    }));

  it('sorts sent by this channel’s latest engagement rate, unrated last, across pages', () =>
    run(async ({ svc, ws, ig, ids }) => {
      const byRate = [ids.sent20, ids.sent5, ids.sentNone, ids.legacy];
      const one = await svc.list(ws, ig, {
        tab: 'sent',
        sort: 'engagementRate',
      });
      expect(one.rows.map((r) => r.id)).toEqual(byRate);
      // Every snapshot carries 1 comment: (20 + 1) / 100, (50 + 1) / 1000.
      const none = {
        engagementRate: null,
        impressions: null,
        reach: null,
        likes: null,
        comments: null,
        shares: null,
      };
      expect(one.rows.map((r) => r.metrics)).toEqual([
        {
          engagementRate: 21,
          impressions: 100,
          reach: 80,
          likes: 20,
          comments: 1,
          shares: 0,
        },
        {
          engagementRate: 5.1,
          impressions: 1000,
          reach: 300,
          likes: 50,
          comments: 1,
          shares: 0,
        },
        none,
        none,
      ]);
      const paged = await allPages(svc, ws, ig, {
        tab: 'sent',
        sort: 'engagementRate',
        limit: 1,
      });
      expect(paged.ids).toEqual(byRate);
      expect(paged.pages).toHaveLength(4);

      // Time: newest first, and the paging agrees with one page.
      const byTime = [ids.sentNone, ids.sent20, ids.sent5, ids.legacy];
      const timed = await allPages(svc, ws, ig, { tab: 'sent', limit: 3 });
      expect(timed.ids).toEqual(byTime);
      const oldest = await allPages(svc, ws, ig, {
        tab: 'sent',
        sort: 'timeAsc',
        limit: 3,
      });
      expect(oldest.ids).toEqual([...byTime].reverse());
    }));

  it.each([
    ['reach', 'sent5,sent20,sentNone,legacy'],
    ['impressions', 'sent5,sent20,sentNone,legacy'],
    ['likes', 'sent5,sent20,sentNone,legacy'],
    // A tie (1 comment each) breaks newest first, then by id.
    ['comments', 'sent20,sent5,sentNone,legacy'],
    ['shares', 'sent20,sent5,sentNone,legacy'],
  ] as const)(
    'sorts sent by %s, highest first, missing last, the same page by page',
    (sort, expected) =>
      run(async ({ svc, ws, ig, ids }) => {
        const want = expected.split(',').map((k) => ids[k]);
        const one = await svc.list(ws, ig, { tab: 'sent', sort });
        expect(one.rows.map((r) => r.id)).toEqual(want);
        const paged = await allPages(svc, ws, ig, {
          tab: 'sent',
          sort,
          limit: 1,
        });
        expect(paged.ids).toEqual(want);
      }),
  );

  it('time and timeAsc on the other tabs', () =>
    run(async ({ svc, ws, ig, ids }) => {
      const later = await svc.list(ws, ig, { tab: 'scheduled' });
      expect(later.rows.map((r) => r.id)).toEqual([ids.held, ids.s1, ids.s2]);
      const asc = await svc.list(ws, ig, { tab: 'scheduled', sort: 'timeAsc' });
      expect(asc.rows.map((r) => r.id)).toEqual([ids.held, ids.s1, ids.s2]);
      const drafts = await svc.list(ws, ig, { tab: 'drafts', sort: 'timeAsc' });
      expect(drafts.rows.map((r) => r.id)).toEqual([ids.approved, ids.reel]);
      // Only Sent rows carry metrics.
      expect(later.rows.every((r) => r.metrics === undefined)).toBe(true);
    }));

  it('refuses a foreign channel, a misused sort and a cursor from another tab', () =>
    run(async ({ svc, ws, ig, bsky }) => {
      const other = await svc.list(ws, ig, { tab: 'scheduled', limit: 1 });
      await expect(
        svc.list(ws, ig, { tab: 'drafts', cursor: other.nextCursor! }),
      ).rejects.toBeInstanceOf(BadRequestException);
      for (const sort of ['engagementRate', 'reach', 'likes'] as const) {
        await expect(
          svc.list(ws, ig, { tab: 'scheduled', sort }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      // A cursor minted for one sort is refused under another.
      const byLikes = await svc.list(ws, ig, {
        tab: 'sent',
        sort: 'likes',
        limit: 1,
      });
      await expect(
        svc.list(ws, ig, {
          tab: 'sent',
          sort: 'reach',
          cursor: byLikes.nextCursor!,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.list('00000000-0000-4000-8000-000000000000', bsky, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.list(ws, 987654321, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }));
});
