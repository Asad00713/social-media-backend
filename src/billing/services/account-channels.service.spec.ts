import { ForbiddenException } from '@nestjs/common';
import { AccountChannelsService } from './account-channels.service';
import { UNLIMITED } from './limit-resolver.util';

/**
 * Channels are pooled across the account, so these tests are about the ACCOUNT
 * ceiling — not a per-workspace one. The DB-touching methods are covered by
 * stubbing the two seams the service actually depends on.
 */

type Lookup = {
  findByUserId: jest.Mock;
  getPlanLimits: jest.Mock;
  getAddonQuantities: jest.Mock;
  getOwnerId: jest.Mock;
};

const PRO_LIMITS = {
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  maxWorkspaces: 3,
  aiTokensPerMonth: 20000,
  queuedPostsPerChannel: UNLIMITED,
};

const NO_ADDONS = {
  extraChannels: 0,
  extraMembers: 0,
  extraWorkspaces: 0,
  extraAiTokens: 0,
};

function makeService(lookupOverrides: Partial<Lookup> = {}) {
  const lookup: Lookup = {
    findByUserId: jest
      .fn()
      .mockResolvedValue({ id: 1, planCode: 'PRO', status: 'active' }),
    getPlanLimits: jest.fn().mockResolvedValue(PRO_LIMITS),
    getAddonQuantities: jest.fn().mockResolvedValue(NO_ADDONS),
    getOwnerId: jest.fn().mockResolvedValue('user-1'),
    ...lookupOverrides,
  };
  const service = new AccountChannelsService(lookup as never);
  return { service, lookup };
}

describe('AccountChannelsService.limitForUser', () => {
  it('is the plan allowance when nothing extra was bought', async () => {
    const { service } = makeService();
    await expect(service.limitForUser('user-1')).resolves.toBe(8);
  });

  // The pooled model's whole point: buying channels raises ONE account-wide
  // ceiling, not a per-workspace one.
  it('adds purchased channels to the account ceiling', async () => {
    const { service } = makeService({
      getAddonQuantities: jest
        .fn()
        .mockResolvedValue({ ...NO_ADDONS, extraChannels: 3 }),
    });
    await expect(service.limitForUser('user-1')).resolves.toBe(11);
  });

  it('falls back to FREE when there is no subscription', async () => {
    const { service, lookup } = makeService({
      findByUserId: jest.fn().mockResolvedValue(null),
      getPlanLimits: jest
        .fn()
        .mockResolvedValue({ ...PRO_LIMITS, channelsPerWorkspace: 3 }),
    });
    await expect(service.limitForUser('user-1')).resolves.toBe(3);
    expect(lookup.getPlanLimits).toHaveBeenCalledWith('FREE');
  });

  it('falls back to FREE when the subscription is not active', async () => {
    const { service, lookup } = makeService({
      findByUserId: jest
        .fn()
        .mockResolvedValue({ id: 1, planCode: 'MAX', status: 'past_due' }),
      getPlanLimits: jest
        .fn()
        .mockResolvedValue({ ...PRO_LIMITS, channelsPerWorkspace: 3 }),
    });
    await expect(service.limitForUser('user-1')).resolves.toBe(3);
    expect(lookup.getPlanLimits).toHaveBeenCalledWith('FREE');
  });

  it('passes the unlimited sentinel through without arithmetic', async () => {
    const { service } = makeService({
      getPlanLimits: jest
        .fn()
        .mockResolvedValue({ ...PRO_LIMITS, channelsPerWorkspace: UNLIMITED }),
      getAddonQuantities: jest
        .fn()
        .mockResolvedValue({ ...NO_ADDONS, extraChannels: 5 }),
    });
    await expect(service.limitForUser('user-1')).resolves.toBe(UNLIMITED);
  });
});

describe('AccountChannelsService.enforceWithinTransaction', () => {
  function makeTx() {
    const executed: string[] = [];
    return {
      executed,
      tx: {
        execute: jest.fn(async (q: unknown) => {
          executed.push(JSON.stringify(q));
          return undefined;
        }),
      },
    };
  }

  it('takes the advisory lock BEFORE reading the count', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'countForUser').mockResolvedValue(2);
    const { tx } = makeTx();

    await service.enforceWithinTransaction(tx, 'user-1');

    // The lock must be acquired first, or two concurrent connects could both
    // read the same pre-insert count and both be allowed.
    expect(tx.execute).toHaveBeenCalledTimes(1);
    const lockCallOrder = tx.execute.mock.invocationCallOrder[0];
    const countCallOrder = (service.countForUser as jest.Mock).mock
      .invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(countCallOrder);
  });

  it('allows a connect below the ceiling', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'countForUser').mockResolvedValue(7);
    const { tx } = makeTx();

    await expect(
      service.enforceWithinTransaction(tx, 'user-1'),
    ).resolves.toBeUndefined();
  });

  it('refuses a connect exactly at the ceiling', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'countForUser').mockResolvedValue(8);
    const { tx } = makeTx();

    await expect(
      service.enforceWithinTransaction(tx, 'user-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never refuses on an unlimited plan', async () => {
    const { service } = makeService({
      getPlanLimits: jest
        .fn()
        .mockResolvedValue({ ...PRO_LIMITS, channelsPerWorkspace: UNLIMITED }),
    });
    jest.spyOn(service, 'countForUser').mockResolvedValue(9999);
    const { tx } = makeTx();

    await expect(
      service.enforceWithinTransaction(tx, 'user-1'),
    ).resolves.toBeUndefined();
  });

  it('still takes the lock on an unlimited plan', async () => {
    const { service } = makeService({
      getPlanLimits: jest
        .fn()
        .mockResolvedValue({ ...PRO_LIMITS, channelsPerWorkspace: UNLIMITED }),
    });
    jest.spyOn(service, 'countForUser').mockResolvedValue(1);
    const { tx } = makeTx();

    await service.enforceWithinTransaction(tx, 'user-1');
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
});

describe('AccountChannelsService.getUsage', () => {
  it('reports what is left', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'countForUser').mockResolvedValue(5);

    await expect(service.getUsage('user-1')).resolves.toEqual({
      used: 5,
      limit: 8,
      available: 3,
    });
  });

  it('reports an effectively infinite allowance when unlimited', async () => {
    const { service } = makeService({
      getPlanLimits: jest
        .fn()
        .mockResolvedValue({ ...PRO_LIMITS, channelsPerWorkspace: UNLIMITED }),
    });
    jest.spyOn(service, 'countForUser').mockResolvedValue(40);

    const usage = await service.getUsage('user-1');
    expect(usage.limit).toBe(UNLIMITED);
    expect(usage.available).toBe(Number.MAX_SAFE_INTEGER);
  });
});
