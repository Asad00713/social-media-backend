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
  const onConflictDoUpdate = jest.fn(async () => undefined);
  values.mockReturnValue({ onConflictDoUpdate });
  const db = {
    select: jest.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => channelRows }) }),
    })),
    insert: jest.fn(() => ({ values })),
  };
  const clients = { ig: {}, th: {}, fb: {} };
  const handler = new ChannelAudienceRefreshHandler(
    clients.ig as any,
    clients.th as any,
    clients.fb as any,
    db,
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
    const inserted = values.mock.calls[0][0];
    expect(inserted).toMatchObject({ channelId: 7, ...ROW });
    expect(inserted.fetchedAt).toBeInstanceOf(Date);
    const upsert = (onConflictDoUpdate.mock.calls as any[][])[0][0];
    expect(upsert.set).toMatchObject(ROW);
    expect(upsert.set.fetchedAt).toBeInstanceOf(Date);
  });

  it('passes null followers when no snapshot is known', async () => {
    followersMock.mockResolvedValue(new Map([[7, null]]));
    const { handler } = make([CHANNEL]);
    await handler.handle({ channelId: 7 });
    expect(refreshMock.mock.calls[0][0].followersCount).toBeNull();
  });

  it('still upserts a platform-error row and does not throw', async () => {
    const failed = { ...ROW, status: 'failed', countries: [] };
    refreshMock.mockResolvedValue(failed);
    const { handler, values } = make([CHANNEL]);
    await expect(handler.handle({ channelId: 7 })).resolves.toEqual({
      ok: true,
    });
    expect(values.mock.calls[0][0]).toMatchObject({
      channelId: 7,
      status: 'failed',
      countries: [],
    });
  });
});
