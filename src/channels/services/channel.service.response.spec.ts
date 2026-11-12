import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { users } from '../../drizzle/schema/users.schema';

let channelRows: unknown[];
let userRows: unknown[];
let userQueries: number;

const chain = (rows: () => unknown[]) => {
  const p: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej),
    orderBy: () => chain(rows),
    limit: () => chain(rows),
  };
  return p;
};

const mockDb = {
  select: jest.fn(() => ({
    from: (table: unknown) => ({
      where: () =>
        chain(() => {
          if (table === users) {
            userQueries++;
            return userRows;
          }
          return table === socialMediaChannels ? channelRows : [];
        }),
    }),
  })),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { ChannelService } from './channel.service';

const channel = (over: Record<string, unknown> = {}) => ({
  id: 7,
  workspaceId: 'ws',
  platform: 'google_drive',
  category: 'social', // stale stored value; the platform decides
  accountType: 'storage',
  platformAccountId: 'acc',
  accountName: 'Drive',
  username: null,
  profilePictureUrl: null,
  accessToken: 'enc',
  refreshToken: null,
  tokenExpiresAt: null,
  refreshTokenIssuedAt: null,
  permissions: [],
  capabilities: null,
  isActive: true,
  pausedAt: null,
  pausedByUserId: null,
  connectionStatus: 'connected',
  lastError: null,
  lastSyncedAt: null,
  lastPostedAt: null,
  metadata: {},
  connectedByUserId: 'u1',
  displayOrder: 1,
  timezone: 'UTC',
  color: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const svc = () =>
  new ChannelService({} as never, {} as never, {} as never, {} as never);

beforeEach(() => {
  userQueries = 0;
  userRows = [
    { id: 'u1', name: 'Asad', email: 'asad@example.test' },
    { id: 'u2', name: null, email: 'sana@example.test' },
  ];
});

describe('ChannelResponseDto additions', () => {
  it('adds category from the platform, pausedAt/pausedBy and connectedBy, in one users query', async () => {
    const pausedAt = new Date('2026-11-10T08:00:00Z');
    channelRows = [
      channel(),
      channel({
        id: 8,
        platform: 'bluesky',
        category: 'social',
        pausedAt,
        pausedByUserId: 'u2',
        connectedByUserId: 'u2',
      }),
    ];
    const [drive, bsky] = await svc().getWorkspaceChannels('ws');

    expect(drive).toMatchObject({
      category: 'integration',
      pausedAt: null,
      pausedBy: null,
      connectedBy: { id: 'u1', name: 'Asad' },
    });
    expect(bsky).toMatchObject({
      category: 'social',
      pausedAt,
      pausedBy: { id: 'u2', name: 'sana' },
      connectedBy: { id: 'u2', name: 'sana' },
    });
    // Existing fields are untouched.
    expect(bsky).toMatchObject({ id: 8, isActive: true, accountName: 'Drive' });
    expect(userQueries).toBe(1);
  });

  it('a user who is gone reads as null; a pauser id without a pause is ignored', async () => {
    channelRows = [
      channel({ connectedByUserId: 'gone', pausedByUserId: 'u1' }),
    ];
    const [dto] = await svc().getWorkspaceChannels('ws');
    expect(dto.connectedBy).toBeNull();
    expect(dto.pausedBy).toBeNull();
  });

  it('getChannelById carries the same fields', async () => {
    channelRows = [channel({ pausedAt: new Date(), pausedByUserId: 'u1' })];
    const dto = await svc().getChannelById(7, 'ws');
    expect(dto.pausedBy).toEqual({ id: 'u1', name: 'Asad' });
    expect(dto.category).toBe('integration');
  });
});
