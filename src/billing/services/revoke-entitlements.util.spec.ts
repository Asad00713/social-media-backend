/**
 * `revokeBasePlan` and the purchased extras.
 *
 * Stripe's own cancellation path zeroes `workspace_usage.extra*Purchased`
 * explicitly, under the comment "The purchased extras die with the
 * subscription" (webhook.service.ts:487-494). This shared util — the one
 * BOTH Paddle and Lemon Squeezy use — re-applied the FREE plan limits but
 * left those three columns standing.
 *
 * They are not decoration: `usage.service.ts:131` computes the member limit
 * as `membersLimit + extraMembersPurchased`, and `ai-token.service.ts:248`
 * computes the live AI quota as `aiTokensLimit + extraAiTokensPurchased -
 * used`. `resolveWorkspaceLimits` writes the PLAN's limits only and ignores
 * add-ons entirely, so these columns are the sole record of purchased
 * capacity and are always added on top of whatever was written.
 *
 * The result: a cancelled Paddle or Lemon Squeezy account kept every
 * purchased seat and AI credit, for free, indefinitely — while the same
 * cancellation on Stripe took them back.
 */

interface UpdateCall {
  table: string;
  values: Record<string, unknown>;
}

const updates: UpdateCall[] = [];
const deletes: string[] = [];

/** Names the table a Drizzle table object refers to, for assertions. */
function tableNameOf(table: unknown): string {
  const t = table as Record<symbol | string, unknown>;
  for (const key of Object.getOwnPropertySymbols(t)) {
    if (String(key).includes('Name')) {
      const v = t[key];
      if (typeof v === 'string') return v;
    }
  }
  return 'unknown';
}

const mockDb = {
  select: jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn().mockResolvedValue([{ userId: 'user-1' }]),
    })),
  })),
  update: jest.fn((table: unknown) => ({
    set: jest.fn((values: Record<string, unknown>) => {
      updates.push({ table: tableNameOf(table), values });
      return { where: jest.fn().mockResolvedValue(undefined) };
    }),
  })),
  delete: jest.fn((table: unknown) => {
    deletes.push(tableNameOf(table));
    return { where: jest.fn().mockResolvedValue(undefined) };
  }),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { revokeBasePlan } from './revoke-entitlements.util';

const SUBSCRIPTION_ID = 42;

function limitsApplier() {
  return {
    applyLimitsToAllWorkspaces: jest.fn().mockResolvedValue(undefined),
    getAddonQuantities: jest.fn().mockResolvedValue({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    }),
  };
}

/** Every `workspace_usage` write this run made. */
function usageWrites(): Record<string, unknown>[] {
  return updates
    .filter((u) => u.table === 'workspace_usage')
    .map((u) => u.values);
}

describe.each(['paddle', 'lemonsqueezy'] as const)(
  'revokeBasePlan on %s',
  (provider) => {
    beforeEach(() => {
      updates.length = 0;
      deletes.length = 0;
      jest.clearAllMocks();
    });

    it('zeroes the purchased extras, which outlive the subscription otherwise', async () => {
      // The bug. Without this the account keeps the seats and AI credits it
      // bought, for free, for as long as the row exists — because both
      // limits are read as `written limit + extra*Purchased`.
      const limits = limitsApplier();

      await revokeBasePlan({ provider, subscriptionId: SUBSCRIPTION_ID, limits });

      const writes = usageWrites();
      expect(writes.length).toBeGreaterThan(0);

      const zeroing = writes.find(
        (w) => 'extraAiTokensPurchased' in w || 'extraChannelsPurchased' in w,
      );
      expect(zeroing).toBeDefined();
      expect(zeroing).toMatchObject({
        extraChannelsPurchased: 0,
        extraMembersPurchased: 0,
        extraAiTokensPurchased: 0,
      });
    });

    it('still resets the account to FREE limits', async () => {
      // The pre-existing behaviour must survive the fix: zeroing the extras
      // is in ADDITION to re-applying the plan, not instead of it.
      const limits = limitsApplier();

      await revokeBasePlan({ provider, subscriptionId: SUBSCRIPTION_ID, limits });

      expect(limits.applyLimitsToAllWorkspaces).toHaveBeenCalledWith(
        'user-1',
        'FREE',
        {
          extraChannels: 0,
          extraMembers: 0,
          extraWorkspaces: 0,
          extraAiTokens: 0,
        },
      );
    });

    it('still deletes the add-on bookkeeping rows', async () => {
      const limits = limitsApplier();

      await revokeBasePlan({ provider, subscriptionId: SUBSCRIPTION_ID, limits });

      expect(deletes).toContain('subscription_items');
    });

    it('still marks the provider rows dead and releases the default flag', async () => {
      const limits = limitsApplier();

      await revokeBasePlan({ provider, subscriptionId: SUBSCRIPTION_ID, limits });

      const providerWrite = updates.find(
        (u) => u.table === 'provider_subscriptions',
      );
      expect(providerWrite?.values).toMatchObject({
        providerStatus: 'expired',
        isDefault: false,
        renewsAt: null,
      });
    });

    it('does nothing when the subscription row is gone', async () => {
      // A missing row means there is no account to act on. Writing anyway
      // would touch whatever workspaces a stale id happened to match.
      mockDb.select.mockReturnValueOnce({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([]),
        })),
      } as never);
      const limits = limitsApplier();

      await revokeBasePlan({ provider, subscriptionId: 999, limits });

      expect(limits.applyLimitsToAllWorkspaces).not.toHaveBeenCalled();
      expect(usageWrites()).toHaveLength(0);
    });
  },
);
