// InboxService imports `db` as a module-level singleton (not DI-injected), so
// a real Nest TestingModule can't intercept it — jest.mock the module and drive
// the one query path `getThread` takes: the workspace ownership check, then the
// joined select over inbox_items.
jest.mock('../drizzle/db', () => ({
  db: {
    query: {
      workspace: { findFirst: jest.fn() },
      workspaceInvitation: { findFirst: jest.fn() },
    },
    select: jest.fn(),
  },
}));

import { db } from '../drizzle/db';
import { InboxService } from './inbox.service';

describe('InboxService.getThread — repliedBy', () => {
  let service: InboxService;

  const workspaceId = 'ws-1';
  const userId = 'user-1';
  const threadKey = '42:post-1';

  function commentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'item-1',
      workspaceId,
      channelId: 42,
      platform: 'facebook',
      type: 'comment',
      platformItemId: 'c-1',
      platformParentId: null,
      platformPostId: 'post-1',
      authorHandle: 'pageaccount',
      authorDisplayName: 'Our Page',
      authorAvatarUrl: null,
      text: 'thanks for asking',
      platformCreatedAt: new Date('2026-09-01T10:00:00.000Z'),
      fromMe: true,
      status: 'replied',
      isHidden: false,
      metadata: {},
      repliedByUserId: null,
      ...overrides,
    };
  }

  /** Drive the joined select `getThread` runs. */
  function mockThreadRows(rows: { item: unknown; repliedByName: string | null }[]) {
    const orderBy = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ orderBy });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    (db.select as jest.Mock).mockReturnValue({ from });
    return { from, leftJoin, where, orderBy };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (db.query.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: workspaceId,
      userId,
    });

    service = new InboxService(
      { emit: jest.fn() } as never, // emitter
      { get: jest.fn() } as never, // dispatcher
      { getAccessToken: jest.fn() } as never, // channelService
      {} as never, // facebookService
      {} as never, // instagramService
      { add: jest.fn() } as never, // pollQueue
    );
  });

  it('names the teammate who sent an outbound reply', async () => {
    mockThreadRows([
      {
        item: commentRow({ repliedByUserId: 'user-7' }),
        repliedByName: 'Fatima',
      },
    ]);

    const thread = await service.getThread(workspaceId, userId, threadKey);

    expect(thread.rootComments[0].repliedBy).toEqual({
      id: 'user-7',
      name: 'Fatima',
    });
  });

  it('leaves repliedBy off an inbound comment', async () => {
    mockThreadRows([
      {
        item: commentRow({
          fromMe: false,
          authorHandle: 'a_customer',
          repliedByUserId: null,
        }),
        repliedByName: null,
      },
    ]);

    const thread = await service.getThread(workspaceId, userId, threadKey);

    expect(thread.rootComments[0].repliedBy).toBeUndefined();
  });

  it('leaves repliedBy off when the teammate no longer exists', async () => {
    // The LEFT JOIN is what makes this row survive at all — an inner join
    // would drop the reply entirely once its author left the workspace.
    mockThreadRows([
      {
        item: commentRow({ repliedByUserId: 'user-gone' }),
        repliedByName: null,
      },
    ]);

    const thread = await service.getThread(workspaceId, userId, threadKey);

    expect(thread.rootComments).toHaveLength(1);
    expect(thread.rootComments[0].repliedBy).toBeUndefined();
  });

  it('keeps each reply matched to its own sender', async () => {
    // The map is keyed by item id; a single shared name would pass a
    // one-row test and be wrong the moment two people answer one post.
    mockThreadRows([
      {
        item: commentRow({
          id: 'item-1',
          platformItemId: 'c-1',
          repliedByUserId: 'user-7',
        }),
        repliedByName: 'Fatima',
      },
      {
        item: commentRow({
          id: 'item-2',
          platformItemId: 'c-2',
          repliedByUserId: 'user-9',
          platformCreatedAt: new Date('2026-09-01T11:00:00.000Z'),
        }),
        repliedByName: 'Bilal',
      },
    ]);

    const thread = await service.getThread(workspaceId, userId, threadKey);

    const byId = new Map(
      thread.rootComments.map((c) => [c.id, c.repliedBy?.name]),
    );
    expect(byId.get('item-1')).toBe('Fatima');
    expect(byId.get('item-2')).toBe('Bilal');
  });

  it('joins against users rather than filtering them out', async () => {
    const mocks = mockThreadRows([
      { item: commentRow(), repliedByName: null },
    ]);
    await service.getThread(workspaceId, userId, threadKey);

    // Asserted on the call itself: switching this to an inner join would keep
    // every test above passing on its happy path while silently dropping
    // replies whose author has left.
    expect(mocks.leftJoin).toHaveBeenCalled();
  });
});
