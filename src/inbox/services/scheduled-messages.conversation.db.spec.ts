// ScheduledMessagesService writes through the module-level `db`. Point that at
// the rollback harness connection for the duration of each test.
const mockHolder: { db: unknown } = { db: null };
jest.mock('../../drizzle/db', () => ({
  db: new Proxy(
    {},
    {
      get: (_t, prop) =>
        (mockHolder.db as Record<string, unknown>)[prop as string],
    },
  ),
}));

import type { Queue } from 'bullmq';
import type { PoolClient } from 'pg';
import type { DbType } from '../../drizzle/db';
import type { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';
import type { CalendarPushSyncService } from '../../calendar-sync/services/calendar-push-sync.service';
import type { InboxRealtimeService } from '../conversations/services/inbox-realtime.service';
import {
  describeInboxDb,
  seedChannel,
  seedWorkspace,
  withInboxDb,
} from '../testing/inbox-db';
import type { CreateScheduledMessageDto } from '../dto/create-scheduled-message.dto';
import { ScheduledMessagesService } from './scheduled-messages.service';

const fake = <T>(impl: Record<string, unknown>): T => impl as unknown as T;
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function build(db: DbType) {
  mockHolder.db = db;
  const job = { remove: jest.fn() };
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(job),
  };
  const realtime = {
    timelineAppended: jest.fn(),
    conversationChanged: jest.fn(),
    countsChanged: jest.fn(),
  };
  const emitter = { emit: jest.fn() };
  const service = new ScheduledMessagesService(
    fake<AnalyticsEventEmitter>(emitter),
    fake<Queue>(queue),
    fake<CalendarPushSyncService>({
      syncMessage: jest.fn().mockResolvedValue(undefined),
    }),
    fake<InboxRealtimeService>(realtime),
  );
  return { service, queue, realtime, job, emitter };
}

