import { ChannelInitialBackfillHandler } from './channel-initial-backfill.handler';

jest.mock('../../../common/utils/encryption.util', () => ({
  decrypt: (v: string) => v,
}));

const CHANNEL = {
  id: 7,
  platform: 'instagram',
  accessToken: 'tok',
  connectedByUserId: 'user-1',
};

/** A db whose successive select() calls resolve to the given row sets, in order. */
function fakeDb(selects: any[][]) {
  const queue = [...selects];
  const chain = () => ({
    from: () => ({
      where: () => ({ limit: async () => queue.shift() ?? [] }),
    }),
  });
  const upsert = {
    onConflictDoNothing: async () => undefined,
    onConflictDoUpdate: async () => undefined,
  };
  return {
    select: jest.fn(chain),
    insert: jest.fn(() => ({ values: jest.fn(() => upsert) })),
  };
}

function make(
  opts: {
    syncOk?: boolean;
    hasAdapter?: boolean;
    triggerThrows?: boolean;
  } = {},
) {
  const adapter = {
    estimateQuotaCost: () => 1,
    fetchProfileSnapshot: jest.fn(),
  };
  const registry = {
    has: jest.fn(() => opts.hasAdapter ?? true),
    get: jest.fn(() => adapter),
  };
  const quota = { tryConsume: jest.fn(async () => ({ allowed: true })) };
  const recentPostsSync = {
    handle: jest.fn(async () => ({
      ok: opts.syncOk ?? true,
      synced: 5,
      created: 5,
    })),
  };
  const firstWeek = {
    onChannelBackfilled: jest.fn(async () => {
      if (opts.triggerThrows) throw new Error('redis down');
      return 'started';
    }),
    onBackfillUnreadable: jest.fn(async () => {
      if (opts.triggerThrows) throw new Error('redis down');
      return 'needs_description';
    }),
  };
  // select #1 = the channel; select #2 = today's snapshot (present, so the profile re-fetch is skipped)
  const db = fakeDb([[CHANNEL], [{ channelId: 7 }]]);
  const handler = new ChannelInitialBackfillHandler(
    registry as any,
    quota as any,
    recentPostsSync as any,
    db as any,
    firstWeek as any,
  );
  return { handler, firstWeek, recentPostsSync };
}

describe('ChannelInitialBackfillHandler first-week hook', () => {
  it('starts the first week after a successful backfill', async () => {
    const { handler, firstWeek } = make();
    await handler.handle({ channelId: 7, workspaceId: 'w1' });
    expect(firstWeek.onChannelBackfilled).toHaveBeenCalledWith('w1', 'user-1');
  });

  it('does not start it when the recent-posts sync did not succeed (quota, auth), but offers Describe', async () => {
    const { handler, firstWeek } = make({ syncOk: false });
    await handler.handle({ channelId: 7, workspaceId: 'w1' });
    expect(firstWeek.onChannelBackfilled).not.toHaveBeenCalled();
    expect(firstWeek.onBackfillUnreadable).toHaveBeenCalledWith('w1');
  });

  it('does not start it for a channel with no adapter, but offers Describe', async () => {
    const { handler, firstWeek } = make({ hasAdapter: false });
    await handler.handle({ channelId: 7, workspaceId: 'w1' });
    expect(firstWeek.onChannelBackfilled).not.toHaveBeenCalled();
    expect(firstWeek.onBackfillUnreadable).toHaveBeenCalledWith('w1');
  });

  it('a throwing unreadable hook never fails the backfill', async () => {
    const { handler } = make({ syncOk: false, triggerThrows: true });
    await expect(
      handler.handle({ channelId: 7, workspaceId: 'w1' }),
    ).resolves.toEqual({ ok: true });
  });

  it('a throwing trigger never fails the backfill', async () => {
    const { handler } = make({ triggerThrows: true });
    await expect(
      handler.handle({ channelId: 7, workspaceId: 'w1' }),
    ).resolves.toEqual({ ok: true });
  });
});
