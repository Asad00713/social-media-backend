import type { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { seedChannel, seedWorkspace } from '../inbox/testing/inbox-db';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { utcToWallClock, wallClockToUtc } from '../common/utils/wall-clock';
import { PostRescheduleService } from '../posts/services/post-reschedule.service';
import {
  TZ_MOVE_INLINE_LIMIT,
  WorkspaceTimezoneMoveService,
  type TimezoneMoveJob,
} from './workspace-timezone-move.service';
import { WorkspaceService } from './workspace.service';

// 0089 adds the workspace columns `update` writes and returns. The harness
// applies each file twice, so it must stay idempotent.
const MIGRATIONS = ['0089_workspace_settings.sql'];

// 09:00 in Karachi (UTC+5) and in New York (EST, UTC-5) on a January day.
const KARACHI_9AM = new Date('2027-01-15T04:00:00Z');
const NEW_YORK_9AM = new Date('2027-01-15T14:00:00Z');

interface AddCall {
  name: string;
  data: unknown;
  opts: { jobId: string; delay?: number; attempts?: number };
}

/**
 * BullMQ faked: `getJob` finds a removable job for any id (finished, for the
 * tz-move id), `add` records. `lockedJobs` cannot be removed, as a job that
 * is running cannot.
 */
function fakeQueue(lockedJobs: string[] = [], state = 'completed') {
  const removed: string[] = [];
  const added: AddCall[] = [];
  const queue = {
    getJob: jest.fn((id: string) =>
      Promise.resolve({
        remove: jest.fn(() => {
          if (lockedJobs.includes(id)) {
            return Promise.reject(new Error(`job ${id} is locked`));
          }
          removed.push(id);
          return Promise.resolve();
        }),
        getState: jest.fn(() => Promise.resolve(state)),
      }),
    ),
    add: jest.fn((name: string, data: unknown, opts: AddCall['opts']) => {
      added.push({ name, data, opts });
      return Promise.resolve({ id: opts.jobId });
    }),
  };
  return { queue, removed, added };
}

function makeServices(
  db: never,
  opts: { lockedJobs?: string[]; moveJobState?: string } = {},
) {
  const publishing = fakeQueue(opts.lockedJobs);
  const moveQueue = fakeQueue([], opts.moveJobState);
  const reschedule = new PostRescheduleService(db, publishing.queue as never);
  const moves = new WorkspaceTimezoneMoveService(
    db,
    reschedule,
    moveQueue.queue as never,
  );
  // Never reached: no case here saves a logo.
  const r2 = new CloudflareR2Service({
    get: (name: string, fallback?: string) =>
      ({
        CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
        CLOUDFLARE_R2_ACCESS_KEY_ID: 'key',
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
        CLOUDFLARE_R2_BUCKET: 'bucket',
        CLOUDFLARE_R2_PUBLIC_URL: 'https://cdn.test',
      })[name] ?? fallback,
  } as unknown as ConfigService);
  const workspaces = new WorkspaceService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    r2,
    moves,
  );
  return { moves, workspaces, publishing, moveQueue };
}

async function setChannelZone(
  client: PoolClient,
  channelId: number,
  zone: string,
): Promise<void> {
  await client.query(
    `UPDATE social_media_channels SET timezone = $2 WHERE id = $1`,
    [channelId, zone],
  );
}

