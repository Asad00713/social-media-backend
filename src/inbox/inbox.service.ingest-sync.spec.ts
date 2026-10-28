// InboxService imports `db` as a module-level singleton, so jest.mock the
// module with a chainable fake: `select` resolves the scripted pre-read,
// `insert...returning` resolves the scripted upserted row, `update` records
// every statement in call order.
const calls: string[] = [];
let preRead: Array<{ threadKey: string | null; fromMe: boolean }> = [];
let upserted: Array<Record<string, unknown>> = [];
let insertedValues: Record<string, unknown> | null = null;

function chain(
  result: () => unknown,
  onCall?: (name: string, args: unknown[]) => void,
) {
  const c: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown) => res(result());
        }
        return (...args: unknown[]) => {
          onCall?.(prop, args);
          return c;
        };
      },
    },
  );
  return c;
}

jest.mock('../drizzle/db', () => ({
  db: {
    select: jest.fn(() => chain(() => preRead)),
    insert: jest.fn(() =>
      chain(
        () => upserted,
        (name, args) => {
          if (name === 'values') insertedValues = args[0] as any;
        },
      ),
    ),
    execute: jest.fn(async () => ({
      rows: [
        { channel_id: 7, workspace_id: 'ws-1', thread_key: '7:p1' },
        { channel_id: 7, workspace_id: 'ws-1', thread_key: '7:p1' },
        { channel_id: 7, workspace_id: 'ws-1', thread_key: '7:conv' },
      ],
    })),
    update: jest.fn(() =>
      chain(
        () => undefined,
        (name, args) => {
          if (name === 'set') {
            calls.push(`set:${Object.keys(args[0] as object).join(',')}`);
          }
        },
      ),
    ),
    query: {
      users: {
        findFirst: jest.fn(async () => ({
          id: 'u1',
          name: 'Sam',
          avatarUrl: null,
        })),
      },
      socialMediaChannels: {
        findFirst: jest.fn(async () => ({
          username: 'me',
          accountName: 'Me',
          profilePictureUrl: null,
        })),
      },
    },
  },
}));

import { InboxService } from './inbox.service';

const WS = 'ws-1';
const CH = 7;
const NOW = new Date('2026-10-26T10:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    workspaceId: WS,
    channelId: CH,
    platform: 'threads',
    type: 'comment',
    platformItemId: 'c1',
    platformParentId: null,
    platformPostId: 'p1',
    conversationId: null,
    threadKey: `${CH}:p1`,
    fromMe: false,
    authoredByUserId: null,
    status: 'unread',
    text: 'hi',
    authorHandle: 'ana',
    authorDisplayName: 'Ana',
    authorAvatarUrl: null,
    metadata: {},
    platformCreatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    inserted: true,
    ...over,
  };
}

const dmRow = (over: Record<string, unknown> = {}) =>
  row({
    type: 'dm',
    platform: 'instagram',
    platformPostId: null,
    conversationId: 'conv',
    threadKey: `${CH}:conv`,
    platformItemId: 'm1',
    ...over,
  });

function build() {
  const emitter = { emit: jest.fn() };
  const sync = {
    syncThread: jest.fn(async (..._a: unknown[]) => {
      calls.push('syncThread');
      return { conversationId: 'conv-1' };
    }),
    rekey: jest.fn(async (..._a: unknown[]) => {
      calls.push('rekey');
    }),
    syncThreads: jest.fn(async () => []),
  };
  const realtime = { timelineAppended: jest.fn(), countsChanged: jest.fn() };
  const service = new InboxService(
    emitter as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    realtime as never,
    sync as never,
  );
  return { service, sync, realtime, emitter };
}

const commentInput = {
  workspaceId: WS,
  channelId: CH,
  platform: 'threads' as const,
  platformItemId: 'c1',
  platformPostId: 'p1',
  text: 'hi',
  platformCreatedAt: NOW,
};

const dmInput = {
  workspaceId: WS,
  channelId: CH,
  platform: 'instagram' as const,
  conversationId: 'conv',
  platformItemId: 'm1',
  text: 'hello',
  platformCreatedAt: NOW,
};

beforeEach(() => {
  calls.length = 0;
  preRead = [];
  upserted = [];
  insertedValues = null;
});

