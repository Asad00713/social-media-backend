import { HttpException, Logger } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';

/*
 * The order and the failure rules of `remove`, without a database (the DB
 * spec, workspace.delete.db.spec.ts, covers the queries). `db.select()` hands
 * back the queued results in call order: first the scheduled posts, then the
 * owned-workspace count.
 */

const WS = 'ws-1';
const OWNER = 'owner-1';

/* The fakes stand in for drizzle's fluent builders; `any` is confined to them. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
function selectChain(rows: unknown[]): any {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return chain;
}

function make(
  opts: {
    name?: string;
    otherOwned?: number;
    plan?: { planCode: string; status: string } | null;
    jobRemoveFails?: boolean;
    cancelFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const scheduled = [
    { id: 'p1', jobId: 'post-legacy-1' },
    { id: 'p2', jobId: 'composer-publish-p2' },
  ];
  const selects = [scheduled, [{ n: opts.otherOwned ?? 0 }]];
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
    delete: jest.fn(() => ({
      where: jest.fn(() => {
        calls.push('delete');
        return Promise.resolve();
      }),
    })),
  };
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
    opts.plan === undefined ? { planCode: 'PRO', status: 'active' } : opts.plan;
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

  it('runs release, delete, job removal, tz-move cancel, plan cancel, limits in that order', async () => {
    const { service, calls, subscriptionService } = make();

    await expect(service.remove(WS, OWNER, ' Acme ')).resolves.toEqual({
      message: 'Workspace permanently deleted',
    });

    expect(calls).toEqual([
      'release',
      'delete',
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
      expect(db.delete).not.toHaveBeenCalled();
    },
  );

  it('trims only the typed side: a workspace named with spaces needs them typed', async () => {
    const { service, db } = make({ name: ' Acme' });

    await failure(service.remove(WS, OWNER, ' Acme'));
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('keeps the plan when the owner still owns another workspace', async () => {
    const { service, subscriptionService } = make({ otherOwned: 1 });

    await service.remove(WS, OWNER, 'Acme');
    expect(subscriptionService.cancelForAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['FREE', { planCode: 'FREE', status: 'active' }],
    ['already canceled', { planCode: 'PRO', status: 'canceled' }],
    ['no subscription', null],
  ])('cancels nothing on %s', async (_label, plan) => {
    const { service, subscriptionService } = make({ plan });

    await service.remove(WS, OWNER, 'Acme');
    expect(subscriptionService.cancelForAccount).not.toHaveBeenCalled();
  });

  it('a super admin deleting bills the OWNER, and is recorded as the one who cancelled', async () => {
    const { service, subscriptionService, addonService, lookup } = make();

    await service.remove(WS, 'super-admin', 'Acme');
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
