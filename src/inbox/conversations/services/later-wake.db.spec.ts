import type { PoolClient } from 'pg';
import type { DbType } from '../../../drizzle/db';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import { ConversationSyncService } from './conversation-sync.service';
import { LaterWakeService } from './later-wake.service';

const T0 = new Date('2026-10-26T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function build(db: DbType) {
  const rt = {
    conversationChanged: jest.fn(),
    conversationRemoved: jest.fn(),
    countsChanged: jest.fn(),
    timelineAppended: jest.fn(),
  };
  const sync = new ConversationSyncService(db, rt as never);
  const queue = { add: jest.fn() };
  const wake = new LaterWakeService(queue as never, db, sync);
  return { sync, wake };
}

const dm = (
  client: PoolClient,
  workspaceId: string,
  channelId: number,
  convo: string,
  when: Date = T0,
) =>
  seedItem(client, {
    workspaceId,
    channelId,
    platform: 'instagram',
    type: 'dm',
    conversationId: convo,
    text: 'hi',
    authorHandle: 'maya',
    authorPlatformId: `p-${convo}`,
    platformCreatedAt: when,
  });

const statusOf = async (client: PoolClient, id: string) =>
  (
    await client.query<{ status: string; later_until: Date | null }>(
      `SELECT status, later_until FROM inbox_conversations WHERE id = $1`,
      [id],
    )
  ).rows[0];

describeInboxDb('LaterWakeService', () => {
  it('wakes on time, ignores stale jobs and moved-on conversations', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const key = (await dm(client, workspaceId, ch, 'a')).threadKey!;
      const { sync, wake } = build(db);
      const T = at(60);
      const T2 = at(120);
      const snooze = (until: Date) =>
        sync.syncThread(workspaceId, key, {
          kind: 'manual',
          userId: ownerId,
          status: 'later',
          laterUntil: until,
        });

      const id = (await snooze(T)).conversationId!;
      expect((await statusOf(client, id)).status).toBe('later');

      // Moved on by hand before the job fires: the job leaves it alone.
      await sync.syncThread(workspaceId, key, {
        kind: 'manual',
        userId: ownerId,
        status: 'to_reply',
      });
      await wake.wake(id, T.toISOString());
      expect((await statusOf(client, id)).status).toBe('to_reply');

      // Re-snoozed to T2: the stale T job must not wake it.
      await snooze(T2);
      await wake.wake(id, T.toISOString());
      const still = await statusOf(client, id);
      expect(still.status).toBe('later');
      expect(still.later_until?.getTime()).toBe(T2.getTime());

      await wake.wake(id, T2.toISOString());
      expect((await statusOf(client, id)).status).toBe('to_reply');

      // Unknown conversation: no-op.
      await expect(
        wake.wake('00000000-0000-0000-0000-000000000000', T.toISOString()),
      ).resolves.toBeUndefined();
    }));

  it('an inbound moves a later-until-reply conversation to to_reply; the wake then leaves it', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const key = (await dm(client, workspaceId, ch, 'r')).threadKey!;
      const { sync, wake } = build(db);
      const T = at(60);
      const id = (
        await sync.syncThread(workspaceId, key, {
          kind: 'manual',
          userId: ownerId,
          status: 'later',
          laterUntil: T,
          laterUntilReply: true,
        })
      ).conversationId!;
      await dm(client, workspaceId, ch, 'r', at(10));
      await sync.syncThread(workspaceId, key);
      expect((await statusOf(client, id)).status).toBe('to_reply');
      await wake.wake(id, T.toISOString());
      expect((await statusOf(client, id)).status).toBe('to_reply');
    }));

  it('sweep wakes due conversations only, and skips ones that are done', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const { sync, wake } = build(db);
      const keyA = (await dm(client, workspaceId, ch, 's1')).threadKey!;
      const keyB = (await dm(client, workspaceId, ch, 's2')).threadKey!;
      const keyC = (await dm(client, workspaceId, ch, 's3')).threadKey!;
      const snooze = (key: string, until: Date) =>
        sync.syncThread(workspaceId, key, {
          kind: 'manual',
          userId: ownerId,
          status: 'later',
          laterUntil: until,
        });
      const a = await snooze(keyA, at(60));
      const b = await snooze(keyB, at(60));
      const c = await snooze(keyC, at(600));
      // B is marked done meanwhile.
      await sync.syncThread(workspaceId, keyB, {
        kind: 'manual',
        userId: ownerId,
        status: 'done',
      });

      expect(await wake.sweep(at(90))).toBe(1);
      expect((await statusOf(client, a.conversationId!)).status).toBe(
        'to_reply',
      );
      expect((await statusOf(client, b.conversationId!)).status).toBe('done');
      expect((await statusOf(client, c.conversationId!)).status).toBe('later');
    }));

  it('sweep takes the longest-overdue first and treats later_until = now as due', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const { sync, wake } = build(db);
      const snooze = async (convo: string, until: Date) => {
        const key = (await dm(client, workspaceId, ch, convo)).threadKey!;
        return (
          await sync.syncThread(workspaceId, key, {
            kind: 'manual',
            userId: ownerId,
            status: 'later',
            laterUntil: until,
          })
        ).conversationId!;
      };
      const exact = await snooze('b1', at(60));
      const older = await snooze('b2', at(30));
      const justAfter = await snooze('b3', new Date(at(60).getTime() + 1));

      const order: string[] = [];
      const spy = jest.spyOn(wake, 'wake').mockImplementation((id) => {
        order.push(id);
        return Promise.resolve();
      });
      expect(await wake.sweep(at(60))).toBe(2);
      spy.mockRestore();
      expect(order).toEqual([older, exact]);
      expect((await statusOf(client, justAfter)).status).toBe('later');
    }));

  it('one throwing row does not stop the rest of the sweep', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const { sync, wake } = build(db);
      const ids: string[] = [];
      for (const [i, convo] of ['t1', 't2', 't3'].entries()) {
        const key = (await dm(client, workspaceId, ch, convo)).threadKey!;
        ids.push(
          (
            await sync.syncThread(workspaceId, key, {
              kind: 'manual',
              userId: ownerId,
              status: 'later',
              laterUntil: at(10 + i),
            })
          ).conversationId!,
        );
      }
      // The sweep is ordered by later_until, so the first sync is ids[0]'s.
      jest.spyOn(sync, 'syncThread').mockRejectedValueOnce(new Error('boom'));
      expect(await wake.sweep(at(90))).toBe(2);
      expect((await statusOf(client, ids[0])).status).toBe('later');
      expect((await statusOf(client, ids[1])).status).toBe('to_reply');
      expect((await statusOf(client, ids[2])).status).toBe('to_reply');
    }));
});
