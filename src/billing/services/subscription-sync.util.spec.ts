import { buildSubscriptionSync } from './subscription-sync.util';

const PLAN = {
  code: 'PRO',
  basePriceCents: 1000,
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  aiTokensPerMonth: 2000,
} as any;

function makeStripeSub(overrides: any = {}) {
  return {
    id: 'sub_123',
    status: 'active',
    customer: 'cus_123',
    current_period_start: 1_700_000_000,
    current_period_end: 1_702_000_000,
    items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
    ...overrides,
  } as any;
}

describe('buildSubscriptionSync', () => {
  it('maps stripe subscription + plan into row values', () => {
    const out = buildSubscriptionSync({
      workspaceId: 'ws-1',
      planCode: 'PRO',
      plan: PLAN,
      stripeCustomerId: 'cus_123',
      stripeSubscription: makeStripeSub(),
    });

    expect(out.subscriptionRow).toMatchObject({
      workspaceId: 'ws-1',
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

    expect(out.usageRow).toMatchObject({
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
      workspaceId: 'ws-1',
      planCode: 'PRO',
      plan: PLAN,
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
});