async function seedPost(
  client: PoolClient,
  ws: string,
  p: {
    status: string;
    channelId: number;
    scheduledAt: Date | null;
    jobId?: string | null;
    held?: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const target: Record<string, unknown> = {
    channelId: String(p.channelId),
    platform: 'twitter',
    status: p.status,
  };
  if (p.held) {
    target.heldAt = '2027-01-01T00:00:00.000Z';
    target.heldReason = 'channel_paused';
  }
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, scheduled_at, job_id, metadata)
     SELECT $1, w.owner_id, $2, $3::jsonb, $4, $5, $6::jsonb FROM workspace w WHERE w.id = $1
     RETURNING id`,
    [
      ws,
      p.status,
      JSON.stringify([target]),
      p.scheduledAt,
      p.jobId ?? null,
      JSON.stringify(p.metadata ?? {}),
    ],
  );
  return r.rows[0].id;
}

/** A bulk campaign with one slot whose materialised post is `postId`. */
async function seedCampaignSlot(
  client: PoolClient,
  ws: string,
  channelId: number,
  postId: string,
): Promise<void> {
  const c = await client.query<{ id: string }>(
    `INSERT INTO campaigns (workspace_id, created_by_id, name, type, status, schedule, channel_ids)
     SELECT $1, w.owner_id, 'Launch', 'bulk', 'active', $2::jsonb, $3::jsonb
       FROM workspace w WHERE w.id = $1 RETURNING id`,
    [
      ws,
      JSON.stringify({
        type: 'bulk',
        startDate: '2027-01-15',
        endDate: '2027-01-15',
        defaultTime: '09:00',
        timezone: 'Asia/Karachi',
        blackoutDates: [],
        skipWeekends: false,
      }),
      JSON.stringify([String(channelId)]),
    ],
  );
  await client.query(
    `INSERT INTO campaign_slot_content
       (campaign_id, date, channel_id, time, content, slot_status, scheduled_at, post_id)
     VALUES ($1, '2027-01-15', $2, '09:00', $3::jsonb, 'scheduled', $4, $5)`,
    [
      c.rows[0].id,
      String(channelId),
      JSON.stringify({
        mode: 'manual',
        postType: 'post',
        caption: 'hello',
        media: [],
        threadParts: [],
        templateIds: [],
      }),
      KARACHI_9AM,
      postId,
    ],
  );
}

async function postRow(client: PoolClient, id: string) {
  const r = await client.query<{
    scheduled_at: Date | null;
    job_id: string | null;
  }>(`SELECT scheduled_at, job_id FROM posts WHERE id = $1`, [id]);
  return r.rows[0];
}

async function channelZones(client: PoolClient, ws: string) {
  const r = await client.query<{ timezone: string }>(
    `SELECT timezone FROM social_media_channels WHERE workspace_id = $1 ORDER BY id`,
    [ws],
  );
  return r.rows.map((x) => x.timezone);
}

async function karachiWorkspace(client: PoolClient) {
  const { workspaceId: ws } = await seedWorkspace(client, {
    timezone: 'Asia/Karachi',
  });
  const channel = await seedChannel(client, ws, 'twitter');
  await setChannelZone(client, channel, 'Asia/Karachi');
  return { ws, channel };
}

/** `count` scheduled posts at 09:00 Karachi on `channel`. */
async function seedMany(
  client: PoolClient,
  ws: string,
  channel: number,
  count: number,
): Promise<void> {
  await client.query(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, scheduled_at)
     SELECT $1, w.owner_id, 'scheduled', $2::jsonb, $3
       FROM workspace w, generate_series(1, $4) WHERE w.id = $1`,
    [
      ws,
      JSON.stringify([
        {
          channelId: String(channel),
          platform: 'twitter',
          status: 'scheduled',
        },
      ]),
      KARACHI_9AM,
      count,
    ],
  );
}

function expectNoColonJobIds(...queues: { added: AddCall[] }[]): void {
  for (const q of queues) {
    for (const call of q.added) expect(call.opts.jobId).not.toContain(':');
  }
}