async function seedConv(
  client: PoolClient,
  workspaceId: string,
  channelId: number,
  opts: {
    kind: 'dm' | 'comment_thread';
    threadKey: string;
    windowClosesAt?: Date | null;
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO inbox_conversations
       (workspace_id, channel_id, platform, kind, thread_key, last_message_at,
        reply_window_closes_at)
     VALUES ($1,$2,'facebook',$3,$4, now(), $5) RETURNING id`,
    [
      workspaceId,
      channelId,
      opts.kind,
      opts.threadKey,
      opts.windowClosesAt ?? null,
    ],
  );
  return r.rows[0].id;
}

interface ScheduledRowShape {
  status: string;
  attempts: number;
  type: string;
  thread_key: string;
  inbox_conversation_id: string | null;
  attachments: Array<{ kind: string; url: string; thumbnailUrl: null }>;
  queue_job_id: string | null;
}

async function rowOf(client: PoolClient, id: string) {
  const r = await client.query<ScheduledRowShape>(
    `SELECT * FROM scheduled_inbox_messages WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

const IMG = {
  kind: 'image' as const,
  url: 'https://cdn.example.test/a.png',
  contentType: 'image/png',
};

async function seedRow(
  client: PoolClient,
  p: {
    workspaceId: string;
    channelId: number;
    convId: string | null;
    by: string;
    status: string;
    at: Date;
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO scheduled_inbox_messages
       (workspace_id, channel_id, type, thread_key, conversation_id, text,
        scheduled_at, status, inbox_conversation_id, created_by_user_id,
        attempts, error_message)
     VALUES ($1,$2,'dm',$3,'pg:9','hi',$4,$5,$6,$7, 2, 'boom') RETURNING id`,
    [
      p.workspaceId,
      p.channelId,
      `${p.channelId}:pg:9`,
      p.at,
      p.status,
      p.convId,
      p.by,
    ],
  );
  return r.rows[0].id;
}

async function dmWorld(client: PoolClient) {
  const { workspaceId, ownerId } = await seedWorkspace(client);
  const ch = await seedChannel(client, workspaceId, 'facebook');
  const conv = await seedConv(client, workspaceId, ch, {
    kind: 'dm',
    threadKey: `${ch}:pg:9`,
  });
  return { workspaceId, ownerId, ch, conv };
}

describeInboxDb('ScheduledMessagesService with conversations', () => {
  it('creates by inboxConversationId on a dm with an image: links, stores attachments, returns the superset', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const { service, queue, realtime } = build(db);

      const dto = await service.create(workspaceId, ownerId, {
        inboxConversationId: conv,
        text: 'hello',
        sendAt: inHours(3),
        attachments: [IMG],
      } as CreateScheduledMessageDto);

      const row = await rowOf(client, dto.id);
      expect(row.inbox_conversation_id).toBe(conv);
      expect(row.type).toBe('dm');
      expect(row.thread_key).toBe(`${ch}:pg:9`);
      expect(row.attachments).toEqual([{ ...IMG, thumbnailUrl: null }]);
      expect(dto.conversationId).toBe('pg:9');
      expect(dto.inboxConversationId).toBe(conv);
      expect(dto.sendAt).toBe(dto.scheduledAt);
      expect(dto.error).toBe(dto.errorMessage);
      expect(dto.by).toMatchObject({ id: ownerId });
      expect(dto.attachments).toHaveLength(1);

      const opts = (queue.add.mock.calls[0] as unknown[])[2] as {
        jobId: string;
      };
      expect(opts.jobId).not.toContain(':');
      expect(realtime.timelineAppended).toHaveBeenCalledWith(
        workspaceId,
        conv,
        expect.objectContaining({ kind: 'scheduled', id: dto.id }),
        null,
      );
      expect(realtime.conversationChanged).toHaveBeenCalledWith(
        workspaceId,
        conv,
      );
      expect(realtime.countsChanged).toHaveBeenCalledWith(workspaceId);
    }));

  it('a legacy create by type + threadKey also links the conversation', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const { service } = build(db);

      const dto = await service.create(workspaceId, ownerId, {
        type: 'dm',
        threadKey: `${ch}:pg:9`,
        text: 'hello',
        scheduledAt: inHours(3),
      } as CreateScheduledMessageDto);

      expect((await rowOf(client, dto.id)).inbox_conversation_id).toBe(conv);
      expect(dto.inboxConversationId).toBe(conv);
    }));

  it('rejects attachments on a comment thread (400), on create and update', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'facebook');
      const conv = await seedConv(client, workspaceId, ch, {
        kind: 'comment_thread',
        threadKey: `${ch}:post1`,
      });
      const { service } = build(db);

      await expect(
        service.create(workspaceId, ownerId, {
          inboxConversationId: conv,
          text: 'hello',
          sendAt: inHours(3),
          attachments: [IMG],
        } as CreateScheduledMessageDto),
      ).rejects.toMatchObject({
        status: 400,
        message: 'Attachments can only be scheduled on messages',
      });

      const ok = await service.create(workspaceId, ownerId, {
        inboxConversationId: conv,
        text: 'hello',
        sendAt: inHours(3),
      } as CreateScheduledMessageDto);
      await expect(
        service.update(workspaceId, ownerId, ok.id, { attachments: [IMG] }),
      ).rejects.toMatchObject({ status: 400 });
    }));

  it('rejects a sendAt after the reply window closes (400)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'facebook');
      const conv = await seedConv(client, workspaceId, ch, {
        kind: 'dm',
        threadKey: `${ch}:pg:9`,
        windowClosesAt: new Date(Date.now() + 5 * HOUR),
      });
      const { service } = build(db);
      const base = { inboxConversationId: conv, text: 'hello' };

      await expect(
        service.create(workspaceId, ownerId, {
          ...base,
          sendAt: inHours(6),
        } as CreateScheduledMessageDto),
      ).rejects.toMatchObject({
        status: 400,
        message: 'That time is after the reply window closes',
      });
      const ok = await service.create(workspaceId, ownerId, {
        ...base,
        sendAt: inHours(4),
      } as CreateScheduledMessageDto);
      expect(ok.status).toBe('pending');
    }));

  it('answers 409 SEND_TIME_PASSED on create and update when the time is not in the future', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, conv } = await dmWorld(client);
      const { service } = build(db);
      const past = inHours(-1);
      const passed = {
        status: 409,
        response: { code: 'SEND_TIME_PASSED', message: 'That time has passed' },
      };

      await expect(
        service.create(workspaceId, ownerId, {
          inboxConversationId: conv,
          text: 'hello',
          sendAt: past,
        } as CreateScheduledMessageDto),
      ).rejects.toMatchObject(passed);

      const ok = await service.create(workspaceId, ownerId, {
        inboxConversationId: conv,
        text: 'hello',
        sendAt: inHours(3),
      } as CreateScheduledMessageDto);
      await expect(
        service.update(workspaceId, ownerId, ok.id, { sendAt: past }),
      ).rejects.toMatchObject(passed);
      await expect(
        service.update(workspaceId, ownerId, ok.id, { scheduledAt: past }),
      ).rejects.toMatchObject(passed);
    }));

  it('still accepts the Planner PATCH { scheduledAt } and moves the job', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch } = await dmWorld(client);
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: null,
        by: ownerId,
        status: 'pending',
        at: new Date(Date.now() + HOUR),
      });
      const { service, queue } = build(db);
      const when = inHours(5);

      const dto = await service.update(workspaceId, ownerId, id, {
        scheduledAt: when,
      });

      expect(dto.scheduledAt).toBe(when);
      expect(dto.sendAt).toBe(when);
      expect(queue.add).toHaveBeenCalledTimes(1);
    }));

  it('cancel answers the union body with undo.restoreId', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: conv,
        by: ownerId,
        status: 'pending',
        at: new Date(Date.now() + HOUR),
      });
      const { service, job, realtime } = build(db);

      const body = await service.cancel(workspaceId, ownerId, id);

      expect(body).toEqual({
        ok: true,
        undo: { restoreId: id },
        success: true,
      });
      expect((await rowOf(client, id)).status).toBe('cancelled');
      expect(job.remove).toHaveBeenCalled();
      expect(realtime.countsChanged).toHaveBeenCalledWith(workspaceId);
    }));

  it('a sendAt less than 2 minutes out is a 400 that names sendAt, not the legacy field', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, conv } = await dmWorld(client);
      const { service } = build(db);
      const err: unknown = await service
        .create(workspaceId, ownerId, {
          inboxConversationId: conv,
          text: 'hi',
          sendAt: new Date(Date.now() + 90_000).toISOString(),
        } as CreateScheduledMessageDto)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 400 });
      expect((err as Error).message).toMatch(/sendAt/);
      expect((err as Error).message).not.toMatch(/scheduledAt/);
    }));

  it('the lead-time 400 names the field the caller sent (legacy scheduledAt on create and update)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const soon = new Date(Date.now() + 90_000).toISOString();
      const { service } = build(db);
      const created: unknown = await service
        .create(workspaceId, ownerId, {
          type: 'dm',
          threadKey: `${ch}:pg:9`,
          text: 'hi',
          scheduledAt: soon,
        } as CreateScheduledMessageDto)
        .catch((e: unknown) => e);
      expect((created as Error).message).toMatch(/^scheduledAt must/);

      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: conv,
        by: ownerId,
        status: 'pending',
        at: new Date(Date.now() + HOUR),
      });
      const updated: unknown = await service
        .update(workspaceId, ownerId, id, { scheduledAt: soon })
        .catch((e: unknown) => e);
      expect((updated as Error).message).toMatch(/^scheduledAt must/);
      const updatedNew: unknown = await service
        .update(workspaceId, ownerId, id, { sendAt: soon })
        .catch((e: unknown) => e);
      expect((updatedNew as Error).message).toMatch(/^sendAt must/);
    }));

  it('cancel survives a job-removal failure: row cancelled, event and announce still go out', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: conv,
        by: ownerId,
        status: 'pending',
        at: new Date(Date.now() + HOUR),
      });
      const { service, job, realtime, emitter } = build(db);
      job.remove.mockRejectedValueOnce(new Error('redis blip'));

      const body = await service.cancel(workspaceId, ownerId, id);

      expect(body.ok).toBe(true);
      expect((await rowOf(client, id)).status).toBe('cancelled');
      expect(emitter.emit).toHaveBeenCalledWith(
        workspaceId,
        'scheduled.message.cancelled',
        expect.objectContaining({ id }),
      );
      expect(realtime.countsChanged).toHaveBeenCalledWith(workspaceId);
    }));

  it('cancelling a failed reply is idempotent and offers no undo (restore only takes cancelled)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: conv,
        by: ownerId,
        status: 'failed',
        at: new Date(Date.now() + HOUR),
      });
      const { service } = build(db);
      const body = await service.cancel(workspaceId, ownerId, id);
      expect(body).toEqual({ ok: true, success: true });
      expect(body).not.toHaveProperty('undo');
      expect((await rowOf(client, id)).status).toBe('failed');
    }));

  it('restore re-checks the reply window like create (400)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch } = await dmWorld(client);
      const at = new Date(Date.now() + 3 * HOUR);
      const closed = await seedConv(client, workspaceId, ch, {
        kind: 'dm',
        threadKey: `${ch}:win`,
        windowClosesAt: new Date(Date.now() + HOUR),
      });
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: closed,
        by: ownerId,
        status: 'cancelled',
        at,
      });
      const { service, queue } = build(db);
      await expect(
        service.restore(workspaceId, ownerId, id),
      ).rejects.toMatchObject({ status: 400 });
      expect((await rowOf(client, id)).status).toBe('cancelled');
      expect(queue.add).not.toHaveBeenCalled();
    }));

  it('send-now when the queue add fails leaves a recoverable failed row, not a 500', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: conv,
        by: ownerId,
        status: 'pending',
        at: new Date(Date.now() + HOUR),
      });
      const { service, queue, emitter } = build(db);
      queue.add.mockRejectedValueOnce(new Error('redis down'));

      const dto = await service.sendNow(workspaceId, ownerId, id);

      expect(dto.status).toBe('failed');
      expect(dto.error).toMatch(/Send now/i);
      const row = await rowOf(client, id);
      expect(row.status).toBe('failed');
      expect(emitter.emit).toHaveBeenCalledWith(
        workspaceId,
        'scheduled.message.updated',
        expect.objectContaining({ id, status: 'failed' }),
      );
      // and Send now works again once the queue is back
      const again = await service.sendNow(workspaceId, ownerId, id);
      expect(again.status).toBe('pending');
    }));

  it('restore when the old job cannot be removed ends failed, not a 500 after commit', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: conv,
        by: ownerId,
        status: 'cancelled',
        at: new Date(Date.now() + HOUR),
      });
      const { service, job, queue } = build(db);
      job.remove.mockRejectedValueOnce(new Error('job is locked'));

      const dto = await service.restore(workspaceId, ownerId, id);

      expect(dto.status).toBe('failed');
      expect(queue.add).not.toHaveBeenCalled();
    }));

  it('restore re-queues a cancelled reply, and refuses when the time has passed', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const seed = (status: string, ms: number) =>
        seedRow(client, {
          workspaceId,
          channelId: ch,
          convId: conv,
          by: ownerId,
          status,
          at: new Date(Date.now() + ms),
        });
      const later = await seed('cancelled', HOUR);
      const stale = await seed('cancelled', 60_000);
      const pending = await seed('pending', HOUR);
      const { service, queue } = build(db);

      const dto = await service.restore(workspaceId, ownerId, later);
      expect(dto.status).toBe('pending');
      expect((await rowOf(client, later)).status).toBe('pending');
      const [name, , opts] = queue.add.mock.calls[0] as [
        string,
        unknown,
        { jobId: string },
      ];
      expect(name).toBe('fire');
      expect(opts.jobId).toBe(`scheduled-inbox-${later}`);

      await expect(
        service.restore(workspaceId, ownerId, stale),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'SEND_TIME_PASSED', message: 'That time has passed' },
      });
      expect((await rowOf(client, stale)).status).toBe('cancelled');
      await expect(
        service.restore(workspaceId, ownerId, pending),
      ).rejects.toMatchObject({ status: 409 });
    }));

  it('send-now on a failed reply goes pending, resets attempts and adds a delay-0 job', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const seed = (status: string) =>
        seedRow(client, {
          workspaceId,
          channelId: ch,
          convId: conv,
          by: ownerId,
          status,
          at: new Date(Date.now() - HOUR),
        });
      const failed = await seed('failed');
      const sent = await seed('sent');
      const { service, queue, job } = build(db);
      const before = Date.now();

      const dto = await service.sendNow(workspaceId, ownerId, failed);

      expect(dto.status).toBe('pending');
      const row = await rowOf(client, failed);
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.error_message).toBeNull();
      expect((row.scheduled_at as Date).getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
      expect(job.remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        'fire',
        { scheduledId: failed },
        expect.objectContaining({
          delay: 0,
          jobId: `scheduled-inbox-${failed}`,
        }),
      );
      await expect(
        service.sendNow(workspaceId, ownerId, sent),
      ).rejects.toMatchObject({ status: 409 });
    }));

  it('resolves inboxConversationId for a legacy row that never stored one', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: null,
        by: ownerId,
        status: 'pending',
        at: new Date(Date.now() + HOUR),
      });
      const { service } = build(db);

      const one = await service.get(workspaceId, ownerId, id);
      const all = await service.list(workspaceId, ownerId, {});

      expect(one.inboxConversationId).toBe(conv);
      expect(all[0].inboxConversationId).toBe(conv);
      expect(all[0].by).toMatchObject({ id: ownerId });
    }));

  it('markFailed and markSent announce the change', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, conv } = await dmWorld(client);
      const id = await seedRow(client, {
        workspaceId,
        channelId: ch,
        convId: conv,
        by: ownerId,
        status: 'sending',
        at: new Date(Date.now() - 1000),
      });
      const { service, realtime } = build(db);

      await service.markFailed(id, 'nope');
      expect(realtime.timelineAppended).toHaveBeenLastCalledWith(
        workspaceId,
        conv,
        expect.objectContaining({ status: 'failed', error: 'nope' }),
        null,
      );
      await service.markSent(id, null);
      expect(realtime.timelineAppended).toHaveBeenLastCalledWith(
        workspaceId,
        conv,
        null,
        null,
      );
      expect(realtime.countsChanged).toHaveBeenCalledTimes(2);
    }));
});
