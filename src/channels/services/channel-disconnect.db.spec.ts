/* eslint-disable @typescript-eslint/require-await -- service doubles */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb, type DbType } from '../../planner/testing/rollback-db';
import { seedChannel, seedWorkspace } from '../../inbox/testing/inbox-db';
import { ChannelPauseService } from './channel-pause.service';
import {
  ChannelDisconnectService,
  finalizeJobId,
} from './channel-disconnect.service';

// The local database may predate the channel migrations: replay them (and
// this stream's 0081) inside the rolled-back transaction.
const MIGRATIONS = [
  '0056_media_categories_created_by.sql',
  '0057_library_is_sample.sql',
  '0058_post_comments.sql',
  '0059_brand_kits.sql',
  '0060_insight_hidden_steps.sql',
  '0061_short_links.sql',
  '0062_channel_audience.sql',
  '0063_channel_pause_and_network_requests.sql',
  '0064_channel_nickname_sidebar.sql',
  '0065_release_locked_integrations.sql',
  '0066_insight_reports.sql',
  '0067_channel_connect_links.sql',
  '0081_channel_soft_disconnect.sql',
];
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A BullMQ stand-in: remembers jobs, their state, and removals. */
function fakeQueue() {
  const states = new Map<string, string>();
  const added: Array<{ name: string; data: any; opts: any }> = [];
  const removed: string[] = [];
  return {
    states,
    added,
    removed,
    getJob: async (id: string) =>
      states.has(id)
        ? {
            getState: async () => states.get(id)!,
            remove: async () => {
              removed.push(id);
              states.delete(id);
            },
          }
        : undefined,
    add: async (name: string, data: any, opts: any) => {
      added.push({ name, data, opts });
      states.set(opts.jobId, opts.delay > 0 ? 'delayed' : 'waiting');
      return { id: opts.jobId };
    },
  };
}

