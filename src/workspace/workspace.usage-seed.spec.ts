import { WorkspaceService } from './workspace.service';
import { SubscriptionLookupService } from '../billing/services/subscription-lookup.service';

/**
 * Covers `seedWorkspaceUsage` — the fix for a latent bug account scoping made
 * visible: `applyLimitsToAllWorkspaces` fans plan changes out with UPDATE, so a
 * workspace that never got a `workspace_usage` row is silently skipped by every
 * future plan change. Only the account's first workspace ever got one.
 *
 * These assert RUNTIME values (the numbers actually inserted), not types —
 * ts-jest is transpile-only here, so a type-only assertion would prove nothing.
 */
describe('WorkspaceService.seedWorkspaceUsage', () => {
  const PLAN = {
    channelsPerWorkspace: 3,
    membersPerWorkspace: 2,
    maxWorkspaces: 5,
    aiTokensPerMonth: 100,
    queuedPostsPerChannel: 10,
  };

  const ADDONS = {
    extraChannels: 4,
    extraMembers: 6,
    extraWorkspaces: 1,
    extraAiTokens: 5000,
  };

  /**
   * `ownedCount` is what the post-insert COUNT(*) returns: 1 means the
   * workspace just created is the account's first.
   */
  function makeService(ownedCount: number, subscription: unknown) {
    const values = jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    });

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ n: ownedCount }]),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values }),
    };

    const lookup = {
      findByUserId: jest.fn().mockResolvedValue(subscription),
      getAddonQuantities: jest.fn().mockResolvedValue(ADDONS),
      getPlanLimits: jest.fn().mockResolvedValue(PLAN),
    } as unknown as SubscriptionLookupService;

    const service = new WorkspaceService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      lookup,
      {} as never,
      {} as never,
    );

    return { service, values, db };
  }

  // The private method is the whole unit under test; reaching it by name is
  // deliberate — going through `create()` would drag in slug generation,
  // Stripe subscription creation and the users service for no added coverage.
  function seed(service: WorkspaceService, workspaceId = 'ws-1') {
    return (
      service as unknown as {
        seedWorkspaceUsage(w: string, u: string): Promise<void>;
      }
    ).seedWorkspaceUsage(workspaceId, 'user-1');
  }

  const ACTIVE_SUB = { id: 7, status: 'active', planCode: 'PRO' };

  // The base allowance and the purchased extras go in SEPARATE columns; every
  // reader computes the ceiling as `limit + extraPurchased`. Folding add-ons
  // into the limit would count them twice.
  it('gives the account FIRST workspace the base allowance and its add-ons', async () => {
    const { service, values } = makeService(1, ACTIVE_SUB);

    await seed(service);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        channelsLimit: 3,
        membersLimit: 2,
        aiTokensLimit: 100,
        extraChannelsPurchased: 4,
        extraMembersPurchased: 6,
        extraAiTokensPurchased: 5000,
      }),
    );
  });

  // The gap this closes: an account that bought add-ons BEFORE creating its
  // first workspace would otherwise have them silently dropped here.
  it('carries the purchased extras onto the first workspace', async () => {
    const { service, values } = makeService(1, ACTIVE_SUB);

    await seed(service);

    const written = values.mock.calls[0][0] as Record<string, number>;
    expect(written.channelsLimit + written.extraChannelsPurchased).toBe(7);
  });

  // The anti-arbitrage rule: if a purchased workspace carried the tier's
  // channel allowance, buying an EXTRA_WORKSPACE would be a cheaper route to
  // channels than buying channels whenever it costs less than N extra channels.
  it('creates every LATER workspace empty — no channels, no seats', async () => {
    const { service, values } = makeService(2, ACTIVE_SUB);

    await seed(service, 'ws-2');

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-2',
        channelsLimit: 0,
        membersLimit: 0,
      }),
    );
  });

  it('still seeds a row when the account has no subscription at all', async () => {
    const { service, values } = makeService(1, null);

    await seed(service);

    // The row must exist even with no subscription — a missing row, not a
    // zeroed one, is what breaks every later UPDATE fan-out.
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1' }),
    );
  });

  it('treats a non-active subscription as FREE rather than honouring its plan', async () => {
    const lookupPlan = jest.fn().mockResolvedValue(PLAN);
    const { service } = makeService(1, {
      id: 7,
      status: 'canceled',
      planCode: 'PRO',
    });
    (
      service as unknown as { lookup: { getPlanLimits: jest.Mock } }
    ).lookup.getPlanLimits = lookupPlan;

    await seed(service);

    expect(lookupPlan).toHaveBeenCalledWith('FREE');
  });

  // Regression: the seeded row originally omitted aiTokensResetDate. The
  // monthly reset is gated on `usage.aiTokensResetDate && now >= it`, and NULL
  // is falsy — so the workspace spent its first month's tokens and stayed at
  // zero forever. Seeding the row also made AiTokenService's lazy branch (the
  // only writer that set the date) unreachable, so nothing could repair it.
  it('sets a token reset date so the monthly allowance actually rolls over', async () => {
    const { service, values } = makeService(1, ACTIVE_SUB);

    await seed(service);

    const written = values.mock.calls[0][0] as { aiTokensResetDate?: Date };
    expect(written.aiTokensResetDate).toBeInstanceOf(Date);
    // Must be in the future, or the gate fires on every call instead of monthly.
    expect(written.aiTokensResetDate!.getTime()).toBeGreaterThan(Date.now());
    expect(written.aiTokensResetDate!.getDate()).toBe(1);
  });

  // A later workspace gets zero channels and seats, but its AI allowance still
  // has to roll over — it is the one limit a non-primary workspace can spend.
  it('sets the reset date on later workspaces too, not just the first', async () => {
    const { service, values } = makeService(2, ACTIVE_SUB);

    await seed(service, 'ws-2');

    const written = values.mock.calls[0][0] as { aiTokensResetDate?: Date };
    expect(written.aiTokensResetDate).toBeInstanceOf(Date);
    expect(written.aiTokensResetDate!.getTime()).toBeGreaterThan(Date.now());
  });

  it('never lets a seeding failure destroy the workspace the user just created', async () => {
    const { service, db } = makeService(1, ACTIVE_SUB);
    db.insert.mockImplementation(() => {
      throw new Error('unique violation');
    });

    await expect(seed(service)).resolves.toBeUndefined();
  });
});
