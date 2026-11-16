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
  // The reconnect writes inside a transaction (a revival takes the account
  // lock there); the double runs it on itself.
  transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(mockDb)),
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
  billing: Partial<
    Record<
      'ownerOf' | 'releaseFreedSlots' | 'enforceWithinTransaction',
      jest.Mock
    >
  > = {},
) {
  const accountChannels = {
    ownerOf: billing.ownerOf ?? jest.fn(async () => 'owner-1'),
    releaseFreedSlots:
      billing.releaseFreedSlots ?? jest.fn(async () => undefined),
    enforceWithinTransaction:
      billing.enforceWithinTransaction ?? jest.fn(async () => undefined),
  };
  const heldPosts = {
    releaseAfterReconnect: jest.fn(async () => ({
      resumedCount: 0,
      overdueCount: 0,
      missedCount: 0,
      stillPausedCount: 0,
    })),
  };
  const svc = new ChannelService(
    {} as never,
    { onChannelConnected: jest.fn(async () => undefined) } as never,
    {} as never,
    accountChannels as never,
    {} as never,
    heldPosts as never,
  );
  const increment = jest.fn(async () => undefined);
  (svc as unknown as { incrementChannelCount: jest.Mock }).incrementChannelCount =
    increment;
  return { svc, accountChannels, heldPosts, increment };
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

describe('reconnecting a channel the user disconnected (revival)', () => {
  const disconnected = (over: Record<string, unknown> = {}) =>
    row({
      isActive: true,
      connectionStatus: 'disconnected',
      disconnectedAt: new Date('2026-11-01T10:00:00Z'),
      disconnectedByUserId: 'u9',
      statusBeforeDisconnect: 'connected',
      disconnectFinalizedAt: new Date('2026-11-01T10:10:00Z'),
      accessToken: '',
      ...over,
    });

  it('revives the same row: marks cleared, slot taken under the account lock, held posts released', async () => {
    existing = disconnected();
    const { svc, accountChannels, heldPosts, increment } = make();
    const dto = await reconnect(svc);

    expect(dto.id).toBe(7);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      connectionStatus: 'connected',
      disconnectedAt: null,
      disconnectedByUserId: null,
      statusBeforeDisconnect: null,
      disconnectFinalizedAt: null,
      connectedByUserId: 'u1',
    });
    expect(accountChannels.enforceWithinTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'owner-1',
    );
    expect(increment).toHaveBeenCalledWith('ws', expect.anything());
    expect(heldPosts.releaseAfterReconnect).toHaveBeenCalledWith(
      'ws',
      7,
      10 * 60 * 1000,
    );
  });

  it('refuses at the ceiling and writes nothing', async () => {
    existing = disconnected();
    const limit = Object.assign(new Error('Channel limit reached'), {
      code: 'CHANNEL_LIMIT_REACHED',
    });
    const { svc, heldPosts, increment } = make({
      enforceWithinTransaction: jest.fn(async () => {
        throw limit;
      }),
    });
    await expect(reconnect(svc)).rejects.toBe(limit);
    expect(writes).toHaveLength(0);
    expect(increment).not.toHaveBeenCalled();
    expect(heldPosts.releaseAfterReconnect).not.toHaveBeenCalled();
  });

  it('a broken (not disconnected) channel reconnects without the ceiling or a count change', async () => {
    existing = row({ isActive: true });
    const { svc, accountChannels, heldPosts, increment } = make();
    await reconnect(svc);
    expect(accountChannels.enforceWithinTransaction).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
    expect(heldPosts.releaseAfterReconnect).not.toHaveBeenCalled();
    expect('disconnectedAt' in writes[0]).toBe(false);
  });

  it('a re-added Telegram bot takes its fresh webhook route', async () => {
    existing = disconnected({ platform: 'telegram', telegramWebhookRouteId: 'old' });
    const { svc } = make();
    await svc.createChannel('ws', 'u1', {
      platform: 'telegram',
      accountType: 'bot',
      platformAccountId: 'acc',
      accountName: 'Bot',
      accessToken: 'tok',
      telegramWebhookRouteId: 'fresh',
    } as never);
    expect(writes[0].telegramWebhookRouteId).toBe('fresh');
  });
});

describe('reconnecting a must-delete channel its finalize is deleting', () => {
  it('is refused (409 CHANNEL_BEING_REMOVED) and writes nothing', async () => {
    existing = row({
      platform: 'youtube',
      isActive: true,
      connectionStatus: 'disconnected',
      disconnectedAt: new Date('2026-11-01T10:00:00Z'),
      disconnectFinalizedAt: new Date('2026-11-01T10:10:00Z'),
    });
    const { svc, heldPosts } = make();
    const err = await reconnect(svc, 'youtube').catch((e: unknown) => e);
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      code: 'CHANNEL_BEING_REMOVED',
    });
    expect(writes).toHaveLength(0);
    expect(heldPosts.releaseAfterReconnect).not.toHaveBeenCalled();
  });
});
