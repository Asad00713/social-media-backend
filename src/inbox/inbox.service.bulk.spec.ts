import { BadRequestException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// InboxService reads `db` as a module-level singleton rather than taking it by
// injection, so a Nest TestingModule cannot intercept it. Mock the module and
// drive the paths bulkAction / markThreadUnread touch: the workspace access
// check, and an update inside a transaction.
jest.mock('../drizzle/db', () => {
  const update = jest.fn();
  return {
    db: {
      query: {
        workspace: { findFirst: jest.fn() },
        workspaceInvitation: { findFirst: jest.fn() },
      },
      update,
      // The transaction callback gets a tx that shares the same update mock,
      // so assertions do not care which one the code reached for.
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) =>
        fn({ update }),
      ),
    },
  };
});

import { db } from '../drizzle/db';
import { InboxService } from './inbox.service';

const dialect = new PgDialect();

/** Render a captured Drizzle WHERE clause to inspectable SQL text. */
function renderWhere(clause: SQL): string {
  return dialect.sqlToQuery(clause).sql;
}

/**
 * The values a WHERE clause binds. Drizzle parameterises literals — an
 * `inArray(status, [...])` renders as `status in ($5, $6, $7)` — so asserting
 * on the SQL text alone would never see which statuses were matched.
 */
function whereParams(clause: SQL): unknown[] {
  return dialect.sqlToQuery(clause).params;
}

