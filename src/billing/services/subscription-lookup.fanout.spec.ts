/**
 * Behavioural tests for the account-scoped limit writer.
 *
 * These assert what the method DOES at runtime — which workspaces it writes and
 * what values land on each. ts-jest is transpile-only (isolatedModules), so a
 * type annotation proves nothing here; every assertion below is on real values.
 */

const mockDb = {
  select: jest.fn(),
  update: jest.fn(),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { SubscriptionLookupService } from './subscription-lookup.service';

interface RecordedWrite {
  values: Record<string, unknown>;
  where: unknown;
}

/* The fakes below stand in for drizzle's fluent builders, whose chain types are
   not expressible here — `any` is deliberate and confined to the fakes. */
/* eslint-disable @typescript-eslint/no-unsafe-return */

/** Rows the fake `select` chain will yield, in call order. */
let selectResults: unknown[][];
/** Every `update(workspaceUsage)` the code performed, in order. */
let writes: RecordedWrite[];

/**
 * A stand-in for drizzle's fluent builder. Each terminal (`.limit`,
 * `.orderBy`, `.where`) resolves to the next queued result, so a `.then` on the
 * chain — which is how the service awaits it — yields that row set.
 */
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

function makeUpdateChain(): any {
  const record: RecordedWrite = { values: {}, where: null };
  const chain: any = {
    set: (values: Record<string, unknown>) => {
      record.values = values;
      return chain;
    },
    where: (clause: unknown) => {
      record.where = clause;
      writes.push(record);
      return Promise.resolve(undefined);
    },
  };
  return chain;
}

const d = (iso: string) => new Date(iso);

const PRO_PLAN_ROW = {
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  maxWorkspaces: 3,
  aiTokensPerMonth: 20000,
  queuedPostsPerChannel: -1,
};

const NO_ADDONS = {
  extraChannels: 0,
  extraMembers: 0,
  extraWorkspaces: 0,
  extraAiTokens: 0,
};

describe('SubscriptionLookupService.applyLimitsToAllWorkspaces', () => {
  let service: SubscriptionLookupService;

  beforeEach(() => {
    selectResults = [];
    writes = [];
    mockDb.select.mockClear();
    mockDb.update.mockClear();
    mockDb.select.mockImplementation(() => makeSelectChain());
    mockDb.update.mockImplementation(() => makeUpdateChain());
    service = new SubscriptionLookupService();
  });

  it('writes a usage row for EVERY owned workspace, not just one', async () => {
    selectResults = [
      // listOwnedWorkspaces
      [
        { id: 'ws-old', createdAt: d('2026-01-01T00:00:00Z') },
        { id: 'ws-mid', createdAt: d('2026-02-01T00:00:00Z') },
        { id: 'ws-new', createdAt: d('2026-03-01T00:00:00Z') },
      ],
      // getPlanLimits
      [PRO_PLAN_ROW],
    ];

    await service.applyLimitsToAllWorkspaces('user-1', 'PRO', NO_ADDONS);

    // This is the whole point of the task: three owned workspaces, three
    // writes. One write here is the silent-stale-limits defect.
    expect(writes).toHaveLength(3);
  });

  it('gives the OLDEST workspace the base allowance, others zero', async () => {
    selectResults = [
      [
        { id: 'ws-new', createdAt: d('2026-03-01T00:00:00Z') },
        { id: 'ws-old', createdAt: d('2026-01-01T00:00:00Z') },
      ],
      [PRO_PLAN_ROW],
    ];

    await service.applyLimitsToAllWorkspaces('user-1', 'PRO', {
      extraChannels: 4,
      extraMembers: 2,
      extraWorkspaces: 1,
      extraAiTokens: 5000,
    });

    // Written in the order the query returned them: new first, then old.
    const [newer, older] = writes;

    // The BASE allowance lands on the oldest workspace — regardless of the
    // order rows arrived in. Purchased add-ons are NOT folded in here: they
    // live in extra*Purchased and readers add the two, so folding them here
    // would count every add-on twice.
    expect(older.values.channelsLimit).toBe(8);
    expect(older.values.membersLimit).toBe(5);
    expect(older.values.aiTokensLimit).toBe(20000);

    // Anti-arbitrage: a non-primary workspace gets ZERO channels and seats, so
    // buying a workspace can never be a cheaper route to channels.
    expect(newer.values.channelsLimit).toBe(0);
    expect(newer.values.membersLimit).toBe(0);
  });

  it('falls back to FREE limits when the plan row is missing', async () => {
    selectResults = [
      [{ id: 'ws-1', createdAt: d('2026-01-01T00:00:00Z') }],
      // getPlanLimits finds nothing → FREE fallback, never a throw.
      [],
    ];

    await service.applyLimitsToAllWorkspaces('user-1', 'MYSTERY', NO_ADDONS);

    expect(writes).toHaveLength(1);
    expect(writes[0].values.channelsLimit).toBe(3);
    expect(writes[0].values.membersLimit).toBe(1);
    expect(writes[0].values.aiTokensLimit).toBe(0);
  });

  it('writes nothing when the account owns no workspace', async () => {
    selectResults = [[]];

    await service.applyLimitsToAllWorkspaces('user-1', 'PRO', NO_ADDONS);

    expect(writes).toHaveLength(0);
    // It must also not waste a plan lookup on a no-op.
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('stamps updatedAt on each write', async () => {
    selectResults = [
      [{ id: 'ws-1', createdAt: d('2026-01-01T00:00:00Z') }],
      [PRO_PLAN_ROW],
    ];

    await service.applyLimitsToAllWorkspaces('user-1', 'PRO', NO_ADDONS);

    expect(writes[0].values.updatedAt).toBeInstanceOf(Date);
  });

  it('downgrading re-derives every workspace from the NEW plan', async () => {
    // The defect this task exists to prevent: a user on PRO with three
    // workspaces drops to FREE. Every workspace must land on FREE's ceiling.
    selectResults = [
      [
        { id: 'ws-a', createdAt: d('2026-01-01T00:00:00Z') },
        { id: 'ws-b', createdAt: d('2026-02-01T00:00:00Z') },
        { id: 'ws-c', createdAt: d('2026-03-01T00:00:00Z') },
      ],
      [
        {
          channelsPerWorkspace: 3,
          membersPerWorkspace: 1,
          maxWorkspaces: 1,
          aiTokensPerMonth: 0,
          queuedPostsPerChannel: 10,
        },
      ],
    ];

    await service.applyLimitsToAllWorkspaces('user-1', 'FREE', NO_ADDONS);

    expect(writes).toHaveLength(3);
    // The primary keeps FREE's allowance; the rest are zeroed. Nobody retains
    // PRO's 8 channels.
    expect(writes.map((w) => w.values.channelsLimit)).toEqual([3, 0, 0]);
    expect(writes.map((w) => w.values.aiTokensLimit)).toEqual([0, 0, 0]);
  });
});

describe('SubscriptionLookupService.getPrimaryWorkspaceId', () => {
  let service: SubscriptionLookupService;

  beforeEach(() => {
    selectResults = [];
    writes = [];
    mockDb.select.mockImplementation(() => makeSelectChain());
    mockDb.update.mockImplementation(() => makeUpdateChain());
    service = new SubscriptionLookupService();
  });

  it('returns the oldest owned workspace', async () => {
    selectResults = [
      [
        { id: 'ws-new', createdAt: d('2026-05-01T00:00:00Z') },
        { id: 'ws-old', createdAt: d('2026-01-01T00:00:00Z') },
      ],
    ];

    expect(await service.getPrimaryWorkspaceId('user-1')).toBe('ws-old');
  });

  it('returns null when the account owns nothing', async () => {
    selectResults = [[]];

    expect(await service.getPrimaryWorkspaceId('user-1')).toBeNull();
  });
});
