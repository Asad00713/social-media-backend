import { ChannelAudienceRefreshHandler } from './channel-audience-refresh.handler';
import { refreshAudience } from '../../../insights/audience/refresh';
import { latestFollowerCounts } from '../../../insights/audience/latest-followers';

jest.mock('../../../common/utils/encryption.util', () => ({
  decrypt: (v: string) => `dec(${v})`,
}));
jest.mock('../../../insights/audience/refresh', () => ({
  refreshAudience: jest.fn(),
}));
jest.mock('../../../insights/audience/latest-followers', () => ({
  latestFollowerCounts: jest.fn(),
}));

const refreshMock = refreshAudience as jest.Mock;
const followersMock = latestFollowerCounts as jest.Mock;

const CHANNEL = {
  id: 7,
  platform: 'instagram',
  platformAccountId: 'ig-1',
  accessToken: 'enc-tok',
  isActive: true,
  connectionStatus: 'connected',
};

const ROW = {
  status: 'ok',
  followerCount: 500,
  countries: [{ key: 'PK', value: 3 }],
  cities: [],
  ages: [],
  genders: [],
};

function make(channelRows: unknown[]) {
  const values = jest.fn();
  const onConflictDoUpdate = jest.fn(() => Promise.resolve(undefined));
  values.mockReturnValue({ onConflictDoUpdate });
  const db = {
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(channelRows) }),
      }),
    })),
    insert: jest.fn(() => ({ values })),
  };
  const clients = { ig: {}, th: {}, fb: {} };
  const handler = new ChannelAudienceRefreshHandler(
    clients.ig as never,
    clients.th as never,
    clients.fb as never,
    db as never,
  );
  return { handler, db, values, onConflictDoUpdate, clients };
}

describe('ChannelAudienceRefreshHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    followersMock.mockResolvedValue(new Map([[7, 500]]));
    refreshMock.mockResolvedValue(ROW);
  });

  it.each([
    ['missing', []],
    ['inactive', [{ ...CHANNEL, isActive: false }]],
    ['expired', [{ ...CHANNEL, connectionStatus: 'expired' }]],
    ['revoked', [{ ...CHANNEL, connectionStatus: 'revoked' }]],
  ])('skips a %s channel without refreshing or writing', async (_l, rows) => {
    const { handler, db } = make(rows);
    await expect(handler.handle({ channelId: 7 })).resolves.toEqual({
      ok: true,
      skipped: true,
    });
    expect(refreshMock).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('decrypts the token, refreshes with the latest follower count and upserts', async () => {
    const { handler, db, values, onConflictDoUpdate, clients } = make([
      CHANNEL,
    ]);
    await expect(handler.handle({ channelId: 7 })).resolves.toEqual({
      ok: true,
    });

    expect(followersMock).toHaveBeenCalledWith(db, [7]);
    expect(refreshMock).toHaveBeenCalledWith(
      {
        platform: 'instagram',
        platformAccountId: 'ig-1',
        accessToken: 'dec(enc-tok)',
        followersCount: 500,
      },
      { instagram: clients.ig, threads: clients.th, facebook: clients.fb },
    );
    const [inserted] = (values.mock.calls as unknown[][])[0] as [
      Record<string, unknown>,
    ];
    expect(inserted).toMatchObject({ channelId: 7, ...ROW });
    expect(inserted.fetchedAt).toBeInstanceOf(Date);
    const [upsert] = (
      onConflictDoUpdate.mock.calls as unknown as Array<
        [{ set: Record<string, unknown> }]
      >
    )[0];
    expect(upsert.set).toMatchObject(ROW);
    expect(upsert.set.fetchedAt).toBeInstanceOf(Date);
  });

  it('passes null followers when no snapshot is known', async () => {
    followersMock.mockResolvedValue(new Map([[7, null]]));
    const { handler } = make([CHANNEL]);
    await handler.handle({ channelId: 7 });
    const [arg] = refreshMock.mock.calls[0] as [
      { followersCount: number | null },
    ];
    expect(arg.followersCount).toBeNull();
  });

  it('still upserts a permanent-error row and does not throw', async () => {
    const failed = { ...ROW, status: 'failed', countries: [] };
    refreshMock.mockResolvedValue(failed);
    const { handler, values } = make([CHANNEL]);
    await expect(handler.handle({ channelId: 7 })).resolves.toEqual({
      ok: true,
    });
    expect((values.mock.calls as unknown[][])[0][0]).toMatchObject({
      channelId: 7,
      status: 'failed',
      countries: [],
    });
  });

  it.each(['transient', 'rate_limited'])(
    'rejects on a %s platform error and writes nothing, so BullMQ retries',
    async (code) => {
      const err = Object.assign(new Error('try later'), { code });
      refreshMock.mockRejectedValue(err);
      const { handler, db } = make([CHANNEL]);
      await expect(handler.handle({ channelId: 7 })).rejects.toBe(err);
      expect(db.insert).not.toHaveBeenCalled();
    },
  );
});