function make(
  db: DbType,
  client: PoolClient,
  opts: { limitReached?: boolean } = {},
) {
  const publishQueue = fakeQueue();
  const finalizeQueue = fakeQueue();
  const heldPosts = new ChannelPauseService(db, publishQueue as never);
  const channels = {
    releaseSlot: jest.fn(async () => undefined),
    readStoredAccessToken: (c: { accessToken: string | null }) =>
      c.accessToken ? `plain-${c.accessToken}` : null,
    readStoredRevokeToken: (c: { refreshToken: string | null }) =>
      c.refreshToken ? `refresh-${c.refreshToken}` : null,
    getAccessToken: jest.fn(async () => 'live-token'),
    deleteChannel: jest.fn(async (id: number) => {
      await client.query('DELETE FROM social_media_channels WHERE id = $1', [id]);
    }),
  };
  const postsCleanup = { removeUnpublished: jest.fn(async () => undefined) };
  const syncLifecycle = {
    onChannelDisconnected: jest.fn(async () => undefined),
    onChannelConnected: jest.fn(async () => undefined),
  };
  const googleRevoke = { revokeIfLastGoogleChannel: jest.fn(async () => undefined) };
  const deleteWebhook = jest.fn(async () => undefined);
  const telegram = { forToken: jest.fn(() => ({ deleteWebhook })) };
  const calendar = { teardown: jest.fn(async () => undefined) };
  const limit = Object.assign(new ConflictException('Channel limit reached'), {
    code: 'CHANNEL_LIMIT_REACHED',
  });
  const accountChannels = {
    ownerOf: jest.fn(async () => 'owner'),
    enforceWithinTransaction: jest.fn(async () => {
      if (opts.limitReached) throw limit;
    }),
  };
  const svc = new ChannelDisconnectService(
    db,
    channels as never,
    heldPosts,
    postsCleanup as never,
    syncLifecycle as never,
    googleRevoke as never,
    telegram as never,
    calendar as never,
    accountChannels as never,
    finalizeQueue as never,
  );
  return {
    svc,
    channels,
    postsCleanup,
    syncLifecycle,
    googleRevoke,
    telegram,
    deleteWebhook,
    accountChannels,
    publishQueue,
    finalizeQueue,
    limit,
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

async function channelRow(client: PoolClient, id: number) {
  const r = await client.query(
    `SELECT connection_status, disconnected_at, disconnected_by_user_id,
            status_before_disconnect, disconnect_finalized_at, access_token
       FROM social_media_channels WHERE id = $1`,
    [id],
  );
  return r.rows[0] as Record<string, any> | undefined;
}

async function targetsOf(client: PoolClient, postId: string): Promise<any[]> {
  const r = await client.query(`SELECT targets FROM posts WHERE id = $1`, [postId]);
  return r.rows[0].targets;
}

const t = (channelId: number, extra: Record<string, unknown> = {}) => ({
  channelId: String(channelId),
  platform: 'bluesky',
  status: 'draft',
  ...extra,
});

describeDb('ChannelDisconnectService (database)', () => {
  it('soft disconnect: keeps the row as history, frees the slot, pauses its posts, queues finalize', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const other = await seedChannel(client, ws, 'mastodon');
      const shared = await seedPost(client, ws, ownerId, [t(ch), t(other)]);
      const sent = await seedPost(client, ws, ownerId, [
        t(ch, { status: 'published' }),
      ]);
      const draft = await seedPost(client, ws, ownerId, [t(ch)], {
        status: 'draft',
      });
      const m = make(db, client);
      const now = new Date();

      const res = await m.svc.disconnect(ws, ch, ownerId, {}, now);

      expect(res).toEqual({
        outcome: 'disconnected',
        channelId: ch,
        restoreUntil: new Date(now.getTime() + 10 * MIN).toISOString(),
        historyKept: true,
        pausedCount: 1,
      });
      const row = await channelRow(client, ch);
      expect(row).toMatchObject({
        connection_status: 'disconnected',
        disconnected_by_user_id: ownerId,
        status_before_disconnect: 'connected',
        disconnect_finalized_at: null,
        access_token: 'x', // kept for the undo
      });
      expect(m.syncLifecycle.onChannelDisconnected).toHaveBeenCalledWith(ch);
      expect(m.channels.releaseSlot).toHaveBeenCalledWith(ws, ch);
      expect(m.postsCleanup.removeUnpublished).not.toHaveBeenCalled();

      const held = await targetsOf(client, shared);
      expect(held[0]).toMatchObject({
        heldReason: 'channel_disconnected',
        status: 'draft',
      });
      expect(held[1].heldAt).toBeUndefined(); // the other channel is untouched
      expect((await targetsOf(client, sent))[0].heldAt).toBeUndefined();
      expect((await targetsOf(client, draft))[0].heldAt).toBeUndefined();

      expect(m.finalizeQueue.added).toEqual([
        {
          name: 'finalize-disconnect',
          data: { channelId: ch, disconnectedAt: now.toISOString() },
          opts: expect.objectContaining({
            jobId: finalizeJobId(ch, now),
            delay: 10 * MIN,
          }),
        },
      ]);

      // A second disconnect changes nothing and queues nothing.
      const again = await m.svc.disconnect(
        ws,
        ch,
        ownerId,
        {},
        new Date(now.getTime() + MIN),
      );
      expect(again.outcome).toBe('disconnected');
      expect(m.finalizeQueue.added).toHaveLength(1);
      expect(m.channels.releaseSlot).toHaveBeenCalledTimes(1);
    }));

  it('the CHECK keeps the status and the marker together', () =>
    withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      await client.query('SAVEPOINT s');
      await expect(
        client.query(
          `UPDATE social_media_channels SET connection_status = 'disconnected' WHERE id = $1`,
          [ch],
        ),
      ).rejects.toThrow(/social_media_channels_disconnected_chk/);
      await client.query('ROLLBACK TO SAVEPOINT s');
    }));

  it('restore inside the window: status back, slot retaken, posts released, finalize job removed', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      await client.query(
        `UPDATE social_media_channels SET connection_status = 'expired' WHERE id = $1`,
        [ch],
      );
      const now = new Date();
      // Ahead, its job still waiting: the hold just comes off.
      const ahead = await seedPost(client, ws, ownerId, [t(ch)], {
        jobId: 'job-ahead',
        scheduledAt: new Date(now.getTime() + HOUR),
      });
      const m = make(db, client);
      m.publishQueue.states.set('job-ahead', 'delayed');
      await m.svc.disconnect(ws, ch, ownerId, {}, now);
      // Came due during the window: its job already ran and held it.
      const due = await seedPost(
        client,
        ws,
        ownerId,
        [t(ch, { heldAt: now.toISOString(), heldReason: 'channel_disconnected' })],
        { scheduledAt: new Date(now.getTime() + 2 * MIN) },
      );

      const res = await m.svc.restore(ws, ch, new Date(now.getTime() + 5 * MIN));

      expect(res).toMatchObject({
        channelId: ch,
        connectionStatus: 'expired', // what it had, not "connected"
        resumedCount: 2,
        overdueCount: 1,
        missedCount: 0,
      });
      expect(await channelRow(client, ch)).toMatchObject({
        connection_status: 'expired',
        disconnected_at: null,
        status_before_disconnect: null,
      });
      expect(m.accountChannels.enforceWithinTransaction).toHaveBeenCalled();
      expect(m.syncLifecycle.onChannelConnected).toHaveBeenCalledWith(ch, ws);
      expect(m.finalizeQueue.removed).toEqual([finalizeJobId(ch, now)]);
      expect((await targetsOf(client, ahead))[0].heldAt).toBeUndefined();
      // The overdue one is re-enqueued to go now (the pause-resume rule).
      const job = m.publishQueue.added.find((a) => a.data.postId === due);
      expect(job?.opts.delay).toBe(0);
      expect(job?.data.missedHeld).toBeUndefined();

      // Undo twice: the second finds it back and does nothing.
      const twice = await m.svc.restore(ws, ch);
      expect(twice.resumedCount).toBe(0);
    }));

  it('restore is refused after the window and at the channel limit', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const late = await seedChannel(client, ws, 'bluesky');
      const full = await seedChannel(client, ws, 'mastodon');
      const now = new Date();
      const m = make(db, client);
      await m.svc.disconnect(ws, late, ownerId, {}, new Date(now.getTime() - 11 * MIN));
      const err = await m.svc.restore(ws, late, now).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'RESTORE_WINDOW_CLOSED',
      });

      const capped = make(db, client, { limitReached: true });
      await capped.svc.disconnect(ws, full, ownerId, {}, now);
      await expect(capped.svc.restore(ws, full, now)).rejects.toBe(capped.limit);
      expect((await channelRow(client, full))!.connection_status).toBe(
        'disconnected',
      );
    }));

  it('finalize keeps the history and clears the tokens; idempotent; no undo after', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const bot = await seedChannel(client, ws, 'telegram');
      const now = new Date(Date.now() - 11 * MIN);
      const m = make(db, client);
      await m.svc.disconnect(ws, bot, ownerId, {}, now);

      expect(await m.svc.finalize(bot, now)).toBe('tokens-cleared');
      const row = await channelRow(client, bot);
      expect(row).toMatchObject({
        connection_status: 'disconnected',
        access_token: '',
      });
      expect(row!.disconnect_finalized_at).not.toBeNull();
      // The bot's webhook goes, with the token read before it was cleared.
      expect(m.telegram.forToken).toHaveBeenCalledWith('plain-x');
      expect(m.deleteWebhook).toHaveBeenCalledTimes(1);

      expect(await m.svc.finalize(bot, now)).toBe('already-finalized');
      expect(m.deleteWebhook).toHaveBeenCalledTimes(1);
      await expect(m.svc.restore(ws, bot)).rejects.toBeInstanceOf(
        ConflictException,
      );
    }));

  it('finalize is a no-op for a restored channel or an older disconnect', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const m = make(db, client);
      const first = new Date();
      await m.svc.disconnect(ws, ch, ownerId, {}, first);
      await m.svc.restore(ws, ch, first);
      expect(await m.svc.finalize(ch, first)).toBe('restored');

      const second = new Date(first.getTime() + MIN);
      await m.svc.disconnect(ws, ch, ownerId, {}, second);
      // The first disconnect's job must not close the second one's window.
      expect(await m.svc.finalize(ch, first)).toBe('restored');
      expect((await channelRow(client, ch))!.access_token).toBe('x');
      expect(await m.svc.finalize(999_999_999, first)).toBe('gone');
    }));

  it('a must-delete platform (YouTube) is hard-deleted at finalize, with its unpublished posts', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const yt = await seedChannel(client, ws, 'youtube');
      const now = new Date(Date.now() - 11 * MIN);
      const m = make(db, client);
      const res = await m.svc.disconnect(ws, yt, ownerId, {}, now);
      expect(res.historyKept).toBe(false);

      expect(await m.svc.finalize(yt, now)).toBe('deleted');
      expect(m.postsCleanup.removeUnpublished).toHaveBeenCalledWith(ws, yt);
      expect(m.channels.deleteChannel).toHaveBeenCalledWith(yt, ws, {
        onlyIfDisconnectedAt: now,
      });
      expect(await channelRow(client, yt)).toBeUndefined();
    }));

  it('the sweep finalizes a disconnect whose job was lost', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const fresh = await seedChannel(client, ws, 'mastodon');
      const m = make(db, client);
      const now = new Date();
      await m.svc.disconnect(ws, ch, ownerId, {}, new Date(now.getTime() - 20 * MIN));
      await m.svc.disconnect(ws, fresh, ownerId, {}, now);

      expect(await m.svc.sweep(now)).toBe(1);
      expect((await channelRow(client, ch))!.disconnect_finalized_at).not.toBeNull();
      expect((await channelRow(client, fresh))!.disconnect_finalized_at).toBeNull();
    }));

  it('deleteHistory deletes at once; so does any integration; no undo', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const drive = await seedChannel(client, ws, 'google_drive');
      const m = make(db, client);

      expect(
        await m.svc.disconnect(ws, ch, ownerId, { deleteHistory: true }),
      ).toEqual({
        outcome: 'deleted',
        channelId: ch,
        restoreUntil: null,
        historyKept: false,
        pausedCount: 0,
      });
      expect(m.postsCleanup.removeUnpublished).toHaveBeenCalledWith(ws, ch);
      expect(await channelRow(client, ch)).toBeUndefined();

      expect((await m.svc.disconnect(ws, drive, ownerId)).outcome).toBe(
        'deleted',
      );
      expect(await channelRow(client, drive)).toBeUndefined();
      expect(m.finalizeQueue.added).toHaveLength(0);
    }));

  it('Delete history on a disconnected channel deletes it, not counting its slot twice', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const m = make(db, client);
      await m.svc.disconnect(ws, ch, ownerId);
      await m.svc.disconnect(ws, ch, ownerId, { deleteHistory: true });
      expect(await channelRow(client, ch)).toBeUndefined();
      expect(m.channels.releaseSlot).toHaveBeenCalledTimes(1);
    }));

  it('another workspace\'s channel is not found', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const ch = await seedChannel(client, b.workspaceId, 'bluesky');
      const m = make(db, client);
      await expect(
        m.svc.disconnect(a.workspaceId, ch, a.ownerId),
      ).rejects.toThrow('Channel not found');
      await expect(m.svc.restore(a.workspaceId, ch)).rejects.toThrow(
        'Channel not found',
      );
    }));
});

