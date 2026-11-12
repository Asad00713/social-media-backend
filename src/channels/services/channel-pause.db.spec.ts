/* eslint-disable @typescript-eslint/require-await -- queue double */
import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { seedChannel, seedWorkspace } from '../../inbox/testing/inbox-db';
import { ChannelPauseService } from './channel-pause.service';

const MIGRATION = '0063_channel_pause_and_network_requests.sql';
const HOUR = 60 * 60 * 1000;

/** A BullMQ stand-in: remembers what was added and each job's state. */
function fakeQueue() {
  const states = new Map<string, string>();
  const added: Array<{
    data: unknown;
    opts: { jobId: string; delay: number };
  }> = [];
  return {
    states,
    added,
    getJob: async (id: string) =>
      states.has(id) ? { getState: async () => states.get(id)! } : undefined,
    add: async (
      _name: string,
      data: unknown,
      opts: { jobId: string; delay: number },
    ) => {
      added.push({ data, opts });
      states.set(opts.jobId, opts.delay > 0 ? 'delayed' : 'waiting');
      return { id: opts.jobId };
    },
  };
}

async function seedPost(
  client: PoolClient,
  ws: string,
  userId: string,
  targets: unknown[],
  opts: { status?: string; scheduledAt?: Date; jobId?: string | null } = {},
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, scheduled_at, job_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
    [
      ws,
      userId,
      opts.status ?? 'scheduled',
      JSON.stringify(targets),
      opts.scheduledAt ?? new Date(Date.now() + HOUR),
      opts.jobId ?? null,
    ],
  );
  return r.rows[0].id;
}

const draft = (channelId: number, extra: Record<string, unknown> = {}) => ({
  channelId: String(channelId),
  platform: 'bluesky',
  status: 'draft',
  ...extra,
});
const held = (channelId: number) =>
  draft(channelId, {
    heldAt: new Date(Date.now() - HOUR).toISOString(),
    heldReason: 'channel_paused',
  });

describeDb('ChannelPauseService (database)', () => {
  it('pause stamps when and who, counts the waiting posts, and is idempotent', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const other = await seedChannel(client, ws, 'mastodon');
      await seedPost(client, ws, ownerId, [draft(ch), draft(other)]);
      await seedPost(client, ws, ownerId, [draft(ch)]);
      // Not counted: already out, failed, a draft post, another channel.
      await seedPost(client, ws, ownerId, [
        draft(ch, { status: 'published' }),
        draft(other),
      ]);
      await seedPost(client, ws, ownerId, [
        draft(ch, { publishStatus: 'failed' }),
      ]);
      await seedPost(client, ws, ownerId, [draft(ch)], { status: 'draft' });

      const svc = new ChannelPauseService(db, fakeQueue() as never);
      const first = await svc.pause(ws, ch, ownerId);
      expect(first.heldCount).toBe(2);
      expect(first.pausedBy).toEqual({ id: ownerId, name: 'Owner' });

      const row = await client.query<{
        paused_by_user_id: string | null;
        is_active: boolean;
      }>(
        `SELECT paused_by_user_id, is_active FROM social_media_channels WHERE id = $1`,
        [ch],
      );
      expect(row.rows[0].paused_by_user_id).toBe(ownerId);
      // Never the plan lock.
      expect(row.rows[0].is_active).toBe(true);

      const again = await svc.pause(ws, ch, ownerId);
      expect(again.pausedAt).toBe(first.pausedAt);
    }));

  it('a channel of another workspace is not found', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const ch = await seedChannel(client, b.workspaceId, 'bluesky');
      const svc = new ChannelPauseService(db, fakeQueue() as never);
      await expect(
        svc.pause(a.workspaceId, ch, a.ownerId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.resume(a.workspaceId, ch)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }));

  it('resume clears the pause and re-enqueues held posts: overdue now, future at their time', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const queue = fakeQueue();
      const svc = new ChannelPauseService(db, queue as never);
      await svc.pause(ws, ch, ownerId);

      const overdue = await seedPost(client, ws, ownerId, [held(ch)], {
        scheduledAt: new Date(Date.now() - 2 * HOUR),
        jobId: 'post-old-1',
      });
      const future = await seedPost(client, ws, ownerId, [held(ch)], {
        scheduledAt: new Date(Date.now() + 2 * HOUR),
      });
      // Upcoming, not held: its own job is still waiting; left alone.
      await seedPost(client, ws, ownerId, [draft(ch)]);
      queue.states.set('post-old-1', 'completed');

      const res = await svc.resume(ws, ch);
      expect(res).toEqual({ resumedCount: 3 });

      const row = await client.query(
        `SELECT paused_at, paused_by_user_id FROM social_media_channels WHERE id = $1`,
        [ch],
      );
      expect(row.rows[0]).toEqual({ paused_at: null, paused_by_user_id: null });

      expect(queue.added).toHaveLength(2);
      const byPost = new Map(
        queue.added.map((a) => [(a.data as { postId: string }).postId, a]),
      );
      expect(byPost.get(overdue)?.opts.delay).toBe(0);
      expect(byPost.get(overdue)?.data).toEqual({
        postId: overdue,
        heldOnly: true,
      });
      const futureDelay = byPost.get(future)?.opts.delay ?? 0;
      expect(futureDelay).toBeGreaterThan(HOUR);
      expect(futureDelay).toBeLessThanOrEqual(2 * HOUR);

      // The rows now name the new jobs, so the processor runs them.
      const jobs = await client.query<{ id: string; job_id: string }>(
        `SELECT id, job_id FROM posts WHERE id = ANY($1::uuid[])`,
        [[overdue, future]],
      );
      for (const j of jobs.rows) {
        expect(j.job_id).toBe(byPost.get(j.id)?.opts.jobId);
        expect(j.job_id).not.toContain(':');
      }
    }));

  it('resume twice enqueues nothing the second time', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const queue = fakeQueue();
      const svc = new ChannelPauseService(db, queue as never);
      await svc.pause(ws, ch, ownerId);
      await seedPost(client, ws, ownerId, [held(ch)], {
        scheduledAt: new Date(Date.now() - HOUR),
      });

      await svc.resume(ws, ch);
      await svc.resume(ws, ch);
      expect(queue.added).toHaveLength(1);

      // Once its job has run and the post is held again (paused once more),
      // a later resume enqueues it again.
      for (const id of queue.states.keys()) queue.states.set(id, 'completed');
      await svc.resume(ws, ch);
      expect(queue.added).toHaveLength(2);
    }));

  it('ignores held targets of other channels and of posts no longer scheduled', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const other = await seedChannel(client, ws, 'mastodon');
      await seedPost(client, ws, ownerId, [held(other)]);
      await seedPost(client, ws, ownerId, [held(ch)], { status: 'draft' });
      const queue = fakeQueue();
      const svc = new ChannelPauseService(db, queue as never);
      expect(await svc.heldPostsOf(ws, ch)).toEqual([]);
      await svc.resume(ws, ch);
      expect(queue.added).toHaveLength(0);
    }));

  it('a deleted pauser leaves the pause in place with nobody named', () =>
    withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const u = await client.query<{ id: string }>(
        `INSERT INTO users (email, name) VALUES ('pauser-${ch}@example.test', 'P') RETURNING id`,
      );
      const svc = new ChannelPauseService(db, fakeQueue() as never);
      await svc.pause(ws, ch, u.rows[0].id);
      await client.query(`DELETE FROM users WHERE id = $1`, [u.rows[0].id]);
      const again = await svc.pause(ws, ch, ownerId);
      expect(again.pausedBy).toBeNull();
      expect(again.pausedAt).toBeTruthy();
    }));
});
