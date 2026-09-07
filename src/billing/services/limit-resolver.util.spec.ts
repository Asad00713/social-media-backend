import {
  resolveWorkspaceLimits,
  resolveMaxWorkspaces,
  canQueuePost,
  PlanLimits,
  AddonQuantities,
} from './limit-resolver.util';

const PRO: PlanLimits = {
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  maxWorkspaces: 3,
  aiTokensPerMonth: 20000,
  queuedPostsPerChannel: -1,
};

const FREE: PlanLimits = {
  channelsPerWorkspace: 3,
  membersPerWorkspace: 1,
  maxWorkspaces: 1,
  aiTokensPerMonth: 0,
  queuedPostsPerChannel: 10,
};

const NO_ADDONS: AddonQuantities = {
  extraChannels: 0,
  extraMembers: 0,
  extraWorkspaces: 0,
  extraAiTokens: 0,
};

describe('resolveWorkspaceLimits', () => {
  it('returns the plan limits when there are no add-ons', () => {
    expect(resolveWorkspaceLimits(PRO, NO_ADDONS, true)).toEqual({
      channelsLimit: 8,
      membersLimit: 5,
      aiTokensLimit: 20000,
      queuedPostsPerChannel: -1,
    });
  });

  // workspace_usage stores the BASE allowance and the purchased amount in
  // separate columns; all eight readers compute the ceiling as
  // `limit + extraPurchased`. Adding add-ons here too counted them twice —
  // PRO(8) + 3 EXTRA_CHANNEL gave 14 usable channels for 11 paid.
  it('returns the base allowance and does NOT fold add-ons in', () => {
    const addons: AddonQuantities = {
      ...NO_ADDONS,
      extraChannels: 2,
      extraMembers: 3,
      extraAiTokens: 5000,
    };
    expect(resolveWorkspaceLimits(PRO, addons, true)).toEqual({
      channelsLimit: 8,
      membersLimit: 5,
      aiTokensLimit: 20000,
      queuedPostsPerChannel: -1,
    });
  });

  // The arbitrage guard from the spec: a bought workspace arrives empty.
  it('grants a non-primary workspace zero channels and zero members', () => {
    const addons: AddonQuantities = {
      ...NO_ADDONS,
      extraChannels: 2,
      extraMembers: 3,
    };
    expect(resolveWorkspaceLimits(PRO, addons, false)).toEqual({
      channelsLimit: 0,
      membersLimit: 0,
      aiTokensLimit: 20000,
      queuedPostsPerChannel: -1,
    });
  });

  it('keeps the unlimited sentinel intact rather than doing arithmetic on it', () => {
    const addons: AddonQuantities = { ...NO_ADDONS, extraChannels: 5 };
    expect(
      resolveWorkspaceLimits(PRO, addons, true).queuedPostsPerChannel,
    ).toBe(-1);
  });

  it('passes a finite queue limit through unchanged', () => {
    expect(
      resolveWorkspaceLimits(FREE, NO_ADDONS, true).queuedPostsPerChannel,
    ).toBe(10);
  });
});

// The effective ceiling every reader computes. This mirrors what
// usage.service.ts, dashboard.service.ts, channel.service.ts and
// admin.service.ts all do: base limit + purchased extras. Keeping it here as a
// test guards the contract from either side drifting.
describe('effective ceiling (base + extraPurchased)', () => {
  it('gives PRO + 3 extra channels exactly 11, not 14', () => {
    const addons: AddonQuantities = { ...NO_ADDONS, extraChannels: 3 };
    const base = resolveWorkspaceLimits(PRO, addons, true);

    // What workspace_usage would store, and what every reader then sums.
    const storedLimit = base.channelsLimit;
    const storedExtra = addons.extraChannels;

    expect(storedLimit + storedExtra).toBe(11);
  });

  it('gives one 5000-token AI pack exactly 25000, not 30000', () => {
    const addons: AddonQuantities = { ...NO_ADDONS, extraAiTokens: 5000 };
    const base = resolveWorkspaceLimits(PRO, addons, true);

    expect(base.aiTokensLimit + addons.extraAiTokens).toBe(25000);
  });
});

describe('resolveMaxWorkspaces', () => {
  it('returns the plan value when no workspaces are purchased', () => {
    expect(resolveMaxWorkspaces(PRO, NO_ADDONS)).toBe(3);
  });

  it('adds purchased workspaces to the plan value', () => {
    expect(
      resolveMaxWorkspaces(PRO, { ...NO_ADDONS, extraWorkspaces: 2 }),
    ).toBe(5);
  });

  it('lets a FREE user buy workspaces', () => {
    expect(
      resolveMaxWorkspaces(FREE, { ...NO_ADDONS, extraWorkspaces: 1 }),
    ).toBe(2);
  });
});

describe('canQueuePost', () => {
  it('allows a post below the limit', () => {
    expect(canQueuePost(10, 9)).toBe(true);
  });

  it('refuses a post at the limit', () => {
    expect(canQueuePost(10, 10)).toBe(false);
  });

  it('refuses a post above the limit', () => {
    expect(canQueuePost(10, 11)).toBe(false);
  });

  it('always allows when the limit is the unlimited sentinel', () => {
    expect(canQueuePost(-1, 9999)).toBe(true);
  });

  it('refuses everything when the limit is zero', () => {
    expect(canQueuePost(0, 0)).toBe(false);
  });
});