describe('InboxService ingest -> syncThread (R1)', () => {
  it('a new inbound comment syncs its thread once and appends a comment timeline event', async () => {
    const { service, sync, realtime } = build();
    upserted = [row()];
    await service.upsertComment(commentInput as never);
    expect(sync.syncThread).toHaveBeenCalledTimes(1);
    expect(sync.syncThread).toHaveBeenCalledWith(WS, `${CH}:p1`, {
      kind: 'refresh',
    });
    expect(realtime.timelineAppended).toHaveBeenCalledWith(
      WS,
      'conv-1',
      null,
      'row-1',
    );
  });

  it('a merge that keeps the key and from_me does not sync', async () => {
    const { service, sync, realtime } = build();
    preRead = [{ threadKey: `${CH}:p1`, fromMe: false }];
    upserted = [row({ inserted: false })];
    await service.upsertComment(commentInput as never);
    expect(sync.syncThread).not.toHaveBeenCalled();
    expect(sync.rekey).not.toHaveBeenCalled();
    expect(realtime.timelineAppended).not.toHaveBeenCalled();
  });

  it('a merge that flips from_me syncs', async () => {
    const { service, sync } = build();
    preRead = [{ threadKey: `${CH}:p1`, fromMe: false }];
    upserted = [row({ inserted: false, fromMe: true })];
    await service.upsertComment(commentInput as never);
    expect(sync.syncThread).toHaveBeenCalledTimes(1);
  });

  it('a mention upgraded to a comment moves our replies and re-keys', async () => {
    const { service, sync } = build();
    preRead = [{ threadKey: `${CH}:mention:m7`, fromMe: false }];
    upserted = [
      row({
        inserted: false,
        platformItemId: 'm7',
        platformPostId: 'p9',
        threadKey: `${CH}:p9`,
      }),
    ];
    await service.upsertComment({
      ...commentInput,
      platformItemId: 'm7',
      platformPostId: 'p9',
    } as never);
    expect(sync.rekey).toHaveBeenCalledWith(WS, `${CH}:mention:m7`, `${CH}:p9`);
    expect(calls).toContain('set:platformPostId');
    expect(calls.indexOf('set:platformPostId')).toBeLessThan(
      calls.indexOf('rekey'),
    );
  });

  it('a new from_me dm without an author marks the thread replied BEFORE syncing (R5)', async () => {
    const { service, sync } = build();
    upserted = [dmRow({ fromMe: true })];
    await service.upsertDm({ ...dmInput, fromMe: true });
    expect(calls.indexOf('set:repliedAt')).toBeGreaterThan(-1);
    expect(calls.indexOf('set:repliedAt')).toBeLessThan(
      calls.indexOf('syncThread'),
    );
    expect(sync.syncThread).toHaveBeenCalledWith(WS, `${CH}:conv`, {
      kind: 'refresh',
    });
  });

  it('a new from_me comment without an author marks the parent comment replied (R5)', async () => {
    const { service } = build();
    upserted = [
      row({ fromMe: true, platformItemId: 'r1', platformParentId: 'c1' }),
    ];
    await service.upsertComment({
      ...commentInput,
      platformItemId: 'r1',
      platformParentId: 'c1',
      fromMe: true,
    } as never);
    expect(calls).toContain('set:repliedAt');
  });

  it('a from_me dm WITH authoredByUserId issues no R5 update and broadcasts sentBy', async () => {
    const { service, realtime } = build();
    upserted = [dmRow({ fromMe: true, authoredByUserId: 'u1' })];
    await service.upsertDm({
      ...dmInput,
      fromMe: true,
      authoredByUserId: 'u1',
    });
    expect(calls).not.toContain('set:repliedAt');
    expect(realtime.timelineAppended).toHaveBeenCalledWith(
      WS,
      'conv-1',
      expect.objectContaining({
        kind: 'message',
        from: 'me',
        canDelete: false,
        sentBy: { id: 'u1', name: 'Sam', avatarUrl: null },
      }),
      null,
    );
  });

  it('a new inbound dm appends a message entry', async () => {
    const { service, realtime } = build();
    upserted = [dmRow()];
    await service.upsertDm(dmInput);
    expect(realtime.timelineAppended).toHaveBeenCalledWith(
      WS,
      'conv-1',
      expect.objectContaining({ kind: 'message', from: 'them', id: 'row-1' }),
      null,
    );
  });

  it('recordOutgoingDiscordMessage forwards authoredByUserId into the insert', async () => {
    const { service } = build();
    upserted = [
      dmRow({
        platform: 'discord',
        conversationId: 'dc',
        threadKey: `${CH}:dc`,
        platformItemId: 'd1',
        fromMe: true,
        authoredByUserId: 'u1',
      }),
    ];
    await service.recordOutgoingDiscordMessage({
      workspaceId: WS,
      channelId: CH,
      conversationId: 'dc',
      platformItemId: 'd1',
      text: 'yo',
      authoredByUserId: 'u1',
    });
    expect(insertedValues).toMatchObject({ authoredByUserId: 'u1' });
  });

  it('a sync failure does not fail the ingest', async () => {
    const { service, sync } = build();
    sync.syncThread.mockRejectedValueOnce(new Error('boom'));
    upserted = [row()];
    await expect(
      service.upsertComment(commentInput as never),
    ).resolves.toBeTruthy();
  });

  it('a Discord gateway delete re-syncs the deleted message thread', async () => {
    const { service, sync } = build();
    preRead = [];
    const { db } = jest.requireMock('../drizzle/db');
    db.select.mockReturnValueOnce(
      chain(() => [
        { id: 'row-1', channelId: CH, threadKey: `${CH}:dc`, metadata: {} },
      ]),
    );
    await service.softDeleteDmByPlatformItemId({
      workspaceId: WS,
      channelId: CH,
      platformItemId: 'd1',
    });
    expect(sync.syncThreads).toHaveBeenCalledWith(WS, [`${CH}:dc`]);
  });

  it('the orphan cleanup re-syncs every deleted row thread', async () => {
    const { service, sync } = build();
    await service.cleanupOrphanedThreadKeysForWorkspace(WS);
    expect(sync.syncThreads).toHaveBeenCalledWith(WS, [
      '7:p1',
      '7:p1',
      '7:conv',
    ]);
  });
});
