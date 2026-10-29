// The REPLIED_FIRST predicates run against real Postgres rows (the scripted-db
// service spec only renders their SQL). Each row of data is seeded, then the
// service's own collision check is called.
const mockHolder: { db: Record<string, unknown> } = { db: {} };
jest.mock('../drizzle/db', () => ({
  db: new Proxy(
    {},
    {
      get: (_t, prop) => mockHolder.db[prop as string],
    },
  ),
}));

import { ConflictException } from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from './testing/inbox-db';
import { InboxService } from './inbox.service';
import type { InboxItem } from '../drizzle/schema/inbox.schema';

interface Checks {
  assertNoDmCollision(
    ws: string,
    channelId: number,
    conversationId: string,
    userId: string,
    since: Date,
  ): Promise<void>;
  assertNoCommentCollision(
    ws: string,
    target: InboxItem,
    userId: string,
    since: Date,
  ): Promise<void>;
}

function checks(db: DbType): Checks {
  mockHolder.db = db as unknown as Record<string, unknown>;
  return new InboxService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as Checks;
}

const SINCE = new Date('2026-10-26T10:00:00.000Z');
const AFTER = new Date(SINCE.getTime() + 5000);
const BEFORE = new Date(SINCE.getTime() - 5000);

interface Refusal {
  code: string;
  reply: { by: { id: string; name: string } | null; text: string; at: string };
}

async function reason(p: Promise<void>): Promise<Refusal | null> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return (e as ConflictException).getResponse() as Refusal;
  }
  return null;
}

async function targetOf(db: DbType, id: string): Promise<InboxItem> {
  const row = await db.query.inboxItems.findFirst({
    where: (t, { eq }) => eq(t.id, id),
  });
  if (!row) throw new Error('seed missing');
  return row;
}

