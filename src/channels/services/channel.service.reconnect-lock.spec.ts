/* eslint-disable @typescript-eslint/require-await -- service doubles */
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

/** The row the reconnect finds; the row billing leaves behind. */
let existing: Record<string, unknown>;
let afterBilling: Record<string, unknown> | null;
let writes: Record<string, unknown>[];

const chain = (rows: () => unknown[]) => {
  const p: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej),
    limit: () => chain(rows),
    orderBy: () => chain(rows),
    returning: () => chain(rows),
  };
  return p;
};

let selects: number;
const mockDb = {
  select: jest.fn(() => ({
    from: (table: unknown) => ({
      where: () =>
        chain(() => {
          if (table !== socialMediaChannels) return []; // users lookup
          selects++;
          // 1st: the duplicate check; later: the re-read after billing.
          return selects === 1 ? [existing] : [afterBilling ?? existing];
        }),
    }),
  })),
  update: jest.fn(() => ({
    set: (v: Record<string, unknown>) => {
      writes.push(v);
      return { where: () => chain(() => [{ ...existing, ...v }]) };
    },
  })),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { ChannelService } from './channel.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 7,
  workspaceId: 'ws',
  platform: 'bluesky',
  category: 'social',
  accountType: 'profile',
  platformAccountId: 'acc',
  accountName: 'Bluesky',
  accessToken: 'enc',
  refreshToken: null,
  tokenExpiresAt: null,
  refreshTokenIssuedAt: null,
  isActive: false, // locked by the plan
  pausedAt: null,
  pausedByUserId: null,
  connectionStatus: 'expired',
  lastError: 'Token expired',
  metadata: {},
  connectedByUserId: 'u1',
  displayOrder: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function make(
  billing: Partial<Record<'ownerOf' | 'releaseFreedSlots', jest.Mock>> = {},
) {
  const accountChannels = {
    ownerOf: billing.ownerOf ?? jest.fn(async () => 'owner-1'),
    releaseFreedSlots:
      billing.releaseFreedSlots ?? jest.fn(async () => undefined),
  };
  const svc = new ChannelService(
    {} as never,
    { onChannelConnected: jest.fn(async () => undefined) } as never,
    {} as never,
    accountChannels as never,
  );
  return { svc, accountChannels };
}

const reconnect = (svc: ChannelService, platform = 'bluesky') =>
  svc.createChannel('ws', 'u1', {
    platform,
    accountType: 'profile',
    platformAccountId: 'acc',
    accountName: 'Bluesky',
    accessToken: 'new-token',
  } as never);

beforeEach(() => {
  writes = [];
  selects = 0;
  afterBilling = null;
});

describe('reconnecting a plan-locked channel', () => {
  it('never writes is_active, and leaves the decision to billing', async () => {
    existing = row();
    const { svc, accountChannels } = make();
    const dto = await reconnect(svc);

    expect(writes).toHaveLength(1);
    expect('isActive' in writes[0]).toBe(false);
    expect(writes[0].connectionStatus).toBe('connected');
    expect(accountChannels.ownerOf).toHaveBeenCalledWith('ws');
    expect(accountChannels.releaseFreedSlots).toHaveBeenCalledWith('owner-1');
    // Billing kept it locked (over the ceiling): it stays locked.
    expect(dto.isActive).toBe(false);
  });

  it('comes back only when billing releases it', async () => {
    existing = row();
    afterBilling = row({ isActive: true, connectionStatus: 'connected' });
    const { svc } = make();
    const dto = await reconnect(svc);
    expect(dto.isActive).toBe(true);
  });

  it('stays locked when the billing check fails', async () => {
    existing = row();
    const { svc } = make({
      releaseFreedSlots: jest.fn(async () => {
        throw new Error('db down');
      }),
    });
    const dto = await reconnect(svc);
    expect(dto.isActive).toBe(false);
  });

  it('an active channel being reconnected does not run the lock pass', async () => {
    existing = row({ isActive: true });
    const { svc, accountChannels } = make();
    const dto = await reconnect(svc);
    expect(accountChannels.releaseFreedSlots).not.toHaveBeenCalled();
    expect('isActive' in writes[0]).toBe(false);
    expect(dto.isActive).toBe(true);
  });

  it('an integration (never holds a slot) keeps its flag and skips billing', async () => {
    existing = row({ platform: 'google_drive', accountType: 'storage' });
    const { svc, accountChannels } = make();
    const dto = await reconnect(svc, 'google_drive');
    expect(accountChannels.releaseFreedSlots).not.toHaveBeenCalled();
    expect(dto.isActive).toBe(false);
  });
});