describeDb('ChannelPauseService.releaseAfterReconnect (database)', () => {
  it('a post missed by more than the grace is enqueued as missed, never sent late', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const now = new Date();
      const old = await seedPost(
        client,
        ws,
        ownerId,
        [t(ch, { heldAt: now.toISOString(), heldReason: 'channel_disconnected' })],
        { scheduledAt: new Date(now.getTime() - 3 * 24 * HOUR) },
      );
      const q = fakeQueue();
      const svc = new ChannelPauseService(db, q as never);
      const res = await svc.releaseAfterReconnect(ws, ch, 10 * MIN, now);
      expect(res).toEqual({
        resumedCount: 0,
        overdueCount: 0,
        missedCount: 1,
        stillPausedCount: 0,
      });
      expect(q.added[0].data).toEqual({
        postId: old,
        heldOnly: true,
        missedHeld: true,
      });
    }));

  it('a channel that is also paused keeps its posts held, as paused', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      await client.query(
        `UPDATE social_media_channels SET paused_at = now() WHERE id = $1`,
        [ch],
      );
      const now = new Date();
      const post = await seedPost(client, ws, ownerId, [
        t(ch, { heldAt: now.toISOString(), heldReason: 'channel_disconnected' }),
      ]);
      const q = fakeQueue();
      const svc = new ChannelPauseService(db, q as never);
      const res = await svc.releaseAfterReconnect(ws, ch, 10 * MIN, now);
      expect(res.stillPausedCount).toBe(1);
      expect(q.added).toHaveLength(0);
      expect((await targetsOf(client, post))[0].heldReason).toBe(
        'channel_paused',
      );
    }));
});

