// Minimal fake db: getWorkspaceLimits only ever runs
// db.select({ id }).from(workspace).where(eq(workspace.ownerId, userId))
// which resolves directly to an array of rows (no further chaining). Tests
// control the row count via `mockWorkspaceRows` to exercise the
// currentWorkspaces / workspacesAvailable arithmetic.
let mockWorkspaceRows: Array<{ id: string }> = [];
jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(mockWorkspaceRows),
      }),
    }),
  },
}));

import { UsageService } from './usage.service';
import type { SubscriptionLookupService } from './subscription-lookup.service';
import type { PlanLimits, AddonQuantities } from './limit-resolver.util';
import type { Subscription } from '../../drizzle/schema';

const FREE_LIMITS: PlanLimits = {
  channelsPerWorkspace: 3,
  membersPerWorkspace: 1,
  maxWorkspaces: 1,
  aiTokensPerMonth: 0,
  queuedPostsPerChannel: 10,
};

const MAX_LIMITS: PlanLimits = {
  channelsPerWorkspace: 50,
  membersPerWorkspace: 25,
  maxWorkspaces: 3,
  aiTokensPerMonth: 100_000,
  queuedPostsPerChannel: -1,
};

const ZERO_ADDONS: AddonQuantities = {
  extraChannels: 0,
  extraMembers: 0,
  extraWorkspaces: 0,
  extraAiTokens: 0,
};

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 42,
    userId: 'user-1',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    planCode: 'MAX',
    status: 'active',
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    scheduledPlanCode: null,
    scheduledChangeAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * A concretely-typed fake of the three SubscriptionLookupService methods
 * getWorkspaceLimits actually calls, each a real jest.fn(). Deliberately NOT
 * typed as `SubscriptionLookupService` itself: doing so makes every
 * `expect(lookup.someMethod)` below trip @typescript-eslint/unbound-method
 * (it reads as a class-method reference torn off its instance). Callers cast
 * to `SubscriptionLookupService` only at the `new UsageService(...)` call
 * site, where the two unused interface methods are stubbed inline.
 */
interface FakeLookup {
  findByUserId: jest.Mock<Promise<Subscription | null>, [string]>;
  getPlanLimits: jest.Mock<Promise<PlanLimits>, [string]>;
  getAddonQuantities: jest.Mock<Promise<AddonQuantities>, [number]>;
}

function makeFakeLookup(overrides?: {
  findByUserId?: Subscription | null;
  planLimitsByCode?: Record<string, PlanLimits>;
  addonsBySubscriptionId?: Record<number, AddonQuantities>;
}): FakeLookup {
  const planLimitsByCode = overrides?.planLimitsByCode ?? { FREE: FREE_LIMITS };
  const addonsBySubscriptionId = overrides?.addonsBySubscriptionId ?? {};

  return {
    // Ignores the userId it's called with — the fake is pre-configured with
    // the subscription to return; the test asserts the CALL (via
    // toHaveBeenCalledWith), not a lookup keyed on it.
    findByUserId: jest.fn<Promise<Subscription | null>, [string]>(() =>
      Promise.resolve(overrides?.findByUserId ?? null),
    ),
    getPlanLimits: jest.fn((planCode: string) =>
      Promise.resolve(planLimitsByCode[planCode] ?? FREE_LIMITS),
    ),
    getAddonQuantities: jest.fn((subscriptionId: number) =>
      Promise.resolve(addonsBySubscriptionId[subscriptionId] ?? ZERO_ADDONS),
    ),
  };
}

/** Wires a FakeLookup into a real UsageService, stubbing the two unused methods. */
function makeService(lookup: FakeLookup): UsageService {
  return new UsageService({
    ...lookup,
    findByWorkspaceId: jest.fn(),
    getOwnerId: jest.fn(),
  } as unknown as SubscriptionLookupService);
}