describeDb('WorkspaceTimezoneMoveService (database)', () => {
  it('moves both channels and keeps the scheduled post at 09:00 local; drafts, published and held posts stay', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client, {
        timezone: 'Asia/Karachi',
      });
      const karachi = await seedChannel(client, ws, 'twitter');
      const paris = await seedChannel(client, ws, 'twitter');
      await setChannelZone(client, karachi, 'Asia/Karachi');
      await setChannelZone(client, paris, 'Europe/Paris');

      const scheduled = await seedPost(client, ws, {
        status: 'scheduled',
        channelId: karachi,
        scheduledAt: KARACHI_9AM,
        jobId: 'post-legacy-job',
      });
      const draft = await seedPost(client, ws, {
        status: 'draft',
        channelId: karachi,
        scheduledAt: KARACHI_9AM,
      });
      const published = await seedPost(client, ws, {
        status: 'published',
        channelId: karachi,
        scheduledAt: KARACHI_9AM,
      });
      const held = await seedPost(client, ws, {
        status: 'scheduled',
        channelId: karachi,
        scheduledAt: KARACHI_9AM,
        held: true,
      });
      const { moves, publishing } = makeServices(db as never);

      const before = Date.now();
      const result = await moves.moveExisting(
        ws,
        'Asia/Karachi',
        'America/New_York',
      );

      expect(result).toEqual({
        movedChannels: 2,
        rescheduledPosts: 1,
        queued: false,
        unmovedPosts: 0,
      });
      expect(await channelZones(client, ws)).toEqual([
        'America/New_York',
        'America/New_York',
      ]);

      const moved = await postRow(client, scheduled);
      expect(moved.scheduled_at).toEqual(NEW_YORK_9AM);
      expect(moved.job_id).toBe(`composer-publish-${scheduled}`);
      // The composer's job and the one the row named are both removed.
      expect(publishing.removed).toEqual(
        expect.arrayContaining([
          `composer-publish-${scheduled}`,
          'post-legacy-job',
        ]),
      );
      expect(publishing.added).toHaveLength(1);
      const [call] = publishing.added;
      expect(call.name).toBe('publish');
      expect(call.data).toEqual({ postId: scheduled });
      expect(call.opts.jobId).toBe(`composer-publish-${scheduled}`);
      expect(call.opts.attempts).toBe(3);
      const expectedDelay = NEW_YORK_9AM.getTime() - before;
      expect(call.opts.delay).toBeLessThanOrEqual(expectedDelay);
      expect(call.opts.delay).toBeGreaterThan(expectedDelay - 60_000);

      for (const id of [draft, published, held]) {
        expect((await postRow(client, id)).scheduled_at).toEqual(KARACHI_9AM);
      }
      expectNoColonJobIds(publishing);
    });
  });

  it('never moves a campaign post: a slot post or one carrying metadata.campaignId', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, channel } = await karachiWorkspace(client);
      const slotPost = await seedPost(client, ws, {
        status: 'scheduled',
        channelId: channel,
        scheduledAt: KARACHI_9AM,
        jobId: 'campaign-job-1',
      });
      await seedCampaignSlot(client, ws, channel, slotPost);
      // How an evergreen occurrence materialises: no slot row, the mark only.
      const evergreenPost = await seedPost(client, ws, {
        status: 'scheduled',
        channelId: channel,
        scheduledAt: KARACHI_9AM,
        metadata: { campaignId: '00000000-0000-4000-8000-000000000001' },
      });
      const { moves, publishing } = makeServices(db as never);

      const result = await moves.moveExisting(
        ws,
        'Asia/Karachi',
        'America/New_York',
      );

      expect(result).toEqual({
        movedChannels: 1,
        rescheduledPosts: 0,
        queued: false,
        unmovedPosts: 0,
      });
      for (const id of [slotPost, evergreenPost]) {
        expect((await postRow(client, id)).scheduled_at).toEqual(KARACHI_9AM);
      }
      expect((await postRow(client, slotPost)).job_id).toBe('campaign-job-1');
      expect(publishing.added).toHaveLength(0);
      expect(publishing.removed).toHaveLength(0);
    });
  });

  it('a post whose new instant is already past is set to now and published at once', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, channel } = await karachiWorkspace(client);
      // A Karachi time whose wall-clock, read in New York, was five minutes
      // ago. Built from "now" so it never goes stale.
      const now = new Date();
      const wall = utcToWallClock(
        new Date(now.getTime() - 5 * 60_000),
        'America/New_York',
      );
      const karachiSameWall = wallClockToUtc(
        wall.date,
        wall.time,
        'Asia/Karachi',
      )!;
      const post = await seedPost(client, ws, {
        status: 'scheduled',
        channelId: channel,
        scheduledAt: karachiSameWall,
      });
      const { moves, publishing } = makeServices(db as never);

      const result = await moves.moveExisting(
        ws,
        'Asia/Karachi',
        'America/New_York',
      );

      expect(result.rescheduledPosts).toBe(1);
      const row = await postRow(client, post);
      expect(row.scheduled_at!.getTime()).toBeGreaterThanOrEqual(
        now.getTime() - 1000,
      );
      expect(row.scheduled_at!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(publishing.added[0].opts.delay).toBe(0);
      expectNoColonJobIds(publishing);
    });
  });

  it('a post whose old job cannot be removed stays on its old time and is reported unmoved', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, channel } = await karachiWorkspace(client);
      const stuck = await seedPost(client, ws, {
        status: 'scheduled',
        channelId: channel,
        scheduledAt: KARACHI_9AM,
        jobId: 'composer-publish-x',
      });
      const fine = await seedPost(client, ws, {
        status: 'scheduled',
        channelId: channel,
        scheduledAt: KARACHI_9AM,
      });
      const { moves, publishing } = makeServices(db as never, {
        lockedJobs: [`composer-publish-${stuck}`],
      });

      const result = await moves.moveExisting(
        ws,
        'Asia/Karachi',
        'America/New_York',
      );

      expect(result).toEqual({
        movedChannels: 1,
        rescheduledPosts: 1,
        queued: false,
        unmovedPosts: 1,
      });
      // Row and job agree: the old job still fires at the old time.
      expect((await postRow(client, stuck)).scheduled_at).toEqual(KARACHI_9AM);
      expect((await postRow(client, fine)).scheduled_at).toEqual(NEW_YORK_9AM);
      expect(publishing.added.map((c) => c.opts.jobId)).toEqual([
        `composer-publish-${fine}`,
      ]);
    });
  });

  it('update with the flag saves nothing on 409 while the last move is still queued', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, channel } = await karachiWorkspace(client);
      const post = await seedPost(client, ws, {
        status: 'scheduled',
        channelId: channel,
        scheduledAt: KARACHI_9AM,
      });
      const { workspaces, publishing } = makeServices(db as never, {
        moveJobState: 'active',
      });

      const err = await workspaces
        .update(ws, {
          name: 'Renamed',
          timezone: 'America/New_York',
          applyTimezoneToChannels: true,
        })
        .catch((e: unknown) => e);

      expect((err as { getStatus?: () => number }).getStatus?.()).toBe(409);
      const row = await client.query<{ name: string; timezone: string }>(
        `SELECT name, timezone FROM workspace WHERE id = $1`,
        [ws],
      );
      expect(row.rows[0]).toEqual({
        name: 'Inbox WS',
        timezone: 'Asia/Karachi',
      });
      expect(await channelZones(client, ws)).toEqual(['Asia/Karachi']);
      expect((await postRow(client, post)).scheduled_at).toEqual(KARACHI_9AM);
      expect(publishing.added).toHaveLength(0);
    });
  });

  it('update returns timezoneMove with the flag and leaves channels alone without it', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws } = await karachiWorkspace(client);
      const { workspaces, publishing } = makeServices(db as never);

      const plain = await workspaces.update(ws, { timezone: 'Europe/Paris' });
      expect(plain.timezoneMove).toBeNull();
      expect(await channelZones(client, ws)).toEqual(['Asia/Karachi']);

      const withMove = await workspaces.update(ws, {
        timezone: 'America/New_York',
        applyTimezoneToChannels: true,
      });
      expect(withMove.workspace.timezone).toBe('America/New_York');
      expect(withMove.timezoneMove).toEqual({
        movedChannels: 1,
        rescheduledPosts: 0,
        queued: false,
        unmovedPosts: 0,
      });
      expect(await channelZones(client, ws)).toEqual(['America/New_York']);
      expectNoColonJobIds(publishing);
    });
  });

  it(`exactly ${TZ_MOVE_INLINE_LIMIT} posts still move inline`, async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, channel } = await karachiWorkspace(client);
      await seedMany(client, ws, channel, TZ_MOVE_INLINE_LIMIT);
      const { moves, moveQueue } = makeServices(db as never);

      const result = await moves.moveExisting(
        ws,
        'Asia/Karachi',
        'America/New_York',
      );

      expect(result).toMatchObject({
        rescheduledPosts: TZ_MOVE_INLINE_LIMIT,
        queued: false,
      });
      expect(moveQueue.added).toHaveLength(0);
    });
  });

  it(`above ${TZ_MOVE_INLINE_LIMIT} posts the channels move inline and the queued plan moves the posts, once`, async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, channel } = await karachiWorkspace(client);
      const total = TZ_MOVE_INLINE_LIMIT + 1;
      await seedMany(client, ws, channel, total);
      const { moves, publishing, moveQueue } = makeServices(db as never);

      const result = await moves.moveExisting(
        ws,
        'Asia/Karachi',
        'America/New_York',
      );

      expect(result).toEqual({
        movedChannels: 1,
        rescheduledPosts: total,
        queued: true,
        unmovedPosts: 0,
      });
      expect(await channelZones(client, ws)).toEqual(['America/New_York']);
      // Nothing moved yet: the job carries the plan.
      const untouched = await client.query(
        `SELECT 1 FROM posts WHERE workspace_id = $1 AND scheduled_at = $2`,
        [ws, KARACHI_9AM],
      );
      expect(untouched.rowCount).toBe(total);
      expect(publishing.added).toHaveLength(0);
      // The finished job left by an earlier move is removed, freeing the id.
      expect(moveQueue.removed).toEqual([`tz-move-${ws}`]);
      expect(moveQueue.added).toHaveLength(1);
      const job = moveQueue.added[0];
      expect(job.opts).toMatchObject({
        jobId: `tz-move-${ws}`,
        attempts: 3,
        backoff: { type: 'exponential' },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      });
      const data = job.data as TimezoneMoveJob;
      expect(data).toMatchObject({
        workspaceId: ws,
        fromZone: 'Asia/Karachi',
        toZone: 'America/New_York',
        channelZones: { [String(channel)]: 'Asia/Karachi' },
      });
      expect(data.posts).toHaveLength(total);
      expect(data.posts[0]).toMatchObject({
        from: KARACHI_9AM.toISOString(),
        to: NEW_YORK_9AM.toISOString(),
      });

      // Someone re-times one post before the job runs: it is left alone.
      const retimed = data.posts[0].id;
      const theirs = new Date('2027-02-01T12:00:00Z');
      await client.query(`UPDATE posts SET scheduled_at = $2 WHERE id = $1`, [
        retimed,
        theirs,
      ]);

      // What the processor runs; a retry must not shift the posts again.
      expect(await moves.processQueued(data)).toBe(total - 1);
      expect(await moves.processQueued(data)).toBe(total - 1);

      const times = await client.query<{ scheduled_at: Date; n: string }>(
        `SELECT scheduled_at, count(*) AS n FROM posts
          WHERE workspace_id = $1 AND id <> $2 GROUP BY 1`,
        [ws, retimed],
      );
      expect(times.rows).toEqual([
        { scheduled_at: NEW_YORK_9AM, n: String(total - 1) },
      ]);
      expect((await postRow(client, retimed)).scheduled_at).toEqual(theirs);
      expect(publishing.added).toHaveLength((total - 1) * 2);
      expect(publishing.added.some((c) => c.opts.jobId.endsWith(retimed))).toBe(
        false,
      );
      expectNoColonJobIds(publishing, moveQueue);
    });
  });

  it('the queued job puts a post whose job did not move back on its old time, then throws to retry', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, channel } = await karachiWorkspace(client);
      await seedMany(client, ws, channel, TZ_MOVE_INLINE_LIMIT + 1);
      const first = makeServices(db as never);
      await first.moves.moveExisting(ws, 'Asia/Karachi', 'America/New_York');
      const data = first.moveQueue.added[0].data as TimezoneMoveJob;
      const stuck = data.posts[0].id;

      const attempt = makeServices(db as never, {
        lockedJobs: [`composer-publish-${stuck}`],
      });
      await expect(attempt.moves.processQueued(data)).rejects.toThrow('1 of');
      expect((await postRow(client, stuck)).scheduled_at).toEqual(KARACHI_9AM);

      // The retry, with the job free again, moves it.
      const retry = makeServices(db as never);
      await retry.moves.processQueued(data);
      expect((await postRow(client, stuck)).scheduled_at).toEqual(NEW_YORK_9AM);
    });
  });
});