describe('InboxService bulk + unread', () => {
  let service: InboxService;
  let emitter: { emit: jest.Mock };
  let setMock: jest.Mock;
  let whereMock: jest.Mock;
  /** Local handle on the mocked db.update, so assertions do not reference the
   *  imported binding as an unbound method. */
  let updateMock: jest.Mock;
  /** Every WHERE clause passed to db.update during the test. */
  let capturedWheres: SQL[];
  /** Every value object passed to .set(). */
  let capturedSets: Record<string, unknown>[];

  const workspaceId = 'ws-1';
  const userId = 'user-1';

  beforeEach(() => {
    jest.clearAllMocks();
    capturedWheres = [];
    capturedSets = [];

    emitter = { emit: jest.fn() };

    (db.query.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: workspaceId,
    });

    whereMock = jest.fn((clause: SQL) => {
      capturedWheres.push(clause);
      return {
        returning: jest.fn().mockResolvedValue([{ id: 'row-1' }]),
      };
    });
    setMock = jest.fn((values: Record<string, unknown>) => {
      capturedSets.push(values);
      return { where: whereMock };
    });
    // db.update is a jest.fn from the module mock above, not a real method
    // being detached from its object.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    updateMock = db.update as unknown as jest.Mock;
    updateMock.mockReturnValue({ set: setMock });

    service = new InboxService(
      emitter as any,
      {} as any, // InboxDispatcher — unused on these paths
      {} as any, // ChannelService
      {} as any, // FacebookService
      {} as any, // InstagramService
      {} as any, // BullMQ pollQueue
    );

    jest.spyOn(service as any, 'emitCounts').mockResolvedValue(undefined);
  });

  describe('bulkAction validation', () => {
    it('rejects a payload with neither threadKeys nor itemIds', async () => {
      await expect(
        service.bulkAction(workspaceId, userId, { action: 'mark_read' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // Thread keys are `channelId:<rest>`, and `rest` is a post id for comments
    // but a conversation id for DMs — indistinguishable by shape, so acting
    // without a scope would guess which column to match on.
    it('rejects threadKeys without a scope', async () => {
      await expect(
        service.bulkAction(workspaceId, userId, {
          action: 'mark_read',
          threadKeys: ['7:post_1'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('bulkAction partial failure', () => {
    /**
     * A selection of 200 threads will routinely contain one a teammate
     * archived a second ago. Rejecting the whole request over it is hostile,
     * so bad keys are reported rather than thrown.
     */
    it('applies the valid keys and reports the malformed one instead of throwing', async () => {
      const result = await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        scope: 'comment',
        threadKeys: ['7:post_1', 'not-a-key', '8:post_2'],
      });

      expect(result.failed).toEqual([
        { key: 'not-a-key', reason: 'Invalid thread key' },
      ]);
      expect(result.requestedThreads).toBe(3);
      // The two decodable keys still went to the database.
      expect(updateMock).toHaveBeenCalledTimes(1);
    });

    it('does not touch the database when every key is malformed', async () => {
      const result = await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        scope: 'comment',
        threadKeys: ['nope', 'also-nope'],
      });

      expect(result.updatedCount).toBe(0);
      expect(result.failed).toHaveLength(2);
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe('tenant isolation', () => {
    // Thread keys come from the client. Access is asserted once up front, but
    // a forged key must still be unable to reach another tenant's rows, so
    // every statement carries the workspace predicate itself.
    it('scopes every bulk update to the workspace', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        scope: 'comment',
        threadKeys: ['7:post_1'],
      });

      expect(capturedWheres).toHaveLength(1);
      expect(renderWhere(capturedWheres[0])).toContain('workspace_id');
    });

    it('scopes an itemIds bulk update to the workspace too', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        itemIds: ['11111111-1111-4111-8111-111111111111'],
      });

      expect(renderWhere(capturedWheres[0])).toContain('workspace_id');
    });
  });

  describe('bulkAction guards', () => {
    /**
     * The guard that protects every unread badge in the product. `computeCounts`
     * counts unread rows with `from_me = false`; if a bulk mark-unread could
     * flip our own replies to unread, every badge would inflate.
     */
    it('never marks our own messages unread', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'mark_unread',
        scope: 'comment',
        threadKeys: ['7:post_1'],
      });

      expect(renderWhere(capturedWheres[0])).toContain('from_me');
      expect(capturedSets[0]).toMatchObject({ status: 'unread' });
      // `false` is the bound value of the from_me predicate: only THEIR
      // messages are eligible.
      expect(whereParams(capturedWheres[0])).toContain(false);
    });

    it('marks read by moving unread incoming rows to needs_reply', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'mark_read',
        scope: 'comment',
        threadKeys: ['7:post_1'],
      });

      expect(capturedSets[0]).toMatchObject({ status: 'needs_reply' });

      const params = whereParams(capturedWheres[0]);
      // Only rows that are currently unread, and only incoming ones.
      expect(params).toContain('unread');
      expect(params).toContain(false);
    });

    it('archives by stamping archived_at rather than by setting a status', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'archive',
        scope: 'comment',
        threadKeys: ['7:post_1'],
      });

      expect(capturedSets[0]).toHaveProperty('archivedAt');
      expect(capturedSets[0]).not.toHaveProperty('status');
    });

    // Marking a thread done applies to the whole thread, including our own
    // replies — unlike read/unread, which only concern incoming messages.
    it('marks done without a from_me restriction', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        scope: 'comment',
        threadKeys: ['7:post_1'],
      });

      expect(renderWhere(capturedWheres[0])).not.toContain('from_me');
    });
  });

  describe('bulkAction scope', () => {
    it('matches on platform_post_id for the comment scope', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        scope: 'comment',
        threadKeys: ['7:post_1'],
      });

      const where = renderWhere(capturedWheres[0]);
      expect(where).toContain('platform_post_id');
      expect(where).not.toContain('conversation_id');
    });

    it('matches on conversation_id for the dm scope', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        scope: 'dm',
        threadKeys: ['7:convo_1'],
      });

      const where = renderWhere(capturedWheres[0]);
      expect(where).toContain('conversation_id');
      expect(where).not.toContain('platform_post_id');
    });
  });

  describe('bulkAction events', () => {
    /**
     * One event for the batch, not one per row. `updateThreadStatus` emits per
     * item, which is fine for a single thread but would be thousands of socket
     * frames for a 200-thread bulk.
     */
    it('emits a single bulk event rather than one per updated row', async () => {
      await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        scope: 'comment',
        threadKeys: ['7:post_1', '8:post_2'],
      });

      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        workspaceId,
        'inbox.bulk.updated',
        expect.objectContaining({ action: 'mark_done', scope: 'comment' }),
      );
    });

    it('emits nothing when no row actually changed', async () => {
      whereMock.mockImplementation((clause: SQL) => {
        capturedWheres.push(clause);
        return { returning: jest.fn().mockResolvedValue([]) };
      });

      await service.bulkAction(workspaceId, userId, {
        action: 'mark_done',
        scope: 'comment',
        threadKeys: ['7:post_1'],
      });

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('markThreadUnread', () => {
    it('rejects a malformed thread key', async () => {
      await expect(
        service.markThreadUnread(workspaceId, userId, 'garbage'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * There is no `read` status — reading maps unread -> needs_reply — so
     * un-reading has to accept every "already seen" status. Restricting it to
     * needs_reply would make the button silently do nothing on a thread the
     * user had just marked done.
     */
    it('returns a thread to unread from needs_reply, replied or done', async () => {
      await service.markThreadUnread(workspaceId, userId, '7:post_1');

      expect(capturedSets[0]).toMatchObject({ status: 'unread' });
      expect(renderWhere(capturedWheres[0])).toContain('from_me');

      const params = whereParams(capturedWheres[0]);
      expect(params).toEqual(
        expect.arrayContaining(['needs_reply', 'replied', 'done']),
      );
      // Crucially NOT 'unread' — a row that is already unread is not a
      // candidate, and including it would be a no-op write.
      expect(params).not.toContain('unread');
    });

    it('scopes the update to comment rows in this workspace', async () => {
      await service.markThreadUnread(workspaceId, userId, '7:post_1');

      const where = renderWhere(capturedWheres[0]);
      expect(where).toContain('workspace_id');
      expect(where).toContain('platform_post_id');
    });
  });
});
