import { buildSubscriptionSync } from './subscription-sync.util';

const PLAN = {
  code: 'PRO',
  basePriceCents: 1000,
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  maxWorkspaces: 3,
  aiTokensPerMonth: 2000,
  queuedPostsPerChannel: -1,
} as any;

const ADDONS = {
  extraChannels: 0,
  extraMembers: 0,
  extraWorkspaces: 0,
  extraAiTokens: 0,
};

const WORKSPACES = [{ id: 'ws-1', createdAt: new Date('2026-01-01T00:00:00Z') }];

function makeStripeSub(overrides: any = {}) {
  return {
    id: 'sub_123',
    status: 'active',
    customer: 'cus_123',
    current_period_start: 1_700_000_000,
    current_period_end: 1_702_000_000,
    items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
    ...overrides,
  };
}

describe('buildSubscriptionSync', () => {
  it('maps stripe subscription + plan into row values', () => {
    const out = buildSubscriptionSync({
      userId: 'user-1',
      workspaces: WORKSPACES,
      planCode: 'PRO',
      plan: PLAN,
      addons: ADDONS,
      stripeCustomerId: 'cus_123',
      stripeSubscription: makeStripeSub(),
    });

    expect(out.subscriptionRow).toMatchObject({
      userId: 'user-1',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      planCode: 'PRO',
      status: 'active',
    });
    expect(out.subscriptionRow.currentPeriodStart).toEqual(
      new Date(1_700_000_000 * 1000),
    );
    expect(out.subscriptionRow.currentPeriodEnd).toEqual(
      new Date(1_702_000_000 * 1000),
    );
    // trialEnd omitted when no trial
    expect('trialEnd' in out.subscriptionRow).toBe(false);

    expect(out.baseItem).toMatchObject({
      stripeSubscriptionItemId: 'si_123',
      itemType: 'BASE_PLAN',
      stripePriceId: 'price_123',
      quantity: 1,
      unitPriceCents: 1000,
    });

    expect(out.usageRows).toHaveLength(1);
    expect(out.usageRows[0]).toMatchObject({
      workspaceId: 'ws-1',
      channelsLimit: 8,
      membersLimit: 5,
      aiTokensLimit: 2000,
      channelsCount: 0,
      extraChannelsPurchased: 0,
      membersCount: 0,
      extraMembersPurchased: 0,
    });
  });

  it('includes trialEnd when the subscription is trialing', () => {
    const out = buildSubscriptionSync({
      userId: 'user-1',
      workspaces: WORKSPACES,
      planCode: 'PRO',
      plan: PLAN,
      addons: ADDONS,
      stripeCustomerId: 'cus_123',
      stripeSubscription: makeStripeSub({
        status: 'trialing',
        trial_end: 1_701_000_000,
      }),
    });
    expect(out.subscriptionRow.trialEnd).toEqual(
      new Date(1_701_000_000 * 1000),
    );
    expect(out.subscriptionRow.status).toBe('trialing');
  });

  it('emits a usage row for every workspace the account owns', () => {
    const result = buildSubscriptionSync({
      userId: 'user-1',
      workspaces: [
        { id: 'ws-a', createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'ws-b', createdAt: new Date('2026-02-01T00:00:00Z') },
      ],
      planCode: 'PRO',
      plan: {
        basePriceCents: 1500,
        channelsPerWorkspace: 8,
        membersPerWorkspace: 5,
        maxWorkspaces: 3,
        aiTokensPerMonth: 20000,
        queuedPostsPerChannel: -1,
      },
      addons: {
        extraChannels: 0,
        extraMembers: 0,
        extraWorkspaces: 0,
        extraAiTokens: 0,
      },
      stripeCustomerId: 'cus_test',
      stripeSubscription: {
        id: 'sub_test',
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [{ id: 'si_test', price: { id: 'price_test' }, current_period_start: 1767225600, current_period_end: 1769904000 }] },
      } as any,
    });

    expect(result.usageRows).toHaveLength(2);
    expect(result.usageRows.find((r) => r.workspaceId === 'ws-a')!.channelsLimit).toBe(8);
    // The second workspace arrives empty — the arbitrage guard.
    expect(result.usageRows.find((r) => r.workspaceId === 'ws-b')!.channelsLimit).toBe(0);
    expect(result.subscriptionRow.userId).toBe('user-1');
  });
});
