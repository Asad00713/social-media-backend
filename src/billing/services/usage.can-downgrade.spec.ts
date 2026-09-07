/**
 * Behavioural tests for the account-scoped downgrade gate.
 *
 * The defect these pin: `canDowngrade` used to validate ONE workspace. A
 * downgrade re-limits every workspace the account owns, so checking one let a
 * user pass validation while a second workspace still held channels over the
 * new limit — landing it silently over-limit.
 *
 * ts-jest is transpile-only, so nothing here leans on a type annotation; every
 * assertion is on a runtime value.
 */

const mockDb = {
  select: jest.fn(),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { UsageService } from './usage.service';
import { SubscriptionLookupService } from './subscription-lookup.service';

/* The fake below stands in for drizzle's fluent builder, whose chain type is
   not expressible here — `any` is deliberate and confined to the fake. */
/* eslint-disable @typescript-eslint/no-unsafe-return */

/** Rows the fake `select` chain yields, in call order. */
let selectResults: unknown[][];

function makeSelectChain(): any {
  const rows = selectResults.shift() ?? [];
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return chain;
}

const FREE_PLAN_ROW = {
  name: 'Free',
  channelsPerWorkspace: 3,
  membersPerWorkspace: 1,
};

describe('UsageService.canDowngrade (account-scoped)', () => {
  let service: UsageService;

  beforeEach(() => {
    selectResults = [];
    mockDb.select.mockReset();
    mockDb.select.mockImplementation(() => makeSelectChain());
    service = new UsageService(new SubscriptionLookupService());
  });

  it('blocks the downgrade when a SECOND workspace is over the new limit', async () => {
    selectResults = [
      // plans lookup
      [FREE_PLAN_ROW],
      // every owned workspace + its usage
      [
        { workspaceName: 'Primary', channelsCount: 2, membersCount: 1 },
        { workspaceName: 'Side Project', channelsCount: 7, membersCount: 1 },
      ],
    ];

    const result = await service.canDowngrade('user-1', 'FREE');

    // The old per-workspace check passed here (the browsed workspace fits),
    // silently stranding "Side Project" over its limit.
    expect(result.canDowngrade).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  it('names the offending workspace so the user knows where to tidy', async () => {
    selectResults = [
      [FREE_PLAN_ROW],
      [{ workspaceName: 'Side Project', channelsCount: 7, membersCount: 1 }],
    ];

    const result = await service.canDowngrade('user-1', 'FREE');

    expect(result.issues[0]).toContain('Side Project');
    expect(result.issues[0]).toContain('7 channels');
    expect(result.issues[0]).toContain('only allows 3');
    // It says how many to remove, not just that it is over.
    expect(result.issues[0]).toContain('remove 4 channel(s)');
  });

  it('allows the downgrade when every owned workspace fits', async () => {
    selectResults = [
      [FREE_PLAN_ROW],
      [
        { workspaceName: 'Primary', channelsCount: 3, membersCount: 1 },
        { workspaceName: 'Second', channelsCount: 0, membersCount: 0 },
        { workspaceName: 'Third', channelsCount: 1, membersCount: 1 },
      ],
    ];

    const result = await service.canDowngrade('user-1', 'FREE');

    expect(result.canDowngrade).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reports EVERY offending workspace, not just the first', async () => {
    selectResults = [
      [FREE_PLAN_ROW],
      [
        { workspaceName: 'Alpha', channelsCount: 9, membersCount: 1 },
        { workspaceName: 'Beta', channelsCount: 5, membersCount: 4 },
      ],
    ];

    const result = await service.canDowngrade('user-1', 'FREE');

    // Alpha: channels. Beta: channels AND members.
    expect(result.issues).toHaveLength(3);
    expect(result.issues.filter((i) => i.includes('Alpha'))).toHaveLength(1);
    expect(result.issues.filter((i) => i.includes('Beta'))).toHaveLength(2);
  });

  it('refuses a plan code that does not exist', async () => {
    selectResults = [[]];

    const result = await service.canDowngrade('user-1', 'NOPE');

    expect(result.canDowngrade).toBe(false);
    expect(result.issues).toEqual(['Plan not found']);
  });

  it('allows the downgrade when the account owns no workspace with usage', async () => {
    selectResults = [[FREE_PLAN_ROW], []];

    const result = await service.canDowngrade('user-1', 'FREE');

    expect(result.canDowngrade).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('UsageService.describeDowngradeIssues', () => {
  const plan = {
    name: 'Free',
    channelsPerWorkspace: 3,
    membersPerWorkspace: 1,
  };

  it('says nothing when the workspace fits exactly at the limit', () => {
    expect(
      UsageService.describeDowngradeIssues(
        { workspaceName: 'W', channelsCount: 3, membersCount: 1 },
        plan,
      ),
    ).toEqual([]);
  });

  it('complains about members separately from channels', () => {
    const issues = UsageService.describeDowngradeIssues(
      { workspaceName: 'W', channelsCount: 1, membersCount: 4 },
      plan,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('4 members');
    expect(issues[0]).toContain('remove 3 member(s)');
  });

  it('reports both when a workspace is over on both counts', () => {
    const issues = UsageService.describeDowngradeIssues(
      { workspaceName: 'W', channelsCount: 10, membersCount: 6 },
      plan,
    );

    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('channels');
    expect(issues[1]).toContain('members');
  });
});
