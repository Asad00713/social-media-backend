/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- service doubles; jest.fn calls are untyped */
import { ForbiddenException } from '@nestjs/common';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

/**
 * X is paid-only: a free workspace may not add a NEW X channel. The invariant
 * is about the WRITE - createChannel is the one place every connect path
 * (OAuth callback, connect links, /twitter/connect, complete-oauth) inserts a
 * channel, so a refused connect must leave no row behind, whatever started it.
 * Reconnecting an X channel the workspace already holds stays allowed.
 */

/** What the duplicate check finds ([] = a new channel). */
let existing: Record<string, unknown>[];
let inserted: Record<string, unknown>[];
let updates: Record<string, unknown>[];

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

const storedRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  workspaceId: 'ws',
  platform: 'twitter',
  category: 'social',
  accountType: 'profile',
  platformAccountId: 'x-1',
  accountName: 'X account',
  accessToken: 'enc',
  refreshToken: null,
  tokenExpiresAt: null,
  refreshTokenIssuedAt: null,
  isActive: true,
  pausedAt: null,
  pausedByUserId: null,
  connectionStatus: 'expired', // unhealthy -> reconnect path
  lastError: 'Token expired',
  metadata: {},
  connectedByUserId: 'u1',
  displayOrder: 1,
  connectLinkId: null,
  addedViaLinkAt: null,
  addedViaLinkEmail: null,
  disconnectedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const mockDb = {
  select: jest.fn((fields?: unknown) => ({
    from: (table: unknown) => ({
      where: () =>
        chain(() => {
          if (table !== socialMediaChannels) return [];
          return fields ? [{ maxOrder: 1 }] : existing;
        }),
    }),
  })),
  update: jest.fn(() => ({
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      return { where: () => chain(() => [{ ...(existing[0] ?? {}), ...v }]) };
    },
  })),
  insert: jest.fn(() => ({
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return chain(() => [storedRow({ ...v, id: 9 })]);
    },
  })),
  transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(mockDb)),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { ChannelService } from './channel.service';
import { AccountChannelsService } from '../../billing/services/account-channels.service';

function make(subscription: Record<string, unknown> | null) {
  // The REAL gate, reading the owner's plan through a stubbed lookup; only the
  // advisory-lock ceiling (covered by its own specs) is taken out.
  const accountChannels = new AccountChannelsService({
    findByUserId: jest.fn(async () => subscription),
    getOwnerId: jest.fn(async () => 'owner-1'),
  } as never);
  jest
    .spyOn(accountChannels, 'enforceWithinTransaction')
    .mockResolvedValue(undefined);
  jest
    .spyOn(accountChannels, 'releaseFreedSlots')
    .mockResolvedValue([] as never);
  const svc = new ChannelService(
    {} as never,
    { onChannelConnected: jest.fn(async () => undefined) } as never,
    {} as never,
    accountChannels,
    {} as never,
    {} as never,
  );
  (svc as any).incrementChannelCount = jest.fn(async () => undefined);
  (svc as any).migrateOrphanedPostTargets = jest.fn(async () => undefined);
  return svc;
}

const FREE = { id: 1, planCode: 'FREE', status: 'active' };
const PRO = { id: 1, planCode: 'PRO', status: 'active' };

const xDto = {
  platform: 'twitter',
  accountType: 'profile',
  platformAccountId: 'x-1',
  accountName: 'X account',
  accessToken: 'tok',
} as const;

const linkedinDto = {
  platform: 'linkedin',
  accountType: 'profile',
  platformAccountId: 'li-1',
  accountName: 'LinkedIn',
  accessToken: 'tok',
} as const;

beforeEach(() => {
  existing = [];
  inserted = [];
  updates = [];
});

describe('ChannelService.createChannel - X is paid-only', () => {
  it('refuses a new X channel on a FREE workspace and writes no row', async () => {
    const err = await make(FREE)
      .createChannel('ws', 'u1', xDto)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      statusCode: 403,
      code: 'PLAN_UPGRADE_REQUIRED',
      feature: 'x',
      message: 'X is available on paid plans.',
    });
    expect(inserted).toHaveLength(0);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('refuses it with no subscription, and for a connect link too', async () => {
    const err = await make(null)
      .createChannel('ws', 'u1', xDto, {
        connectLink: { linkId: 'link-1', email: null },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(inserted).toHaveLength(0);
  });

  it('adds a new X channel on a paid workspace', async () => {
    const out = await make(PRO).createChannel('ws', 'u1', xDto);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      platform: 'twitter',
      platformAccountId: 'x-1',
    });
    expect(out.id).toBe(9);
  });

  it('lets a FREE workspace reconnect the X channel it already holds', async () => {
    existing = [storedRow()];
    await make(FREE).createChannel('ws', 'u1', xDto);
    expect(inserted).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ connectionStatus: 'connected' });
  });

  it('lets a FREE workspace revive its disconnected X channel', async () => {
    existing = [
      storedRow({
        connectionStatus: 'disconnected',
        disconnectedAt: new Date(),
      }),
    ];
    await make(FREE).createChannel('ws', 'u1', xDto);
    expect(inserted).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it('leaves other platforms on a FREE workspace unaffected', async () => {
    await make(FREE).createChannel('ws', 'u1', linkedinDto);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ platform: 'linkedin' });
  });
});
