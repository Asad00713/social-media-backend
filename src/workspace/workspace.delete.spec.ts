import { HttpException, Logger } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';

/*
 * The order and the failure rules of `remove`, without a database (the DB
 * spec, workspace.delete.db.spec.ts, covers the queries). `db.select()` hands
 * back the queued results in call order: the unlocked owned count (slot
 * release), then inside the transaction the owner's locked workspace rows,
 * then the scheduled posts. The transaction runs on the same fake.
 */

const WS = 'ws-1';
const OWNER = 'owner-1';

/* The fakes stand in for drizzle's fluent builders; `any` is confined to them. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
let locks: string[] = [];

function selectChain(rows: unknown[]): any {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    for: (mode: string) => {
      locks.push(mode);
      return chain;
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return chain;
}

function make(
  opts: {
    name?: string;
    otherOwned?: number;
    /** Other owned workspaces once the lock is held (a parallel delete). */
    otherOwnedLocked?: number;
    /** The workspace was deleted by a parallel request before the lock. */
    goneBeforeLock?: boolean;
    plan?: {
      planCode: string;
      status: string;
      cancelAtPeriodEnd?: boolean;
    } | null;
    jobRemoveFails?: boolean;
    cancelFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const marked: Record<string, unknown>[] = [];
  const scheduled = [
    { id: 'p1', jobId: 'post-legacy-1' },
    { id: 'p2', jobId: 'composer-publish-p2' },
  ];
  locks = [];
  const lockedOthers = opts.otherOwnedLocked ?? opts.otherOwned ?? 0;
  const ownedRows = [
    ...(opts.goneBeforeLock ? [] : [{ id: WS }]),
    ...Array.from({ length: lockedOthers }, (_, i) => ({ id: `ws-o${i}` })),
  ];
  const selects = [[{ n: opts.otherOwned ?? 0 }], ownedRows, scheduled];
  const db = {
    query: {
      workspace: {
        findFirst: jest.fn().mockResolvedValue({
          id: WS,
          name: opts.name ?? 'Acme',
          ownerId: OWNER,
        }),
      },
    },
    select: jest.fn(() => selectChain(selects.shift() ?? [])),
    // The soft delete: UPDATE workspace SET deleted_at, deleted_by_id.
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        marked.push(values);
        return {
          where: jest.fn(() => {
            calls.push('soft-delete');
            return Promise.resolve();
          }),
        };
      }),
    })),
  };
  // The transaction runs on the same fake (added after, so `db` stays typed).
  Object.assign(db, {
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      calls.push('lock');
      return fn(db);
    }),
  });
  const publishingQueue = {
    getJob: jest.fn((id: string) =>
      Promise.resolve({
        remove: jest.fn(() => {
          calls.push(`remove:${id}`);
          return opts.jobRemoveFails
            ? Promise.reject(new Error('locked'))
            : Promise.resolve();
        }),
      }),
    ),
  };
  const subscriptionService = {
    cancelForAccount: jest.fn(() => {
      calls.push('cancel');
      return opts.cancelFails
        ? Promise.reject(new Error('provider down'))
        : Promise.resolve('cancelled');
    }),
  };
  const plan =
    opts.plan === undefined
      ? { planCode: 'PRO', status: 'active', cancelAtPeriodEnd: false }
      : opts.plan;
  const lookup = {
    findByUserId: jest.fn().mockResolvedValue(plan ? { id: 7, ...plan } : null),
    getPlanLimits: jest.fn().mockResolvedValue({ maxWorkspaces: 1 }),
    getAddonQuantities: jest.fn().mockResolvedValue({}),
    applyLimitsToAllWorkspaces: jest.fn(() => {
      calls.push('limits');
      return Promise.resolve();
    }),
  };
  const addonService = {
    removeAddon: jest.fn(() => {
      calls.push('release');
      return Promise.resolve();
    }),
  };
  const timezoneMove = {
    cancelPendingMove: jest.fn(() => {
      calls.push('tz-move');
      return Promise.resolve();
    }),
  };
  const service = new WorkspaceService(
    db as never,
    {} as never,
    {} as never,
    subscriptionService as never,
    lookup as never,
    addonService as never,
    {} as never,
    {} as never,
    timezoneMove as never,
    publishingQueue as never,
  );
  return {
    service,
    db,
    calls,
    marked,
    subscriptionService,
    lookup,
    addonService,
    timezoneMove,
  };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), body: error.getResponse() };
    }
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('WorkspaceService.remove', () => {
  beforeEach(() => {
    // The best-effort failures log by design; keep the output clean.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('runs release, locked soft delete, job removal, tz-move cancel, plan cancel, limits in that order', async () => {
    const { service, calls, subscriptionService, marked } = make();

    await expect(service.remove(WS, OWNER, ' Acme ')).resolves.toEqual({
      message: 'Workspace permanently deleted',
    });

    expect(calls).toEqual([
      'release',
      'lock',
      'soft-delete',
      'remove:composer-publish-p1',
      'remove:post-legacy-1',
      'remove:composer-publish-p2',
      'tz-move',
      'cancel',
      'limits',
    ]);
    expect(subscriptionService.cancelForAccount).toHaveBeenCalledWith(
      OWNER,
      true,
      { changedByUserId: OWNER },
    );
    // The owner's rows are locked before the count the cancel decides on.
    expect(locks).toEqual(['update']);
    // Marked, not removed: who and when (main's soft-delete convention).
    expect(marked).toEqual([
      { deletedAt: expect.any(Date), deletedById: OWNER },
    ]);
  });

  it.each(['acme', 'Acme Inc', '', 'ACME'])(
    'refuses %p with the coded 400 and touches nothing',
    async (typed) => {
      const { service, calls, db } = make();

      expect(await failure(service.remove(WS, OWNER, typed))).toEqual({
        status: 400,
        body: {
          statusCode: 400,
          error: 'Bad Request',
          code: 'CONFIRM_NAME_MISMATCH',
          message: 'Type the workspace name exactly to delete it.',
        },
      });
      expect(calls).toEqual([]);
      expect(db.update).not.toHaveBeenCalled();
    },
  );

  it.each(['Acme', ' Acme ', '  Acme'])(
    'a stored name with surrounding spaces is deleted by typing %p',
    async (typed) => {
      const { service, db } = make({ name: '  Acme ' });

      await service.remove(WS, OWNER, typed);
      expect(db.update).toHaveBeenCalledTimes(1);
    },
  );

  it('a stored name with spaces is still compared case-sensitively', async () => {
    const { service, db } = make({ name: ' Acme ' });

    expect((await failure(service.remove(WS, OWNER, 'acme'))).status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('two parallel deletes of the last two workspaces: the second, counting under the lock, cancels', async () => {
    // Before the lock it saw the other workspace; once the lock is held the
    // parallel delete has committed and nothing else is left.
    const { service, subscriptionService } = make({
      otherOwned: 1,
      otherOwnedLocked: 0,
    });

    await service.remove(WS, OWNER, 'Acme');
    expect(subscriptionService.cancelForAccount).toHaveBeenCalledWith(
      OWNER,
      true,
      { changedByUserId: OWNER },
    );
  });

  it('a workspace deleted by a parallel request answers 404 and removes no jobs', async () => {
    const { service, calls, db } = make({ goneBeforeLock: true });

    expect((await failure(service.remove(WS, OWNER, 'Acme'))).status).toBe(404);
    expect(db.update).not.toHaveBeenCalled();
    expect(calls.some((c) => c.startsWith('remove:'))).toBe(false);
    expect(calls).not.toContain('cancel');
  });

  it('keeps the plan when the owner still owns another workspace', async () => {
    const { service, subscriptionService } = make({ otherOwned: 1 });

    await service.remove(WS, OWNER, 'Acme');
    expect(subscriptionService.cancelForAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['FREE', { planCode: 'FREE', status: 'active' }],
    ['already canceled', { planCode: 'PRO', status: 'canceled' }],
    [
      'already ending at the period end',
      { planCode: 'PRO', status: 'active', cancelAtPeriodEnd: true },
    ],
    ['no subscription', null],
  ])('cancels nothing on %s', async (_label, plan) => {
    const { service, subscriptionService } = make({ plan });

    await service.remove(WS, OWNER, 'Acme');
    expect(subscriptionService.cancelForAccount).not.toHaveBeenCalled();
  });

  it('a super admin deleting bills the OWNER, and is recorded as the one who cancelled and deleted', async () => {
    const { service, subscriptionService, addonService, lookup, marked } =
      make();

    await service.remove(WS, 'super-admin', 'Acme');
    expect(marked).toEqual([
      { deletedAt: expect.any(Date), deletedById: 'super-admin' },
    ]);
    expect(addonService.removeAddon).toHaveBeenCalledWith(
      WS,
      OWNER,
      'EXTRA_WORKSPACE',
      1,
    );
    expect(subscriptionService.cancelForAccount).toHaveBeenCalledWith(
      OWNER,
      true,
      { changedByUserId: 'super-admin' },
    );
    expect(lookup.applyLimitsToAllWorkspaces).toHaveBeenCalledWith(
      OWNER,
      'PRO',
      {},
    );
  });

  it('a job that cannot be removed or a failed cancel never fails the delete', async () => {
    const { service, calls } = make({
      jobRemoveFails: true,
      cancelFails: true,
    });

    await expect(service.remove(WS, OWNER, 'Acme')).resolves.toEqual({
      message: 'Workspace permanently deleted',
    });
    expect(calls).toContain('limits');
  });
});
