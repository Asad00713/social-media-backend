import { WorkspaceService } from './workspace.service';

/*
 * The preview's plan line without a database. `db.select()` hands back the
 * queued results in call order: channels, scheduled posts, member roles,
 * other owned workspaces, the owner's LIVE plan name (ownerPlanName), the
 * owner's subscription row, then ownerPlanName's FREE fallback.
 */

const WS = 'ws-1';

/* The fakes stand in for drizzle's fluent builders; `any` is confined to them. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
function selectChain(rows: unknown[]): any {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    groupBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return chain;
}

function make(opts: {
  otherOwned?: number;
  livePlanName: string | null;
  sub: Record<string, unknown> | null;
  /** The BASE_PLAN provider rows, read after the rest (loadBasePlanRow). */
  providerRows?: Record<string, unknown>[];
}) {
  const selects: unknown[][] = [
    [{ n: 2 }],
    [{ n: 4 }],
    [
      { role: 'MEMBER', n: 3 },
      { role: 'GUEST', n: 1 },
    ],
    [{ n: opts.otherOwned ?? 0 }],
    opts.livePlanName ? [{ name: opts.livePlanName }] : [],
    opts.sub ? [opts.sub] : [],
    [{ name: 'Free Plan' }],
    opts.providerRows ?? [],
  ];
  const db = {
    query: {
      workspace: {
        findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: 'owner-1' }),
      },
    },
    select: jest.fn(() => selectChain(selects.shift() ?? [])),
  };
  return new WorkspaceService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('WorkspaceService.deletionPreview plan line', () => {
  it('paused PRO on the last workspace: cancelsPlan with the PRO name, never the free one', async () => {
    const service = make({
      livePlanName: null, // paused is not a live status for ownerPlanName
      sub: {
        planCode: 'PRO',
        status: 'paused',
        cancelAtPeriodEnd: false,
        planName: 'Pro Plan',
      },
    });

    await expect(service.deletionPreview(WS)).resolves.toEqual({
      channels: 2,
      scheduledPosts: 4,
      members: 3,
      guests: 1,
      isLastOwnedWorkspace: true,
      cancelsPlan: true,
      planName: 'Pro Plan',
    });
  });

  it('FREE: nothing cancelled, the free plan name', async () => {
    const service = make({
      livePlanName: 'Free Plan',
      sub: {
        planCode: 'FREE',
        status: 'active',
        cancelAtPeriodEnd: false,
        planName: 'Free Plan',
      },
    });

    const preview = await service.deletionPreview(WS);
    expect(preview.cancelsPlan).toBe(false);
    expect(preview.planName).toBe('Free Plan');
  });

  it('paused PRO with another owned workspace: nothing cancelled, the display name stays ownerPlanName', async () => {
    const service = make({
      otherOwned: 1,
      livePlanName: null,
      sub: {
        planCode: 'PRO',
        status: 'paused',
        cancelAtPeriodEnd: false,
        planName: 'Pro Plan',
      },
    });

    const preview = await service.deletionPreview(WS);
    expect(preview.cancelsPlan).toBe(false);
    expect(preview.planName).toBe('Free Plan');
  });

  it('the provider already ended the base plan: nothing to cancel, though the local row is still paused', async () => {
    const service = make({
      livePlanName: null,
      sub: {
        id: 11,
        planCode: 'PRO',
        status: 'paused',
        cancelAtPeriodEnd: false,
        planName: 'Pro Plan',
      },
      providerRows: [
        {
          subscriptionId: 11,
          provider: 'stripe',
          itemType: 'BASE_PLAN',
          isDefault: true,
          providerStatus: 'incomplete_expired',
          endsAt: null,
        },
      ],
    });

    const preview = await service.deletionPreview(WS);
    expect(preview.cancelsPlan).toBe(false);
  });
});
