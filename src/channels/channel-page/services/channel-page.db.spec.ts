/* eslint-disable @typescript-eslint/require-await -- Redis double */
import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
} from '../../../planner/testing/rollback-db';
import type { DbType } from '../../../planner/testing/rollback-db';
import {
  INBOX_MIGRATIONS,
  seedChannel,
  seedWorkspace,
} from '../../../inbox/testing/inbox-db';
import { ConversationListService } from '../../../inbox/conversations/services/conversation-list.service';
import { ConversationPresenter } from '../../../inbox/conversations/services/conversation-presenter.service';
import { InsightsService } from '../../../insights/insights.service';
import { PostPerformanceRepository } from '../../../post-performance/post-performance.repository';
import { BestTimesService } from '../../../planner/services/best-times.service';
import { PlannerPreferencesService } from '../../../planner/services/planner-preferences.service';
import {
  addDays,
  localDateOf,
  wallClockToUtc,
} from '../../../planner/lib/workspace-time';
import {
  ChannelPageService,
  type RefreshLimitStore,
} from './channel-page.service';

const MIGRATIONS = [...INBOX_MIGRATIONS, '0060_insight_hidden_steps.sql'];
const TZ = 'Asia/Karachi';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const TODAY = localDateOf(NOW, TZ);
const local = (dayOffset: number, hhmm: string) =>
  wallClockToUtc(addDays(TODAY, dayOffset), hhmm, TZ);