describeInboxDb('REPLIED_FIRST collision predicates (real Postgres)', () => {
  describe('comments: per comment', () => {
    it('a teammate reply under comment A collides for A and not for B on the same post', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const mate = await seedMember(client, workspaceId, 'MEMBER', {
          name: 'Mia',
        });
        const me = await seedMember(client, workspaceId, 'MEMBER');
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const base = {
          workspaceId,
          channelId: ch,
          platform: 'facebook',
          type: 'comment' as const,
          platformPostId: 'p1',
          platformCreatedAt: BEFORE,
        };
        const a = await seedItem(client, { ...base, platformItemId: 'A' });
        const b = await seedItem(client, { ...base, platformItemId: 'B' });
        await seedItem(client, {
          ...base,
          platformItemId: 'A-reply',
          platformParentId: 'A',
          fromMe: true,
          authoredByUserId: mate,
          text: 'on it',
          platformCreatedAt: AFTER,
        });
        const svc = checks(db);

        const onA = await reason(
          svc.assertNoCommentCollision(
            workspaceId,
            await targetOf(db, a.id),
            me,
            SINCE,
          ),
        );
        expect(onA).toMatchObject({
          code: 'REPLIED_FIRST',
          reply: { by: { id: mate, name: 'Mia' }, text: 'on it' },
        });
        expect(onA?.reply.at).toBe(AFTER.toISOString());
        expect(
          await reason(
            svc.assertNoCommentCollision(
              workspaceId,
              await targetOf(db, b.id),
              me,
              SINCE,
            ),
          ),
        ).toBeNull();
      }));

    it('the target answered after since by a teammate collides with text empty; by the sender it does not', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const mate = await seedMember(client, workspaceId, 'MEMBER');
        const me = await seedMember(client, workspaceId, 'MEMBER');
        const ch = await seedChannel(client, workspaceId, 'youtube');
        const base = {
          workspaceId,
          channelId: ch,
          platform: 'youtube',
          type: 'comment' as const,
          platformPostId: 'v1',
          platformCreatedAt: BEFORE,
        };
        const answeredByMate = await seedItem(client, {
          ...base,
          platformItemId: 'X',
          repliedAt: AFTER,
        });
        await client.query(
          `UPDATE inbox_items SET replied_by_user_id = $2 WHERE id = $1`,
          [answeredByMate.id, mate],
        );
        const answeredByMe = await seedItem(client, {
          ...base,
          platformItemId: 'Y',
          repliedAt: AFTER,
        });
        await client.query(
          `UPDATE inbox_items SET replied_by_user_id = $2 WHERE id = $1`,
          [answeredByMe.id, me],
        );
        const svc = checks(db);

        const collided = await reason(
          svc.assertNoCommentCollision(
            workspaceId,
            await targetOf(db, answeredByMate.id),
            me,
            SINCE,
          ),
        );
        expect(collided).toMatchObject({
          code: 'REPLIED_FIRST',
          reply: { by: { id: mate }, text: '' },
        });
        expect(
          await reason(
            svc.assertNoCommentCollision(
              workspaceId,
              await targetOf(db, answeredByMe.id),
              me,
              SINCE,
            ),
          ),
        ).toBeNull();
      }));
  });

  describe('dms: per conversation', () => {
    const seedDm = (
      client: Parameters<typeof seedItem>[0],
      over: Partial<Parameters<typeof seedItem>[1]> & {
        workspaceId: string;
        channelId: number;
      },
    ) =>
      seedItem(client, {
        platform: 'facebook',
        type: 'dm',
        conversationId: 'conv',
        fromMe: true,
        platformCreatedAt: AFTER,
        ...over,
      });

    it("the sender's own rows are excluded, a teammate's is not", () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const mate = await seedMember(client, workspaceId, 'MEMBER');
        const me = await seedMember(client, workspaceId, 'MEMBER');
        const ch = await seedChannel(client, workspaceId, 'facebook');
        await seedDm(client, {
          workspaceId,
          channelId: ch,
          authoredByUserId: me,
        });
        const svc = checks(db);
        expect(
          await reason(
            svc.assertNoDmCollision(workspaceId, ch, 'conv', me, SINCE),
          ),
        ).toBeNull();

        await seedDm(client, {
          workspaceId,
          channelId: ch,
          authoredByUserId: mate,
          text: 'mine first',
        });
        expect(
          await reason(
            svc.assertNoDmCollision(workspaceId, ch, 'conv', me, SINCE),
          ),
        ).toMatchObject({ reply: { by: { id: mate }, text: 'mine first' } });
      }));

    it('a platform-native reply (no author) collides with by: null', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const me = await seedMember(client, workspaceId, 'MEMBER');
        const ch = await seedChannel(client, workspaceId, 'facebook');
        await seedDm(client, {
          workspaceId,
          channelId: ch,
          authoredByUserId: null,
          text: 'sent from the app',
        });
        const got = await reason(
          checks(db).assertNoDmCollision(workspaceId, ch, 'conv', me, SINCE),
        );
        expect(got).toMatchObject({
          code: 'REPLIED_FIRST',
          reply: { by: null, text: 'sent from the app' },
        });
      }));

    it('the boundary is strict: a row at exactly typingStartedAt does not collide, one ms later does', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const mate = await seedMember(client, workspaceId, 'MEMBER');
        const me = await seedMember(client, workspaceId, 'MEMBER');
        const ch = await seedChannel(client, workspaceId, 'facebook');
        await seedDm(client, {
          workspaceId,
          channelId: ch,
          authoredByUserId: mate,
          platformCreatedAt: SINCE,
        });
        const svc = checks(db);
        expect(
          await reason(
            svc.assertNoDmCollision(workspaceId, ch, 'conv', me, SINCE),
          ),
        ).toBeNull();
        await seedDm(client, {
          workspaceId,
          channelId: ch,
          authoredByUserId: mate,
          platformCreatedAt: new Date(SINCE.getTime() + 1),
        });
        expect(
          await reason(
            svc.assertNoDmCollision(workspaceId, ch, 'conv', me, SINCE),
          ),
        ).not.toBeNull();
      }));

    it('the same conversation id on another channel or in another workspace is ignored', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const other = await seedWorkspace(client);
        const mate = await seedMember(client, other.workspaceId, 'MEMBER');
        const me = await seedMember(client, workspaceId, 'MEMBER');
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const otherChannelSameWs = await seedChannel(
          client,
          workspaceId,
          'facebook',
        );
        const otherWsChannel = await seedChannel(
          client,
          other.workspaceId,
          'facebook',
        );
        await seedDm(client, {
          workspaceId,
          channelId: otherChannelSameWs,
          authoredByUserId: null,
        });
        await seedDm(client, {
          workspaceId: other.workspaceId,
          channelId: otherWsChannel,
          authoredByUserId: mate,
        });
        expect(
          await reason(
            checks(db).assertNoDmCollision(workspaceId, ch, 'conv', me, SINCE),
          ),
        ).toBeNull();
      }));

    it('inbound rows (from_me false) never collide', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const me = await seedMember(client, workspaceId, 'MEMBER');
        const ch = await seedChannel(client, workspaceId, 'facebook');
        await seedDm(client, { workspaceId, channelId: ch, fromMe: false });
        expect(
          await reason(
            checks(db).assertNoDmCollision(workspaceId, ch, 'conv', me, SINCE),
          ),
        ).toBeNull();
      }));
  });
});