describeDb('ChannelDisconnectService review fixes (database)', () => {
  it('finalize (history kept) resolves its paused posts as failed', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const other = await seedChannel(client, ws, 'mastodon');
      const only = await seedPost(client, ws, ownerId, [t(ch)]);
      const shared = await seedPost(client, ws, ownerId, [
        t(ch),
        t(other, { status: 'published' }),
      ]);
      const stillGoing = await seedPost(client, ws, ownerId, [t(ch), t(other)]);
      const now = new Date(Date.now() - 11 * MIN);
      const m = make(db, client);
      await m.svc.disconnect(ws, ch, ownerId, {}, now);

      expect(await m.svc.finalize(ch, now)).toBe('tokens-cleared');
      const status = async (id: string) =>
        (await client.query(`SELECT status FROM posts WHERE id = $1`, [id]))
          .rows[0].status as string;
      expect(await status(only)).toBe('failed');
      expect(await status(shared)).toBe('partially_published');
      expect(await status(stillGoing)).toBe('scheduled');
      const [target] = await targetsOf(client, only);
      expect(target).toMatchObject({ status: 'failed' });
      expect(target.heldAt).toBeUndefined();
      expect(target.errorMessage).toMatch(/channel was disconnected/);
    }));

  it('a bot live in another workspace keeps its webhook (finalize and delete)', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const bot = await seedChannel(client, a.workspaceId, 'telegram');
      const now = new Date(Date.now() - 11 * MIN);
      const m = make(db, client);
      await m.svc.disconnect(a.workspaceId, bot, a.ownerId, {}, now);
      // Workspace B connects the same bot during the undo window.
      await client.query(
        `INSERT INTO social_media_channels
           (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
         SELECT $1, 'telegram', 'bot', platform_account_id, 'Bot', 'y', $2
           FROM social_media_channels WHERE id = $3`,
        [b.workspaceId, b.ownerId, bot],
      );

      expect(await m.svc.finalize(bot, now)).toBe('tokens-cleared');
      expect(m.deleteWebhook).not.toHaveBeenCalled();
      await m.svc.disconnect(a.workspaceId, bot, a.ownerId, {
        deleteHistory: true,
      });
      expect(m.deleteWebhook).not.toHaveBeenCalled();
    }));

  it('a must-delete finalize deletes only this very disconnect (a revive is never deleted)', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const yt = await seedChannel(client, ws, 'youtube');
      const now = new Date(Date.now() - 11 * MIN);
      const m = make(db, client);
      await m.svc.disconnect(ws, yt, ownerId, {}, now);
      expect(await m.svc.finalize(yt, now)).toBe('deleted');
      expect(m.channels.deleteChannel).toHaveBeenCalledWith(yt, ws, {
        onlyIfDisconnectedAt: now,
      });
    }));
});