async function seedPost(
  client: PoolClient,
  ws: string,
  userId: string,
  p: {
    status: string;
    targets: unknown[];
    scheduledAt?: Date | null;
    publishedAt?: Date | null;
    mediaItems?: unknown[];
    platformContent?: unknown;
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, scheduled_at,
                        published_at, media_items, platform_content, content)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, 'caption') RETURNING id`,
    [
      ws,
      userId,
      p.status,
      JSON.stringify(p.targets),
      p.scheduledAt ?? null,
      p.publishedAt ?? null,
      JSON.stringify(p.mediaItems ?? []),
      JSON.stringify(p.platformContent ?? {}),
    ],
  );
  return r.rows[0].id;
}

async function seedSnapshot(
  client: PoolClient,
  postId: string,
  channelId: number,
  m: { likes: number; impressions: number; reach: number },
) {
  await client.query(
    `INSERT INTO post_metric_snapshots
       (post_id, channel_id, snapshot_at, age_bucket, likes_count, comments_count,
        shares_count, impressions_count, reach_count, fetched_at, sync_status)
     VALUES ($1, $2, now(), '24h', $3, 0, 0, $4, $5, now(), 'ok')`,
    [postId, channelId, m.likes, m.impressions, m.reach],
  );
}

let convSeq = 0;
async function seedConversation(
  client: PoolClient,
  ws: string,
  channelId: number,
  status: string,
) {
  convSeq += 1;
  await client.query(
    `INSERT INTO inbox_conversations
       (workspace_id, channel_id, platform, kind, thread_key, status,
        unread_count, last_message_at, last_snippet, search_text, later_until_reply)
     VALUES ($1, $2, 'instagram', 'dm', $3, $4, 1, $5, 'hi', '', false)`,
    [ws, channelId, `${channelId}:c${convSeq}`, status, ago(convSeq / 100)],
  );
}

const noRedis: RefreshLimitStore = {
  pttl: async () => -2,
  get: async () => null,
};

function build(db: DbType, redis: RefreshLimitStore = noRedis) {
  const perf = new PostPerformanceRepository(db);
  const insights = new InsightsService(db, perf);
  const svc = new ChannelPageService(
    db,
    insights,
    new BestTimesService(db, perf, new PlannerPreferencesService(db)),
    new ConversationListService(db, new ConversationPresenter(db)),
    redis,
  );
  return { svc, insights };
}

describeDb('ChannelPageService (database)', () => {
  it('composes the overview of one channel', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client, {
        timezone: TZ,
      });
      const ig = await seedChannel(client, ws, 'instagram', {
        accountName: 'Daybreak Coffee Roasters',
      });
      const other = await seedChannel(client, ws, 'bluesky');
      await client.query(
        `UPDATE social_media_channels SET nickname = 'Daybreak', show_in_sidebar = true WHERE id = $1`,
        [ig],
      );
      const IG = (over: Record<string, unknown> = {}) => ({
        channelId: String(ig),
        platform: 'instagram',
        status: 'draft',
        ...over,
      });

      // KPIs: two posts in the last 30 days, one in the 30 before.
      const a = await seedPost(client, ws, ownerId, {
        status: 'published',
        publishedAt: ago(5),
        targets: [IG({ status: 'published' })],
      });
      await seedSnapshot(client, a, ig, {
        likes: 30,
        impressions: 1000,
        reach: 800,
      });
      const b = await seedPost(client, ws, ownerId, {
        status: 'published',
        publishedAt: ago(10),
        targets: [IG({ publishStatus: 'published' })],
      });
      await seedSnapshot(client, b, ig, {
        likes: 70,
        impressions: 1000,
        reach: 500,
      });
      const older = await seedPost(client, ws, ownerId, {
        status: 'published',
        publishedAt: ago(40),
        targets: [IG({ status: 'published' })],
      });
      await seedSnapshot(client, older, ig, {
        likes: 5,
        impressions: 100,
        reach: 90,
      });

      // The week, on the workspace clock. Today's times are 06:00+ UTC on a
      // date no earlier than UTC today (Karachi is ahead), so they never fall
      // in the KPI window, which ends yesterday UTC.
      const sentToday = await seedPost(client, ws, ownerId, {
        status: 'published',
        publishedAt: local(0, '12:00'),
        targets: [IG({ status: 'published' })],
        mediaItems: [{ url: 'https://cdn/p.jpg', type: 'image' }],
      });
      const heldToday = await seedPost(client, ws, ownerId, {
        status: 'scheduled',
        scheduledAt: local(0, '11:00'),
        targets: [IG({ heldAt: local(0, '11:00').toISOString() })],
      });
      const reel = await seedPost(client, ws, ownerId, {
        status: 'scheduled',
        scheduledAt: local(3, '19:00'),
        targets: [IG()],
        mediaItems: [
          {
            url: 'https://cdn/v.mp4',
            type: 'video',
            thumbnailUrl: 'https://cdn/v.jpg',
          },
        ],
        platformContent: {
          instagram: { platformSpecific: { postType: 'reel' } },
        },
      });
      const failed = await seedPost(client, ws, ownerId, {
        status: 'failed',
        scheduledAt: local(1, '09:00'),
        targets: [IG({ publishStatus: 'failed' })],
      });
      // Outside the week, on another channel, or a draft: never listed.
      await seedPost(client, ws, ownerId, {
        status: 'scheduled',
        scheduledAt: local(7, '00:00'),
        targets: [IG()],
      });
      await seedPost(client, ws, ownerId, {
        status: 'scheduled',
        scheduledAt: local(-1, '23:59'),
        targets: [IG()],
      });
      await seedPost(client, ws, ownerId, {
        status: 'scheduled',
        scheduledAt: local(2, '10:00'),
        targets: [{ channelId: String(other), platform: 'bluesky' }],
      });
      await seedPost(client, ws, ownerId, {
        status: 'draft',
        scheduledAt: local(2, '10:00'),
        targets: [IG()],
      });

      // Needs reply: 5 waiting on this channel; done and other channels not.
      for (let i = 0; i < 5; i++)
        await seedConversation(client, ws, ig, 'to_reply');
      await seedConversation(client, ws, ig, 'done');
      await seedConversation(client, ws, other, 'to_reply');

      const { svc, insights } = build(db);
      const page = await svc.getPage(ws, ig, ownerId, NOW);

      expect(page.channel).toMatchObject({
        id: ig,
        accountName: 'Daybreak Coffee Roasters',
        nickname: 'Daybreak',
        displayName: 'Daybreak',
        showInSidebar: true,
        health: { kind: 'ok' },
        refresh: { nextAllowedAt: null },
      });
      expect(page.channel.connectedAt).toBe(
        new Date(page.channel.createdAt).toISOString(),
      );
      expect(page.channel).not.toHaveProperty('accessToken');

      // KPIs, against the previous 30 days.
      expect(page.kpis.postsSent).toMatchObject({ value: 2, delta: 1 });
      expect(page.kpis.reach).toMatchObject({ value: 1300 });
      expect(page.kpis.engagementRate.value).toBe(5); // 100 / 2000
      expect(page.kpis.comparable).toBe(true);
      for (const s of [
        page.kpis.postsSent.series,
        page.kpis.reach!.series,
        page.kpis.engagementRate.series,
      ]) {
        expect(s).toHaveLength(30);
      }
      expect(page.kpis.postsSent.series.reduce((x, y) => x + y, 0)).toBe(2);
      expect(page.kpis.reach!.series.reduce((x, y) => x + y, 0)).toBe(1300);

      // Best posts: this channel's, most engagements first.
      expect(page.bestPosts.map((p) => p.postId)).toEqual([b, a]);
      // The tip is exactly the channel's first next step.
      const signals = await insights.signals(ws, ownerId, String(ig), NOW);
      expect(page.tip).toEqual(signals.nextSteps[0] ?? null);

      // The week: today and six more days, on the Karachi clock.
      expect(page.week.timezone).toBe(TZ);
      expect(page.week.from).toBe(TODAY);
      expect(page.week.to).toBe(addDays(TODAY, 6));
      expect(page.week.days.map((d) => d.date)).toEqual(
        Array.from({ length: 7 }, (_, i) => addDays(TODAY, i)),
      );
      // Fewer than 15 measured posts: general times, so no "Best at".
      expect(page.week.days.every((d) => d.bestHour === null)).toBe(true);
      const byDay = Object.fromEntries(
        page.week.days.map((d) => [d.date, d.posts]),
      );
      expect(byDay[TODAY]).toEqual([
        {
          postId: heldToday,
          at: local(0, '11:00').toISOString(),
          status: 'scheduled',
          heldAt: local(0, '11:00').toISOString(),
          format: 'text',
          thumbnailUrl: null,
        },
        {
          postId: sentToday,
          at: local(0, '12:00').toISOString(),
          status: 'published',
          heldAt: null,
          format: 'image',
          thumbnailUrl: 'https://cdn/p.jpg',
        },
      ]);
      expect(byDay[addDays(TODAY, 1)]).toMatchObject([
        { postId: failed, status: 'failed' },
      ]);
      expect(byDay[addDays(TODAY, 3)]).toEqual([
        expect.objectContaining({
          postId: reel,
          format: 'reel',
          thumbnailUrl: 'https://cdn/v.jpg',
        }),
      ]);
      expect(page.week.days.flatMap((d) => d.posts)).toHaveLength(4);

      expect(page.needsReply?.total).toBe(5);
      expect(page.needsReply?.rows).toHaveLength(4);
      expect(page.needsReply?.rows.every((r) => r.channelId === ig)).toBe(true);
    }));

  it('reach is not reported where the platform has none; no inbox is null', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const li = await seedChannel(client, ws, 'linkedin');
      const page = await build(db).svc.getPage(ws, li, ownerId, NOW);
      expect(page.kpis.reach).toBeNull();
      expect(page.kpis.comparable).toBe(false);
      expect(page.kpis.postsSent).toMatchObject({ value: 0 });
      expect(page.needsReply).toBeNull();
      expect(page.bestPosts).toEqual([]);
    }));

  it('a broken channel says since when; the refresh lock comes from Redis', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ig = await seedChannel(client, ws, 'instagram');
      const erroredAt = ago(2);
      await client.query(
        `UPDATE social_media_channels
            SET connection_status = 'expired', last_error = 'Token expired', last_error_at = $2
          WHERE id = $1`,
        // As drizzle writes a `timestamp` (no zone): the UTC wall clock.
        [ig, erroredAt.toISOString()],
      );
      const locked: RefreshLimitStore = {
        pttl: async (key) =>
          key === `refresh-limit:channel:${ig}` ? 30 * 60 * 1000 : -2,
        get: async () => null,
      };
      const page = await build(db, locked).svc.getPage(ws, ig, ownerId, NOW);
      expect(page.channel.health).toEqual({
        kind: 'reconnect',
        reason: 'Token expired',
        since: erroredAt.toISOString(),
      });
      expect(page.channel.refresh.nextAllowedAt).toBe(
        new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
      );

      const capped: RefreshLimitStore = {
        pttl: async () => -2,
        get: async (key) =>
          key.startsWith(`refresh-limit:workspace:${ws}:`) ? '50' : null,
      };
      const capPage = await build(db, capped).svc.getPage(ws, ig, ownerId, NOW);
      expect(capPage.channel.refresh.nextAllowedAt).toBe(
        `${addDays(NOW.toISOString().slice(0, 10), 1)}T00:00:00.000Z`,
      );

      const down: RefreshLimitStore = {
        pttl: async () => {
          throw new Error('ECONNREFUSED');
        },
        get: async () => null,
      };
      const downPage = await build(db, down).svc.getPage(ws, ig, ownerId, NOW);
      expect(downPage.channel.refresh.nextAllowedAt).toBeNull();
    }));

  it('another workspace’s channel is a 404', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const mine = await seedWorkspace(client);
      const theirs = await seedWorkspace(client);
      const foreign = await seedChannel(
        client,
        theirs.workspaceId,
        'instagram',
      );
      await expect(
        build(db).svc.getPage(mine.workspaceId, foreign, mine.ownerId, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
    }));
});
