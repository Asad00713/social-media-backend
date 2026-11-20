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

  it('refuses with a machine-readable CHANNEL_LIMIT_REACHED body', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'countForUser').mockResolvedValue(8);
    const { tx } = makeTx();

    const err: unknown = await service
      .enforceWithinTransaction(tx, 'user-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'CHANNEL_LIMIT_REACHED',
      used: 8,
      limit: 8,
      message:
        'Channel limit reached (8/8). Upgrade your plan or purchase additional channels.',
    });
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

describe('AccountChannelsService - paid-only platforms (X)', () => {
  const FREE_SUB = { id: 1, planCode: 'FREE', status: 'active' };
  const PRO_SUB = { id: 1, planCode: 'PRO', status: 'active' };

  async function codeOf(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException);
      return ((e as ForbiddenException).getResponse() as { code?: string })
        .code;
    }
    return 'ALLOWED';
  }

  describe('assertPlatformAllowed (the final write)', () => {
    it('refuses X on a FREE account', async () => {
      const { service } = makeService({
        findByUserId: jest.fn().mockResolvedValue(FREE_SUB),
      });
      await expect(
        codeOf(service.assertPlatformAllowed('user-1', 'twitter')),
      ).resolves.toBe('PLAN_UPGRADE_REQUIRED');
    });

    it('refuses X with no subscription at all', async () => {
      const { service } = makeService({
        findByUserId: jest.fn().mockResolvedValue(null),
      });
      await expect(
        codeOf(service.assertPlatformAllowed('user-1', 'twitter')),
      ).resolves.toBe('PLAN_UPGRADE_REQUIRED');
    });

    it('refuses X on a paid plan that is not active (past_due)', async () => {
      const { service } = makeService({
        findByUserId: jest
          .fn()
          .mockResolvedValue({ ...PRO_SUB, status: 'past_due' }),
      });
      await expect(
        codeOf(service.assertPlatformAllowed('user-1', 'twitter')),
      ).resolves.toBe('PLAN_UPGRADE_REQUIRED');
    });

    it('allows X on an active paid plan', async () => {
      const { service } = makeService({
        findByUserId: jest.fn().mockResolvedValue(PRO_SUB),
      });
      await expect(
        codeOf(service.assertPlatformAllowed('user-1', 'twitter')),
      ).resolves.toBe('ALLOWED');
    });

    it('allows every other platform on FREE without reading the plan', async () => {
      const { service, lookup } = makeService({
        findByUserId: jest.fn().mockResolvedValue(FREE_SUB),
      });
      await expect(
        codeOf(service.assertPlatformAllowed('user-1', 'linkedin')),
      ).resolves.toBe('ALLOWED');
      expect(lookup.findByUserId).not.toHaveBeenCalled();
    });
  });

  describe('assertCanStartConnect (the OAuth start)', () => {
    it('refuses a new X connect on a FREE workspace', async () => {
      const { service } = makeService({
        findByUserId: jest.fn().mockResolvedValue(FREE_SUB),
      });
      jest.spyOn(service, 'hasChannelOn').mockResolvedValue(false);
      await expect(
        codeOf(service.assertCanStartConnect('ws-1', 'twitter')),
      ).resolves.toBe('PLAN_UPGRADE_REQUIRED');
    });

    // The frontend's reconnect goes through the same initiate route, and the
    // callback (createChannel) still refuses a NEW account if one is added.
    it('lets a FREE workspace that already holds an X channel start (reconnect)', async () => {
      const { service, lookup } = makeService({
        findByUserId: jest.fn().mockResolvedValue(FREE_SUB),
      });
      const has = jest.spyOn(service, 'hasChannelOn').mockResolvedValue(true);
      await expect(
        codeOf(service.assertCanStartConnect('ws-1', 'twitter')),
      ).resolves.toBe('ALLOWED');
      expect(has).toHaveBeenCalledWith('ws-1', 'twitter');
      expect(lookup.findByUserId).not.toHaveBeenCalled();
    });

    it('allows a new X connect on a paid workspace', async () => {
      const { service } = makeService({
        findByUserId: jest.fn().mockResolvedValue(PRO_SUB),
      });
      jest.spyOn(service, 'hasChannelOn').mockResolvedValue(false);
      await expect(
        codeOf(service.assertCanStartConnect('ws-1', 'twitter')),
      ).resolves.toBe('ALLOWED');
    });

    // The plan that counts is the workspace OWNER's ('owner-1' here), never
    // the acting user's: ownerOf resolves it and only that id is looked up.
    describe("reads the OWNER's plan, not the acting user's", () => {
      const byUser = (owner: unknown, actor: unknown) => (id: string) =>
        Promise.resolve(id === 'owner-1' ? owner : actor);

      it('refuses when the owner is FREE although another user is paid', async () => {
        const { service, lookup } = makeService({
          getOwnerId: jest.fn().mockResolvedValue('owner-1'),
          findByUserId: jest.fn(byUser(FREE_SUB, PRO_SUB)),
        });
        jest.spyOn(service, 'hasChannelOn').mockResolvedValue(false);
        await expect(
          codeOf(service.assertCanStartConnect('ws-1', 'twitter')),
        ).resolves.toBe('PLAN_UPGRADE_REQUIRED');
        expect(lookup.findByUserId).toHaveBeenCalledWith('owner-1');
      });

      it('allows when the owner is paid although another user is FREE', async () => {
        const { service, lookup } = makeService({
          getOwnerId: jest.fn().mockResolvedValue('owner-1'),
          findByUserId: jest.fn(byUser(PRO_SUB, FREE_SUB)),
        });
        jest.spyOn(service, 'hasChannelOn').mockResolvedValue(false);
        await expect(
          codeOf(service.assertCanStartConnect('ws-1', 'twitter')),
        ).resolves.toBe('ALLOWED');
        expect(lookup.findByUserId).toHaveBeenCalledWith('owner-1');
      });
    });

    it('leaves other platforms alone on FREE', async () => {
      const { service } = makeService({
        findByUserId: jest.fn().mockResolvedValue(FREE_SUB),
      });
      const has = jest.spyOn(service, 'hasChannelOn');
      await expect(
        codeOf(service.assertCanStartConnect('ws-1', 'linkedin')),
      ).resolves.toBe('ALLOWED');
      expect(has).not.toHaveBeenCalled();
    });
  });

  describe('platformAccessForUser (what the frontend badges from)', () => {
    it('FREE: X is paid-only and the plan is not paid', async () => {
      const { service } = makeService({
        findByUserId: jest.fn().mockResolvedValue(FREE_SUB),
      });
      await expect(service.platformAccessForUser('user-1')).resolves.toEqual({
        isPaidPlan: false,
        paidOnlyPlatforms: ['twitter'],
      });
    });

    it('PRO: the plan is paid', async () => {
      const { service } = makeService({
        findByUserId: jest.fn().mockResolvedValue(PRO_SUB),
      });
      await expect(service.platformAccessForUser('user-1')).resolves.toEqual({
        isPaidPlan: true,
        paidOnlyPlatforms: ['twitter'],
      });
    });
  });
});