describe('UsageService.getWorkspaceLimits', () => {
  beforeEach(() => {
    mockWorkspaceRows = [];
  });

  // 1. The regression this task exists to fix: a user who owns several
  // workspaces resolves to ONE subscription lookup, not one per workspace.
  it('looks up the subscription once by userId, never per-workspace', async () => {
    mockWorkspaceRows = [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }];
    const lookup = makeFakeLookup({
      findByUserId: makeSubscription({ planCode: 'MAX' }),
      planLimitsByCode: { MAX: MAX_LIMITS },
    });
    const service = makeService(lookup);

    const result = await service.getWorkspaceLimits('user-1');

    expect(lookup.findByUserId).toHaveBeenCalledTimes(1);
    expect(lookup.findByUserId).toHaveBeenCalledWith('user-1');
    expect(result.maxWorkspaces).toBe(MAX_LIMITS.maxWorkspaces);
    expect(result.currentWorkspaces).toBe(3);
  });

  // 2. No subscription at all -> FREE allowance, no exception.
  it('falls back to FREE limits when the user has no subscription', async () => {
    mockWorkspaceRows = [{ id: 'ws-1' }];
    const lookup = makeFakeLookup({ findByUserId: null });
    const service = makeService(lookup);

    const result = await service.getWorkspaceLimits('user-1');

    expect(lookup.getPlanLimits).toHaveBeenCalledWith('FREE');
    expect(lookup.getAddonQuantities).not.toHaveBeenCalled();
    expect(result.maxWorkspaces).toBe(FREE_LIMITS.maxWorkspaces);
    expect(result.workspacesAvailable).toBe(FREE_LIMITS.maxWorkspaces - 1);
  });

  // 3. A subscription that exists but is not active -> FREE plan limits.
  // Reads back what the implementation actually does with add-ons in this
  // case: because `subscription` is truthy, the `subscription ? ... : ...`
  // ternary in getWorkspaceLimits takes the truthy branch and DOES call
  // getAddonQuantities with that (inactive) subscription's id, even though
  // the plan itself was forced to FREE. This documents the implementation's
  // real behaviour, not an assumption.
  it('falls back to FREE plan limits for a non-active subscription, but still reads its add-ons', async () => {
    mockWorkspaceRows = [{ id: 'ws-1' }];
    const pastDue = makeSubscription({
      id: 99,
      planCode: 'MAX',
      status: 'past_due',
    });
    const lookup = makeFakeLookup({
      findByUserId: pastDue,
      planLimitsByCode: { FREE: FREE_LIMITS, MAX: MAX_LIMITS },
      addonsBySubscriptionId: {
        99: { ...ZERO_ADDONS, extraWorkspaces: 5 },
      },
    });
    const service = makeService(lookup);

    const result = await service.getWorkspaceLimits('user-1');

    expect(lookup.getPlanLimits).toHaveBeenCalledWith('FREE');
    expect(lookup.getAddonQuantities).toHaveBeenCalledWith(99);
    // FREE.maxWorkspaces (1) + extraWorkspaces (5) purchased on the lapsed
    // subscription = 6. Whether add-ons from a non-active subscription
    // should still count is a product question outside this task's scope;
    // this test documents current behaviour so a future change is
    // deliberate, not accidental.
    expect(result.maxWorkspaces).toBe(6);
  });

  // 4. Add-ons increase the allowance on top of the plan.
  it('adds extraWorkspaces on top of the plan max', async () => {
    mockWorkspaceRows = [{ id: 'ws-1' }];
    const sub = makeSubscription({ id: 7, planCode: 'MAX', status: 'active' });
    const lookup = makeFakeLookup({
      findByUserId: sub,
      planLimitsByCode: { MAX: MAX_LIMITS },
      addonsBySubscriptionId: {
        7: { ...ZERO_ADDONS, extraWorkspaces: 2 },
      },
    });
    const service = makeService(lookup);

    const result = await service.getWorkspaceLimits('user-1');

    expect(result.maxWorkspaces).toBe(MAX_LIMITS.maxWorkspaces + 2); // 3 + 2 = 5
  });

  // 5. workspacesAvailable arithmetic, including over-allowance (owns more
  // workspaces than the plan permits). Implementation does a plain
  // subtraction with no clamping, so this legitimately goes negative.
  it('lets workspacesAvailable go negative when over the limit', async () => {
    mockWorkspaceRows = [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }];
    const lookup = makeFakeLookup({ findByUserId: null }); // FREE: max 1
    const service = makeService(lookup);

    const result = await service.getWorkspaceLimits('user-1');

    expect(result.currentWorkspaces).toBe(3);
    expect(result.maxWorkspaces).toBe(1);
    expect(result.workspacesAvailable).toBe(-2);
  });
});
