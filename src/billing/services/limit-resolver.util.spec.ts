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

  it('adds purchased channels and members to the primary workspace', () => {
    const addons: AddonQuantities = {
      ...NO_ADDONS,
      extraChannels: 2,
      extraMembers: 3,
      extraAiTokens: 5000,
    };
    expect(resolveWorkspaceLimits(PRO, addons, true)).toEqual({
      channelsLimit: 10,
      membersLimit: 8,
      aiTokensLimit: 25000,
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
