import { buildUsageFanout, pickPrimaryWorkspaceId, WorkspaceRef } from './usage-fanout.util';
import { PlanLimits, AddonQuantities } from './limit-resolver.util';

const PRO: PlanLimits = {
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  maxWorkspaces: 3,
  aiTokensPerMonth: 20000,
  queuedPostsPerChannel: -1,
};

const NO_ADDONS: AddonQuantities = {
  extraChannels: 0,
  extraMembers: 0,
  extraWorkspaces: 0,
  extraAiTokens: 0,
};

const d = (iso: string) => new Date(iso);

describe('pickPrimaryWorkspaceId', () => {
  it('returns the oldest workspace, whatever order it arrives in', () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'b', createdAt: d('2026-03-01T00:00:00Z') },
      { id: 'a', createdAt: d('2026-01-01T00:00:00Z') },
      { id: 'c', createdAt: d('2026-02-01T00:00:00Z') },
    ];
    expect(pickPrimaryWorkspaceId(workspaces)).toBe('a');
  });

  it('returns null when the user owns nothing', () => {
    expect(pickPrimaryWorkspaceId([])).toBeNull();
  });
});

describe('buildUsageFanout', () => {
  it('produces one write per owned workspace', () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'a', createdAt: d('2026-01-01T00:00:00Z') },
      { id: 'b', createdAt: d('2026-02-01T00:00:00Z') },
      { id: 'c', createdAt: d('2026-03-01T00:00:00Z') },
    ];
    const writes = buildUsageFanout(workspaces, PRO, NO_ADDONS);
    expect(writes).toHaveLength(3);
    expect(writes.map((w) => w.workspaceId).sort()).toEqual(['a', 'b', 'c']);
  });

  // This is the whole point of the task: the old code wrote ONE row.
  it('gives the primary workspace the plan allowance and the rest zero channels', () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'primary', createdAt: d('2026-01-01T00:00:00Z') },
      { id: 'second', createdAt: d('2026-02-01T00:00:00Z') },
    ];
    const writes = buildUsageFanout(workspaces, PRO, NO_ADDONS);
    const primary = writes.find((w) => w.workspaceId === 'primary');
    const second = writes.find((w) => w.workspaceId === 'second');

    expect(primary).toEqual({
      workspaceId: 'primary',
      channelsLimit: 8,
      membersLimit: 5,
      aiTokensLimit: 20000,
    });
    expect(second).toEqual({
      workspaceId: 'second',
      channelsLimit: 0,
      membersLimit: 0,
      aiTokensLimit: 20000,
    });
  });

  // Add-ons are NOT folded into channelsLimit — workspace_usage keeps them in
  // extra*Purchased and readers sum the two. Folding here double-counted them.
  it('gives the primary the base allowance and non-primary zero', () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'primary', createdAt: d('2026-01-01T00:00:00Z') },
      { id: 'second', createdAt: d('2026-02-01T00:00:00Z') },
    ];
    const writes = buildUsageFanout(workspaces, PRO, {
      ...NO_ADDONS,
      extraChannels: 4,
    });
    expect(writes.find((w) => w.workspaceId === 'primary')!.channelsLimit).toBe(8);
    expect(writes.find((w) => w.workspaceId === 'second')!.channelsLimit).toBe(0);
  });

  it('returns no writes when the user owns no workspaces', () => {
    expect(buildUsageFanout([], PRO, NO_ADDONS)).toEqual([]);
  });
});
